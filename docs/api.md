# Ricochet API Reference

Full reference for both surfaces: the **Cloudflare Worker HTTP API** and the
**`@victusfate/ricochet` npm library**.

> **Auto-generated type docs** (HTML): run `npm run docs:api` locally — output goes to
> `docs/api/` (gitignored). The HTML version is hyperlinked and includes source
> positions.

---

## Table of contents

1. [Worker HTTP API](#worker-http-api)
   - [CORS](#cors)
   - [Rate limiting](#rate-limiting)
   - [GET /health](#get-health)
   - [POST /interactions](#post-interactions)
   - [GET /recommendations/:userId](#get-recommendationsuserid)
   - [POST /recommendations/:userId](#post-recommendationsuserid)
   - [Error responses](#error-responses)
2. [npm Library](#npm-library)
   - [Functions](#functions)
   - [Constants](#constants)
   - [Types](#types)
3. [Bindings reference](#bindings-reference)
4. [Cron / lifecycle](#cron--lifecycle)

---

## Worker HTTP API

Base URL: your Worker deployment, e.g. `https://rec-worker.example.com`

### CORS

Allowed origins by default: `http://localhost:5173`, `http://localhost:4173`,
and their `127.0.0.1` equivalents.

Production origins must be added to the `EXTRA_CORS_ORIGINS` environment
variable (comma-separated `https://` URLs):

```
EXTRA_CORS_ORIGINS=https://your-project.pages.dev,https://custom.example.com
```

All `OPTIONS` preflight requests receive `204 No Content` regardless of origin.

---

### Rate limiting

Rate limits are enforced per IP address (`CF-Connecting-IP`) per Worker isolate.
They are **best-effort** — Cloudflare may run many isolates across colos, so the
effective ceiling is `limit × isolate count`. Traffic without `CF-Connecting-IP`
(non-Cloudflare) is not rate-limited.

| Endpoint | Limit |
|---|---|
| `POST /interactions` | 60 req / 60 s |
| `GET /recommendations/:userId` | 30 req / 60 s |
| `POST /recommendations/:userId` | 30 req / 60 s |

Exceeded limits return `429 Too Many Requests` with a `Retry-After` header.

---

### GET /health

Returns a liveness check. No authentication required.

**Response `200`**
```json
{ "ok": true, "service": "ricochet-rec" }
```

---

### POST /interactions

Ingests one or more interaction events and triggers an online SGD update.

**Request body** — either shape is accepted:

```ts
// Canonical wrapper form (recommended)
{ events: InteractionEvent[] }

// Bare array (also accepted)
InteractionEvent[]
```

**Constraints**
- Batch size: max **200** events per request.
- Body size: max **50 KB**.
- `userId` / `articleId`: max 256 chars; `sourceId`: max 128 chars.
- `topics`: 1–10 non-empty strings.
- `action`: one of `read`, `upvote`, `downvote`, `save`, `seen`.
- `ts`: positive finite epoch-ms integer. The server overwrites this with its
  own clock to prevent prune-window spoofing; include any positive value.
- **Deduplication**: the same `(userId, articleId, action)` triple is stored
  once. Retrying the same event is safe — it will refresh the row timestamp
  but not retrain the model.
- Events that fail validation are silently dropped; valid events in the same
  batch are still processed.

**Response `200`**
```json
{ "ok": true, "queued": 3 }
```

`queued` is the count of events that passed validation. If all events are
invalid: `{ "ok": true, "queued": 0 }`.

**Response `400`** — malformed body or unknown fields  
**Response `413`** — body exceeds 50 KB  
**Response `429`** — rate limit exceeded

---

### GET /recommendations/:userId

Returns a ranked list of article IDs for `userId` from a global candidate pool.

**Path parameter**
- `userId` — URL-encoded anonymous stable identifier (e.g. SHA-256 of a device ID).

**Query parameters**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `limit` | integer | `50` | Max articles to return. Capped at `200`. |
| `candidates` | CSV string | — | Comma-separated article IDs to rank (feed-pool mode). Max 100. |

**Caching** — responses are KV-cached for 300 s. `If-None-Match` / `ETag` is
supported for GET requests; a matching tag returns `304 Not Modified`.

**Cache key**
- Global mode: `recs:<userId>:limit:<limit>`
- Feed-pool mode: `recs:<userId>:pool:<sha256(sorted candidates)[:12]>:limit:<limit>`

**Response `200`** — see [RecResponse](#recresponse)

---

### POST /recommendations/:userId

Ranks a caller-supplied feed pool and/or applies topic-weight boosts.

**Path parameter** — same as GET.

**Request body**
```ts
interface RecRankRequest {
  candidateArticleIds?: string[];         // feed-pool to rank (max 100)
  topicWeights?: Record<string, number>;  // boost multipliers per topic (max 20 entries, values 0–10)
  limit?: number;                         // default 50, max 200
}
```

**Notes**
- `topicWeights` bypasses the KV cache (results are preference-specific).
- If `candidateArticleIds` is omitted the global candidate pool is used.
- `limit` is clamped to `candidateArticleIds.length` in feed-pool mode.
- `ETag` / `304` is not returned for POST responses.

**Response `200`** — see [RecResponse](#recresponse)

---

### Error responses

All error responses share a common shape:

```json
{ "ok": false, "message": "Human-readable description" }
```

| Status | Condition |
|---|---|
| `400` | Malformed JSON, unknown body shape, invalid field values |
| `404` | Unrecognised path |
| `413` | Body exceeds 50 KB |
| `429` | Rate limit exceeded (includes `Retry-After` header) |

---

## npm Library

Install:
```sh
npm install @victusfate/ricochet
```

Import:
```ts
import {
  mfPredict, mfLearnOne, newFactorRow, zeroFactorRow,
  ACTION_RATING, DEFAULT_MF_PARAMS,
  isValidEvent,
  type InteractionEvent, type RecResponse, type RecRankRequest,
  type MfParams, type FactorRow,
} from '@victusfate/ricochet';
```

No Cloudflare dependencies — safe to use in Node, browsers, and any edge runtime.

---

### Functions

#### `mfPredict(globalMean, user, item) → number`

Computes the Biased Matrix Factorization predicted score for a (user, item) pair.

```
ŷ = globalMean + user.bias + item.bias + dot(user.v, item.v)
```

| Parameter | Type | Description |
|---|---|---|
| `globalMean` | `number` | Running mean of all observed ratings |
| `user` | `FactorRow` | Learned user factor row |
| `item` | `FactorRow` | Learned item factor row |

Returns an unbounded float. Higher = more predicted affinity.

---

#### `mfLearnOne(params, globalMean, n, user, item, rating) → { globalMean, n, user, item }`

Performs one online SGD step of Biased MF. **Inputs are not mutated.**

Latent vectors are updated simultaneously (both gradients computed from old
vectors before either is applied).

| Parameter | Type | Description |
|---|---|---|
| `params` | `MfParams` | Hyperparameters |
| `globalMean` | `number` | Current running mean |
| `n` | `number` | Ratings seen before this one |
| `user` | `FactorRow` | Current user factor row |
| `item` | `FactorRow` | Current item factor row |
| `rating` | `number` | Observed rating (see `ACTION_RATING`) |

Returns `{ globalMean, n, user, item }` — the updated state after one step.

---

#### `newFactorRow(params) → FactorRow`

Allocates a new factor row: bias = 0, latent vector sampled from
N(0, `params.sigmaInit`). Use for a freshly seen user or item.

---

#### `zeroFactorRow(params) → FactorRow`

Allocates an all-zeros factor row. Cold-start scoring with a zero user vector
reduces to `globalMean + item.bias` — pure popularity ranking.

---

#### `isValidEvent(e) → e is InteractionEvent`

Type guard that returns `true` when `e` is a structurally valid
`InteractionEvent`. Use this to filter untrusted inputs before calling
`mfLearnOne` or sending to `POST /interactions`.

---

### Constants

#### `ACTION_RATING`

Maps each interaction action to its training signal:

| Action | Rating |
|---|---|
| `save` | `2.0` |
| `upvote` | `1.0` |
| `read` | `0.5` |
| `seen` | `0.1` |
| `downvote` | `−1.0` |

---

#### `DEFAULT_MF_PARAMS`

Production-tuned `MfParams` defaults. Override individual fields:

```ts
const params = { ...DEFAULT_MF_PARAMS, nFactors: 20 };
```

| Field | Default | Description |
|---|---|---|
| `nFactors` | `10` | Latent factor dimensions |
| `lrBias` | `0.05` | Bias learning rate |
| `lrLatent` | `0.05` | Latent vector learning rate |
| `l2Bias` | `0.0` | L2 regularisation on biases |
| `l2Latent` | `0.05` | L2 regularisation on latent vectors |
| `clipError` | `10.0` | Residual error clamp before gradient step |
| `sigmaInit` | `0.1` | Std dev for random initialisation |

---

### Types

#### `InteractionEvent`

```ts
interface InteractionEvent {
  userId:    string;  // anonymous stable ID — max 256 chars
  articleId: string;  // 16-hex SHA-256(url)[:8] — max 256 chars
  sourceId:  string;  // feed slug, e.g. "ars-technica" — max 128 chars
  topics:    Topic[]; // 1–10 topic strings
  action:    Action;
  ts:        number;  // epoch ms (advisory — server uses its own clock)
}
```

---

#### `Topic`

```ts
type Topic =
  | 'technology' | 'science' | 'world' | 'business'
  | 'health' | 'environment' | 'sports' | 'entertainment' | 'general';
```

---

#### `Action`

```ts
type Action = 'read' | 'upvote' | 'downvote' | 'save' | 'seen';
```

---

#### `MfParams`

See [`DEFAULT_MF_PARAMS`](#default_mf_params) for field descriptions.

---

#### `FactorRow`

```ts
interface FactorRow {
  bias: number;
  v:    number[];  // length === MfParams.nFactors
}
```

---

#### `RecResponse`

Full response from `GET /recommendations/:userId` and `POST /recommendations/:userId`.

```ts
interface RecResponse {
  articleIds:       string[];         // ranked IDs, downvoted articles excluded
  generatedAt:      number;           // epoch ms
  scoredArticleIds: ScoredArticle[];  // same order as articleIds
  diagnostics:      RecDiagnostics;
  trace:            RecTraceInfo;
  cache:            RecCacheInfo;
  timingMs:         RecTimingMs;
}
```

---

#### `RecDiagnostics`

```ts
interface RecDiagnostics {
  model:              'biased-mf';
  modelVersion:       string;
  factorCount:        number;
  candidateMode?:     'feed-pool' | 'global';
  candidateStrategy?: 'diverse' | 'top-bias' | 'feed-pool';
  candidateCount:     number;   // size of the pool before ranking
  rankedCount:        number;   // after downvote exclusion
  returnedCount:      number;   // capped by limit
  excludedDownvotes:  number;
  coldItemCount?:     number;   // items with no learned factors
  warmItemCount?:     number;   // items with learned factors
  coldStart:          boolean;  // true when the user has no factor row yet
  limit:              number;   // effective limit used
}
```

`candidateStrategy` values:
- `'diverse'` — cold-start users (< 30 interactions): top-N per topic pool
- `'top-bias'` — warm users: top-N by global item bias
- `'feed-pool'` — caller supplied `candidateArticleIds`

---

#### `ScoredArticle`

```ts
interface ScoredArticle {
  articleId: string;
  score:     number;  // ŷ from mfPredict, optionally multiplied by topicWeights
}
```

---

#### `RecRankRequest`

```ts
interface RecRankRequest {
  candidateArticleIds?: string[];         // feed-pool to rank (max 100)
  topicWeights?: Record<string, number>;  // per-topic score multipliers (0–10, max 20 keys)
  limit?: number;                         // default 50, max 200
}
```

---

#### `RecTraceInfo`

```ts
interface RecTraceInfo {
  requestId: string;   // random UUID per request
  cfRay?:    string;   // Cloudflare Ray ID (Worker deployments only)
}
```

---

#### `RecCacheInfo`

```ts
interface RecCacheInfo {
  status:  'hit' | 'miss' | 'bypass';
  key:     string;   // KV cache key
  ttlSec:  number;   // configured TTL (300 s)
  ageSec:  number;   // seconds since the cached response was generated
}
```

---

#### `RecTimingMs`

```ts
interface RecTimingMs {
  total:        number;
  cacheLookup:  number;
  doFetch:      number;   // 0 on cache hit
  cacheWrite:   number;   // 0 on cache hit or bypass
}
```

---

## Bindings reference

These binding names must match exactly in your `wrangler.jsonc`:

| Binding | Type | Name | Required |
|---|---|---|---|
| KV namespace | `KVNamespace` | `REC_STORE` | ✅ |
| Durable Object | `DurableObjectNamespace` | `REC_DO` | ✅ |
| Environment variable | `string` | `EXTRA_CORS_ORIGINS` | ✅ (production) |

`EXTRA_CORS_ORIGINS` — comma-separated list of additional allowed CORS origins
(`https://` only). Required for any non-localhost production deployment.

---

## Cron / lifecycle

A cron trigger (`0 * * * *` — every hour) calls `POST /prune` on the Durable
Object, which deletes stale data on two independent schedules:

| Table | Retention | Rationale |
|---|---|---|
| `interactions` | 30 days | High-volume; drives model freshness |
| `item_factors` | 180 days (by `updated_at`) | Retains learned quality for seasonal / long-tail articles after their interactions age out |

The cron is configured in `wrangler.jsonc`:
```jsonc
"triggers": { "crons": ["0 * * * *"] }
```

The `updated_at > 0` guard prevents accidental deletion of rows that still
carry the schema default value.
