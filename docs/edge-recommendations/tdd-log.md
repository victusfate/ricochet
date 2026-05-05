# TDD Log — Edge Recommendations (rec-worker / ricochet)

Feature slug: `edge-recommendations`

---

| Slice | Description | Status |
|-------|-------------|--------|
| S1 | Worker scaffold (health, CORS, 404) | green |
| S2 | Interaction ingestion (POST /interactions) | green |
| S3 | Recommendations (GET /recommendations/:userId) | green |
| S4 | Maintenance cron (prune old interactions) | green |
| S5 | AGENTS.md + README docs | done |

---

## Slice S1 — Worker scaffold

**RED**: Tests written for GET /health, OPTIONS preflight, unknown path 404
**GREEN**: `src/index.ts` implemented with CORS helpers, routing, rate-limit skeleton
**Notes**: Followed meta-worker pattern exactly for CORS allowlist and json() helper

---

## Slice S2 — Interaction ingestion

**RED**: Tests for POST /interactions with valid/invalid body, rate limiting, batch cap
**GREEN**: RecDO `interactions` + `article_scores` SQLite tables; Worker forwards to DO
**Notes**: SQLite UPSERT with `PRIMARY KEY (user_id, article_id, action)` prevents double-counting

---

## Slice S3 — Recommendations

**RED**: Tests for GET /recommendations/:userId returning ranked articleIds, excluding downvotes
**GREEN**: RecDO `getRecommendations()` queries article_scores DESC, filters downvoted
**Notes**: limit param capped at 200; default 50

---

## Slice S4 — Maintenance cron

**RED**: Tests for RecDO prune removing old interactions and stale article scores
**GREEN**: `prune(cutoffMs)` deletes interactions + recomputes scores; cron wires scheduled handler
**Notes**: Same pattern as MetaDO's cron prune

---

## Slice S5 — Docs

**Done**: AGENTS.md, README.md updated with project description and commands
