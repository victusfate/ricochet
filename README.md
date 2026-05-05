# ricochet — edge-recommendations rec-worker

A Cloudflare Worker that provides edge-side article recommendations for
[victusfate/boomerang](https://github.com/victusfate/boomerang).

## What it does

- **Ingests** anonymous interaction events (`read`, `upvote`, `downvote`, `save`, `seen`) from
  `news-feed` clients via `POST /interactions`
- **Aggregates** cross-user popularity scores in a global Durable Object (SQLite)
- **Returns** ranked article-ID lists via `GET /recommendations/:userId`, with the requesting
  user's downvoted articles excluded

It complements—not replaces—the local ranking in `news-feed/src/services/algorithm.ts`.

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| POST | `/interactions` | Ingest batch of `InteractionEvent[]` |
| GET | `/recommendations/:userId` | Get ranked article IDs |

See `docs/edge-recommendations/prd.md` for full API shapes.

## Quick start

```sh
npm install
npm test          # run Vitest suite
npm run typecheck # TypeScript check
npm run dev       # wrangler dev on :8790
npm run deploy    # wrangler deploy
```

## Context

Full design, PRD, plan, and TDD log live in `docs/edge-recommendations/`.
Data types and conventions are documented in the
[boomerang context doc](https://github.com/victusfate/boomerang/blob/claude/edge-recommendations/docs/edge-recommendations/boomerang-context.md).
