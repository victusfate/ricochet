import { RecDO } from './RecDO';
export { RecDO };
export type { RecWorkerEnv } from './worker-env';
import type { RecWorkerEnv } from './worker-env';
import type { RecCoreResponse, RecResponse } from './types';
import { isValidEvent } from './validation';

const RATE_LIMIT_INTERACTIONS_MAX = 60;
const RATE_LIMIT_RECS_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;

const rateBuckets = new Map<string, { count: number; resetAt: number }>();

const ALLOWED_ORIGINS = [
  'https://victusfate.github.io',
  'https://boomerang-news.com',
  'https://www.boomerang-news.com',
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
    if (u.protocol === 'https:' && u.hostname.endsWith('.pages.dev')) return true;
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
  h.set('Access-Control-Allow-Headers', 'Content-Type');
  h.set('Vary', 'Origin');
  return h;
}

function json(data: unknown, request: Request, env: RecWorkerEnv, init?: ResponseInit): Response {
  const headers = corsHeaders(request, env);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(data), { ...init, headers });
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

function getClientIp(request: Request): string | null {
  const cfIp = request.headers.get('CF-Connecting-IP');
  if (cfIp) return cfIp;
  const forwarded = request.headers.get('X-Forwarded-For');
  if (!forwarded) return null;
  return forwarded.split(',')[0]?.trim() || null;
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
    rateBuckets.set(bucketKey, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { limited: false };
  }
  if (existing.count >= max) {
    return {
      limited: true,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }
  existing.count += 1;
  if (rateBuckets.size > 10_000) {
    for (const [k, bucket] of rateBuckets) {
      if (bucket.resetAt <= now) rateBuckets.delete(k);
    }
  }
  return { limited: false };
}

const MAX_BATCH_SIZE = 200;
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
const CACHE_TTL_SECONDS = 300;

function getRecDOStub(env: RecWorkerEnv): DurableObjectStub {
  const id = env.REC_DO.idFromName('global');
  return env.REC_DO.get(id);
}

function withObservability(
  core: RecCoreResponse,
  request: Request,
  cacheKey: string,
  cacheStatus: 'hit' | 'miss' | 'bypass',
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

    // GET /health
    if (pathname === '/health' && request.method === 'GET') {
      return json({ ok: true, service: 'ricochet-rec' }, request, env);
    }

    // POST /interactions
    if (pathname === '/interactions' && request.method === 'POST') {
      const limited = checkRateLimit(request, 'interactions', RATE_LIMIT_INTERACTIONS_MAX);
      if (limited.limited) return tooManyRequests(request, env, limited.retryAfterSeconds);

      let body: { events?: unknown };
      try {
        body = await request.json() as { events?: unknown };
      } catch {
        return json({ ok: false, message: 'Invalid JSON body' }, request, env, { status: 400 });
      }

      if (!Array.isArray(body.events)) {
        return json(
          { ok: false, message: 'body.events must be an array' },
          request, env, { status: 400 },
        );
      }
      if (body.events.length > MAX_BATCH_SIZE) {
        return json(
          { ok: false, message: `Batch too large; max ${MAX_BATCH_SIZE} events` },
          request, env, { status: 400 },
        );
      }

      const valid = body.events.filter(isValidEvent);
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

    // GET /recommendations/:userId
    const recsMatch = pathname.match(/^\/recommendations\/(.+)$/);
    if (recsMatch && request.method === 'GET') {
      const requestStartedAt = Date.now();
      const limited = checkRateLimit(request, 'recs', RATE_LIMIT_RECS_MAX);
      if (limited.limited) return tooManyRequests(request, env, limited.retryAfterSeconds);

      const userId = recsMatch[1];
      const rawLimit = parseInt(url.searchParams.get('limit') ?? String(DEFAULT_LIMIT), 10);
      const limit = Math.min(isNaN(rawLimit) || rawLimit < 1 ? DEFAULT_LIMIT : rawLimit, MAX_LIMIT);

      const cacheKey = `recs:${userId}`;
      const cacheLookupStartedAt = Date.now();
      const cached = await env.REC_STORE.get(cacheKey, 'json') as RecCoreResponse | null;
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
        return json(response, request, env);
      }

      const cacheStatus: 'miss' | 'bypass' = cached ? 'bypass' : 'miss';

      const stub = getRecDOStub(env);
      const doFetchStartedAt = Date.now();
      const doRes = await stub.fetch(
        new Request(`http://do-internal/recs/${encodeURIComponent(userId)}?limit=${limit}`),
      );
      const recBody = await doRes.json() as RecCoreResponse;
      const doFetchMs = Date.now() - doFetchStartedAt;

      const cacheWriteStartedAt = Date.now();
      await env.REC_STORE.put(cacheKey, JSON.stringify(recBody), { expirationTtl: CACHE_TTL_SECONDS });
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
      return json(response, request, env);
    }

    return new Response('Not Found', { status: 404, headers: corsHeaders(request, env) });
  },
} satisfies ExportedHandler<RecWorkerEnv>;
