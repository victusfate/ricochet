# Ricochet — Static Analysis & Code Review

**Date:** 2026-05-29
**Scope:** `src/**` (Worker edge layer, `RecDO` Durable Object, scoring library, parsing/validation), configs, and docs.
**Baseline health:** `npm run typecheck` ✅ clean · `npm test` ✅ 80/80 passing · `tsconfig` is `strict: true`.

The codebase is in good shape — strict TypeScript, parameterised SQL throughout, sensible
input validation, and strong test coverage. Findings below are ordered by severity. Each
item is actionable and references `file:line`.

---

## 🔴 High — Correctness / Contract

### H1. `POST /interactions` body contract contradicts the README
- **Where:** `src/index.ts:213-225` vs `README.md` ("Body / Params: `InteractionEvent[]`" and the *Caller pattern* example).
- **What:** The Worker requires a wrapper object — `{ "events": [ ... ] }` — and rejects anything else with `400 "body.events must be an array"` (`index.ts:220`). The tests confirm this shape (`src/worker.test.ts:74`). But the README's API table says the body is `InteractionEvent[]` (max 200), and the *Caller pattern* sample sends a **bare array**:
  ```ts
  body: JSON.stringify([{ userId, articleId, ... }])   // README — would 400
  ```
- **Impact:** Any integrator following the README verbatim gets a silent `400` and zero ingested events. This is the single most user-facing defect.
- **Fix (pick one):**
  - **Docs route (smallest diff):** update the README table and example to `{ events: InteractionEvent[] }`.
  - **Code route (more forgiving):** accept both shapes — `const events = Array.isArray(body) ? body : body?.events`.

### H2. `limit` max documented as 500, enforced at 200
- **Where:** `README.md` (`RecRankRequest`: `limit?: number; // default 50, max 500`) vs `src/parsing.ts:5` (`MAX_LIMIT = 200`), further clamped to `GLOBAL_CANDIDATE_LIMIT = 200` (`RecDO.ts:16,158`).
- **What:** A caller requesting `limit: 500` silently receives at most 200 results.
- **Impact:** Misleading contract; clients may assume truncation is a data problem.
- **Fix:** Align the README to `max 200`, or raise `MAX_LIMIT`/`GLOBAL_CANDIDATE_LIMIT` if 500 is actually intended.

---

## 🟠 Medium — Robustness / Security

### M1. `Content-Length`-only body-size guard is bypassable
- **Where:** `src/index.ts:208-211, 266-269` (`MAX_BODY_BYTES = 50_000`).
- **What:** Oversized-body protection reads `request.headers.get('Content-Length')`. A client using chunked transfer encoding (or simply omitting the header) skips the check, and `request.json()` then buffers an arbitrarily large payload before `MAX_BATCH_SIZE`/validation apply.
- **Impact:** Memory-pressure DoS vector on the Worker isolate.
- **Fix:** Enforce the cap on the actually-read bytes — e.g. read via `request.body` with a byte counter, or after `await request.text()` check `.length` before `JSON.parse`.

### M2. Rate limiting is per-isolate and best-effort only
- **Where:** `src/index.ts:14, 87-116` (`rateBuckets` is a module-scope `Map`).
- **What:** Cloudflare spins up many isolates across many colos; the in-memory counter is not shared. Effective limits are `max × (isolate count)`, and counters reset whenever an isolate is recycled. Additionally, when `CF-Connecting-IP` is absent (`getClientIp` returns `null`, `index.ts:84`), rate limiting is skipped entirely.
- **Impact:** The documented "60/min" and "30/min" caps are soft; a distributed client can substantially exceed them.
- **Fix:** Either document the limiter as best-effort per-isolate, or back it with a Durable Object / KV / Cloudflare Rate Limiting binding for a hard global cap.

### M3. CORS allows **any** `*.pages.dev` subdomain
- **Where:** `src/index.ts:35` (`u.hostname.endsWith('.pages.dev')`).
- **What:** Every Cloudflare Pages site (including `attacker.pages.dev`) is treated as an allowed origin.
- **Impact:** Lower risk because the API is cookie-less/credential-less (no `Access-Control-Allow-Credentials`), so cross-origin reads expose only non-sensitive recommendation data. Still, it widens the surface for nuisance/abuse traffic from arbitrary origins.
- **Fix:** Prefer explicit allow-listing via `EXTRA_CORS_ORIGINS` (already supported, `index.ts:23-27`) and drop the broad `.pages.dev` wildcard, or scope it to a known account subdomain prefix.

### M4. Two conflicting definitions of "cold start"
- **Where:** Candidate selection uses **interaction count < 30** (`RecDO.ts:166-170`, `COLD_START_THRESHOLD`); the `diagnostics.coldStart` flag uses **absence of a user-factor row** (`RecDO.ts:425`, `coldStart = !uDbRow`).
- **What:** A user can have a factor row (so `coldStart: false` in diagnostics) while still receiving the diversity-bucketed cold-start candidate pool, or vice-versa.
- **Impact:** Diagnostics misrepresent which ranking path actually ran — confusing for anyone debugging recommendation quality via the observability fields.
- **Fix:** Surface both signals distinctly (e.g. add `interactionCount` / a `candidateStrategy: 'diverse' | 'top-bias' | 'feed-pool'` field) rather than overloading one `coldStart` boolean.

---

## 🟡 Low — Consistency / Quality

### L1. `POST` can return `304 Not Modified`
- **Where:** `src/index.ts:407-412` (fresh path) checks `If-None-Match` without gating on method, whereas the cache-hit path correctly restricts 304 to GET (`index.ts:343`).
- **Impact:** A `POST /recommendations/:userId` with a matching `If-None-Match` gets a body-less `304` — semantically odd for a POST and inconsistent with the hit path.
- **Fix:** Add `request.method === 'GET' &&` to the condition at `index.ts:408`.

### L2. Dead/legacy exports in `types.ts`
- **Where:** `src/types.ts:101-121`: `RankingCacheEntry`, `REC_FEED_POOL_CACHE_TTL_MS`, `REC_GLOBAL_CACHE_TTL_MS`, and `ArticleScore` have no references anywhere in `src/` or `scripts/` (the active cache is KV-based with `CACHE_TTL_SECONDS`). They appear to be remnants of a prior DO-local ranking-cache design.
- **Impact:** Misleads readers into thinking a SQLite ranking cache / popularity-aggregate table exists. (`RecCacheStatus` and `RecTimingMs` *are* used internally — keep those.)
- **Fix:** Delete the four unused declarations, or move them behind a clearly-labelled "reserved/legacy" comment if intentionally kept.

### L3. `InteractionEvent.ts` is required but ignored server-side
- **Where:** Validation requires `ts > 0` (`src/validation.ts:20`), but `learnOne` deliberately overrides it with server `now` for both insert and dedup-refresh (`RecDO.ts:264-277`). The override is correct (prevents prune-window spoofing — good security call), but the field is otherwise inert.
- **Impact:** Minor API confusion — clients compute/send a timestamp that is never stored.
- **Fix:** Document that `ts` is advisory/ignored, or drop it from the required-field contract.

### L4. README diagnostics example omits documented fields
- **Where:** `README.md` "Observability fields" JSON sample lacks `candidateMode`, `coldItemCount`, `warmItemCount` even though they are part of `RecDiagnostics` (`types.ts:55-61`) and the populated response (`RecDO.ts:184-191`).
- **Fix:** Refresh the sample so it matches the emitted shape.

### L5. `clipGradient` clips the error, not the gradient
- **Where:** `src/scoring.ts:82` clamps `rawErr` (the residual) to `±clipGradient`; the latent/bias gradients derived from it are not separately bounded.
- **Impact:** Naming/comment mismatch (`scoring.ts:19,29` call it `clipGradient`). Behaviour is reasonable and L2 regularisation keeps factors bounded in practice — no NaN observed in tests or MovieLens eval — but the name overstates what's clipped.
- **Fix:** Rename to `clipError`, or clip the post-multiply gradient terms if true gradient clipping is intended.

### L6. `getDiverseCandidates` fill query may under-fill
- **Where:** `src/RecDO.ts:371-383` — the fill pass selects `ORDER BY bias DESC LIMIT totalLimit`, then skips already-`seen` IDs. If many of the per-topic diverse picks fall outside the global top-`totalLimit` by bias, the merged set can finish below `totalLimit`.
- **Impact:** Cold-start pools occasionally smaller than intended → fewer candidates to rank. Low severity (still returns a valid, diverse pool).
- **Fix:** Fetch `totalLimit + seen.size` (or `ORDER BY bias DESC LIMIT totalLimit OFFSET 0` with an exclusion) so the fill can always reach the target.

---

## ✅ Notable strengths (keep doing this)
- **SQL safety:** every query uses bound parameters, including the dynamically-sized `IN (...)` chunking that respects workerd's 100-variable cap (`RecDO.ts:436-448`).
- **Spoof-resistant timestamps:** server-side `now` overrides client `ts` to protect the prune window (`RecDO.ts:262-277`).
- **Trustworthy client IP:** rate limiter uses `CF-Connecting-IP` and explicitly refuses to trust `X-Forwarded-For` (`index.ts:80-85`).
- **Atomic ingest:** batch learning runs inside `transactionSync` (`RecDO.ts:108-110`).
- **Decoupled retention:** interactions (30d) vs item factors (180d) with an `updated_at > 0` guard against deleting schema-default rows (`RecDO.ts:500-510`).
- **Pure, dependency-free scoring lib** cleanly separated for npm consumption (`src/lib.ts`, `src/scoring.ts`).

---

## Suggested priority order
1. **H1** — fix the `/interactions` body mismatch (docs and/or accept both shapes).
2. **H2** — reconcile the `limit` max (200 vs 500).
3. **M1** — make the body-size cap enforce on real bytes.
4. **M3 / M2** — tighten CORS; document or harden rate limiting.
5. **M4, L1–L6** — diagnostics clarity, dead-code removal, and naming/doc polish.
