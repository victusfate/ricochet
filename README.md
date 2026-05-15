# ricochet

Biased Matrix Factorization recommendation engine, packaged as a Cloudflare Worker
and a standalone npm library.

## What it does

- **Ingests** anonymous interaction events (`read`, `upvote`, `downvote`, `save`, `seen`)
  from any client via `POST /interactions`
- **Learns** per-user and per-item latent factors online via BiasedMF SGD
- **Returns** personalised ranked article-ID lists via `GET /recommendations/:userId`,
  with the requesting user's downvoted articles excluded
- **Exports** pure scoring functions as an npm library for use in any JS/TS project

## Worker API

| Method | Path | Body / Params | Response |
|--------|------|---------------|----------|
| `GET` | `/health` | — | `200 OK` |
| `POST` | `/interactions` | `InteractionEvent[]` (max 200) | `200` or `400` |
| `GET` | `/recommendations/:userId` | Optional `limit`, `candidates=id1,id2,...` | `RecResponse` (JSON) |
| `POST` | `/recommendations/:userId` | `RecRankRequest` | `RecResponse` (JSON) |

### Key contracts

- **Deduplication**: same `(userId, articleId, action)` triple is stored once — safe to retry.
- **Downvote exclusion**: `articleIds` never contains articles the user has downvoted, regardless of global popularity.
- **No PII**: `userId` must be an anonymous stable hash. No email, name, or device identifier.
- **Batch cap**: `POST /interactions` rejects arrays > 200 events with `400`.
- **Cache**: recommendations are KV-cached for a short TTL; expect up to ~60 s staleness after new interactions.

## Types

```ts
type Topic = 'technology' | 'science' | 'world' | 'business' |
             'health' | 'environment' | 'sports' | 'entertainment' | 'general';

type Action = 'read' | 'upvote' | 'downvote' | 'save' | 'seen';

interface InteractionEvent {
  userId:    string;   // anonymous stable ID (e.g. SHA-256 of IndexedDB deviceId)
  articleId: string;   // 16-hex ID — SHA-256(url)[:8] from rss-worker
  sourceId:  string;   // feed slug, e.g. "ars-technica"
  topics:    Topic[];  // 1–3 topics
  action:    Action;
  ts:        number;   // epoch ms
}

interface RecResponse {
  articleIds:  string[];  // ranked by personalised score, downvoted articles excluded
  generatedAt: number;    // epoch ms
  scoredArticleIds: Array<{ articleId: string; score: number }>;
  diagnostics: {
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
  };
  trace: {
    requestId: string;
    cfRay?: string;
  };
  cache: {
    status: 'hit' | 'miss' | 'bypass';
    key: string;
    ttlSec: number;
    ageSec: number;
  };
  timingMs: {
    total: number;
    cacheLookup: number;
    doFetch: number;
    cacheWrite: number;
  };
}
```

```ts
interface RecRankRequest {
  candidateArticleIds?: string[]; // when present, rank only this caller feed-pool
  limit?: number;                  // default 50, max 500
}
```

## Observability fields

`/recommendations/:userId` always returns observability fields alongside ranked IDs.
When candidates are provided (`POST` body or `GET ?candidates=`), ranking is pool-scoped.

```json
{
  "articleIds": ["a3f1c2d4b5e60718", "b4e2d3c4a5f60719"],
  "generatedAt": 1778855365123,
  "scoredArticleIds": [
    { "articleId": "a3f1c2d4b5e60718", "score": 1.7421 },
    { "articleId": "b4e2d3c4a5f60719", "score": 1.3396 }
  ],
  "diagnostics": {
    "model": "biased-mf",
    "modelVersion": "v1",
    "factorCount": 10,
    "candidateCount": 200,
    "rankedCount": 187,
    "returnedCount": 50,
    "excludedDownvotes": 13,
    "coldStart": false,
    "limit": 50
  },
  "trace": {
    "requestId": "2f4b1e51-1835-4561-95eb-40dc8bd4ddcd",
    "cfRay": "8c2a6d0f4b8a1234-IAD"
  },
  "cache": {
    "status": "hit",
    "key": "recs:user0000000000001",
    "ttlSec": 300,
    "ageSec": 42
  },
  "timingMs": {
    "total": 7,
    "cacheLookup": 2,
    "doFetch": 0,
    "cacheWrite": 0
  }
}
```

### Action → rating mapping

| Action | Rating |
|--------|--------|
| `save` | 2.0 |
| `upvote` | 1.0 |
| `read` | 0.5 |
| `seen` | 0.1 |
| `downvote` | −1.0 |

## Caller pattern

```ts
// 1. Fire-and-forget: send interaction when user acts
await fetch('https://rec-worker.example.com/interactions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify([{
    userId, articleId, sourceId, topics, action: 'upvote', ts: Date.now(),
  }]),
});

// 2. Fetch ranked IDs; intersect with locally available articles
const { articleIds } = await fetch(
  `https://rec-worker.example.com/recommendations/${userId}`
).then(r => r.json()) as RecResponse;

const ranked = articleIds
  .map(id => localArticleMap.get(id))
  .filter(Boolean);
```

## npm library

```ts
import {
  mfPredict, mfLearnOne, ACTION_RATING, DEFAULT_MF_PARAMS,
  newFactorRow, zeroFactorRow, isValidEvent,
  type InteractionEvent, type RecResponse, type MfParams, type FactorRow,
} from '@victusfate/ricochet';
```

Install:

```sh
# npm registry
npm install @victusfate/ricochet

# directly from GitHub
npm install github:victusfate/ricochet
```

No Cloudflare dependencies — safe to import in Node, browsers, and other edge runtimes.

## Deploying as a Worker in another repo

The Worker entry and Durable Object are also exported so you can wrap them with your own `wrangler.jsonc`:

```ts
// your-worker/src/index.ts
export { default, RecDO } from '@victusfate/ricochet/worker';
```

```jsonc
// your-worker/wrangler.jsonc
{
  "name": "your-rec-worker",
  "main": "src/index.ts",
  "compatibility_date": "2026-04-09",
  "kv_namespaces": [
    { "binding": "REC_STORE", "id": "<your-kv-namespace-id>" }
  ],
  "durable_objects": {
    "bindings": [{ "name": "REC_DO", "class_name": "RecDO" }]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["RecDO"] }
  ],
  "triggers": { "crons": ["0 * * * *"] }
}
```

**Required binding names** — these must match exactly or the worker will fail to start:

| Binding | Type | Name |
|---------|------|------|
| KV namespace | `KVNamespace` | `REC_STORE` |
| Durable Object | `DurableObjectNamespace` | `REC_DO` |
| Optional env var | `string` | `EXTRA_CORS_ORIGINS` |

The `EXTRA_CORS_ORIGINS` env var accepts a comma-separated list of additional allowed CORS origins (e.g. a custom Cloudflare Pages domain).

## Quick start

```sh
make install   # npm install
make test      # vitest suite
make build     # compile library to dist/
make eval      # download MovieLens 100K + run offline BiasedMF evaluation
make dev       # wrangler dev on :8790 (alias for npm run dev)
```

Or with npm directly:

```sh
npm install
npm test
npm run build
npm run dev
npm run deploy
```

## Automated versioning

Version bumps are automated from conventional commits on `main` via semantic-release.

- `fix:` commits trigger patch releases
- `feat:` commits trigger minor releases
- `BREAKING CHANGE:` in commit body/footer (or `!`) triggers major releases

To preview the next computed version locally:

```sh
npm run release:dry-run
```

## Offline evaluation

```sh
make data   # download MovieLens 100K into data/ml-100k/
make eval   # run evaluation — RMSE, MAE, filter verification
```

Results on MovieLens 100K (100k ratings, 943 users, 1682 items, 80/20 split):

| Predictor | RMSE | MAE |
|---|---|---|
| Global mean | 1.122 | 0.941 |
| Item mean | 1.017 | 0.811 |
| **BiasedMF** | **0.930** | **0.733** |

## Docs

Design, PRD, implementation plan, and TDD log live in `docs/biased-mf-recs/`.
