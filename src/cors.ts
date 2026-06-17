// CORS origin allowlist and header construction for the ricochet Worker.

import type { RecWorkerEnv } from './worker-env';

const ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
];

// Memoized per isolate (env is constant for the isolate lifetime); keyed on the
// raw value so tests with differing fake envs still resolve correctly.
let extraOriginsCache: { raw: string | undefined; origins: string[] } | null = null;

function extraOriginsFromEnv(env: RecWorkerEnv): string[] {
  const raw = env.EXTRA_CORS_ORIGINS;
  if (extraOriginsCache && extraOriginsCache.raw === raw) return extraOriginsCache.origins;
  // The env contract documents https:// only — enforce it so a misconfigured
  // http:// or garbage entry is never honored.
  const origins = (raw?.trim() ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(s => s.startsWith('https://'));
  extraOriginsCache = { raw, origins };
  return origins;
}

/** Exported for tests — origin allowlist check (defaults + EXTRA_CORS_ORIGINS + localhost). */
export function isAllowedOrigin(origin: string, env: RecWorkerEnv): boolean {
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

export function corsHeaders(request: Request, env: RecWorkerEnv): Headers {
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
