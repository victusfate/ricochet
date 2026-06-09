import { SELF, env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Behavior-preservation net for the batch global_state optimization: a batch
// must produce exactly the same final global mean/count as sequential
// per-event learning (ratings: upvote=1.0, read=0.5, save=2.0).

const ORIGIN = 'https://victusfate.github.io';

function event(userId: string, articleId: string, action: string) {
  return { userId, articleId, sourceId: 'ars-technica', topics: ['science'], action, ts: Date.now() };
}

async function ingest(events: unknown[]): Promise<void> {
  const res = await SELF.fetch('http://localhost/interactions', {
    method: 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ events }),
  });
  expect(res.status).toBe(200);
}

async function globalState(): Promise<{ mean: number; n: number }> {
  const stub = env.REC_DO.get(env.REC_DO.idFromName('global'));
  const res = await stub.fetch(new Request('http://do-internal/debug/global-state'));
  return res.json() as Promise<{ mean: number; n: number }>;
}

describe('batch ingest — global_state equivalence', () => {
  it('a multi-event batch yields the exact sequential running mean and count', async () => {
    await ingest([
      event('batchUserA00001', 'batchartA0000001', 'upvote'), // rating 1.0
      event('batchUserB00001', 'batchartB0000001', 'read'),   // rating 0.5
      event('batchUserC00001', 'batchartC0000001', 'save'),   // rating 2.0
    ]);
    const gs = await globalState();
    // m1 = 1.0; m2 = 1.0 + (0.5-1.0)/2 = 0.75; m3 = 0.75 + (2.0-0.75)/3
    expect(gs.n).toBe(3);
    expect(gs.mean).toBeCloseTo(0.75 + (2.0 - 0.75) / 3, 12);
  });

  it('a duplicate inside one batch is learned only once', async () => {
    await ingest([
      event('batchUserD00001', 'batchartD0000001', 'upvote'),
      event('batchUserD00001', 'batchartD0000001', 'upvote'), // dedup — no second update
    ]);
    const gs = await globalState();
    expect(gs.n).toBe(1);
    expect(gs.mean).toBeCloseTo(1.0, 12);
  });
});
