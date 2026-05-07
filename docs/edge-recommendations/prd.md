# PRD — Edge Recommendations (rec-worker / ricochet)

Feature slug: `edge-recommendations`

---

## Problem

`victusfate/boomerang` ranks articles entirely on the client using per-user IndexedDB weights
(recency, source, topic, keyword). There is no shared signal: a new device starts cold, popular
articles are invisible to new users, and no cross-user trends are surfaced.

---

## Solution

A lightweight Cloudflare Worker (`rec-worker`, repo: `ricochet`) that:

1. Collects anonymous interaction events from all clients (`POST /interactions`)
2. Aggregates them into per-article popularity scores in a global Durable Object
3. Returns a ranked list of article IDs (`GET /recommendations/:userId`) that the client can
   blend with its local score

The worker complements—not replaces—the existing local ranking in `news-feed`.

---

## User Stories

1. **As a first-time user**, I receive globally trending article IDs so my feed is not empty while
   my local preferences are still cold.
2. **As a returning user**, my downvoted articles are excluded from the global rec list so I never
   see them resurface via cross-user popularity.
3. **As the news-feed client**, I can send a batch of interaction events in one HTTP call so network
   overhead stays low.
4. **As a privacy-conscious user**, my identity is an anonymous hash; no email, name, or PII is
   ever stored in rec-worker.
5. **As an operator**, I can deploy the worker with `wrangler deploy` from the repo root with no
   external dependencies beyond Cloudflare KV and Durable Objects.

---

## Implementation Decisions

See `design.md` for full rationale. Summary:

- **Single global RecDO** (Durable Object) with SQLite — consistent write path, no external DB
- **KV `REC_STORE`** — cache recommendation snapshots (5-min TTL)
- **Popularity score** = `upvotes×3 + reads×1 + saves×2 + seens×0.1 − downvotes×2` (no ML)
- **Anonymous userId** — SHA-256 of IndexedDB deviceId; no PII
- **Batch cap** — max 200 events per POST; validated and rejected with 400 otherwise
- **CORS** — same allowlist as `meta-worker`; `EXTRA_CORS_ORIGINS` env for custom domains
- **Rate limits** — 60 req/min (interactions), 30 req/min (recommendations) per client IP

---

## API Surface

### `POST /interactions`

Request body (JSON):
```ts
{ events: InteractionEvent[] }   // 1–200 events
```

Response (200):
```ts
{ ok: true; queued: number }
```

Errors: 400 (invalid body / too many events), 429 (rate limited).

### `GET /recommendations/:userId`

Query params: `limit` (optional, default 50, max 200)

Response (200):
```ts
{ articleIds: string[]; generatedAt: number }
```

Errors: 429 (rate limited).

### `GET /health`

```ts
{ ok: true; service: 'ricochet-rec' }
```

---

## Testing Strategy

- **Unit / integration via `@cloudflare/vitest-pool-workers`** (same as meta-worker)
- `src/worker.test.ts` — HTTP endpoint tests (S1 scaffold, S2 interactions, S3 recommendations)
- `src/RecDO.test.ts` — Durable Object internals (S4 storage, S5 prune)
- TDD order: RED → GREEN → REFACTOR per slice; tracked in `tdd-log.md`

---

## Out of Scope

- Article fetching / RSS parsing — stays in `rss-worker`
- User prefs persistence — stays in IndexedDB (`news-feed`)
- Cross-device sync — stays in `sync-worker`
- AI tags — stays in `meta-worker`
- Local re-ranking — stays in `news-feed/src/services/algorithm.ts`
- Collaborative filtering with user-similarity / embeddings — future v2
- Authentication / paid tiers — out of scope
