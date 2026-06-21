import type { InteractionEvent } from './types';
import { ACTIONS, TOPICS } from './types';

const VALID_ACTIONS = new Set<string>(ACTIONS);
const VALID_TOPICS  = new Set<string>(TOPICS);

// Field length caps prevent KV key overflow (512-byte limit) and unbounded SQLite growth.
// quality-ok: magic-number — value is the definition of this named constant
export const MAX_ID_LENGTH = 256;
const MAX_SOURCE_LENGTH = 128;
const MAX_TOPICS       = 10;

/**
 * Type guard — returns `true` when `e` is a structurally valid `InteractionEvent`.
 *
 * Use this to filter untrusted arrays before passing them to `mfLearnOne` or
 * sending them to `POST /interactions`.
 *
 * Validates: non-empty `userId`/`articleId`/`sourceId` within length limits,
 * 1–10 taxonomy topics, a recognised `action`, and a positive finite `ts`.
 * Off-taxonomy topics are rejected — fabricated topics would otherwise pollute
 * the diversity-bucketed cold-start candidate pool.
 */
export function isValidEvent(e: unknown): e is InteractionEvent {
  if (typeof e !== 'object' || e === null) return false;
  const ev = e as Record<string, unknown>;
  return (
    typeof ev.userId    === 'string' && ev.userId.length    > 0 && ev.userId.length    <= MAX_ID_LENGTH &&
    typeof ev.articleId === 'string' && ev.articleId.length > 0 && ev.articleId.length <= MAX_ID_LENGTH &&
    typeof ev.sourceId  === 'string' && ev.sourceId.length  > 0 && ev.sourceId.length  <= MAX_SOURCE_LENGTH &&
    Array.isArray(ev.topics) && ev.topics.length > 0 && ev.topics.length <= MAX_TOPICS &&
    (ev.topics as unknown[]).every(t => typeof t === 'string' && VALID_TOPICS.has(t)) &&
    typeof ev.action === 'string' && VALID_ACTIONS.has(ev.action) &&
    typeof ev.ts === 'number' && Number.isFinite(ev.ts) && ev.ts > 0
  );
}
