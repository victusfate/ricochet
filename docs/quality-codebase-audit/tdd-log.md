# TDD Log: quality-codebase-audit

Baseline before slice 1: 89 tests green.

## Slice 1 — Shared rank-request parser (D1)
- Status: done (13 new tests; RED → GREEN)
- Notes: `parseTopicWeights` kept its `{ weights?, message? }` shape — it is
  public API via `lib.ts`; only `parseCandidateArticleIds` and the new
  `parseRankRequest` use the discriminated `ParseResult`. Deviation from the
  design's blanket migration, recorded as the frozen-contract tradeoff.

## Slice 2 — Handler extraction (D2)
- Status: done (pure refactor; existing suite as net)
- Notes: also landed F-36 (redundant conjunct) and F-37 (`Response.json`)
  since both sat inside the moved code.

## Slice 3 — Shared low-level helpers (D3)
- Status: done (pure refactor; existing suite as net)
- Notes: `readBoundedBody` was folded into `readBoundedJson` rather than kept
  alongside it — no caller needed the unparsed text.

## Slice 4 — Canonical vocabulary & type ties (D4)
- Status: done (6 new tests; RED → GREEN)
- Notes: existing tests already used taxonomy topics, so enforcement broke
  nothing in-repo. Boomerang's emitted topic set still needs verification
  before deploy (flagged in PR description).

## Slice 5 — Hardening & storage growth (D5)
- Status: done (13 new tests; RED → GREEN)
- Notes: the RED run reproduced the cache-key collision (F-05) and the DO
  crashes (F-02/03/04) exactly as the audit predicted. Cache keys now hash the
  userId segment; two pre-existing tests that pinned the old key format were
  updated (documented edge case). F-07/F-08 (DO failure propagation) have no
  dedicated tests — a DO failure cannot be forced through the public API;
  covered by review only.

## Slice 6 — Hot-path efficiency (D6)
- Status: done (2 equivalence tests written as a pre-refactor net)
- Notes: storage isolation is per test FILE in vitest-pool-workers, so the
  equivalence tests are delta-based. Final mean/count verified bit-identical
  to sequential math after hoisting.

## Slice 7 — CI workflows (D7)
- Status: done (no unit tests — verified on the PR itself)
- Notes: the version-bump commit on this PR must show a `CI / verify` run;
  that is the acceptance check for F-13.

Final suite: 123 tests green (89 baseline + 34 new), typecheck clean.
