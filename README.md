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
| `GET` | `/recommendations/:userId` | — | `RecResponse` (JSON) |

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
