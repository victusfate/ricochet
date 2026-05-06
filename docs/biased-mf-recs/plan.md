# Implementation Plan — Biased Matrix Factorisation Recommendations

Feature slug: `biased-mf-recs`

Approach: vertical slices, each independently testable. RED → GREEN → REFACTOR per slice.

---

## Slice 1 — Rating map and pure SGD math (`src/scoring.ts`)

**What changes**: extend `scoring.ts` with the BiasedMF update logic as pure functions —
no SQLite, no DO, no CF deps. Fully unit-testable with plain Vitest.

**Adds**:
- `ACTION_RATING: Record<Action, number>` — `{save:2, upvote:1, read:0.5, seen:0.1, downvote:-1}`
- `DEFAULT_MF_PARAMS` — hyperparameter defaults object
- `mfPredict(globalMean, userBias, itemBias, userVec, itemVec): number`
- `mfLearnOne(params, globalMean, uRow, iRow, rating): { globalMean, uRow, iRow }` —
  returns updated copies, no mutation

**Tests** (`src/scoring.test.ts`):
- `mfPredict` matches hand-computed dot product
- `mfLearnOne` reduces error on a known (user, item, rating) triple
- Repeated `mfLearnOne` on same pair converges prediction toward rating
- `save` rating (2.0) produces larger gradient step than `upvote` (1.0)
- `downvote` (-1.0) moves prediction below global mean

---

## Slice 2 — SQLite schema migration (`src/RecDO.ts`)

**What changes**: add three new tables to `RecDO` constructor alongside the existing
`interactions` table. Existing tables are NOT removed yet (parallel running until S5).

**Adds**:
```sql
global_state  (mean REAL, n INTEGER)
user_factors  (user_id PK, bias, v0-v9, updated_at)
item_factors  (article_id PK, bias, v0-v9, source_id, topic, updated_at)
```

**Tests** (`src/RecDO.test.ts` — new describe block `S2-mf-schema`):
- Tables exist after DO construction
- `user_factors` and `item_factors` rows can be inserted and retrieved
- `global_state` initialises with `mean=0, n=0`

---

## Slice 3 — `learnOne` method (`src/RecDO.ts`)

**What changes**: add `RecDO.learnOne(event: InteractionEvent): void` which:
1. Maps `event.action` → rating via `ACTION_RATING`
2. Reads `global_state`, `user_factors`, `item_factors` (upsert-on-miss with zeros + Normal init)
3. Calls `mfLearnOne` from `scoring.ts`
4. Writes back all three rows in a single SQLite transaction
5. Upserts `interactions` for dedup (existing logic)

**Tests** (`src/RecDO.test.ts` — `S3-learn-one`):
- After one `save` event, `item_factors.bias` is positive
- After one `downvote`, `item_factors.bias` moves negative
- Duplicate event (same user/article/action) does not double-update factors
  (dedup via `interactions` PRIMARY KEY — second call is a no-op)
- Global mean updates toward the rating after each call
- User and item latent vectors are non-zero after first interaction

---

## Slice 4 — `score` and `getRecommendations` (`src/RecDO.ts`)

**What changes**: replace `getRecommendations` with BiasedMF scoring.

- `getTopCandidates(limit: number): string[]` — top articles by `item_factors.bias DESC`
  (used for cold-start and KV candidate pool refresh)
- `score(userId: string, candidateIds: string[]): string[]` — reads user vector,
  scores each candidate with `mfPredict`, excludes downvoted articles, returns ranked IDs

Cold-start path: if no `user_factors` row exists for `userId`, score = `ȳ + bi_i` (bias-only).

**Tests** (`src/RecDO.test.ts` — `S4-scoring`):
- After several `save` events on article A and `read` events on article B,
  article A ranks higher for that user
- Cold-start user (no history) receives articles ordered by item bias
- Downvoted article is excluded even if it has a high item bias
- `limit` param respected
- Two users with different histories receive different orderings

---

## Slice 5 — KV cache layer (`src/index.ts`)

**What changes**: wire the two-layer cache into `GET /recommendations/:userId`.

Read path:
1. KV `get recs:{userId}` → hit: return
2. KV `get candidates:global` → hit: use pool / miss: call `RecDO.getTopCandidates`
   and write `candidates:global` with 10-min TTL
3. Call `RecDO.score(userId, pool)`
4. Write `recs:{userId}` with 5-min TTL
5. Return

**Also**: route `POST /interactions` through `RecDO.learnOne` instead of the old
`ingestEvents` method. Remove `article_scores` table dependency.

**Tests** (`src/worker.test.ts` — `S5-kv-cache`):
- First rec request hits DO (cache miss), second request returns same result without
  hitting DO again (verified via KV mock spy)
- After TTL expires, next request recomputes
- `POST /interactions` still returns `{ ok: true, queued: N }` (contract unchanged)
- `GET /recommendations` still returns `RecResponse` shape (contract unchanged)

---

## Slice 6 — Cleanup and migration (`src/RecDO.ts`, `src/scoring.ts`)

**What changes**: remove the old `article_scores` table, `ingestEvents`, old scoring
constants (`ACTION_SCORE`), and the old `getRecommendations` implementation now that
BiasedMF is the live path.

Update `AGENTS.md` table and `docs/edge-recommendations/` to reflect the new module layout.

**Tests**: full suite passes. No regressions in S1–S5 tests.

---

## Slice ordering rationale

| Slice | Depends on |
|-------|-----------|
| S1 — pure math | nothing |
| S2 — schema | nothing (additive) |
| S3 — learnOne | S1 + S2 |
| S4 — scoring | S3 |
| S5 — KV cache | S4 |
| S6 — cleanup | S5 green |

S1 and S2 can be done in parallel. S6 is last — never delete old code while new code
is still RED.
