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

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| POST | `/interactions` | Ingest batch of `InteractionEvent[]` |
| GET | `/recommendations/:userId` | Get ranked article IDs |

## npm library

```ts
import {
  mfPredict, mfLearnOne, ACTION_RATING,
  type InteractionEvent, type RecResponse,
} from '@victusfate/ricochet';
```

Install:

```sh
# npm registry
npm install @victusfate/ricochet

# directly from GitHub
npm install github:victusfate/ricochet
```

Exports: `InteractionEvent`, `RecResponse`, `Action`, `Topic`, `isValidEvent`,
`mfPredict`, `mfLearnOne`, `ACTION_RATING`, `DEFAULT_MF_PARAMS`, `FactorRow`, `MfParams`,
`newFactorRow`, `zeroFactorRow`.

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
