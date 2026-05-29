# @victusfate/ricochet — Agent Integration Guide

Complete reference for agents and automated systems consuming this package.

---

## Installation

```sh
npm install @victusfate/ricochet
```

No Cloudflare dependencies — safe to import in Node ≥22, browsers, and other edge runtimes.

---

## Package surface

```
@victusfate/ricochet          # standalone scoring library (dist/lib.js)
@victusfate/ricochet/worker   # Cloudflare Worker + Durable Object entry
```

### All named exports (library)

```ts
import {
  // Core scoring
  mfPredict,
  mfLearnOne,
  newFactorRow,
  zeroFactorRow,
  ACTION_RATING,
  DEFAULT_MF_PARAMS,

  // Validation & parsing
  isValidEvent,
  parseTopicWeights,

  // Types
  type Topic,
  type Action,
  type InteractionEvent,
  type ScoredArticle,
  type RecRankRequest,
  type RecCoreResponse,
  type RecResponse,
  type RecDiagnostics,
  type RecCacheStatus,
  type RecCacheInfo,
  type RecTimingMs,
  type RecTraceInfo,
  type MfParams,
  type FactorRow,

  // Constants
  REC_MAX_CANDIDATES,       // 100 — max candidateArticleIds per recommendation request
} from '@victusfate/ricochet';
```

Full TypeDoc reference is at [`docs/api/README.md`](api/README.md).

---

## Worker REST API

Deploy the Worker once; call it from any client. See `README.md` for `wrangler.jsonc` setup.

### POST /interactions — record a user action

```ts
const BASE = 'https://rec-worker.example.com';

async function recordInteraction(event: InteractionEvent): Promise<void> {
  await fetch(`${BASE}/interactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Accepts bare array OR { events: [...] }. Batch up to 200 events per call.
    body: JSON.stringify({ events: [event] }),
  });
  // Fire-and-forget is fine; the server is idempotent for the same
  // (userId, articleId, action) triple.
}

await recordInteraction({
  userId:    'a1b2c3d4e5f60718',   // anonymous stable hash, e.g. SHA-256(deviceId)
  articleId: 'b4e2d3c4a5f60719',   // 16-hex SHA-256(url)[:8]
  sourceId:  'ars-technica',        // feed slug
  topics:    ['technology'],        // 1–3 values from the Topic union
  action:    'upvote',
  ts:        Date.now(),            // advisory — server overwrites with its own clock
});
```

### GET /recommendations/:userId — ranked article IDs

```ts
import type { RecResponse } from '@victusfate/ricochet';

async function getRecs(userId: string, limit = 50): Promise<string[]> {
  const res = await fetch(`${BASE}/recommendations/${userId}?limit=${limit}`);
  if (!res.ok) throw new Error(`recs fetch failed: ${res.status}`);
  const body = await res.json() as RecResponse;
  return body.articleIds; // already ranked; downvoted articles excluded
}

// Intersect with locally available articles (server returns up to `limit` IDs
// from its global pool; your local pool is likely a subset)
const ranked = (await getRecs(userId)).filter(id => localPool.has(id));
```

### POST /recommendations/:userId — feed-pool ranking + topic weights

Use `POST` when you have a specific candidate pool (e.g. today's feed) or want
to boost certain topics.

```ts
import type { RecRankRequest, RecResponse } from '@victusfate/ricochet';

async function rankFeedPool(
  userId: string,
  candidateArticleIds: string[],
  topicWeights?: Record<string, number>,
): Promise<RecResponse> {
  const body: RecRankRequest = {
    candidateArticleIds, // max 100; ranked by personalised score
    topicWeights,        // optional — e.g. { technology: 2.0, sports: 0.5 }
    limit: 50,
  };
  const res = await fetch(`${BASE}/recommendations/${userId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<RecResponse>;
}

const { articleIds, diagnostics } = await rankFeedPool(
  'a1b2c3d4e5f60718',
  ['b4e2d3c4a5f60719', 'c5f3e4d5b6a70820'],
  { technology: 1.5 },
);
console.log(diagnostics.candidateStrategy); // 'diverse' | 'top-bias' | 'feed-pool'
```

### ETag / conditional GET

The `/recommendations` response includes an `ETag` header. Pass it back on
subsequent calls to receive `304 Not Modified` when rankings haven't changed:

```ts
let etag: string | null = null;

async function getRecsConditional(userId: string): Promise<string[] | null> {
  const headers: HeadersInit = etag ? { 'If-None-Match': etag } : {};
  const res = await fetch(`${BASE}/recommendations/${userId}`, { headers });
  if (res.status === 304) return null; // cached — no new data
  etag = res.headers.get('ETag');
  return (await res.json() as RecResponse).articleIds;
}
```

### GET /health

```ts
const ok = await fetch(`${BASE}/health`).then(r => r.ok);
```

---

## Standalone Library

Use the library functions to run BiasedMF inference or training outside a Worker —
for example in a Node.js backend, a browser, or another edge runtime.

### Validate events before sending

```ts
import { isValidEvent } from '@victusfate/ricochet';

const raw: unknown[] = await fetchBatch();
const valid = raw.filter(isValidEvent);
// valid is InteractionEvent[] — pass to mfLearnOne or POST /interactions
```

`isValidEvent` checks: non-empty `userId`/`articleId`/`sourceId` within length
limits, 1–10 non-empty topic strings, a recognised `action`, and a positive
finite `ts`.

### Action → rating mapping

```ts
import { ACTION_RATING } from '@victusfate/ricochet';

console.log(ACTION_RATING);
// { save: 2.0, upvote: 1.0, read: 0.5, seen: 0.1, downvote: -1.0 }

const rating = ACTION_RATING[event.action]; // number
```

### Initialise factor rows

```ts
import { DEFAULT_MF_PARAMS, newFactorRow, zeroFactorRow } from '@victusfate/ricochet';

const params = DEFAULT_MF_PARAMS;
// { nFactors: 10, lrBias: 0.05, lrLatent: 0.05, l2Bias: 0, l2Latent: 0.05,
//   clipError: 10, sigmaInit: 0.1 }

// New user or item — random initialisation from N(0, sigmaInit)
const userFactor = newFactorRow(params);

// Cold-start scoring — all zeros; mfPredict reduces to globalMean + item.bias
const coldUser = zeroFactorRow(params);
```

### Predict a score

```ts
import { mfPredict } from '@victusfate/ricochet';
import type { FactorRow } from '@victusfate/ricochet';

const globalMean = 0.3;
const user: FactorRow = { bias: 0.1, v: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0] };
const item: FactorRow = { bias: 0.2, v: [0.5, 0, 0, 0, 0, 0, 0, 0, 0, 0] };

// ŷ = globalMean + user.bias + item.bias + dot(user.v, item.v)
//   = 0.3 + 0.1 + 0.2 + (1 × 0.5) = 1.1
const score = mfPredict(globalMean, user, item);
```

### Train online — one SGD step

```ts
import { mfLearnOne, ACTION_RATING, DEFAULT_MF_PARAMS, newFactorRow } from '@victusfate/ricochet';

let globalMean = 0;
let n = 0;
let userFactor = newFactorRow(DEFAULT_MF_PARAMS);
let itemFactor = newFactorRow(DEFAULT_MF_PARAMS);

// Inputs are never mutated — mfLearnOne returns new copies.
const result = mfLearnOne(
  DEFAULT_MF_PARAMS,
  globalMean,
  n,
  userFactor,
  itemFactor,
  ACTION_RATING['upvote'], // 1.0
);

globalMean = result.globalMean;
n          = result.n;
userFactor = result.user;
itemFactor = result.item;
```

### Parse topic weights from untrusted input

```ts
import { parseTopicWeights } from '@victusfate/ricochet';

const { weights, message } = parseTopicWeights({ technology: 2.0, sports: 0.5 });
if (message) throw new Error(message);
// weights: { technology: 2.0, sports: 0.5 }
// Values are capped at 10× to prevent runaway score skewing.
```

Valid input: an object with non-empty string keys and non-negative finite numeric
values. At most 20 entries. `null` / `undefined` → returns `{}` (no error).

### Complete mini-recommender

End-to-end example: train on a batch of interactions and rank a candidate pool.

```ts
import {
  isValidEvent,
  newFactorRow,
  zeroFactorRow,
  mfLearnOne,
  mfPredict,
  ACTION_RATING,
  DEFAULT_MF_PARAMS,
} from '@victusfate/ricochet';
import type { FactorRow, MfParams } from '@victusfate/ricochet';

const params: MfParams = DEFAULT_MF_PARAMS;

// State — in production, persist these to a database between calls.
let globalMean = 0;
let n = 0;
const userFactors  = new Map<string, FactorRow>();
const itemFactors  = new Map<string, FactorRow>();

function getOrCreate(map: Map<string, FactorRow>, id: string): FactorRow {
  if (!map.has(id)) map.set(id, newFactorRow(params));
  return map.get(id)!;
}

// Train on a batch of raw events.
function train(events: unknown[]): void {
  for (const e of events) {
    if (!isValidEvent(e)) continue;
    const rating = ACTION_RATING[e.action];
    const user = getOrCreate(userFactors, e.userId);
    const item = getOrCreate(itemFactors, e.articleId);
    const result = mfLearnOne(params, globalMean, n, user, item, rating);
    globalMean = result.globalMean;
    n          = result.n;
    userFactors.set(e.userId, result.user);
    itemFactors.set(e.articleId, result.item);
  }
}

// Rank a candidate pool for a user. Returns IDs sorted by descending score.
function rank(userId: string, candidateIds: string[]): string[] {
  const user = userFactors.get(userId) ?? zeroFactorRow(params);
  return candidateIds
    .map(id => ({
      id,
      score: mfPredict(globalMean, user, itemFactors.get(id) ?? zeroFactorRow(params)),
    }))
    .sort((a, b) => b.score - a.score)
    .map(x => x.id);
}
```

---

## Custom hyperparameters

Override individual fields via spread. The defaults are production-tuned.

```ts
import { DEFAULT_MF_PARAMS } from '@victusfate/ricochet';
import type { MfParams } from '@victusfate/ricochet';

const params: MfParams = {
  ...DEFAULT_MF_PARAMS,
  nFactors: 20,    // more expressive; higher memory cost
  lrLatent: 0.03,  // lower learning rate for noisier data
};
```

| Field | Default | Effect |
|-------|---------|--------|
| `nFactors` | 10 | Latent vector dimensionality |
| `lrBias` | 0.05 | Learning rate for bias terms |
| `lrLatent` | 0.05 | Learning rate for latent vectors |
| `l2Bias` | 0.0 | L2 regularisation on biases |
| `l2Latent` | 0.05 | L2 regularisation on latent vectors |
| `clipError` | 10.0 | Residual error clip before gradient computation |
| `sigmaInit` | 0.1 | Std dev of random initial factor values |

---

## Gotchas

- **`ts` is advisory.** The Worker overwrites `ts` with its own clock to prevent
  prune-window spoofing. Sending the current `Date.now()` is correct; stale
  timestamps are fine for the library.
- **Downvote exclusion is server-side only.** The standalone library functions
  (`mfPredict`, `rank`) do not automatically exclude downvoted articles. Filter
  them yourself if needed.
- **Cold-start users** have no stored factors; the Worker uses a diverse
  topic-bucketed fallback. In the standalone library, `zeroFactorRow` gives a
  zero-personalisation baseline: `ŷ = globalMean + item.bias`.
- **Recommendation cache TTL is ~5 minutes.** After sending interactions, ranked
  results may be stale for up to 300 s. Use `diagnostics.coldStart` and
  `cache.status` in the `RecResponse` to detect this.
- **`candidateArticleIds` max is 100** (`REC_MAX_CANDIDATES`). The Worker returns
  `400` if you exceed it.
- **Idempotent interactions.** The same `(userId, articleId, action)` triple is
  stored once — safe to retry `POST /interactions` on network failure.
