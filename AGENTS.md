# Ricochet — Claude Code Guidelines

## What is this repo?

`ricochet` is a Cloudflare Worker (`rec-worker`) that provides edge-side article recommendations
for `victusfate/boomerang`. It ingests anonymous interaction events from `news-feed` clients
and returns ranked article-ID lists based on aggregated popularity.

This repo inherits conventions from
[victusfate/boomerang AGENTS.md](https://github.com/victusfate/boomerang/blob/main/AGENTS.md).

---

## Repository layout

| Path | What it is |
|---|---|
| `src/index.ts` | Worker entry — routing, CORS, rate limiting, scheduled handler |
| `src/types.ts` | Shared types: `Topic`, `InteractionEvent`, `RecResponse` |
| `src/RecDO.ts` | Global Durable Object — interaction storage, popularity scoring, recommendations |
| `src/worker.test.ts` | HTTP endpoint tests (Vitest + cloudflare pool) |
| `src/RecDO.test.ts` | Durable Object unit / integration tests |
| `wrangler.jsonc` | Worker config — KV binding `REC_STORE`, DO binding `REC_DO` |
| `docs/edge-recommendations/` | Design → PRD → Plan → TDD log |

---

## Tech stack

- **Runtime**: Cloudflare Workers (ES2024, TypeScript strict)
- **Storage**: One global `RecDO` (SQLite via Durable Object storage) + KV namespace `REC_STORE`
- **Tests**: Vitest 4 + `@cloudflare/vitest-pool-workers`
- **Deploy**: `wrangler deploy` (from repo root)

---

## PR workflow — always follow this order

1. Pull latest main first
2. Create a clean branch: `git checkout -b claude/<short-descriptive-name>`
3. Do the work, then typecheck: `npm run typecheck`
4. Run tests: `npm test`
5. Push branch and create PR via GitHub MCP tools
6. After merge, pull main again

> Never commit directly to main for feature work.

---

## Quick reference

| Action | Command |
|---|---|
| Install deps | `npm install` |
| Run tests | `npm test` |
| Typecheck | `npm run typecheck` |
| Dev server | `npm run dev` → http://127.0.0.1:8790 |
| Deploy | `npm run deploy` |
| Regen types | `npm run cf-typegen` |

---

## Claude Code Workflow — Design → PRD → Plan → TDD

Same chain as boomerang. See `docs/edge-recommendations/` for the feature artifacts.

Artifacts live in `./docs/<feature-slug>/` (kebab-case, ≤30 chars):

```
./docs/<feature-slug>/
  ├── design.md      # Q&A, decisions, scenarios, canonical vocabulary
  ├── prd.md         # full PRD
  ├── plan.md        # vertical slices
  └── tdd-log.md     # per-slice TDD status and notes
```

Git commit messages follow conventional-commit style:
- `docs(<slug>): design Q&A and vocabulary`
- `test(<slug>): slice N red — <behavior>`
- `feat(<slug>): slice N green — <behavior>`
- `refactor(<slug>): slice N — <what changed>`

---

## Minimum Viable Diff

Prefer the smallest change that achieves the goal. No opportunistic refactors.
When in doubt, ask before producing a diff larger than ~30 lines for a small feature.

---

## Key behaviours to preserve

- **Interaction deduplication**: SQLite `PRIMARY KEY (user_id, article_id, action)` prevents
  double-counting the same action.
- **Downvote exclusion**: `GET /recommendations/:userId` always excludes articles the user
  has downvoted, even if they are globally popular.
- **No PII**: `userId` is an anonymous hash. No email, name, or device identifier stored.
- **Batch cap**: `POST /interactions` rejects batches > 200 events with 400.
- **CORS**: Allowlist same as meta-worker; `EXTRA_CORS_ORIGINS` env for custom domains.

---

## What rec-worker does NOT own

- Article fetching / RSS parsing — `rss-worker` in boomerang
- User prefs persistence — Fireproof in `news-feed`
- Cross-device sync — `sync-worker` in boomerang
- AI tags — `meta-worker` in boomerang
- Local re-ranking — `news-feed/src/services/algorithm.ts`
