# `@victusfate/ricochet` — Quick Reference

> **Full API reference:** [`docs/api.md`](./api.md)
> **Auto-generated type docs:** run `npm run docs:api` → `docs/api/index.html`

Install: `npm install @victusfate/ricochet`

---

## HTTP Worker API

| Method | Path | Body / Params | Response |
|--------|------|---------------|----------|
| `GET` | `/health` | — | `200 OK` |
| `POST` | `/interactions` | `{ events: InteractionEvent[] }` or bare `InteractionEvent[]` (max 200) | `200` or `400` |
| `GET` | `/recommendations/:userId` | Optional `limit` (max 200), `candidates=id1,id2,...` (max 100) | `RecResponse` |
| `POST` | `/recommendations/:userId` | `RecRankRequest` | `RecResponse` |

---

## Types

```ts
type Topic = 'technology' | 'science' | 'world' | 'business' |
             'health' | 'environment' | 'sports' | 'entertainment' | 'general';

type Action = 'read' | 'upvote' | 'downvote' | 'save' | 'seen';

interface InteractionEvent {
  userId:    string;   // anonymous stable ID — max 256 chars
  articleId: string;   // 16-hex SHA-256(url)[:8] — max 256 chars
  sourceId:  string;   // feed slug, e.g. "ars-technica" — max 128 chars
  topics:    Topic[];  // 1–10 topics
  action:    Action;
  ts:        number;   // epoch ms (advisory — server uses its own clock)
}

interface RecRankRequest {
  candidateArticleIds?: string[];         // feed-pool to rank (max 100)
  topicWeights?: Record<string, number>;  // per-topic score multipliers (0–10, max 20 keys)
  limit?: number;                         // default 50, max 200
}

interface RecDiagnostics {
  model:              'biased-mf';
  modelVersion:       string;
  factorCount:        number;
  candidateMode?:     'feed-pool' | 'global';
  candidateStrategy?: 'diverse' | 'top-bias' | 'feed-pool';
  candidateCount:     number;
  rankedCount:        number;
  returnedCount:      number;
  excludedDownvotes:  number;
  coldItemCount?:     number;
  warmItemCount?:     number;
  coldStart:          boolean;
  limit:              number;
}

interface RecResponse {
  articleIds:       string[];
  generatedAt:      number;
  scoredArticleIds: Array<{ articleId: string; score: number }>;
  diagnostics:      RecDiagnostics;
  trace:  { requestId: string; cfRay?: string };
  cache:  { status: 'hit' | 'miss' | 'bypass'; key: string; ttlSec: number; ageSec: number };
  timingMs: { total: number; cacheLookup: number; doFetch: number; cacheWrite: number };
}
```

---

## Action → rating mapping

| Action | Rating |
|--------|--------|
| `save` | 2.0 |
| `upvote` | 1.0 |
| `read` | 0.5 |
| `seen` | 0.1 |
| `downvote` | −1.0 |

---

## npm library exports

```ts
import {
  mfPredict, mfLearnOne, newFactorRow, zeroFactorRow,
  ACTION_RATING, DEFAULT_MF_PARAMS,
  isValidEvent,
  type InteractionEvent, type RecResponse, type RecRankRequest,
  type MfParams, type FactorRow,
} from '@victusfate/ricochet';
```

---

## Key contracts

- **Deduplication**: same `(userId, articleId, action)` triple stored once — safe to retry.
- **Downvote exclusion**: `articleIds` never includes articles the user has downvoted.
- **Cache**: KV-cached 300 s; `GET` supports `ETag` / `If-None-Match` for `304`.
- **CORS**: production origins require `EXTRA_CORS_ORIGINS` env var.
- **No PII**: `userId` must be an anonymous stable hash.
