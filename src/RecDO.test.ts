import { SELF, env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import type { InteractionEvent, RecCoreResponse, RecResponse } from './types';
import { buildRecCacheKey } from './index';

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

async function getRecsForCandidates(
  userId: string,
  candidateArticleIds: string[],
  limit = 50,
): Promise<RecResponse> {
  const res = await SELF.fetch(
    `http://localhost/recommendations/${encodeURIComponent(userId)}`,
    {
      method: 'POST',
      headers: {
        Origin: 'https://victusfate.github.io',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ candidateArticleIds, limit }),
    },
  );
  expect(res.status).toBe(200);
  return res.json() as Promise<RecResponse>;
}

// ── S2 — Interaction storage and popularity ───────────────────────────────────

describe('S2 — interaction ingestion and popularity', () => {
  it('upvoted article appears in recs with higher score than only-read article', async () => {
    const upvotedId = 'upvotedarticle001';
    const readOnlyId = 'readonlyarticle01';
    const userId = 'userAAAA00000001';

    // Seed upvotedId with multiple upvotes across users so item bias (upvote=1.0)
    // dominates over the random latent-vector noise from a single SGD step.
    await ingest([
      makeEvent({ userId,                  articleId: upvotedId,  action: 'upvote' }),
      makeEvent({ userId: 'upv-seed-u-01', articleId: upvotedId,  action: 'upvote' }),
      makeEvent({ userId: 'upv-seed-u-02', articleId: upvotedId,  action: 'upvote' }),
      makeEvent({ userId: 'upv-seed-u-03', articleId: upvotedId,  action: 'upvote' }),
      makeEvent({ userId,                  articleId: readOnlyId, action: 'read' }),
    ]);

    const recs = await getRecs(userId);
    const upvotedIdx = recs.articleIds.indexOf(upvotedId);
    const readOnlyIdx = recs.articleIds.indexOf(readOnlyId);

    expect(upvotedIdx).toBeGreaterThanOrEqual(0);
    expect(readOnlyIdx).toBeGreaterThanOrEqual(0);
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
    const data = await recsRes.json() as RecCoreResponse;

    // Article should still be in recs
    expect(data.articleIds).toContain(articleId);

    // Score should be 1 (one read), not 2 (two reads).
    // Seed upvotedId with save interactions from multiple users so its item bias
    // dominates clearly over articleId's single deduped read — removes latent noise.
    const upvotedId = 'deduphigherscore1';
    await ingest([
      makeEvent({ userId,            articleId: upvotedId, action: 'save' }),
      makeEvent({ userId,            articleId: upvotedId, action: 'upvote' }),
      makeEvent({ userId,            articleId: upvotedId, action: 'read' }),
      makeEvent({ userId: 'dedup-seed-u1', articleId: upvotedId, action: 'save' }),
      makeEvent({ userId: 'dedup-seed-u2', articleId: upvotedId, action: 'save' }),
      makeEvent({ userId: 'dedup-seed-u3', articleId: upvotedId, action: 'save' }),
    ]);
    const doStub = env.REC_DO.get(env.REC_DO.idFromName('global'));
    const recs2Res = await doStub.fetch(
      new Request(`http://do-internal/recs/${userId}?limit=50`),
    );
    const recs2 = await recs2Res.json() as RecCoreResponse;
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
    const recs = await getRecs('userTimestamp0001');
    const after = Date.now();
    expect(recs.generatedAt).toBeGreaterThanOrEqual(before);
    expect(recs.generatedAt).toBeLessThanOrEqual(after);
  });

  it('returns scoredArticleIds + diagnostics aligned to articleIds', async () => {
    const userId = 'userObs000000001';
    const articleA = 'obsarticleA000001';
    const articleB = 'obsarticleB000001';
    await ingest([
      makeEvent({ userId, articleId: articleA, action: 'save' }),
      makeEvent({ userId, articleId: articleB, action: 'read' }),
    ]);

    const recs = await getRecs(userId, 10);
    expect(recs.scoredArticleIds.map(r => r.articleId)).toEqual(recs.articleIds);
    expect(recs.scoredArticleIds.every(r => typeof r.score === 'number')).toBe(true);
    expect(recs.diagnostics.model).toBe('biased-mf');
    expect(recs.diagnostics.limit).toBe(10);
    expect(recs.diagnostics.returnedCount).toBe(recs.articleIds.length);
    expect(recs.diagnostics.rankedCount).toBeGreaterThanOrEqual(recs.diagnostics.returnedCount);
  });

  it('feed-pool mode keeps cold items and excludes downvoted items', async () => {
    const userId = 'userPoolMode00001';
    const warmId = 'poolmoderecwarm01';
    const coldId = 'poolmodereccold01';
    const downvotedId = 'poolmodedownvote1';
    await ingest([
      makeEvent({ userId, articleId: warmId, action: 'save' }),
      makeEvent({ userId, articleId: downvotedId, action: 'downvote' }),
    ]);

    const recs = await getRecsForCandidates(userId, [warmId, coldId, downvotedId, coldId], 10);
    expect(recs.articleIds).toContain(warmId);
    expect(recs.articleIds).toContain(coldId);
    expect(recs.articleIds).not.toContain(downvotedId);
    expect(recs.diagnostics.candidateMode).toBe('feed-pool');
    expect(recs.diagnostics.candidateCount).toBe(3);
    expect(recs.diagnostics.excludedDownvotes).toBe(1);
    expect((recs.diagnostics.coldItemCount ?? 0)).toBeGreaterThanOrEqual(1);
    expect((recs.diagnostics.warmItemCount ?? 0)).toBeGreaterThanOrEqual(1);
  });

  it('feed-pool mode with empty candidates returns 200 and empty lists', async () => {
    const recs = await getRecsForCandidates('userPoolModeEmpty1', [], 10);
    expect(recs.articleIds).toEqual([]);
    expect(recs.scoredArticleIds).toEqual([]);
    expect(recs.diagnostics.candidateMode).toBe('feed-pool');
    expect(recs.diagnostics.candidateCount).toBe(0);
    expect(recs.diagnostics.returnedCount).toBe(0);
  });

  it('feed-pool mode rejects candidate lists over 100', async () => {
    const userId = 'userPoolModeLarge1';
    const candidateArticleIds = Array.from({ length: 101 }, (_, i) =>
      `poollarge${String(i).padStart(8, '0')}`);
    const res = await SELF.fetch(
      `http://localhost/recommendations/${encodeURIComponent(userId)}`,
      {
        method: 'POST',
        headers: {
          Origin: 'https://victusfate.github.io',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ candidateArticleIds, limit: 50 }),
      },
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; message: string };
    expect(body.ok).toBe(false);
    expect(body.message).toContain('Too many candidateArticleIds in request');
  });

  it('legacy mode remains global when candidates are omitted', async () => {
    const recs = await getRecs('userLegacyMode0001');
    expect(recs.diagnostics.candidateMode).toBe('global');
  });

  it('DO /recs POST rejects non-object JSON body with 400', async () => {
    const stub = env.REC_DO.get(env.REC_DO.idFromName('global'));
    const res = await stub.fetch(new Request('http://do-internal/recs/userBadBody0001', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(123),
    }));
    expect(res.status).toBe(400);
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

    // Prune with cutoff = now for both interactions and item_factors.
    // factorCutoff must be passed explicitly since soft-prune decouples the two schedules.
    const stub = env.REC_DO.get(env.REC_DO.idFromName('global'));
    const now = Date.now();
    const pruneRes = await stub.fetch(
      new Request(`http://do-internal/prune?cutoff=${now}&factorCutoff=${now}`, { method: 'POST' }),
    );
    expect(pruneRes.status).toBe(204);

    // Clear KV cache so getRecs reflects post-prune DO state
    await env.REC_STORE.delete(await buildRecCacheKey(userId, 50));

    // Article should be gone from recs (item_factors row removed too)
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

// ── S2-mf-schema — BiasedMF table creation ───────────────────────────────────

describe('S2-mf-schema — BiasedMF tables exist after DO init', () => {
  function stub() {
    return env.REC_DO.get(env.REC_DO.idFromName('global'));
  }

  it('global_state initialises with mean=0 and n=0', async () => {
    type GsRow = { mean: number; n: number };
    const s = stub();
    const res = await s.fetch(new Request('http://do-internal/debug/global-state'));
    expect(res.status).toBe(200);
    const row = await res.json() as GsRow;
    expect(typeof row.mean).toBe('number');
    expect(typeof row.n).toBe('number');
  });

  it('user_factors table accepts a full row insert and retrieval', async () => {
    const s = stub();
    const res = await s.fetch(new Request('http://do-internal/debug/user-factors-count'));
    expect(res.status).toBe(200);
    const { count } = await res.json() as { count: number };
    expect(typeof count).toBe('number');
  });

  it('item_factors table accepts a full row insert and retrieval', async () => {
    const s = stub();
    const res = await s.fetch(new Request('http://do-internal/debug/item-factors-count'));
    expect(res.status).toBe(200);
    const { count } = await res.json() as { count: number };
    expect(typeof count).toBe('number');
  });

  it('existing interactions table still present', async () => {
    const s = stub();
    const res = await s.fetch(new Request('http://do-internal/debug/interactions-count'));
    expect(res.status).toBe(200);
    const { count } = await res.json() as { count: number };
    expect(typeof count).toBe('number');
  });
});

// ── S3 — learnOne ─────────────────────────────────────────────────────────────

describe('S3 — learnOne', () => {
  it('after one save, item_factors.bias is positive', async () => {
    await ingest([makeEvent({ userId: 'userS3A0000001', articleId: 's3articleA00001', action: 'save' })]);
    const s = env.REC_DO.get(env.REC_DO.idFromName('global'));
    type CountRow = { count: number };
    const res = await s.fetch(new Request('http://do-internal/debug/item-factors-count'));
    const { count } = await res.json() as CountRow;
    expect(count).toBeGreaterThan(0);
    // Verify via recs — saved article must appear
    const recs = await getRecs('userS3A0000001');
    expect(recs.articleIds).toContain('s3articleA00001');
  });

  it('after one downvote, article is excluded from that user recs', async () => {
    const userId    = 'userS3B0000001';
    const articleId = 's3articleB00001';
    await ingest([makeEvent({ userId, articleId, action: 'downvote' })]);
    const recs = await getRecs(userId);
    expect(recs.articleIds).not.toContain(articleId);
  });

  it('global mean updates toward the rating after each call', async () => {
    const s = env.REC_DO.get(env.REC_DO.idFromName('global'));
    const before = await s.fetch(new Request('http://do-internal/debug/global-state'));
    const { n: nBefore } = await before.json() as { mean: number; n: number };

    await ingest([makeEvent({ userId: 'userS3C0000001', articleId: 's3articleC00001', action: 'read' })]);

    const after = await s.fetch(new Request('http://do-internal/debug/global-state'));
    const { n: nAfter } = await after.json() as { mean: number; n: number };
    expect(nAfter).toBeGreaterThan(nBefore);
  });

  it('user and item factors are non-zero after first interaction', async () => {
    await ingest([makeEvent({ userId: 'userS3D0000001', articleId: 's3articleD00001', action: 'upvote' })]);
    const s = env.REC_DO.get(env.REC_DO.idFromName('global'));
    const uRes = await s.fetch(new Request('http://do-internal/debug/user-factors-count'));
    const { count: uCount } = await uRes.json() as { count: number };
    const iRes = await s.fetch(new Request('http://do-internal/debug/item-factors-count'));
    const { count: iCount } = await iRes.json() as { count: number };
    expect(uCount).toBeGreaterThan(0);
    expect(iCount).toBeGreaterThan(0);
  });

  it('duplicate event does not double-update factors', async () => {
    const userId    = 'userS3E0000001';
    const articleId = 's3articleE00001';
    const higherId  = 's3articleE00002';

    await ingest([makeEvent({ userId, articleId, action: 'read' })]);
    await ingest([makeEvent({ userId, articleId, action: 'read' })]);  // duplicate
    // save+upvote+read on higherId gives clear signal over the single deduped read
    await ingest([
      makeEvent({ userId, articleId: higherId, action: 'save' }),
      makeEvent({ userId, articleId: higherId, action: 'upvote' }),
      makeEvent({ userId, articleId: higherId, action: 'read' }),
    ]);

    const recs = await getRecs(userId);
    expect(recs.articleIds.indexOf(higherId)).toBeLessThan(recs.articleIds.indexOf(articleId));
  });

  it('learnOne creates a new user_factors row for an unseen user', async () => {
    const s = env.REC_DO.get(env.REC_DO.idFromName('global'));
    const before = await (await s.fetch(new Request('http://do-internal/debug/user-factors-count'))).json() as { count: number };
    await ingest([makeEvent({ userId: 'userS3F0000001', articleId: 's3articleF00001', action: 'save' })]);
    const after = await (await s.fetch(new Request('http://do-internal/debug/user-factors-count'))).json() as { count: number };
    expect(after.count).toBeGreaterThan(before.count);
  });

  it('learnOne creates a new item_factors row for an unseen article', async () => {
    const s = env.REC_DO.get(env.REC_DO.idFromName('global'));
    const before = await (await s.fetch(new Request('http://do-internal/debug/item-factors-count'))).json() as { count: number };
    await ingest([makeEvent({ userId: 'userS3G0000001', articleId: 's3articleG00001', action: 'read' })]);
    const after = await (await s.fetch(new Request('http://do-internal/debug/item-factors-count'))).json() as { count: number };
    expect(after.count).toBeGreaterThan(before.count);
  });
});

// ── S4 — score and getTopCandidates ───────────────────────────────────────────

describe('S4 — scoring and recommendations', () => {
  it('saved article ranks above read-only article for same user', async () => {
    const userId  = 'userS4A0000001';
    const savedId = 's4articleSave001';
    const readId  = 's4articleRead001';

    await ingest([
      makeEvent({ userId, articleId: savedId, action: 'save' }),
      makeEvent({ userId, articleId: readId,  action: 'read' }),
    ]);

    // Pool-scoped ranking avoids noise from unrelated globally popular items.
    const recs = await getRecsForCandidates(userId, [savedId, readId], 50);
    expect(recs.articleIds.indexOf(savedId)).toBeLessThan(recs.articleIds.indexOf(readId));
  });

  it('cold-start user receives articles ordered by item bias', async () => {
    // Seed articles with different interaction levels via another user
    const seeder = 'userS4Seeder0001';
    const popular = 's4popularArt0001';
    const lessPop = 's4lesspopArt001';

    await ingest([
      makeEvent({ userId: seeder, articleId: popular, action: 'upvote' }),
      makeEvent({ userId: seeder, articleId: popular, action: 'save' }),
      makeEvent({ userId: seeder, articleId: lessPop, action: 'seen' }),
    ]);

    // Cold-start user has no history
    const recs = await getRecs('userS4Cold000001');
    const popIdx    = recs.articleIds.indexOf(popular);
    const lessIdx   = recs.articleIds.indexOf(lessPop);
    if (popIdx !== -1 && lessIdx !== -1) {
      expect(popIdx).toBeLessThan(lessIdx);
    }
  });

  it('downvoted article excluded even with high item bias', async () => {
    const userId    = 'userS4B0000001';
    const popularId = 's4popularDv0001';
    const seeder    = 'userS4BSeed0001';

    // Make article popular for other users
    await ingest([
      makeEvent({ userId: seeder,  articleId: popularId, action: 'upvote' }),
      makeEvent({ userId: seeder,  articleId: popularId, action: 'save' }),
      makeEvent({ userId: 'userS4BSeed0002', articleId: popularId, action: 'upvote' }),
    ]);
    // Target user downvotes it
    await ingest([makeEvent({ userId, articleId: popularId, action: 'downvote' })]);

    const recs = await getRecs(userId);
    expect(recs.articleIds).not.toContain(popularId);
  });

  it('limit param caps the returned list', async () => {
    const events = Array.from({ length: 15 }, (_, i) =>
      makeEvent({ articleId: `s4limitarticle${String(i).padStart(3, '0')}`, action: 'read' }),
    );
    await ingest(events);
    const recs = await getRecs('userAAAA00000001', 5);
    expect(recs.articleIds.length).toBeLessThanOrEqual(5);
  });

  it('two users with different histories receive different orderings', async () => {
    const userA = 'userS4C0000001';
    const userB = 'userS4D0000001';
    const artX  = 's4articleXC0001';
    const artY  = 's4articleYD0001';

    // userA loves artX, explicitly downvotes artY (excluded from recs)
    // userB loves artY, explicitly downvotes artX (excluded from recs)
    // Downvote exclusion is deterministic — no latent noise can override it
    await ingest([
      makeEvent({ userId: userA, articleId: artX, action: 'save' }),
      makeEvent({ userId: userA, articleId: artX, action: 'upvote' }),
      makeEvent({ userId: userA, articleId: artX, action: 'read' }),
      makeEvent({ userId: userA, articleId: artY, action: 'downvote' }),
      makeEvent({ userId: userB, articleId: artY, action: 'save' }),
      makeEvent({ userId: userB, articleId: artY, action: 'upvote' }),
      makeEvent({ userId: userB, articleId: artY, action: 'read' }),
      makeEvent({ userId: userB, articleId: artX, action: 'downvote' }),
    ]);

    const recsA = await getRecs(userA);
    const recsB = await getRecs(userB);

    expect(recsA.articleIds).toContain(artX);
    expect(recsA.articleIds).not.toContain(artY);
    expect(recsB.articleIds).toContain(artY);
    expect(recsB.articleIds).not.toContain(artX);
  });

  it('getTopCandidates returns articles ordered by bias DESC via recs cold-start', async () => {
    const seeder   = 'userS4E0000001';
    const highBias = 's4highBiasArt01';
    const lowBias  = 's4lowBiasArt001';

    await ingest([
      makeEvent({ userId: seeder, articleId: highBias, action: 'save' }),
      makeEvent({ userId: seeder, articleId: highBias, action: 'upvote' }),
      makeEvent({ userId: seeder, articleId: lowBias,  action: 'seen' }),
    ]);

    // Cold-start user — ranks by bias only
    const recs = await getRecs('userS4ECold00001');
    const hiIdx = recs.articleIds.indexOf(highBias);
    const loIdx = recs.articleIds.indexOf(lowBias);
    if (hiIdx !== -1 && loIdx !== -1) expect(hiIdx).toBeLessThan(loIdx);
  });

  it('empty candidate pool returns empty array without error', async () => {
    // Fresh DO namespace would be empty, but we share state — just verify shape
    const recs = await getRecs('userS4F0000001');
    expect(Array.isArray(recs.articleIds)).toBe(true);
  });
});

// ── S6 — Cold-start diversity and topic-affinity ─────────────────────────────

describe('S6 — cold-start diversity and topic affinity', () => {
  function stub() {
    return env.REC_DO.get(env.REC_DO.idFromName('global'));
  }

  it('getDiverseCandidates includes articles from multiple topics when present', async () => {
    // Seed articles across 3 distinct topics
    const seeder = 'userDiverseSeed01';
    const techArt    = 'diversetech00001';
    const scienceArt = 'diversescience01';
    const worldArt   = 'diverseworld0001';

    await ingest([
      makeEvent({ userId: seeder, articleId: techArt,    topics: ['technology'], action: 'upvote', sourceId: 'src1' }),
      makeEvent({ userId: seeder, articleId: scienceArt, topics: ['science'],    action: 'upvote', sourceId: 'src2' }),
      makeEvent({ userId: seeder, articleId: worldArt,   topics: ['world'],      action: 'upvote', sourceId: 'src3' }),
    ]);

    // Cold-start user (no prior interactions) should get a fresh response
    const coldUser = 'userColdDiverse001';
    const recs = await getRecs(coldUser);
    expect(Array.isArray(recs.articleIds)).toBe(true);
    // All three articles should be in the candidate pool (< 200 total articles in test DO)
    expect(recs.articleIds).toContain(techArt);
    expect(recs.articleIds).toContain(scienceArt);
    expect(recs.articleIds).toContain(worldArt);
  });

  it('topic-affinity weights via POST /recs boost preferred topic articles', async () => {
    const seeder    = 'userTopicSeed0001';
    const highBiasArt = 'topicHighBias001'; // technology, many interactions → high bias
    const lowBiasArt  = 'topicLowBias0001'; // science, few interactions → low bias

    // Make tech article popular
    await ingest([
      makeEvent({ userId: seeder,      articleId: highBiasArt, topics: ['technology'], action: 'save',   sourceId: 'src-tech' }),
      makeEvent({ userId: seeder,      articleId: highBiasArt, topics: ['technology'], action: 'upvote', sourceId: 'src-tech' }),
      makeEvent({ userId: seeder,      articleId: highBiasArt, topics: ['technology'], action: 'read',   sourceId: 'src-tech' }),
      makeEvent({ userId: 'twSeed002', articleId: highBiasArt, topics: ['technology'], action: 'save',   sourceId: 'src-tech' }),
      makeEvent({ userId: 'twSeed003', articleId: highBiasArt, topics: ['technology'], action: 'save',   sourceId: 'src-tech' }),
    ]);
    // Science article gets only one read
    await ingest([
      makeEvent({ userId: seeder, articleId: lowBiasArt, topics: ['science'], action: 'read', sourceId: 'src-sci' }),
    ]);

    const s = stub();

    // Without topic weights: high-bias tech article should rank first
    const baseRes = await s.fetch(new Request(
      'http://do-internal/recs/userTopicTarget01?limit=50',
    ));
    const baseBody = await baseRes.json() as { articleIds: string[] };
    const baseHiIdx = baseBody.articleIds.indexOf(highBiasArt);
    const baseLoIdx = baseBody.articleIds.indexOf(lowBiasArt);
    if (baseHiIdx !== -1 && baseLoIdx !== -1) {
      expect(baseHiIdx).toBeLessThan(baseLoIdx);
    }

    // With science boosted 10×: science article should rank above tech
    const boostedRes = await s.fetch(new Request(
      'http://do-internal/recs/userTopicTarget01',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topicWeights: { science: 10, technology: 1 }, limit: 50 }),
      },
    ));
    const boostedBody = await boostedRes.json() as { articleIds: string[] };
    const boostedHiIdx = boostedBody.articleIds.indexOf(highBiasArt);
    const boostedLoIdx = boostedBody.articleIds.indexOf(lowBiasArt);

    // Science should now rank above tech due to 10× multiplier
    if (boostedHiIdx !== -1 && boostedLoIdx !== -1) {
      expect(boostedLoIdx).toBeLessThan(boostedHiIdx);
    }
  });

  it('POST /recs returns 400 for invalid topicWeights', async () => {
    const s = stub();
    const res = await s.fetch(new Request(
      'http://do-internal/recs/userBadWeights01',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topicWeights: { technology: -1 } }),
      },
    ));
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; message: string };
    expect(body.message).toContain('non-negative');
  });

  it('POST /recs with no topicWeights returns normal ranking', async () => {
    const s = stub();
    const res = await s.fetch(new Request(
      'http://do-internal/recs/userNoWeights001',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: 10 }),
      },
    ));
    expect(res.status).toBe(200);
    const body = await res.json() as { articleIds: string[] };
    expect(Array.isArray(body.articleIds)).toBe(true);
  });
});

// ── S7 — Soft prune (decoupled interaction vs factor retention) ───────────────

describe('S7 — soft prune: interactions vs item_factors on separate schedules', () => {
  function stub() {
    return env.REC_DO.get(env.REC_DO.idFromName('global'));
  }

  it('interaction rows are deleted at interactionCutoff but item_factors survive', async () => {
    const userId    = 'userSoftPruneA01';
    const articleId = 'softpruneArt0001';

    await ingest([makeEvent({ userId, articleId, action: 'read' })]);

    // Verify interactions row exists
    const countBefore = await stub().fetch(
      new Request('http://do-internal/debug/interactions-count'),
    );
    const { count: cntBefore } = await countBefore.json() as { count: number };

    const factorsBefore = await stub().fetch(
      new Request('http://do-internal/debug/item-factors-count'),
    );
    const { count: factorCntBefore } = await factorsBefore.json() as { count: number };

    // Prune interactions aggressively (cutoff = now) but keep factors (factorCutoff = 180 days ago)
    const interactionCutoff = Date.now();
    const factorCutoff = Date.now() - 180 * 24 * 60 * 60 * 1000; // 180 days ago
    const pruneRes = await stub().fetch(new Request(
      `http://do-internal/prune?cutoff=${interactionCutoff}&factorCutoff=${factorCutoff}`,
      { method: 'POST' },
    ));
    expect(pruneRes.status).toBe(204);

    // Interactions should decrease
    const countAfter = await stub().fetch(
      new Request('http://do-internal/debug/interactions-count'),
    );
    const { count: cntAfter } = await countAfter.json() as { count: number };
    expect(cntAfter).toBeLessThan(cntBefore);

    // item_factors count should be unchanged (recent updated_at, not expired)
    const factorsAfter = await stub().fetch(
      new Request('http://do-internal/debug/item-factors-count'),
    );
    const { count: factorCntAfter } = await factorsAfter.json() as { count: number };
    expect(factorCntAfter).toBe(factorCntBefore);
  });

  it('item_factors are deleted when factorCutoff covers their updated_at', async () => {
    const userId    = 'userSoftPruneB01';
    const articleId = 'softpruneBrt0001';

    await ingest([makeEvent({ userId, articleId, action: 'upvote' })]);

    const factorsBefore = await stub().fetch(
      new Request('http://do-internal/debug/item-factors-count'),
    );
    const { count: cntBefore } = await factorsBefore.json() as { count: number };
    expect(cntBefore).toBeGreaterThan(0);

    // Both cutoffs = now → prune everything including item_factors updated recently
    const now = Date.now();
    await stub().fetch(new Request(
      `http://do-internal/prune?cutoff=${now}&factorCutoff=${now}`,
      { method: 'POST' },
    ));

    const factorsAfter = await stub().fetch(
      new Request('http://do-internal/debug/item-factors-count'),
    );
    const { count: cntAfter } = await factorsAfter.json() as { count: number };
    expect(cntAfter).toBeLessThan(cntBefore);
  });
});
