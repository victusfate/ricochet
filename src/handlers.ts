// HTTP request handlers for the ricochet Worker, fronting the RecDO.

import type { ArticlesResponse, RecCacheStatus, RecCoreResponse, RecRankRequest } from './types';
import { ARTICLES_GET_MAX, ARTICLES_POST_MAX } from './types';
import type { RecWorkerEnv } from './worker-env';
import { makeRankInput, parseRankRequest } from './parsing';
import { isValidEvent, MAX_ID_LENGTH } from './validation';
import { corsHeaders } from './cors';
import { badRequest, json, readBoundedJson, tooManyRequests } from './http';
import { checkRateLimit, RATE_LIMIT_INTERACTIONS_MAX, RATE_LIMIT_RECS_MAX } from './rate-limit';
import { buildRecCacheKey, CACHE_TTL_SECONDS, respondWithETag, withObservability } from './rec-cache';

const MAX_BATCH_SIZE = 200;
const HTTP_BAD_GATEWAY = 502;
const MS_PER_SECOND = 1000;

export function getRecDOStub(env: RecWorkerEnv): DurableObjectStub {
  const id = env.REC_DO.idFromName('global');
  return env.REC_DO.get(id);
}

// POST /interactions
export async function handleInteractions(request: Request, env: RecWorkerEnv): Promise<Response> {
  const limited = checkRateLimit(request, 'interactions', RATE_LIMIT_INTERACTIONS_MAX);
  if (limited.limited) return tooManyRequests(request, env, limited.retryAfterSeconds);

  const bodyResult = await readBoundedJson(request, env);
  if ('error' in bodyResult) return bodyResult.error;
  const parsed = bodyResult.value;

  // Accept both shapes: bare array or { events: [...] }
  const eventsRaw: unknown = Array.isArray(parsed) ? parsed
    : (parsed !== null && typeof parsed === 'object')
      ? (parsed as Record<string, unknown>).events
      : undefined;
  if (!Array.isArray(eventsRaw)) {
    return badRequest(request, env, 'body must be an InteractionEvent[] array or { events: InteractionEvent[] }');
  }
  if (eventsRaw.length > MAX_BATCH_SIZE) {
    return badRequest(request, env, `Batch too large; max ${MAX_BATCH_SIZE} events`);
  }

  const valid = eventsRaw.filter(isValidEvent);
  if (valid.length === 0) {
    return json({ ok: true, queued: 0 }, request, env);
  }

  const stub = getRecDOStub(env);
  const doRes = await stub.fetch(new Request('http://do-internal/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(valid),
  }));
  if (!doRes.ok) {
    // Never claim success when events were dropped.
    return badRequest(request, env, 'Failed to ingest interactions', HTTP_BAD_GATEWAY);
  }

  return json({ ok: true, queued: valid.length }, request, env);
}

// GET /recommendations/:userId  — global popularity ranking with optional feed-pool + ETag
// POST /recommendations/:userId — personalized ranking with candidateArticleIds and/or topicWeights
export async function handleRecommendations(
  request: Request,
  env: RecWorkerEnv,
  url: URL,
  userId: string,
): Promise<Response> {
  const requestStartedAt = Date.now();
  const limited = checkRateLimit(request, 'recs', RATE_LIMIT_RECS_MAX);
  if (limited.limited) return tooManyRequests(request, env, limited.retryAfterSeconds);

  // Same cap as /interactions IDs — bounds DO work and keeps KV keys sane.
  if (userId.length === 0 || userId.length > MAX_ID_LENGTH) {
    return badRequest(request, env, `userId must be 1-${MAX_ID_LENGTH} characters`);
  }

  let body: RecRankRequest | null = null;
  if (request.method === 'POST') {
    const recsBodyResult = await readBoundedJson(request, env);
    if ('error' in recsBodyResult) return recsBodyResult.error;
    body = recsBodyResult.value as RecRankRequest | null;
  }
  const parsed = parseRankRequest(makeRankInput(request.method as 'GET' | 'POST', url.searchParams, body));
  if (!parsed.ok) {
    return badRequest(request, env, parsed.message);
  }
  const { limit, candidateModeProvided, candidateArticleIds, topicWeights } = parsed.value;

  // Bypass cache when topicWeights are provided — results are personalized per user preference
  const skipCache = !!topicWeights && Object.keys(topicWeights).length > 0;

  const cacheKey = skipCache
    ? ''
    : await buildRecCacheKey(
      userId,
      limit,
      candidateModeProvided ? (candidateArticleIds ?? []) : undefined,
    );

  const cacheLookupStartedAt = Date.now();
  const cached = skipCache
    ? null
    : await env.REC_STORE.get(cacheKey, 'json') as RecCoreResponse | null;
  const cacheLookupMs = Date.now() - cacheLookupStartedAt;

  if (cached?.scoredArticleIds && cached?.diagnostics) {
    const now = Date.now();
    const response = withObservability(
      cached,
      request,
      cacheKey,
      'hit',
      Math.max(0, Math.floor((now - cached.generatedAt) / MS_PER_SECOND)),
      {
        total: now - requestStartedAt,
        cacheLookup: cacheLookupMs,
        doFetch: 0,
        cacheWrite: 0,
      },
    );
    return respondWithETag(response, request, env);
  }

  const cacheStatus: RecCacheStatus = skipCache ? 'bypass' : (cached ? 'bypass' : 'miss');

  const stub = getRecDOStub(env);
  const doFetchStartedAt = Date.now();
  let doRes: Response;
  if (candidateModeProvided || topicWeights) {
    doRes = await stub.fetch(
      new Request(`http://do-internal/recs/${encodeURIComponent(userId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(candidateModeProvided ? { candidateArticleIds: candidateArticleIds ?? [] } : {}),
          limit,
          ...(topicWeights ? { topicWeights } : {}),
        }),
      }),
    );
  } else {
    doRes = await stub.fetch(
      new Request(`http://do-internal/recs/${encodeURIComponent(userId)}?limit=${limit}`),
    );
  }
  if (!doRes.ok) {
    const errorText = await doRes.text();
    return badRequest(request, env, errorText || 'Failed to rank recommendations', doRes.status);
  }
  const recBody = await doRes.json() as RecCoreResponse;
  const doFetchMs = Date.now() - doFetchStartedAt;

  const cacheWriteStartedAt = Date.now();
  if (!skipCache) {
    await env.REC_STORE.put(cacheKey, JSON.stringify(recBody), { expirationTtl: CACHE_TTL_SECONDS });
  }
  const cacheWriteMs = Date.now() - cacheWriteStartedAt;

  const now = Date.now();
  const response = withObservability(
    recBody,
    request,
    cacheKey,
    cacheStatus,
    0,
    {
      total: now - requestStartedAt,
      cacheLookup: cacheLookupMs,
      doFetch: doFetchMs,
      cacheWrite: cacheWriteMs,
    },
  );

  return respondWithETag(response, request, env);
}

// GET /rec/articles?ids=<csv>  — up to ARTICLES_GET_MAX IDs
// POST /rec/articles           — up to ARTICLES_POST_MAX IDs in body
export async function handleArticles(request: Request, env: RecWorkerEnv, url: URL): Promise<Response> {
  const limited = checkRateLimit(request, 'articles', RATE_LIMIT_RECS_MAX);
  if (limited.limited) return tooManyRequests(request, env, limited.retryAfterSeconds);

  let ids: string[];

  if (request.method === 'GET') {
    const raw = url.searchParams.get('ids') ?? '';
    ids = raw.split(',').map(s => s.trim()).filter(Boolean);
    if (ids.length === 0) {
      return badRequest(request, env, 'ids query param is required');
    }
    if (ids.length > ARTICLES_GET_MAX) {
      return badRequest(request, env, `Too many ids; max ${ARTICLES_GET_MAX} for GET`);
    }
  } else if (request.method === 'POST') {
    const bodyResult = await readBoundedJson(request, env);
    if ('error' in bodyResult) return bodyResult.error;
    const parsed = bodyResult.value;
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray((parsed as Record<string, unknown>).ids)) {
      return badRequest(request, env, 'body must be { ids: string[] }');
    }
    ids = ((parsed as Record<string, unknown>).ids as unknown[]).map(String);
    if (ids.length === 0) {
      return json({ articles: [] }, request, env);
    }
    if (ids.length > ARTICLES_POST_MAX) {
      return badRequest(request, env, `Too many ids; max ${ARTICLES_POST_MAX} for POST`);
    }
  } else {
    return new Response('Method Not Allowed', { status: 405, headers: corsHeaders(request, env) });
  }

  const stub = getRecDOStub(env);
  const doRes = await stub.fetch(new Request('http://do-internal/articles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  }));
  if (!doRes.ok) {
    const errorText = await doRes.text();
    return badRequest(request, env, errorText || 'Failed to fetch articles', doRes.status);
  }
  const articlesBody = await doRes.json() as ArticlesResponse;
  return json(articlesBody, request, env);
}
