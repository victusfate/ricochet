# TDD Log — Biased Matrix Factorisation Recommendations

Feature slug: `biased-mf-recs`

Status legend: ⬜ not started · 🔴 RED (test written, failing) · 🟢 GREEN (passing) · ♻️ REFACTOR

---

## Slice 1 — Rating map and pure SGD math

File: `src/scoring.test.ts`

| # | Test | Status |
|---|------|--------|
| 1.1 | `ACTION_RATING` contains all 5 actions with correct values | ⬜ |
| 1.2 | `mfPredict` returns `ȳ + bu + bi + dot(vu, vi)` for known inputs | ⬜ |
| 1.3 | `mfLearnOne` reduces prediction error on a single step | ⬜ |
| 1.4 | Repeated `mfLearnOne` on same pair converges prediction toward rating | ⬜ |
| 1.5 | `save` (2.0) produces larger weight delta than `upvote` (1.0) | ⬜ |
| 1.6 | `downvote` (-1.0) moves prediction below global mean | ⬜ |
| 1.7 | `mfLearnOne` clips gradient when error exceeds `clip_gradient` | ⬜ |
| 1.8 | L2 regularisation shrinks latent weights toward zero | ⬜ |

---

## Slice 2 — SQLite schema migration

File: `src/RecDO.test.ts` (new describe block)

| # | Test | Status |
|---|------|--------|
| 2.1 | `global_state` table exists with `mean=0, n=0` after DO init | ⬜ |
| 2.2 | `user_factors` table exists and accepts a full row insert | ⬜ |
| 2.3 | `item_factors` table exists and accepts a full row insert | ⬜ |
| 2.4 | Existing `interactions` table still present (non-breaking) | ⬜ |

---

## Slice 3 — `learnOne`

File: `src/RecDO.test.ts`

| # | Test | Status |
|---|------|--------|
| 3.1 | After one `save`, `item_factors.bias` is positive | ⬜ |
| 3.2 | After one `downvote`, `item_factors.bias` moves negative | ⬜ |
| 3.3 | Global mean updates toward rating after each call | ⬜ |
| 3.4 | User and item latent vectors are non-zero after first interaction | ⬜ |
| 3.5 | Duplicate event (same user/article/action) does not double-update | ⬜ |
| 3.6 | `learnOne` for unseen user creates a new `user_factors` row | ⬜ |
| 3.7 | `learnOne` for unseen article creates a new `item_factors` row | ⬜ |

---

## Slice 4 — `score` and `getRecommendations`

File: `src/RecDO.test.ts`

| # | Test | Status |
|---|------|--------|
| 4.1 | After saves on article A and reads on article B, A ranks above B | ⬜ |
| 4.2 | Cold-start user receives articles ordered by item bias only | ⬜ |
| 4.3 | Downvoted article excluded from results even with high item bias | ⬜ |
| 4.4 | `limit` param caps the returned list length | ⬜ |
| 4.5 | Two users with different histories receive different orderings | ⬜ |
| 4.6 | `getTopCandidates(N)` returns N articles ordered by `bias DESC` | ⬜ |
| 4.7 | Empty candidate pool returns empty array without error | ⬜ |

---

## Slice 5 — KV cache layer

File: `src/worker.test.ts` (new describe block)

| # | Test | Status |
|---|------|--------|
| 5.1 | First rec request triggers DO score call (cache miss) | ⬜ |
| 5.2 | Second rec request within TTL returns same result (cache hit) | ⬜ |
| 5.3 | `POST /interactions` returns `{ ok: true, queued: N }` (unchanged) | ⬜ |
| 5.4 | `GET /recommendations` returns `RecResponse` shape (unchanged) | ⬜ |
| 5.5 | Missing `candidates:global` triggers `getTopCandidates` and writes KV | ⬜ |
| 5.6 | Rate limits still enforced (60/min interactions, 30/min recs) | ⬜ |

---

## Slice 6 — Cleanup

| # | Task | Status |
|---|------|--------|
| 6.1 | `article_scores` table removed from schema | ⬜ |
| 6.2 | `ingestEvents` method removed | ⬜ |
| 6.3 | Old `ACTION_SCORE` / `ACTION_COLUMN` constants removed from `scoring.ts` | ⬜ |
| 6.4 | Full test suite passes with no regressions | ⬜ |
| 6.5 | `AGENTS.md` module table updated | ⬜ |
| 6.6 | `docs/edge-recommendations/` updated to reference new scoring model | ⬜ |
