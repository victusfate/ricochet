/** Shared parsing utilities — used by both the Worker edge layer and the RecDO. */

export const MAX_LIMIT    = 200;
export const DEFAULT_LIMIT = 50;

export function parseLimit(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(value)));
  }
  if (typeof value === 'string') {
    const parsed = parseInt(value, 10);
    if (!Number.isNaN(parsed)) return Math.max(1, Math.min(MAX_LIMIT, parsed));
  }
  return DEFAULT_LIMIT;
}

/**
 * Parses and validates a topic-weights map from an untrusted source.
 * Keys are topic names; values are non-negative multipliers capped at 10×.
 */
export function parseTopicWeights(
  value: unknown,
): { weights?: Record<string, number>; message?: string } {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { message: 'topicWeights must be an object mapping topic names to numeric weights' };
  }
  const raw = value as Record<string, unknown>;
  const keys = Object.keys(raw);
  if (keys.length > 20) {
    return { message: 'topicWeights must not exceed 20 entries' };
  }
  const result: Record<string, number> = {};
  for (const k of keys) {
    const v = raw[k];
    if (!k) return { message: 'topicWeights keys must be non-empty strings' };
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      return { message: `topicWeights["${k}"] must be a non-negative finite number` };
    }
    result[k] = Math.min(v, 10); // cap multiplier to prevent runaway score skewing
  }
  return { weights: result };
}
