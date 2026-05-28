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

// Shared request cap for feed-pool ranking candidates.
export const REC_MAX_CANDIDATES = 100;

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

// Shared row shape for the ranking_cache SQLite table.
export type RankingCacheEntry = {
  cache_key:  string;
  payload:    string;
  expires_at: number;  // Unix ms
};

// Default TTLs for the DO-local ranking cache.
export const REC_FEED_POOL_CACHE_TTL_MS = 5 * 60 * 1000;   // 5 min — articles change per refresh
export const REC_GLOBAL_CACHE_TTL_MS    = 60 * 60 * 1000;  // 1 h  — stable discovery-mode results

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

