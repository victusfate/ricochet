// Recommendation response shaping: KV cache keys, ETags, and observability envelope.

import type { RecCacheStatus, RecCoreResponse, RecResponse } from './types';
import type { RecWorkerEnv } from './worker-env';
import { corsHeaders } from './cors';
import { json } from './http';

// quality-ok: magic-number — value is the definition of this named constant
export const CACHE_TTL_SECONDS = 300;
// Byte lengths for SHA-256 hash prefixes used in cache keys and ETags.
// quality-ok: magic-number — value is the definition of this named constant
const ETAG_HASH_BYTES      = 16;
// quality-ok: magic-number — value is the definition of this named constant
const CACHE_KEY_HASH_BYTES = 12;

async function sha256HexPrefix(text: string, nBytes: number): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .slice(0, nBytes)
    // quality-ok: magic-number — radix 16 and padStart 2 are the standard hex-byte idiom
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Computes a stable ETag from the ranked article ID list. */
async function computeETag(articleIds: string[]): Promise<string> {
  return `"${await sha256HexPrefix(articleIds.join(','), ETAG_HASH_BYTES)}"`;
}

async function hashCandidateArticleIds(candidateArticleIds: string[]): Promise<string> {
  return sha256HexPrefix([...candidateArticleIds].sort().join(','), CACHE_KEY_HASH_BYTES);
}

/**
 * Builds the KV cache key for a recommendations response. The userId segment
 * is hashed: a raw userId could embed `:pool:`/`:limit:` separators and forge
 * a collision with another user's key (cache poisoning), and arbitrary-length
 * userIds could exceed the 512-byte KV key limit. Exported for tests.
 */
export async function buildRecCacheKey(
  userId: string,
  limit: number,
  candidateArticleIds?: string[],
): Promise<string> {
  const uid = await sha256HexPrefix(userId, CACHE_KEY_HASH_BYTES);
  if (!candidateArticleIds) return `recs:u:${uid}:limit:${limit}`;
  const poolHash = await hashCandidateArticleIds(candidateArticleIds);
  return `recs:u:${uid}:pool:${poolHash}:limit:${limit}`;
}

export function withObservability(
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

export async function respondWithETag(
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
