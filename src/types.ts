// Topic taxonomy — exactly 9 values, matching boomerang rss-worker
export type Topic =
  | 'technology'
  | 'science'
  | 'world'
  | 'business'
  | 'health'
  | 'environment'
  | 'sports'
  | 'entertainment'
  | 'general';

// Interaction actions
export type Action = 'read' | 'upvote' | 'downvote' | 'save' | 'seen';

/**
 * A single user–article interaction event sent to POST /interactions.
 * userId is an anonymous stable identifier (e.g. SHA-256 of IndexedDB deviceId).
 * articleId is the 16-hex SHA-256(url)[:8] ID from boomerang rss-worker.
 */
export interface InteractionEvent {
  userId:    string;   // anonymous stable ID
  articleId: string;   // 16-hex article ID
  sourceId:  string;   // stable slug, e.g. "ars-technica"
  topics:    Topic[];  // 1–3 topics
  action:    Action;
  ts:        number;   // epoch ms
}

/**
 * Response from GET /recommendations/:userId.
 * articleIds are ordered by global popularity score (desc), with the requesting
 * user's downvoted articles excluded.
 */
export interface RecResponse {
  articleIds:  string[];  // ordered; client filters against its live article pool
  generatedAt: number;    // epoch ms
}

// Internal: per-article aggregated popularity stored in SQLite
export interface ArticleScore {
  articleId:  string;
  score:      number;
  reads:      number;
  upvotes:    number;
  downvotes:  number;
  saves:      number;
  seens:      number;
  updatedAt:  number;
}
