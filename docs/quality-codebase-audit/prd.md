# PRD: Quality Rework — Full Codebase Audit

## Problem Statement

A three-lens audit (correctness, structural quality, simplification) of the
ricochet codebase surfaced 38 unique findings (see
`design.md` for the full table). The service works, but it carries: an
unbounded-growth storage table reachable by anonymous clients; cache-key and
input-validation holes on public routes; the rank-request parsing logic
duplicated across the Worker and the DO; two oversized `fetch` if-chains;
redundant per-event queries on the hot ingest path; and a CI version-bump
workflow whose `[skip ci]` defeats the required status check. Each of these
raises the cost or risk of every future change.

## Solution

Fix the findings in seven cohesive classes (D1–D7 in `design.md`) with zero
public API contract change: same routes, same response shapes, byte-identical
error message strings. The result is a hardened, deduplicated codebase where
parsing has one home, handlers are named functions, storage is bounded, batch
ingest does O(1) global-state queries, and every PR head SHA gets a CI run.

## User Stories

1. As an operator, I want `user_factors` pruned on the same retention window
   as other tables, so anonymous clients cannot grow DO storage without bound. (F-01)
2. As a client developer, I want malformed bodies and malformed path encodings
   to return 400s with the canonical error shape, not 500s. (F-02, F-03, F-04)
3. As a user, I want my recommendations cache isolated from other users even
   if someone crafts a hostile userId, so results cannot be poisoned. (F-05, F-06)
4. As a client developer, I want `/interactions` and `/rec/articles` to report
   failure when the DO call fails, so events are never silently dropped. (F-07, F-08)
5. As an operator, I want only taxonomy topics accepted on ingest, so the
   cold-start pool cannot be polluted with fabricated topics. (F-09)
6. As an operator, I want `/rec/articles` rate-limited like the other public
   routes, and `EXTRA_CORS_ORIGINS` to honor its https-only contract. (F-10, F-11)
7. As a maintainer, I want rank-request parsing defined once and shared by the
   Worker and DO, with the candidate cap enforced uniformly for CSV and POST
   input. (F-17, F-26, F-28)
8. As a maintainer, I want route handlers extracted into named functions so
   each `fetch` reads as dispatch only. (F-18, F-19, F-24)
9. As a maintainer, I want the duplicated low-level patterns (chunked IN
   select, topics JSON parse, error responses, bounded JSON body read,
   SHA-256 hex prefix) collapsed into single helpers. (F-20–F-25, F-37)
10. As a maintainer, I want one canonical source for the action vocabulary and
    an assertion tying `nFactors` to the factor-column schema, so drift is a
    compile/test failure. (F-27, F-29, F-30, F-35)
11. As an operator, I want batch ingest to read/write `global_state` once per
    batch and scoring to parse `all_topics` once per row, so hot paths do no
    redundant work. (F-31, F-32, F-33, F-34)
12. As a maintainer, I want the version-bump commit to get a CI run (no
    `[skip ci]`) and fork PRs to skip rather than fail the push steps. (F-13, F-14, F-15)

## Implementation Decisions

- **Shared rank-request parser (D1):** `parseRankRequest` lives in `parsing.ts`
  and returns the discriminated parse result
  `{ ok: true, limit, candidateArticleIds?, topicWeights? } | { ok: false, message }`.
  Worker and DO both call it. The `REC_MAX_CANDIDATES` cap moves inside the
  parser (covering CSV and POST); the dead post-hoc checks are deleted.
  Existing parsers migrate to the discriminated-union shape. Error strings are
  a frozen contract — byte-identical to today.
- **Handler extraction (D2):** Worker `fetch` becomes CORS + rate limit +
  dispatch over `handleInteractions` / `handleRecommendations` /
  `handleArticles`. DO `fetch` dispatches to private `handleRecs` /
  `handleArticles` methods plus a table-driven debug-count map. Mechanical and
  behavior-preserving.
- **Shared helpers (D3):** `selectByIdsChunked` (one `SQL_VAR_LIMIT`),
  `parseTopicsJson`, per-layer `badRequest` helpers (Worker variant attaches
  CORS headers; DO variant does not), `readBoundedJson`, `sha256HexPrefix`;
  replace the one hand-rolled `new Response(JSON.stringify(...))` with
  `Response.json`.
- **Canonical vocabulary (D4):** `Action` union derived from a single `const`
  array; `VALID_ACTIONS` derived from `ACTION_RATING` keys. `isValidEvent`
  enforces the `Topic` taxonomy (reject unknown topics with the existing
  invalid-event behavior). A test asserts `DEFAULT_MF_PARAMS.nFactors`
  matches the `v0..v9` schema width. `/rec/articles` response typed as
  `ArticlesResponse`.
- **Hardening (D5):** `userId` validated (non-empty, ≤256 chars) before any
  KV or DO use; cache keys use a collision-proof encoding (hash the userId
  segment). DO `/ingest` and `/articles` validate body shape and return 400.
  `decodeURIComponent` guarded. Worker checks DO response status on
  `/interactions` and `/rec/articles` and propagates failure. `prune` deletes
  `user_factors` rows older than the retention window via `updated_at`.
  Rate limiter extended to `/rec/articles`. `extraOriginsFromEnv` filters
  non-`https://` entries.
- **Efficiency (D6):** `global_state` read once before the ingest loop,
  written once after, with the running mean threaded through `learnOne` so
  per-event math is unchanged. `all_topics` pre-parsed when building
  `itemById`. Parsed extra origins memoized per isolate. `learnOne` dedup
  collapsed to `UPDATE` + rows-written check.
- **CI (D7):** drop `[skip ci]` from the version-bump commit (the
  `chore(release):` last-commit guard remains the loop breaker); add same-repo
  guards so fork PRs skip push steps; scope `docs.yml` concurrency/ref for
  `workflow_dispatch`.

## Testing Decisions

- Prior art: `worker.test.ts` (Worker routes via `req` helper),
  `RecDO.test.ts` (DO behavior via stub), `scoring.test.ts` (pure math) —
  all run with vitest + `@cloudflare/vitest-pool-workers`. New tests follow
  the same patterns.
- **Contract-freeze tests first:** every existing test must keep passing
  untouched through D1–D3 refactors — they are the behavior-preservation net.
  Error-message strings asserted explicitly where parsing moves.
- **New behavior gets new tests:** user_factors pruning (retention window,
  active users survive), malformed-body 400s, hostile-userId cache isolation,
  oversized userId 400, DO-failure propagation, topic taxonomy rejection,
  `/rec/articles` rate limit, https-only origins, nFactors/schema assertion.
- **Batch-ingest equivalence test (D6):** final `global_state` and factor
  values after a multi-event batch must equal the sequential implementation's
  results.
- CI workflow changes (D7) are not unit-testable; verified by `actionlint`-style
  review and on the PR itself (the version-bump commit must show a CI run).

## Out of Scope

- New features, routes, or auth (userIds remain anonymous)
- Any public API contract change (paths, shapes, error strings)
- Rate-limit policy tuning beyond extending the limiter to `/rec/articles`
- Topic taxonomy contents; model/scoring algorithm changes
- Deferred findings: F-12 (global mean decay), F-16 (placeholder KV id),
  F-38 (cache-status vocabulary)

## Further Notes

- **Boomerang topic verification (F-09):** before deploying topic enforcement,
  confirm boomerang only emits taxonomy topics; if not, ship log-and-accept
  first. Flagged for the PR description.
- Cache-key format change invalidates existing KV entries once (TTL'd, no
  migration).
