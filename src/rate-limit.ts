// Best-effort per-isolate IP rate limiting for the ricochet Worker.

// quality-ok: magic-number — value is the definition of this named constant
export const RATE_LIMIT_INTERACTIONS_MAX = 60;
// quality-ok: magic-number — value is the definition of this named constant
export const RATE_LIMIT_RECS_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;
const MS_PER_SECOND = 1000;
// Sweep stale buckets once the map grows past this, bounding memory after a traffic spike.
const RATE_BUCKET_SWEEP_THRESHOLD = 1_000;

// Per-isolate in-memory buckets — best-effort only. Cloudflare may run many isolates
// across colos, so the effective cap is max × isolate count. Absent CF-Connecting-IP
// (non-Cloudflare traffic) rate limiting is skipped entirely.
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function getClientIp(request: Request): string | null {
  // CF-Connecting-IP is injected by Cloudflare and cannot be spoofed by the client.
  // X-Forwarded-For is client-controlled and must NOT be trusted for rate limiting —
  // falling back to it would let any client bypass limits by forging the header.
  return request.headers.get('CF-Connecting-IP');
}

export function checkRateLimit(
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
    // Bucket expired or missing — reset, then opportunistically sweep stale entries.
    rateBuckets.set(bucketKey, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    if (rateBuckets.size > RATE_BUCKET_SWEEP_THRESHOLD) {
      for (const [k, bucket] of rateBuckets) {
        if (bucket.resetAt <= now) rateBuckets.delete(k);
      }
    }
    return { limited: false };
  }
  if (existing.count >= max) {
    return {
      limited: true,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / MS_PER_SECOND)),
    };
  }
  existing.count += 1;
  return { limited: false };
}
