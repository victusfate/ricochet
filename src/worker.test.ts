import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from './index';
import type { InteractionEvent } from './types';

async function req(
  method: string,
  path: string,
  body?: unknown,
  origin = 'https://victusfate.github.io',
  clientIp?: string,
): Promise<Response> {
  const headers = new Headers({ Origin: origin });
  if (clientIp) headers.set('CF-Connecting-IP', clientIp);
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers.set('Content-Type', 'application/json');
    init.body = JSON.stringify(body);
  }
  const request = new Request(`http://localhost${path}`, init);
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

const sampleEvent: InteractionEvent = {
  userId:    'user0000000000001',
  articleId: 'a3f1c2d4b5e60718',
  sourceId:  'ars-technica',
  topics:    ['technology'],
  action:    'read',
  ts:        Date.now(),
};

// ── S1 — Worker scaffold ──────────────────────────────────────────────────────

describe('S1 — worker scaffold', () => {
  it('GET /health → 200 with service name', async () => {
    const res = await req('GET', '/health');
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; service: string };
    expect(body).toMatchObject({ ok: true, service: 'ricochet-rec' });
  });

  it('OPTIONS preflight → 204 with CORS headers', async () => {
    const headers = new Headers({
      Origin: 'https://victusfate.github.io',
      'Access-Control-Request-Method': 'POST',
    });
    const request = new Request('http://localhost/interactions', { method: 'OPTIONS', headers });
    const ctx = createExecutionContext();
    const res = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://victusfate.github.io');
  });

  it('unknown path → 404', async () => {
    const res = await req('GET', '/nonexistent');
    expect(res.status).toBe(404);
  });

  it('trailing slash on /health/ → 200', async () => {
    const res = await req('GET', '/health/');
    expect(res.status).toBe(200);
  });
});

// ── S2 — POST /interactions ───────────────────────────────────────────────────

describe('S2 — POST /interactions', () => {
  it('valid batch → 200 { ok: true, queued: N }', async () => {
    const res = await req('POST', '/interactions', { events: [sampleEvent] });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; queued: number };
    expect(body).toMatchObject({ ok: true, queued: 1 });
  });

  it('invalid JSON body → 400', async () => {
    const headers = new Headers({
      Origin: 'https://victusfate.github.io',
      'Content-Type': 'application/json',
    });
    const request = new Request('http://localhost/interactions', {
      method: 'POST',
      headers,
      body: 'not json',
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(400);
  });

  it('missing events field → 400', async () => {
    const res = await req('POST', '/interactions', { notEvents: [] });
    expect(res.status).toBe(400);
  });

  it('batch larger than 200 → 400', async () => {
    const events = Array.from({ length: 201 }, (_, i) => ({
      ...sampleEvent,
      articleId: `article${String(i).padStart(9, '0')}`,
    }));
    const res = await req('POST', '/interactions', { events });
    expect(res.status).toBe(400);
  });

  it('empty events array → 200 queued:0', async () => {
    const res = await req('POST', '/interactions', { events: [] });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; queued: number };
    expect(body).toMatchObject({ ok: true, queued: 0 });
  });

  it('events with invalid action are silently dropped', async () => {
    const bad = { ...sampleEvent, action: 'invalid' } as unknown as InteractionEvent;
    const res = await req('POST', '/interactions', { events: [bad] });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; queued: number };
    expect(body.queued).toBe(0);
  });

  it('rate-limits POST /interactions to 60 req/min per client IP', async () => {
    const clientIp = '203.0.113.22';
    for (let i = 0; i < 60; i++) {
      const res = await req('POST', '/interactions', { events: [sampleEvent] },
        'https://victusfate.github.io', clientIp);
      expect(res.status).toBe(200);
    }
    const limited = await req('POST', '/interactions', { events: [sampleEvent] },
      'https://victusfate.github.io', clientIp);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBeTruthy();
  });
});

// ── S3 — GET /recommendations/:userId ────────────────────────────────────────

describe('S3 — GET /recommendations/:userId', () => {
  it('returns RecResponse shape', async () => {
    const res = await req('GET', '/recommendations/user0000000000001');
    expect(res.status).toBe(200);
    const body = await res.json() as { articleIds: unknown; generatedAt: unknown };
    expect(Array.isArray(body.articleIds)).toBe(true);
    expect(typeof body.generatedAt).toBe('number');
  });

  it('accepts optional limit param', async () => {
    const res = await req('GET', '/recommendations/user0000000000001?limit=10');
    expect(res.status).toBe(200);
  });

  it('clamps limit above MAX_LIMIT (200) silently', async () => {
    const res = await req('GET', '/recommendations/user0000000000001?limit=9999');
    expect(res.status).toBe(200);
  });

  it('rate-limits GET /recommendations to 30 req/min per client IP', async () => {
    const clientIp = '203.0.113.33';
    for (let i = 0; i < 30; i++) {
      const res = await req('GET', '/recommendations/someuser',
        undefined, 'https://victusfate.github.io', clientIp);
      expect(res.status).toBe(200);
    }
    const limited = await req('GET', '/recommendations/someuser',
      undefined, 'https://victusfate.github.io', clientIp);
    expect(limited.status).toBe(429);
  });
});
