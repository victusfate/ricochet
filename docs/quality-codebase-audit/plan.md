# Plan: Quality Rework — Vertical Slices

Order: structure first (D1–D3) so hardening and efficiency land on clean code;
each slice ends with the full suite green.

## Slice 1 — Shared rank-request parser (D1: F-17, F-26, F-28)
- `parsing.ts`: migrate parsers to discriminated unions; add `parseRankRequest`
  enforcing the candidate cap for both CSV and POST input.
- Worker + DO call it; delete dead post-hoc cap checks.
- Tests: new parser unit tests incl. CSV-over-cap (currently unenforced —
  behavior change, RED first); existing route tests stay green (frozen error
  strings).

## Slice 2 — Handler extraction (D2: F-18, F-19, F-24, F-36)
- Worker `fetch` → dispatch to `handleInteractions` / `handleRecommendations`
  / `handleArticles`; DO `fetch` → `handleRecs` / `handleArticles` + map-driven
  debug counts; drop redundant conjunct.
- Pure refactor: existing suite is the net; no new tests.

## Slice 3 — Shared low-level helpers (D3: F-20–F-25, F-37)
- `selectByIdsChunked`, `parseTopicsJson`, per-layer `badRequest`,
  `readBoundedJson`, `sha256HexPrefix`, `Response.json` cleanup.
- Pure refactor: existing suite is the net.

## Slice 4 — Canonical vocabulary & type ties (D4: F-09, F-27, F-29, F-30, F-35)
- Single `const` action array → `Action` union, `VALID_ACTIONS`, `ACTION_RATING`
  keys; `isValidEvent` rejects off-taxonomy topics (RED first); nFactors↔schema
  assertion test; type `/rec/articles` response.

## Slice 5 — Hardening & storage growth (D5: F-01–F-08, F-10, F-11)
- userId validation (≤256), hashed cache-key segment, DO body validation
  (400s), guarded `decodeURIComponent`, DO status propagation on
  `/interactions` + `/rec/articles`, `user_factors` pruning by `updated_at`,
  rate limit on `/rec/articles`, https-only extra origins.
- All new behaviors RED→GREEN individually.

## Slice 6 — Hot-path efficiency (D6: F-31–F-34)
- Batch `global_state` hoisting (equivalence test RED first), pre-parsed
  `all_topics`, memoized extra origins, single-statement learnOne dedup.

## Slice 7 — CI workflows (D7: F-13, F-14, F-15)
- version-bump: drop `[skip ci]`, same-repo guard; docs.yml: fork guard +
  `workflow_dispatch`-safe concurrency/ref. No unit tests; verified on the PR.
