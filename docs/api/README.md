**@victusfate/ricochet v1.7.1**

***

# ricochet

[![API docs](https://img.shields.io/badge/API%20docs-Markdown-blue)](docs/api/README.md)

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
| `POST` | `/interactions` | `{ events: InteractionEvent[] }` or bare `InteractionEvent[]` (max 200 per batch) | `200` or `400` |
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
  ts:        number;   // epoch ms (advisory — server uses its own clock to prevent prune-window spoofing)
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
    candidateStrategy?: 'diverse' | 'top-bias' | 'feed-pool';
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
  candidateArticleIds?: string[]; // when present, rank only this caller feed-pool (max 100)
  topicWeights?: Record<string, number>; // optional per-topic score multipliers
  limit?: number;                  // default 50, max 200
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
    "candidateMode": "global",
    "candidateStrategy": "top-bias",
    "candidateCount": 200,
    "rankedCount": 187,
    "returnedCount": 50,
    "excludedDownvotes": 13,
    "coldItemCount": 2,
    "warmItemCount": 185,
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
  body: JSON.stringify({ events: [{
    userId, articleId, sourceId, topics, action: 'upvote', ts: Date.now(),
  }] }),
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

Production domains are expected to be configured through `EXTRA_CORS_ORIGINS` by the integrating app/deployment (for example Boomerang `platform-worker`). Ricochet keeps only localhost defaults in code for dev ergonomics.

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

## Migration notes

### Upgrading to 1.5.x

Three breaking changes require action depending on how you use ricochet.

#### 1. CORS — `*.pages.dev` no longer auto-allowed (Worker deployments)

The broad `*.pages.dev` wildcard was removed from the CORS allow-list. Any
Cloudflare Pages origin that previously worked without configuration will now
receive a `CORS error`.

**Action:** add your Pages domain to `EXTRA_CORS_ORIGINS` in your `wrangler.jsonc`
(or environment secret):

```jsonc
// wrangler.jsonc
{
  "vars": {
    "EXTRA_CORS_ORIGINS": "https://your-project.pages.dev"
  }
}
```

Multiple origins are comma-separated:
`"https://your-project.pages.dev,https://custom.example.com"`

#### 2. `MfParams.clipGradient` renamed to `clipError` (npm library)

If you pass a custom `MfParams` object you must rename the field:

```ts
// before
const params: MfParams = { ...DEFAULT_MF_PARAMS, clipGradient: 5.0 };

// after
const params: MfParams = { ...DEFAULT_MF_PARAMS, clipError: 5.0 };
```

`DEFAULT_MF_PARAMS` is updated automatically — no change needed if you use it
as-is.

#### 3. Removed exports: `RankingCacheEntry`, `REC_FEED_POOL_CACHE_TTL_MS`, `REC_GLOBAL_CACHE_TTL_MS`, `ArticleScore` (npm library)

These types and constants were exported since v1.3 but were unused internally
and not part of the core API. They have been removed.

**Action:** if you imported any of them, either inline the definitions in your
own codebase or open an issue if you have a concrete use-case for them.

```ts
// before (no longer exported)
import { RankingCacheEntry, REC_FEED_POOL_CACHE_TTL_MS, ArticleScore } from '@victusfate/ricochet';

// after — define locally if needed, e.g.
const FEED_POOL_TTL_MS = 5 * 60 * 1000;
```

---

### Non-breaking changes in 1.5.x (no action required)

| Change | Details |
|---|---|
| `POST /interactions` bare-array body | Both `{ events: [...] }` and a bare `InteractionEvent[]` are now accepted |
| `limit` max corrected | Always enforced at 200; docs previously claimed 500 |
| `diagnostics.candidateStrategy` | New field: `'diverse' \| 'top-bias' \| 'feed-pool'` indicating which candidate pool strategy ran |
| `diagnostics.coldStart` | Meaning unchanged: `true` when the user has no factor row yet |
| `POST /recommendations` no longer returns `304` | Was a spec violation; POSTs now always return a full body |

---

## Docs

Design, PRD, implementation plan, and TDD log live in `docs/biased-mf-recs/`.

## API docs

Auto-generated TypeDoc reference lives in [`docs/api/`](_media/README.md), committed directly to the repo.

Regenerate locally with `npm run docs:api` (output → `docs/api/`). On every push to `main` that touches `src/` or `typedoc.json`, `.github/workflows/docs.yml` regenerates the Markdown and commits it back automatically.
