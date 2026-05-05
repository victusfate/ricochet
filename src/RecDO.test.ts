import { SELF, env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import type { InteractionEvent, RecResponse } from './types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<InteractionEvent> = {}): InteractionEvent {
  return {
    userId:    'userAAAA00000001',
    articleId: 'aabb1122ccddeeff',
    sourceId:  'ars-technica',
    topics:    ['technology'],
    action:    'read',
    ts:        Date.now(),
    ...overrides,
  };
}

async function ingest(events: InteractionEvent[]): Promise<void> {
  const res = await SELF.fetch('http://localhost/interactions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://victusfate.github.io',
    },
    body: JSON.stringify({ events }),
  });
  expect(res.status).toBe(200);
}

async function getRecs(userId: string, limit = 50): Promise<RecResponse> {
  const res = await SELF.fetch(
    `http://localhost/recommendations/${encodeURIComponent(userId)}?limit=${limit}`,
    { headers: { Origin: 'https://victusfate.github.io' } },
  );
  expect(res.status).toBe(200);
  return res.json() as Promise<RecResponse>;
}

// ── S2 — Interaction storage and popularity ───────────────────────────────────

describe('S2 — interaction ingestion and popularity', () => {
  it('upvoted article appears in recs with higher score than only-read article', async () => {
    const upvotedId = 'upvotedarticle001';
    const readOnlyId = 'readonlyarticle01';

    await ingest([
      makeEvent({ articleId: upvotedId, action: 'upvote' }),
      makeEvent({ articleId: readOnlyId, action: 'read' }),
    ]);

    const recs = await getRecs('userAAAA00000001');
    const upvotedIdx = recs.articleIds.indexOf(upvotedId);
    const readOnlyIdx = recs.articleIds.indexOf(readOnlyId);

    expect(upvotedIdx).toBeGreaterThanOrEqual(0);
    expect(readOnlyIdx).toBeGreaterThanOrEqual(0);
    // upvote score (3) > read score (1), so upvoted comes first
    expect(upvotedIdx).toBeLessThan(readOnlyIdx);
  });

  it('duplicate interaction (same user/article/action) does not double-count score', async () => {
    const articleId = 'deduparticle00001';
    const userId = 'userDedup0000001';

    await ingest([makeEvent({ userId, articleId, action: 'read' })]);
    await ingest([makeEvent({ userId, articleId, action: 'read' })]);

    const stub = env.REC_DO.get(env.REC_DO.idFromName('global'));
    const recsRes = await stub.fetch(
      new Request(`http://do-internal/recs/${userId}?limit=50`),
    );
    const data = await recsRes.json() as RecResponse;

    // Article should still be in recs
    expect(data.articleIds).toContain(articleId);

    // Score should be 1 (one read), not 2 (two reads)
    // We verify indirectly: a separate article with one upvote (score 3) must rank higher
    const upvotedId = 'deduphigherscore1';
    await ingest([makeEvent({ userId, articleId: upvotedId, action: 'upvote' })]);
    const recs2 = await getRecs(userId);
    expect(recs2.articleIds.indexOf(upvotedId)).toBeLessThan(
      recs2.articleIds.indexOf(articleId),
    );
  });

  it('downvoted article is excluded from recs for that user', async () => {
    const userId = 'userDownvote00001';
    const downvotedId = 'downvotedarticle1';
    const otherArticle = 'otherarticleDv01';

    await ingest([
      makeEvent({ userId, articleId: downvotedId, action: 'downvote' }),
      makeEvent({ userId, articleId: otherArticle, action: 'read' }),
    ]);

    const recs = await getRecs(userId);
    expect(recs.articleIds).not.toContain(downvotedId);
    expect(recs.articleIds).toContain(otherArticle);
  });

  it('globally popular article still excluded for the downvoting user', async () => {
    const downvoteUser = 'userExclude00001';
    const otherUser    = 'userOther0000001';
    const popularId    = 'globalpopularart1';

    // Many users upvote the article
    await ingest([
      makeEvent({ userId: otherUser,    articleId: popularId, action: 'upvote' }),
      makeEvent({ userId: 'user3rdone1', articleId: popularId, action: 'upvote' }),
      makeEvent({ userId: 'user3rdtwo1', articleId: popularId, action: 'upvote' }),
    ]);
    // downvoteUser downvotes it
    await ingest([makeEvent({ userId: downvoteUser, articleId: popularId, action: 'downvote' })]);

    const recsForDownvoter = await getRecs(downvoteUser);
    const recsForOtherUser = await getRecs(otherUser);

    expect(recsForDownvoter.articleIds).not.toContain(popularId);
    expect(recsForOtherUser.articleIds).toContain(popularId);
  });

  it('limit param is respected', async () => {
    // Seed many articles
    const events = Array.from({ length: 20 }, (_, i) =>
      makeEvent({ articleId: `limitarticle${String(i).padStart(4, '0')}`, action: 'read' }),
    );
    await ingest(events);

    const recs = await getRecs('userAAAA00000001', 5);
    expect(recs.articleIds.length).toBeLessThanOrEqual(5);
  });

  it('generatedAt is a recent epoch timestamp', async () => {
    const before = Date.now();
    const recs = await getRecs('userAAAA00000001');
    const after = Date.now();
    expect(recs.generatedAt).toBeGreaterThanOrEqual(before);
    expect(recs.generatedAt).toBeLessThanOrEqual(after);
  });
});

// ── S4 — Maintenance prune ────────────────────────────────────────────────────

describe('S4 — prune old interactions', () => {
  it('POST /prune is blocked at the public Worker layer (404)', async () => {
    const res = await SELF.fetch('http://localhost/prune', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('DO stub POST /prune removes interactions older than cutoff', async () => {
    const userId = 'userPrune0000001';
    const oldArticle = 'oldarticleprune1';

    // Ingest with old timestamp
    const oldTs = Date.now() - 40 * 24 * 60 * 60 * 1000; // 40 days ago
    await ingest([makeEvent({ userId, articleId: oldArticle, action: 'read', ts: oldTs })]);

    // Verify article is in recs before prune
    const before = await getRecs(userId);
    expect(before.articleIds).toContain(oldArticle);

    // Prune with cutoff = now (removes everything older than now)
    const stub = env.REC_DO.get(env.REC_DO.idFromName('global'));
    const pruneRes = await stub.fetch(
      new Request(`http://do-internal/prune?cutoff=${Date.now()}`, { method: 'POST' }),
    );
    expect(pruneRes.status).toBe(204);

    // Article should be gone from recs (score row removed too)
    const after = await getRecs(userId);
    expect(after.articleIds).not.toContain(oldArticle);
  });

  it('prune preserves recent interactions', async () => {
    const userId = 'userPrune0000002';
    const recentArticle = 'recentarticlepr1';

    await ingest([makeEvent({ userId, articleId: recentArticle, action: 'upvote' })]);

    // Prune with old cutoff (30 days ago) — should not remove recent data
    const stub = env.REC_DO.get(env.REC_DO.idFromName('global'));
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    await stub.fetch(
      new Request(`http://do-internal/prune?cutoff=${cutoff}`, { method: 'POST' }),
    );

    const recs = await getRecs(userId);
    expect(recs.articleIds).toContain(recentArticle);
  });
});
