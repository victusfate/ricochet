import type { InteractionEvent } from './types';

const VALID_ACTIONS = new Set(['read', 'upvote', 'downvote', 'save', 'seen']);

export function isValidEvent(e: unknown): e is InteractionEvent {
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
