# Design — Edge Recommendations (rec-worker)

Feature slug: `edge-recommendations`

---

## Q&A Summary

**Q: What is the single responsibility of rec-worker?**
A: Ingest cross-user interaction events and produce ranked article-ID lists based on aggregated
popularity and collaborative co-occurrence. Per-user personalisation (topic/source weights,
keyword weights) remains entirely in Fireproof on the client (`news-feed`).

**Q: How do article IDs arrive at rec-worker?**
A: The client sends them in `InteractionEvent.articleId` — the same 16-hex SHA-256(url)[:8] IDs
already computed by `rss-worker`. rec-worker is ID-transparent; it never fetches or parses articles.

**Q: What user identity is used?**
A: An anonymous, stable `userId` — e.g., a SHA-256 hash of Fireproof's `deviceId` — generated
and stored locally in `news-feed`. rec-worker never stores PII.

**Q: Does rec-worker duplicate the local scoring formula in `news-feed`?**
A: No. The local formula (`recency × sourceWeight × topicWeight + keywordWeights`) runs
client-side. rec-worker contributes a complementary **global popularity / collaborative** score
that the client can blend in optionally via `RecResponse.articleIds`.

**Q: What storage primitives are used?**
A: One global `RecDO` (Durable Object with SQLite storage) handles all writes and reads for
interaction ingestion, popularity aggregation, and recommendation queries. A KV namespace
`REC_STORE` is available for caching recommendation snapshots.

**Q: What is the write flow?**
A: `POST /interactions` → Worker validates → forwards batch to RecDO → RecDO upserts interactions
in SQLite and updates per-article popularity scores atomically.

**Q: What is the read flow?**
A: `GET /recommendations/:userId` → Worker → RecDO computes ranked list (popularity desc,
excluding user's downvoted articles) → returns `RecResponse`.

**Q: How are old interactions pruned?**
A: A cron trigger (hourly) calls `POST /prune` internally on the RecDO, which deletes interactions
older than 30 days and recomputes affected article scores.

**Q: What CORS/rate-limit strategy is used?**
A: Same origin allowlist as `meta-worker`. Rate limit: 60 req/min for `POST /interactions`,
30 req/min for `GET /recommendations/:userId` per client IP.

---

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Single global RecDO | Simplest consistency model; matches meta-worker pattern |
| D2 | SQLite in RecDO for interactions + scores | Durable, queryable, no external DB needed |
| D3 | KV for recommendation cache snapshots | Fast edge reads, 5-min TTL |
| D4 | No ML / embeddings in v1 | Keeps scope tight; popularity + co-occurrence is sufficient MVP |
| D5 | Anonymous userId only | No auth, no PII, privacy-preserving |
| D6 | Score = weighted sum of interaction counts / age_decay | Complementary to client recency formula |

---

## Edge-Case Scenarios

1. **User downvotes article already in cached recs** — next `GET /recommendations` fetches fresh
   from RecDO (cache TTL is short), excluded before response.
2. **Same user sends duplicate interaction** — SQLite `PRIMARY KEY (user_id, article_id, action)`
   prevents double-counting; `ts` updated only.
3. **Burst of 500 interactions in one POST** — capped at `MAX_BATCH_SIZE = 200`; excess rejected
   with 400.
4. **Article never seen by any user** — not in `article_scores`; simply absent from recs, which
   is correct.
5. **Cron runs while interactions are being written** — SQLite serialises within the DO; no race.

---

## Canonical Vocabulary

| Term | Definition |
|------|-----------|
| **rec-worker** | This Cloudflare Worker (project name: `ricochet`) |
| **RecDO** | Global Durable Object class; single instance (`name: 'global'`) |
| **InteractionEvent** | Single user–article interaction signal sent to `POST /interactions` |
| **RecResponse** | Response from `GET /recommendations/:userId` — ordered article IDs |
| **popularity score** | Weighted sum: `upvotes×3 + reads×1 + saves×2 + seens×0.1 − downvotes×2` |
| **userId** | Anonymous stable client identifier (SHA-256 of Fireproof deviceId) |
| **articleId** | 16 hex chars — SHA-256(url)[:8], same scheme as boomerang `rss-worker` |
| **Topic** | One of 9 string literals; see `src/types.ts` |
| **action** | One of `read \| upvote \| downvote \| save \| seen` |
| **age_decay** | Future v2 feature — placeholder in scoring formula |
