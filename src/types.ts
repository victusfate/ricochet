// Topic taxonomy — exactly 9 values, matching boomerang rss-worker.
// Single canonical source: the union type and runtime validation both derive from this array.
export const TOPICS = [
  'technology',
  'science',
  'world',
  'business',
  'health',
  'environment',
  'sports',
  'entertainment',
  'general',
] as const;
export type Topic = typeof TOPICS[number];

// Interaction actions — single canonical source for the union, VALID_ACTIONS, and ACTION_RATING keys.
export const ACTIONS = ['read', 'upvote', 'downvote', 'save', 'seen'] as const;
export type Action = typeof ACTIONS[number];

/**
 * A single user–article interaction event sent to POST /interactions.
 * userId is an anonymous stable identifier (e.g. SHA-256 of IndexedDB deviceId).
 * articleId is the 16-hex SHA-256(url)[:8] ID from boomerang rss-worker.
 */
export interface InteractionEvent {
  userId:    string;   // anonymous stable ID
  articleId: string;   // 16-hex article ID
  sourceId:  string;   // stable slug, e.g. "ars-technica"
  topics:    Topic[];  // 1–10 topics (see MAX_TOPICS in validation.ts)
  action:    Action;
  ts:        number;   // epoch ms (advisory — server overwrites with its own clock to prevent prune-window spoofing)
}

// Shared request cap for feed-pool ranking candidates.
export const REC_MAX_CANDIDATES = 100;

// Article metadata lookup limits
export const ARTICLES_GET_MAX  = 50;
export const ARTICLES_POST_MAX = 500;

export interface ArticleMetaRow {
  articleId: string;
  sourceId:  string;
  topics:    string[];
}

export interface ArticlesResponse {
  articles: ArticleMetaRow[];
}

/**
 * Response from GET /recommendations/:userId.
 * Backward-compatible contract:
 * - articleIds + generatedAt remain stable for existing consumers.
 * - scoredArticleIds + diagnostics provide optional observability into CF ranking.
 */
export interface ScoredArticle {
  articleId: string;
  score: number;
}

/** Request body for POST /recommendations/:userId. */
export interface RecRankRequest {
  candidateArticleIds?: string[];
  topicWeights?: Record<string, number>;
  limit?: number;
}

export interface RecDiagnostics {
  model: 'biased-mf';
  modelVersion: string;
  factorCount: number;
  candidateMode?: 'feed-pool' | 'global';
  candidateStrategy?: 'diverse' | 'top-bias' | 'feed-pool';
  candidateCount: number;
  rankedCount: number;
  returnedCount: number;
  excludedDownvotes: number;
  coldItemCount?: number;
  warmItemCount?: number;
  coldStart: boolean;
  limit: number;
}

export interface RecCoreResponse {
  articleIds:  string[];  // ordered; client filters against its live article pool
  generatedAt: number;    // epoch ms
  scoredArticleIds: ScoredArticle[]; // same ordering as articleIds (for returned set)
  diagnostics: RecDiagnostics;
}

export interface RecTraceInfo {
  requestId: string;
  cfRay?: string;
}

export type RecCacheStatus = 'hit' | 'miss' | 'bypass';

export interface RecCacheInfo {
  status: RecCacheStatus;
  key: string;
  ttlSec: number;
  ageSec: number;
}

export interface RecTimingMs {
  total: number;
  cacheLookup: number;
  doFetch: number;
  cacheWrite: number;
}

export interface RecResponse extends RecCoreResponse {
  trace: RecTraceInfo;
  cache: RecCacheInfo;
  timingMs: RecTimingMs;
}
