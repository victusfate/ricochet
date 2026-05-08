# `@victusfate/ricochet` — Interface Reference

Install: `npm install github:victusfate/ricochet`

## HTTP Worker API (Cloudflare edge, deployed separately)

| Method | Path | Body / Params | Response |
|--------|------|---------------|----------|
| `GET` | `/health` | — | `200 OK` |
| `POST` | `/interactions` | `InteractionEvent[]` (max 200) | `200` or `400` |
| `GET` | `/recommendations/:userId` | — | `RecResponse` (JSON) |

## Types

```ts
type Topic = 'technology' | 'science' | 'world' | 'business' |
             'health' | 'environment' | 'sports' | 'entertainment' | 'general';

type Action = 'read' | 'upvote' | 'downvote' | 'save' | 'seen';

interface InteractionEvent {
  userId:    string;   // anonymous stable ID (e.g. SHA-256 of IndexedDB deviceId)
  articleId: string;   // 16-hex ID — SHA-256(url)[:8] from rss-worker
  sourceId:  string;   // feed slug, e.g. "ars-technica"
  topics:    Topic[];  // 1–3 topics
  action:    Action;
  ts:        number;   // epoch ms
}

interface RecResponse {
  articleIds:  string[];  // ranked by personalised score, downvoted articles excluded
  generatedAt: number;    // epoch ms
}
```

## Caller pattern (news-feed)

```ts
// 1. Fire-and-forget: send interaction when user acts
await fetch('https://rec-worker.example.com/interactions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify([{
    userId, articleId, sourceId, topics, action: 'upvote', ts: Date.now(),
  }]),
});

// 2. Fetch ranked IDs; intersect with locally available articles
const { articleIds } = await fetch(
  `https://rec-worker.example.com/recommendations/${userId}`
).then(r => r.json()) as RecResponse;

const ranked = articleIds
  .map(id => localArticleMap.get(id))
  .filter(Boolean);
```

## Key contracts

- **Deduplication**: same `(userId, articleId, action)` triple is stored once — safe to retry.
- **Downvote exclusion**: `articleIds` never contains articles the user has downvoted, regardless of global popularity.
- **No PII**: `userId` must be an anonymous stable hash. No email, name, or device identifier.
- **Batch cap**: `POST /interactions` rejects arrays > 200 events with `400`.
- **Cache**: recommendations are KV-cached for a short TTL; expect up to ~60 s staleness after new interactions.

## npm library (pure scoring, no CF dependency)

```ts
import {
  mfPredict, mfLearnOne, ACTION_RATING, DEFAULT_MF_PARAMS,
  newFactorRow, zeroFactorRow,
  isValidEvent,
  type InteractionEvent, type RecResponse, type MfParams, type FactorRow,
} from '@victusfate/ricochet';
```

Use these if you want to run local re-ranking or simulate scores client-side without hitting the worker.

## Action → rating mapping

| Action | Rating |
|--------|--------|
| `save` | 2.0 |
| `upvote` | 1.0 |
| `read` | 0.5 |
| `seen` | 0.1 |
| `downvote` | −1.0 |
