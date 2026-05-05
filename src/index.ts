import { RecDO } from './RecDO';
export { RecDO };
import type { InteractionEvent } from './types';

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

function extraOriginsFromEnv(env: Env): string[] {
  const raw = env.EXTRA_CORS_ORIGINS?.trim();
  if (!raw) return [];
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

function isAllowedOrigin(origin: string, env: Env): boolean {
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

function corsHeaders(request: Request, env: Env): Headers {
  const origin = request.headers.get('Origin') ?? '';
  const allow = isAllowedOrigin(origin, env) ? origin : ALLOWED_ORIGINS[0];
  const h = new Headers();
  h.set('Access-Control-Allow-Origin', allow);
  h.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type');
  h.set('Vary', 'Origin');
  return h;
}

function json(data: unknown, request: Request, env: Env, init?: ResponseInit): Response {
  const headers = corsHeaders(request, env);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(data), { ...init, headers });
}

function tooManyRequests(request: Request, env: Env, retryAfterSeconds: number): Response {
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

const VALID_ACTIONS = new Set(['read', 'upvote', 'downvote', 'save', 'seen']);
const MAX_BATCH_SIZE = 200;
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

function isValidEvent(e: unknown): e is InteractionEvent {
  if (typeof e !== 'object' || e === null) return false;
  const ev = e as Record<string, unknown>;
  return (
    typeof ev.userId === 'string' && ev.userId.length > 0 &&
    typeof ev.articleId === 'string' && ev.articleId.length > 0 &&
    typeof ev.sourceId === 'string' && ev.sourceId.length > 0 &&
    Array.isArray(ev.topics) && ev.topics.length > 0 &&
    typeof ev.action === 'string' && VALID_ACTIONS.has(ev.action) &&
    typeof ev.ts === 'number'
  );
}

function getRecDOStub(env: Env): DurableObjectStub {
  const id = env.REC_DO.idFromName('global');
  return env.REC_DO.get(id);
}

export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const stub = getRecDOStub(env);
    ctx.waitUntil(stub.fetch(new Request('http://do-internal/prune', { method: 'POST' })));
  },

  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
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
      const limited = checkRateLimit(request, 'recs', RATE_LIMIT_RECS_MAX);
      if (limited.limited) return tooManyRequests(request, env, limited.retryAfterSeconds);

      const userId = recsMatch[1];
      const rawLimit = parseInt(url.searchParams.get('limit') ?? String(DEFAULT_LIMIT), 10);
      const limit = Math.min(isNaN(rawLimit) || rawLimit < 1 ? DEFAULT_LIMIT : rawLimit, MAX_LIMIT);

      const stub = getRecDOStub(env);
      const doRes = await stub.fetch(
        new Request(`http://do-internal/recs/${encodeURIComponent(userId)}?limit=${limit}`),
      );
      const recBody = await doRes.json() as { articleIds: string[]; generatedAt: number };
      return json(recBody, request, env);
    }

    return new Response('Not Found', { status: 404, headers: corsHeaders(request, env) });
  },
} satisfies ExportedHandler<Env>;
