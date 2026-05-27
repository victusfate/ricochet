import type { InteractionEvent } from './types';

const VALID_ACTIONS = new Set(['read', 'upvote', 'downvote', 'save', 'seen']);

// Field length caps prevent KV key overflow (512-byte limit) and unbounded SQLite growth.
const MAX_ID_LENGTH    = 256;
const MAX_SOURCE_LENGTH = 128;
const MAX_TOPICS       = 10;

export function isValidEvent(e: unknown): e is InteractionEvent {
  if (typeof e !== 'object' || e === null) return false;
  const ev = e as Record<string, unknown>;
  return (
    typeof ev.userId    === 'string' && ev.userId.length    > 0 && ev.userId.length    <= MAX_ID_LENGTH &&
    typeof ev.articleId === 'string' && ev.articleId.length > 0 && ev.articleId.length <= MAX_ID_LENGTH &&
    typeof ev.sourceId  === 'string' && ev.sourceId.length  > 0 && ev.sourceId.length  <= MAX_SOURCE_LENGTH &&
    Array.isArray(ev.topics) && ev.topics.length > 0 && ev.topics.length <= MAX_TOPICS &&
    (ev.topics as unknown[]).every(t => typeof t === 'string' && (t as string).length > 0) &&
    typeof ev.action === 'string' && VALID_ACTIONS.has(ev.action) &&
    typeof ev.ts === 'number' && Number.isFinite(ev.ts) && ev.ts > 0
  );
}
