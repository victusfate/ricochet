import { SELF, env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { isAllowedOrigin } from './index';
import type { RecWorkerEnv } from './worker-env';
import type { RecResponse } from './types';

const ORIGIN = 'https://victusfate.github.io';

async function fetchPath(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers ?? { Origin: ORIGIN });
  if (!headers.has('Origin')) headers.set('Origin', ORIGIN);
  return SELF.fetch(`http://localhost${path}`, { ...init, headers });
}

function doStub(): DurableObjectStub {
  return env.REC_DO.get(env.REC_DO.idFromName('global'));
}

// ── F-06: userId validation ───────────────────────────────────────────────────

describe('userId validation on /recommendations', () => {
  it('rejects userIds longer than 256 chars with a 400', async () => {
    const longId = 'u'.repeat(257);
    const res = await fetchPath(`/recommendations/${longId}`);
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; message: string };
    expect(body).toEqual({ ok: false, message: 'userId must be 1-256 characters' });
  });

  it('accepts a 256-char userId', async () => {
    const maxId = 'u'.repeat(256);
    const res = await fetchPath(`/recommendations/${maxId}`);
    expect(res.status).toBe(200);
  });
});

// ── F-05: cache-key isolation ─────────────────────────────────────────────────

describe('cache-key isolation across users', () => {
  it('does not embed the raw userId in the cache key', async () => {
    const res = await fetchPath('/recommendations/cachekey-victim-1');
    const body = await res.json() as RecResponse;
    expect(body.cache.key).not.toContain('cachekey-victim-1');
  });

  it('a crafted userId cannot collide with another user\'s feed-pool key', async () => {
    const victimRes = await fetchPath('/recommendations/victimuser', {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ candidateArticleIds: ['p1aaaaaaaaaaaaaa', 'p2bbbbbbbbbbbbbb'], limit: 50 }),
    });
    const victimBody = await victimRes.json() as RecResponse;
    const victimKey = victimBody.cache.key;

    // Under a raw-interpolation scheme, this userId makes the attacker's GLOBAL
    // key byte-identical to the victim's FEED-POOL key.
    // Colons are legal unencoded in URL paths, so this needs no escaping.
    const craftedId = victimKey.replace(/^recs:/, '').replace(/:limit:50$/, '');
    const attackerRes = await fetchPath(`/recommendations/${craftedId}?limit=50`);
    const attackerBody = await attackerRes.json() as RecResponse;

    expect(attackerBody.cache.key).not.toBe(victimKey);
  });
});

// ── F-10: /rec/articles rate limiting ─────────────────────────────────────────

describe('/rec/articles rate limiting', () => {
  it('returns 429 after the per-IP limit is exhausted', async () => {
    const headers = { Origin: ORIGIN, 'CF-Connecting-IP': '10.99.42.7' };
    let last: Response | null = null;
    for (let i = 0; i < 31; i++) {
      last = await SELF.fetch('http://localhost/rec/articles?ids=a1b2c3d4e5f60718', { headers });
    }
    expect(last!.status).toBe(429);
  });
});

// ── F-11: https-only extra CORS origins ───────────────────────────────────────

describe('EXTRA_CORS_ORIGINS protocol enforcement', () => {
  const fakeEnv = { EXTRA_CORS_ORIGINS: 'http://evil.example,https://app.example' } as RecWorkerEnv;

  it('honors https:// origins from the env', () => {
    expect(isAllowedOrigin('https://app.example', fakeEnv)).toBe(true);
  });

  it('ignores non-https origins from the env', () => {
    expect(isAllowedOrigin('http://evil.example', fakeEnv)).toBe(false);
  });
});

// ── F-02/F-03/F-04: DO input hardening ────────────────────────────────────────

describe('RecDO input hardening', () => {
  it('/ingest with malformed JSON returns 400, not a crash', async () => {
    const res = await doStub().fetch(new Request('http://do-internal/ingest', {
      method: 'POST', body: 'not json',
    }));
    expect(res.status).toBe(400);
  });

  it('/ingest with a non-array body returns 400', async () => {
    const res = await doStub().fetch(new Request('http://do-internal/ingest', {
      method: 'POST', body: JSON.stringify({ events: 'nope' }),
    }));
    expect(res.status).toBe(400);
  });

  it('/articles with a missing ids array returns 400', async () => {
    const res = await doStub().fetch(new Request('http://do-internal/articles', {
      method: 'POST', body: JSON.stringify({ notIds: true }),
    }));
    expect(res.status).toBe(400);
  });

  it('/recs with malformed percent-encoding returns 400, not a crash', async () => {
    const res = await doStub().fetch(new Request('http://do-internal/recs/%'));
    expect(res.status).toBe(400);
  });
});

// ── F-01: user_factors pruning ────────────────────────────────────────────────

describe('user_factors pruning', () => {
  async function userFactorsCount(): Promise<number> {
    const res = await doStub().fetch(new Request('http://do-internal/debug/user-factors-count'));
    const { count } = await res.json() as { count: number };
    return count;
  }

  it('prune removes user factors older than the factor cutoff', async () => {
    await fetchPath('/interactions', {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: [{
        userId: 'userPruneFactors1', articleId: 'prunefactorart01',
        sourceId: 'ars-technica', topics: ['science'], action: 'upvote', ts: Date.now(),
      }] }),
    });
    expect(await userFactorsCount()).toBeGreaterThan(0);

    const future = Date.now() + 10_000;
    await doStub().fetch(new Request(`http://do-internal/prune?factorCutoff=${future}`, { method: 'POST' }));
    expect(await userFactorsCount()).toBe(0);
  });

  it('prune keeps user factors newer than the factor cutoff', async () => {
    await fetchPath('/interactions', {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: [{
        userId: 'userPruneFactors2', articleId: 'prunefactorart02',
        sourceId: 'ars-technica', topics: ['science'], action: 'upvote', ts: Date.now(),
      }] }),
    });
    const before = await userFactorsCount();

    const past = Date.now() - 1_000_000;
    await doStub().fetch(new Request(`http://do-internal/prune?factorCutoff=${past}`, { method: 'POST' }));
    expect(await userFactorsCount()).toBe(before);
  });
});
