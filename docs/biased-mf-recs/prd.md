# PRD — Biased Matrix Factorization Recommendations

Feature slug: `biased-mf-recs`

---

## Problem

The current `RecDO` produces a single global popularity ranking (weighted action counts) with
downvote exclusion as the only personalisation. Every user sees the same ordered list. A new
user on their first session gets the same result as a power user with hundreds of interactions.

There is no mechanism for the system to learn that a user prefers long-form science articles
over sports news, or that two users with similar interaction histories should receive similar
recommendations.

---

## Solution

Replace the global popularity scorer with **Biased Matrix Factorisation (BiasedMF)** — an
online collaborative filtering algorithm that learns a latent representation for every user and
every article from their interaction history.

### Model equation

```
ŷ(u, i) = ȳ + bu_u + bi_i + ⟨v_u, v_i⟩
```

| Symbol | Meaning |
|--------|---------|
| `ȳ`    | Global mean rating across all interactions |
| `bu_u` | User bias — does this user rate higher or lower than average? |
| `bi_i` | Item bias — is this article generally popular or unpopular? |
| `v_u`  | User latent vector (k-dimensional taste representation) |
| `v_i`  | Item latent vector (k-dimensional content representation) |
| `k`    | Number of latent factors (default: 10) |

### Online SGD update (per interaction event)

```
err = y - ŷ                                      (clipped to clip_gradient)

ȳ        += lr_bias * err                        (global mean)
bu_u     += lr_bias  * (err - l2_bias    * bu_u)
bi_i     += lr_bias  * (err - l2_bias    * bi_i)

for f in 0..k:
  vu_f   += lr_latent * (err * vi_f - l2_latent * vu_f)
  vi_f   += lr_latent * (err * vu_f - l2_latent * vi_f)
```

### Interaction → rating mapping

Actions are mapped to explicit pseudo-ratings before updating the model:

| Action     | Rating | Rationale |
|------------|--------|-----------|
| `save`     |  2.0   | Strongest positive — deliberate intent to return |
| `upvote`   |  1.0   | Explicit positive feedback |
| `read`     |  0.5   | Mild positive — article was completed |
| `seen`     |  0.1   | Very weak — scrolled past without reading |
| `downvote` | -1.0   | Explicit negative — repulsion signal |

The asymmetric scale (-1 to +2) is intentional. Saves should move latent vectors more than
upvotes; downvotes are a strong signal but should not permanently bury an item after one event.

---

## User Stories

1. **As a returning user**, my recommendations reflect my reading history — if I consistently
   save science articles my feed surfaces more science, not random popular content.
2. **As a new user (cold start)**, I receive the globally trending articles (ranked by item
   bias `bi_i`) so my first session is not empty.
3. **As a user who downvoted an article**, that article is excluded from my recommendations
   and the model learns negative affinity for similar content.
4. **As the `news-feed` client**, the API contract is unchanged — same `POST /interactions`
   and `GET /recommendations/:userId` endpoints, same `RecResponse` shape.
5. **As an operator**, recommendation latency stays under 50ms at p99 for up to 100K DAU
   without infrastructure changes.

---

## Architecture

### Storage (RecDO SQLite — new tables)

```sql
-- replaces article_scores
CREATE TABLE global_state (
  mean       REAL    NOT NULL DEFAULT 0,
  n          INTEGER NOT NULL DEFAULT 0  -- interaction count for running mean
);

CREATE TABLE user_factors (
  user_id    TEXT    PRIMARY KEY,
  bias       REAL    NOT NULL DEFAULT 0,
  v0  REAL NOT NULL DEFAULT 0, v1  REAL NOT NULL DEFAULT 0,
  v2  REAL NOT NULL DEFAULT 0, v3  REAL NOT NULL DEFAULT 0,
  v4  REAL NOT NULL DEFAULT 0, v5  REAL NOT NULL DEFAULT 0,
  v6  REAL NOT NULL DEFAULT 0, v7  REAL NOT NULL DEFAULT 0,
  v8  REAL NOT NULL DEFAULT 0, v9  REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE item_factors (
  article_id TEXT    PRIMARY KEY,
  bias       REAL    NOT NULL DEFAULT 0,
  v0  REAL NOT NULL DEFAULT 0, v1  REAL NOT NULL DEFAULT 0,
  v2  REAL NOT NULL DEFAULT 0, v3  REAL NOT NULL DEFAULT 0,
  v4  REAL NOT NULL DEFAULT 0, v5  REAL NOT NULL DEFAULT 0,
  v6  REAL NOT NULL DEFAULT 0, v7  REAL NOT NULL DEFAULT 0,
  v8  REAL NOT NULL DEFAULT 0, v9  REAL NOT NULL DEFAULT 0,
  source_id  TEXT    NOT NULL DEFAULT '',
  topic      TEXT    NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
```

The existing `interactions` table is retained for deduplication and prune.

### Candidate generation

Scoring all items on every request is impractical at scale. Two-stage approach:

1. **Candidate pool**: top-200 articles by `bi_i` DESC — fetched from KV cache
   (`candidates:global`, TTL 10 min) or computed from `item_factors` on miss.
2. **Personalised ranking**: score each candidate with the full BiasedMF equation,
   filter downvoted articles, return top-N.

Cold-start users (no `v_u` yet) skip the dot-product term and rank by `ȳ + bi_i` alone —
equivalent to the current global popularity behaviour.

### KV cache layer

| Key | Content | TTL | Written when |
|-----|---------|-----|--------------|
| `candidates:global` | `string[]` — top-200 article IDs by item bias | 10 min | On cache miss |
| `recs:{userId}` | `RecResponse` JSON | 5 min | On cache miss (rec request) |

KV writes only on cache miss. No active invalidation — TTL staleness (≤5 min) is acceptable
for collaborative filtering recommendations.

### Request flows

**POST /interactions** (unchanged API):
```
Worker validates batch → RecDO.learnOne(userId, articleId, rating) per event
  → read user_factors + item_factors (SQLite)
  → SGD update → write back (SQLite transaction)
  → upsert interactions (dedup)
```

**GET /recommendations/:userId**:
```
Worker → KV get recs:{userId}
  hit  → return immediately (~1ms)
  miss → KV get candidates:global
           hit  → use pool
           miss → RecDO.getTopCandidates(200) → write KV candidates:global
         → RecDO.score(userId, candidateIds)
              → read user_factors (1 row)
              → read item_factors for candidates (≤200 rows)
              → dot-product score each, filter downvoted
         → write KV recs:{userId}
         → return
```

---

## Hyperparameters (defaults)

| Parameter | Default | Notes |
|-----------|---------|-------|
| `n_factors` | 10 | Latent vector dimensionality |
| `lr_bias` | 0.05 | Learning rate for bias terms |
| `lr_latent` | 0.05 | Learning rate for latent vectors |
| `l2_bias` | 0.0 | L2 regularisation on biases |
| `l2_latent` | 0.05 | L2 regularisation on latent vectors (non-zero because rating scale reaches 2.0) |
| `clip_gradient` | 10.0 | Tighter than River default given our rating scale |
| `sigma_init` | 0.1 | Std dev for latent vector initialisation (Normal) |
| `candidate_pool_size` | 200 | Max articles scored per rec request |
| `recs_ttl_sec` | 300 | KV TTL for per-user rec cache (5 min) |
| `candidates_ttl_sec` | 600 | KV TTL for global candidate pool (10 min) |

---

## Performance targets

| Metric | Target |
|--------|--------|
| `learnOne` latency (DO internal) | < 5ms per event |
| `score` latency (200 candidates) | < 20ms |
| `GET /recommendations` p99 (cache hit) | < 5ms |
| `GET /recommendations` p99 (cache miss) | < 50ms |
| KV writes per user per day (steady state) | < 1 |
| Storage per user | ~160 bytes |
| Storage per article | ~160 bytes |

---

## Cost model (estimated)

| DAU | Worker req/mo | DO req/mo | KV reads/mo | KV writes/mo | Est. total/mo |
|-----|--------------|-----------|-------------|--------------|---------------|
| 1K  | 120K | 48K | 108K | 18K | **~$5** (base) |
| 10K | 1.2M | 480K | 1.1M | 180K | **~$5** (base) |
| 100K| 12M  | 4.8M | 10.8M | 1.8M | **~$5.60** |
| 1M  | 120M | 48M | 108M | 18M | **~$47** |

Assumptions: 10 interactions/user/day batched, 3 rec requests/user/day, 80% KV cache hit,
no active invalidation.

---

## Out of Scope

- Explicit user-similarity computation (user-user CF) — latent vectors implicitly capture this
- Content embeddings / semantic similarity — future v3
- A/B testing framework — out of scope
- Multi-armed bandit exploration beyond minimal random perturbation — future v2
- Authentication or paid tiers — out of scope
- Anything currently owned by `rss-worker`, `sync-worker`, `meta-worker`, or `news-feed`
