# Implementation Plan — Edge Recommendations (rec-worker / ricochet)

Feature slug: `edge-recommendations`

Approach: tracer-bullet vertical slices — each slice cuts through all layers end-to-end.

---

## Slice 1 — Worker scaffold (health, CORS, 404)

**Covers**: project config → `src/index.ts` → `src/worker.test.ts`

- `wrangler.jsonc`, `package.json`, `tsconfig.json`, `vitest.config.mts`, `worker-configuration.d.ts`
- `src/types.ts` — `Topic`, `InteractionEvent`, `RecResponse`
- `GET /health` → `{ ok: true, service: 'ricochet-rec' }`
- `OPTIONS` → 204 with CORS headers
- Unknown path → 404
- Tests: S1 in `worker.test.ts`

---

## Slice 2 — Interaction ingestion (`POST /interactions`)

**Covers**: Worker route → RecDO `/ingest` → SQLite writes → popularity update

- `src/RecDO.ts` — SQLite tables `interactions`, `article_scores`
- Worker route: validates body, batches, forwards to RecDO
- Rate limit: 60 req/min
- Tests: S2 in `worker.test.ts` + `RecDO.test.ts`

---

## Slice 3 — Recommendations (`GET /recommendations/:userId`)

**Covers**: Worker route → RecDO `/recs/:userId` → score query → exclude downvotes → response

- RecDO: `getRecommendations(userId, limit)` — top articles by score, exclude user downvotes
- Worker route: extracts userId, limit param, forwards to RecDO, returns `RecResponse`
- Rate limit: 30 req/min
- Tests: S3 in `worker.test.ts` + `RecDO.test.ts`

---

## Slice 4 — Maintenance cron (`POST /prune` internal)

**Covers**: Scheduled handler → RecDO `/prune` → delete old interactions → recompute scores

- RecDO: `prune(cutoffMs)` — delete interactions older than cutoff, refresh article_scores
- Scheduled handler in `src/index.ts`
- Tests: S4 in `RecDO.test.ts`

---

## Slice 5 — AGENTS.md + README

- `AGENTS.md` — project conventions, build/test commands, tech stack
- `README.md` — updated with project description and quick start

---

## Slice ordering rationale

Slices 1 → 2 → 3 → 4 build on each other and are independently testable.
Slice 5 is documentation-only and can run concurrently.
