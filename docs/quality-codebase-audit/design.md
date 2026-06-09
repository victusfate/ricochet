# Design: Quality Rework — Full Codebase Audit

Audit date: 2026-06-09. Source: three parallel review passes over the entire
codebase — `[review]` correctness (max effort), `[quality]` structural quality,
`[simplify]` reuse/simplification/efficiency/altitude. Raw findings deduped:
53 reported → 31 unique below.

## Canonical Vocabulary

| Term | Definition |
|---|---|
| Worker | The edge entry point (`src/index.ts`) — CORS, rate limiting, KV caching, route dispatch |
| DO | The `RecDO` Durable Object (`src/RecDO.ts`) — SQLite storage, online learning, scoring |
| rank request | The parsed inputs of `/rec/recommendations`: `limit`, candidate pool, `topicWeights` |
| candidate pool | Client-supplied article IDs to rank (`feed-pool` mode) vs. global mode |
| chunked IN select | SQL `IN (...)` query split into ≤100-variable batches (Workers SQLite limit) |
| parse result | Discriminated union `{ ok: true, value } \| { ok: false, message }` returned by parsers |
| error response | The canonical `{ ok: false, message }` JSON body with 4xx status |
| action vocabulary | The set of valid interaction actions (`view`, `click`, …) — single canonical source |

## Findings

### Correctness `[review]`

| ID | File | Finding | Severity |
|---|---|---|---|
| F-01 | RecDO.ts:528 | `prune()` never deletes from `user_factors`; anonymous client-minted userIds grow the table without bound | high |
| F-02 | RecDO.ts:107 | `/ingest` parses body with no try/catch or array/shape validation → unhandled 500 on malformed input | medium |
| F-03 | RecDO.ts:208 | `/articles` parses body without validating `ids` is a string array → throws on absent/wrong-typed field | low |
| F-04 | RecDO.ts:116 | `decodeURIComponent` on path segment throws `URIError` on malformed percent-encoding → 500 instead of 400 | low |
| F-05 | index.ts:190 | KV cache keys built by raw interpolation; a crafted userId containing `:pool:` collides with another user's feed-pool key (cache poisoning) | medium |
| F-06 | index.ts:295,417 | `userId` path param has no length/charset validation; >512-byte KV key makes `put()` throw → unhandled 500 | medium |
| F-07 | index.ts:278 | `/interactions` ignores DO `/ingest` response status; returns `{ ok: true }` even when events were dropped | medium |
| F-08 | index.ts:488 | `/rec/articles` calls `doRes.json()` without checking `doRes.ok` → throw on non-JSON DO error, 500 without CORS headers | low |
| F-09 | validation.ts:27 | `isValidEvent` accepts any non-empty string as a topic despite the `Topic` union; fabricated topics pollute the diversity-bucketed cold-start pool | medium |
| F-10 | index.ts:441 | `/rec/articles` has no rate limiting, unlike the other two public routes | low |
| F-11 | index.ts:35 | `EXTRA_CORS_ORIGINS` documented as "https:// only" but no protocol check is enforced | low |
| F-12 | RecDO.ts:307 | `global_state.n` grows monotonically, never decays with pruning; rating mean slowly freezes (may be intended) | low |
| F-13 | version-bump.yml:88 | Version-bump commit pushed with `[skip ci]` → PR head SHA has no CI run; stalls or bypasses required checks | medium |
| F-14 | version-bump.yml, docs.yml | Both push to the PR head branch on `pull_request`; fails outright for fork PRs (read-only token) | low |
| F-15 | docs.yml:14,27 | `github.head_ref` is empty on `workflow_dispatch` → unscoped concurrency group, wrong ref checked out | low |
| F-16 | wrangler.jsonc:11 | KV namespace id is a placeholder (`…0001`); deploys bind to nothing unless overridden | low |

### Structure & reuse `[quality]` `[simplify]`

| ID | File | Finding | Severity |
|---|---|---|---|
| F-17 | index.ts:295–344 / RecDO.ts:114–153 | Entire rank-request parsing sequence (limit, candidates, topicWeights, cap check) duplicated line-for-line across Worker and DO | high |
| F-18 | index.ts:226–493 | Worker `fetch` is a ~270-line if-chain with full handler bodies inline (the recommendations branch alone is ~150 lines with mutable locals reassigned across branches) | high |
| F-19 | RecDO.ts:103–272 | DO `fetch` is a 170-line if-chain; `/recs/:userId` branch ~90 lines inline | medium |
| F-20 | RecDO.ts:209,467 | Chunked IN select duplicated, including two local `SQL_VAR_LIMIT = 100` definitions | medium |
| F-21 | RecDO.ts:222,497 | Defensive `JSON.parse(all_topics)` try/catch duplicated with divergent fallbacks | low |
| F-22 | index.ts (≈14 sites) + RecDO.ts (5 sites) | Error response hand-assembled at every site; no canonical helper | low |
| F-23 | index.ts:247,307,459 | "read bounded body → JSON.parse → 400" block repeated in three handlers | medium |
| F-24 | RecDO.ts:249–269 | Three identical `/debug/*-count` endpoints differing only by table name | low |
| F-25 | index.ts:166–183 | `computeETag` and `hashCandidateArticleIds` duplicate SHA-256→hex-prefix logic | low |
| F-26 | index.ts:337 / RecDO.ts:148 / parsing.ts | `REC_MAX_CANDIDATES` re-check is dead on the POST path (parser already enforces it) but the CSV parser doesn't enforce it at all — inconsistent caps | medium |
| F-27 | types.ts / validation.ts / scoring.ts | Action vocabulary defined in three places (`Action` union, `VALID_ACTIONS` set, `ACTION_RATING` keys); drift undetected | medium |
| F-28 | parsing.ts:19,58 | Parsers return loose `{ ids?; message? }` bags instead of discriminated unions; success/failure implicit | medium |
| F-29 | RecDO.ts:25 / scoring.ts:39 | `v0..v9` schema hard-codes 10 factors while `MfParams.nFactors` presents as configurable; nothing ties them together | medium |
| F-30 | types.ts:2 | `Topic` union is decorative — nothing in the data path enforces it (see F-09 for the correctness consequence) | medium |

### Efficiency `[simplify]`

| ID | File | Finding | Severity |
|---|---|---|---|
| F-31 | RecDO.ts:106,307 | `global_state` read+written once per event in a batch — 200 SELECT/UPDATE pairs per 200-event ingest | medium |
| F-32 | RecDO.ts:493 | `all_topics` re-`JSON.parse`d inside the per-candidate scoring loop (up to 200×/request) | low |
| F-33 | index.ts:26 | `extraOriginsFromEnv` re-splits the env string on every request; env is constant per isolate | low |
| F-34 | RecDO.ts:283 | `learnOne` dedup uses `SELECT COUNT(*)` + conditional `UPDATE` where a single `UPDATE` + rows-written check suffices (hot ingest path) | low |

### Minor / dead code

| ID | File | Finding | Severity |
|---|---|---|---|
| F-35 | types.ts:43 | `ArticlesResponse` exported but unused in source; `/rec/articles` return is untyped | low |
| F-36 | RecDO.ts:159 | Redundant `&& parsedCandidates` conjunct (implied by `candidateMode` derivation) | low |
| F-37 | RecDO.ts:201 | Hand-rolled `new Response(JSON.stringify(...))` where every sibling uses `Response.json` | low |
| F-38 | index.ts:349,381 | Empty-string sentinel for "no cache key"; invalid cached entries reported as `bypass`, conflating skip and stale | low |

## Decisions

Findings are addressed as seven cohesive fix classes, not one-by-one:

**D1 — Shared rank-request parser (F-17, F-26, F-28).**
Add `parseRankRequest` to `parsing.ts` returning a discriminated parse result
`{ ok: true, limit, candidateArticleIds?, topicWeights? } | { ok: false, message }`.
Both Worker and DO call it; the candidate cap is enforced inside the parser
(covering both CSV and POST paths), and the dead post-hoc checks are deleted.
Existing parsers (`parseCandidateArticleIds`, `parseTopicWeights`) migrate to
the same discriminated-union shape. Error message strings stay byte-identical
(boomerang client contract).

**D2 — Route handler extraction (F-18, F-19).**
Worker: extract `handleInteractions`, `handleRecommendations`, `handleArticles`;
`fetch` becomes CORS + rate limit + dispatch. DO: extract `handleRecs`,
`handleArticles`, table-driven debug counts (F-24). Mechanical,
behavior-preserving; no route or response changes.

**D3 — Shared low-level helpers (F-20–F-25, F-37).**
One `selectByIdsChunked` in the DO; one `parseTopicsJson`; `errorJson` /
`badRequest` response helpers per layer; `readBoundedJson` folding body read +
parse + 400; `sha256HexPrefix`; replace the hand-rolled `Response` with
`Response.json`.

**D4 — Canonical vocabulary & type ties (F-27, F-29, F-30, F-09, F-35).**
Derive `VALID_ACTIONS` from `ACTION_RATING` keys and the `Action` union from a
single `const` array. For topics: enforce the `Topic` taxonomy in
`isValidEvent` (rejecting unknown topics closes the cold-start pollution hole
F-09) — taxonomy additions then require a deploy, which matches how `Topic` is
already maintained. Add a compile-or-init-time assertion that
`DEFAULT_MF_PARAMS.nFactors` matches the `v0..v9` schema width. Type the
`/rec/articles` response with `ArticlesResponse`.

**D5 — Input hardening & response checks (F-01–F-08, F-10, F-11).**
Validate `userId` (length ≤ 256, same cap as `/interactions` IDs) before KV
key construction; build cache keys with a collision-proof encoding (hash or
length-prefixed segments) (F-05, F-06). Wrap DO body parsing in validation
returning 400s (F-02, F-03). Guard `decodeURIComponent` (F-04). Check DO
response status in `/interactions` and `/rec/articles` before claiming success
(F-07, F-08). Add `prune` of stale `user_factors` rows via `updated_at`
window (F-01). Apply the existing rate limiter to `/rec/articles` (F-10).
Enforce `https://` in `extraOriginsFromEnv` (F-11).

**D6 — Ingest efficiency (F-31, F-32, F-33, F-34).**
Hoist `global_state` read/write out of the per-event loop into the batch
transaction; pre-parse `all_topics` when building `itemById`; memoize parsed
extra origins per isolate; collapse `learnOne`'s dedup to a single statement.
Model output must be bit-identical for a given event sequence — covered by
existing scoring tests plus a new batch-ingest equivalence test.

**D7 — CI workflow fixes (F-13, F-14, F-15).**
Remove `[skip ci]` from the version-bump commit and instead skip re-entry via
the existing `chore(release):` last-commit guard (no loop: the bump commit
itself produces no further bump). Add `if: github.event.pull_request.head.repo.full_name == github.repository`
guards so fork PRs skip the push steps instead of failing. Scope docs.yml
concurrency/ref correctly for `workflow_dispatch`.

**Deferred (no action this pass).**
F-12 (global mean decay) — behavior may be intended; revisit with product
input. F-16 (placeholder KV id) — deploy-time configuration, documented in
README; not a code defect. F-38 — fold the `stale` cache status distinction
into D2's handler extraction only if free; otherwise defer.

## Scope

**In:** all decisions D1–D7; `src/*.ts`, `src/*.test.ts`,
`.github/workflows/version-bump.yml`, `.github/workflows/docs.yml`.

**Out:** new features or routes; auth design (userIds remain anonymous);
changing the public API contract (paths, response shapes, error message
strings); rate-limit policy tuning beyond extending the existing limiter to
`/rec/articles`; topic taxonomy contents; model/scoring algorithm changes.

## Edge Cases

- **Cache-key format change (D5)** invalidates existing KV entries once.
  Acceptable: entries are TTL'd; no migration needed.
- **Error message strings are a client contract** — boomerang matches on them
  for the article-search backfill. D1 must keep them byte-identical.
- **`user_factors` pruning (D5)** must use an `updated_at` retention window so
  active users' factors are never deleted; pruning a returning user only costs
  a cold start, never a crash.
- **Batch `global_state` hoisting (D6)** changes the order of mean updates
  within a batch. The equivalence test must assert final state matches the
  sequential implementation, or the loop must thread the running mean so
  per-event math is unchanged.
- **Topic enforcement (D4/F-09)** rejects events boomerang may already send
  with off-taxonomy topics — verify boomerang's emitted topic set against the
  `Topic` union before enabling rejection (otherwise log-and-accept first).
- **Version-bump CI re-trigger (D7)** — removing `[skip ci]` makes the bump
  commit trigger CI (desired, it becomes the tested head SHA) and re-trigger
  the version-bump workflow itself; the `chore(release):` guard must remain
  the loop breaker.
