import { RecDO } from './RecDO';
export { RecDO };
export type { RecWorkerEnv } from './worker-env';
import type { RecWorkerEnv } from './worker-env';
import type { RecCacheStatus, RecCoreResponse, RecRankRequest, RecResponse } from './types';
import { ARTICLES_GET_MAX, ARTICLES_POST_MAX } from './types';
import { parseRankRequest } from './parsing';
import { isValidEvent } from './validation';

const RATE_LIMIT_INTERACTIONS_MAX = 60;
const RATE_LIMIT_RECS_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;

// Per-isolate in-memory buckets — best-effort only. Cloudflare may run many isolates
// across colos, so the effective cap is max × isolate count. Absent CF-Connecting-IP
// (non-Cloudflare traffic) rate limiting is skipped entirely.
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

const ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
];

function extraOriginsFromEnv(env: RecWorkerEnv): string[] {
  const raw = env.EXTRA_CORS_ORIGINS?.trim();
  if (!raw) return [];
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

function isAllowedOrigin(origin: string, env: RecWorkerEnv): boolean {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  if (extraOriginsFromEnv(env).includes(origin)) return true;
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:') return false;
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

function corsHeaders(request: Request, env: RecWorkerEnv): Headers {
  const origin = request.headers.get('Origin') ?? '';
  const allow = isAllowedOrigin(origin, env) ? origin : ALLOWED_ORIGINS[0];
  const h = new Headers();
  h.set('Access-Control-Allow-Origin', allow);
  h.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type, If-None-Match');
  h.set('Access-Control-Expose-Headers', 'ETag');
  h.set('Vary', 'Origin');
  return h;
}

function json(
  data: unknown,
  request: Request,
  env: RecWorkerEnv,
  init?: ResponseInit,
  extraHeaders?: Record<string, string>,
): Response {
  const headers = corsHeaders(request, env);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v);
  }
  return new Response(JSON.stringify(data), { ...init, headers });
}

/** Canonical error response: `{ ok: false, message }` with CORS headers. */
function badRequest(request: Request, env: RecWorkerEnv, message: string, status = 400): Response {
  return json({ ok: false, message }, request, env, { status });
}

function tooManyRequests(request: Request, env: RecWorkerEnv, retryAfterSeconds: number): Response {
  const headers = corsHeaders(request, env);
  headers.set('Retry-After', String(retryAfterSeconds));
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(
    JSON.stringify({ ok: false, message: 'Too Many Requests' }),
    { status: 429, headers },
  );
}

/** Reads a size-bounded request body and parses it as JSON, producing the error response on failure. */
async function readBoundedJson(
  request: Request,
  env: RecWorkerEnv,
): Promise<{ value: unknown } | { error: Response }> {
  const contentLength = parseInt(request.headers.get('Content-Length') ?? '0', 10);
  if (contentLength > MAX_BODY_BYTES) {
    return { error: badRequest(request, env, 'Request body too large', 413) };
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { error: badRequest(request, env, 'Invalid JSON body') };
  }
  if (text.length > MAX_BODY_BYTES) {
    return { error: badRequest(request, env, 'Request body too large', 413) };
  }
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return { error: badRequest(request, env, 'Invalid JSON body') };
  }
}

async function respondWithETag(
  response: RecResponse,
  request: Request,
  env: RecWorkerEnv,
): Promise<Response> {
  const etag = await computeETag(response.articleIds);
  if (request.method === 'GET' && request.headers.get('If-None-Match') === etag) {
    const h = corsHeaders(request, env);
    h.set('ETag', etag);
    return new Response(null, { status: 304, headers: h });
  }
  return json(response, request, env, undefined, { ETag: etag });
}

function getClientIp(request: Request): string | null {
  // CF-Connecting-IP is injected by Cloudflare and cannot be spoofed by the client.
  // X-Forwarded-For is client-controlled and must NOT be trusted for rate limiting —
  // falling back to it would let any client bypass limits by forging the header.
  return request.headers.get('CF-Connecting-IP');
}

function checkRateLimit(
  request: Request,
  key: string,
  max: number,
): { limited: false } | { limited: true; retryAfterSeconds: number } {
  const clientIp = getClientIp(request);
  if (!clientIp) return { limited: false };
  const now = Date.now();
  const bucketKey = `${key}:${clientIp}`;
  const existing = rateBuckets.get(bucketKey);
  if (!existing || existing.resetAt <= now) {
    // Bucket expired or missing — reset. Opportunistically sweep stale entries to
    // prevent unbounded memory growth after traffic spikes (e.g. DDoS burst).
    rateBuckets.set(bucketKey, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    if (rateBuckets.size > 1_000) {
      for (const [k, bucket] of rateBuckets) {
        if (bucket.resetAt <= now) rateBuckets.delete(k);
      }
    }
    return { limited: false };
  }
  if (existing.count >= max) {
    return {
      limited: true,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }
  existing.count += 1;
  return { limited: false };
}

const MAX_BATCH_SIZE = 200;
// 50 KB is generous for 200 interaction events; reject oversized bodies early
// before JSON.parse() allocates memory for the full payload.
const MAX_BODY_BYTES = 50_000;
const CACHE_TTL_SECONDS = 300;

function getRecDOStub(env: RecWorkerEnv): DurableObjectStub {
  const id = env.REC_DO.idFromName('global');
  return env.REC_DO.get(id);
}

/** Computes a stable ETag from the ranked article ID list. */
async function sha256HexPrefix(text: string, nBytes: number): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .slice(0, nBytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function computeETag(articleIds: string[]): Promise<string> {
  return `"${await sha256HexPrefix(articleIds.join(','), 16)}"`;
}

async function hashCandidateArticleIds(candidateArticleIds: string[]): Promise<string> {
  return sha256HexPrefix([...candidateArticleIds].sort().join(','), 12);
}

async function buildRecCacheKey(
  userId: string,
  limit: number,
  candidateArticleIds?: string[],
): Promise<string> {
  if (!candidateArticleIds) return `recs:${userId}:limit:${limit}`;
  const poolHash = await hashCandidateArticleIds(candidateArticleIds);
  return `recs:${userId}:pool:${poolHash}:limit:${limit}`;
}

function withObservability(
  core: RecCoreResponse,
  request: Request,
  cacheKey: string,
  cacheStatus: RecCacheStatus,
  cacheAgeSec: number,
  timingMs: RecResponse['timingMs'],
): RecResponse {
  const cfRay = request.headers.get('CF-Ray') ?? undefined;
  return {
    ...core,
    trace: {
      requestId: crypto.randomUUID(),
      cfRay,
    },
    cache: {
      status: cacheStatus,
      key: cacheKey,
      ttlSec: CACHE_TTL_SECONDS,
      ageSec: cacheAgeSec,
    },
    timingMs,
  };
}

// POST /interactions
async function handleInteractions(request: Request, env: RecWorkerEnv): Promise<Response> {
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
  await stub.fetch(new Request('http://do-internal/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(valid),
  }));

  return json({ ok: true, queued: valid.length }, request, env);
}

// GET /recommendations/:userId  — global popularity ranking with optional feed-pool + ETag
// POST /recommendations/:userId — personalized ranking with candidateArticleIds and/or topicWeights
async function handleRecommendations(
  request: Request,
  env: RecWorkerEnv,
  url: URL,
  userId: string,
): Promise<Response> {
  const requestStartedAt = Date.now();
  const limited = checkRateLimit(request, 'recs', RATE_LIMIT_RECS_MAX);
  if (limited.limited) return tooManyRequests(request, env, limited.retryAfterSeconds);

  let body: RecRankRequest | null = null;
  if (request.method === 'POST') {
    const recsBodyResult = await readBoundedJson(request, env);
    if ('error' in recsBodyResult) return recsBodyResult.error;
    body = recsBodyResult.value as RecRankRequest | null;
  }
  const parsed = request.method === 'GET'
    ? parseRankRequest({ method: 'GET', searchParams: url.searchParams })
    : parseRankRequest({ method: 'POST', searchParams: url.searchParams, body });
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
      Math.max(0, Math.floor((now - cached.generatedAt) / 1000)),
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
    return json(
      { ok: false, message: errorText || 'Failed to rank recommendations' },
      request,
      env,
      { status: doRes.status },
    );
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
async function handleArticles(request: Request, env: RecWorkerEnv, url: URL): Promise<Response> {
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
  const articlesBody = await doRes.json();
  return json(articlesBody, request, env);
}

export default {
  async scheduled(_controller: ScheduledController, env: RecWorkerEnv, ctx: ExecutionContext): Promise<void> {
    const stub = getRecDOStub(env);
    ctx.waitUntil(stub.fetch(new Request('http://do-internal/prune', { method: 'POST' })));
  },

  async fetch(request: Request, env: RecWorkerEnv, _ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';

    if (pathname === '/health' && request.method === 'GET') {
      return json({ ok: true, service: 'ricochet-rec' }, request, env);
    }

    if (pathname === '/interactions' && request.method === 'POST') {
      return handleInteractions(request, env);
    }

    const recsMatch = pathname.match(/^\/recommendations\/(.+)$/);
    if (recsMatch && (request.method === 'GET' || request.method === 'POST')) {
      return handleRecommendations(request, env, url, recsMatch[1]);
    }

    if (pathname === '/rec/articles') {
      return handleArticles(request, env, url);
    }

    return new Response('Not Found', { status: 404, headers: corsHeaders(request, env) });
  },
} satisfies ExportedHandler<RecWorkerEnv>;
