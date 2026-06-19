// JSON response helpers and size-bounded body reading, all CORS-aware.

import type { RecWorkerEnv } from './worker-env';
import { corsHeaders } from './cors';

// 50 KB is generous for 200 interaction events; reject oversized bodies early
// before JSON.parse() allocates memory for the full payload.
export const MAX_BODY_BYTES = 50_000;

// HTTP status codes used by the response helpers.
const HTTP_BAD_REQUEST = 400;
const HTTP_PAYLOAD_TOO_LARGE = 413;

export function json(
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
export function badRequest(request: Request, env: RecWorkerEnv, message: string, status = HTTP_BAD_REQUEST): Response {
  return json({ ok: false, message }, request, env, { status });
}

export function tooManyRequests(request: Request, env: RecWorkerEnv, retryAfterSeconds: number): Response {
  const headers = corsHeaders(request, env);
  headers.set('Retry-After', String(retryAfterSeconds));
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(
    JSON.stringify({ ok: false, message: 'Too Many Requests' }),
    { status: 429, headers },
  );
}

/** Reads a size-bounded request body and parses it as JSON, producing the error response on failure. */
export async function readBoundedJson(
  request: Request,
  env: RecWorkerEnv,
): Promise<{ value: unknown } | { error: Response }> {
  const contentLength = parseInt(request.headers.get('Content-Length') ?? '0', 10);
  if (contentLength > MAX_BODY_BYTES) {
    return { error: badRequest(request, env, 'Request body too large', HTTP_PAYLOAD_TOO_LARGE) };
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { error: badRequest(request, env, 'Invalid JSON body') };
  }
  if (text.length > MAX_BODY_BYTES) {
    return { error: badRequest(request, env, 'Request body too large', HTTP_PAYLOAD_TOO_LARGE) };
  }
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return { error: badRequest(request, env, 'Invalid JSON body') };
  }
}
