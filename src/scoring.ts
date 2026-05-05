import type { Action } from './types';

export const ACTION_SCORE: Record<Action, number> = {
  read:     1,
  upvote:   3,
  save:     2,
  seen:     0.1,
  downvote: -2,
};

// Maps action → the count column name in the article_scores table
export const ACTION_COLUMN: Record<Action, string> = {
  read:     'reads',
  upvote:   'upvotes',
  downvote: 'downvotes',
  save:     'saves',
  seen:     'seens',
};

export function scoreDelta(action: Action): number {
  return ACTION_SCORE[action] ?? 0;
}
