import { describe, it, expect } from 'vitest';
import { parseRankRequest } from './parsing';
import { REC_MAX_CANDIDATES } from './types';

function params(qs: Record<string, string> = {}): URLSearchParams {
  return new URLSearchParams(qs);
}

describe('parseRankRequest — GET', () => {
  it('returns defaults when no params are provided', () => {
    const res = parseRankRequest({ method: 'GET', searchParams: params() });
    expect(res).toEqual({
      ok: true,
      value: { limit: 50, candidateModeProvided: false, candidateArticleIds: undefined, topicWeights: undefined },
    });
  });

  it('parses limit from the query string with clamping', () => {
    const res = parseRankRequest({ method: 'GET', searchParams: params({ limit: '999' }) });
    expect(res.ok && res.value.limit).toBe(200);
  });

  it('parses and dedupes CSV candidates, marking candidate mode', () => {
    const res = parseRankRequest({
      method: 'GET',
      searchParams: params({ candidates: ' a1 , b2 ,a1, ' }),
    });
    expect(res.ok && res.value.candidateModeProvided).toBe(true);
    expect(res.ok && res.value.candidateArticleIds).toEqual(['a1', 'b2']);
  });

  it('rejects CSV candidate pools over the cap with the canonical message', () => {
    const csv = Array.from({ length: REC_MAX_CANDIDATES + 1 }, (_, i) => `id${i}`).join(',');
    const res = parseRankRequest({ method: 'GET', searchParams: params({ candidates: csv }) });
    expect(res).toEqual({
      ok: false,
      message: `Too many candidateArticleIds in request; max ${REC_MAX_CANDIDATES}`,
    });
  });
});

describe('parseRankRequest — POST', () => {
  it('rejects a non-object body with the canonical message', () => {
    const res = parseRankRequest({ method: 'POST', searchParams: params(), body: 'nope' });
    expect(res).toEqual({ ok: false, message: 'Invalid JSON body' });
  });

  it('accepts a null body as global mode with defaults', () => {
    const res = parseRankRequest({ method: 'POST', searchParams: params(), body: null });
    expect(res.ok && res.value.candidateModeProvided).toBe(false);
    expect(res.ok && res.value.limit).toBe(50);
  });

  it('marks candidate mode when the key is present, even when empty', () => {
    const res = parseRankRequest({
      method: 'POST', searchParams: params(), body: { candidateArticleIds: [] },
    });
    expect(res.ok && res.value.candidateModeProvided).toBe(true);
    expect(res.ok && res.value.candidateArticleIds).toEqual([]);
  });

  it('rejects non-string candidate entries with the canonical message', () => {
    const res = parseRankRequest({
      method: 'POST', searchParams: params(), body: { candidateArticleIds: [42] },
    });
    expect(res).toEqual({ ok: false, message: 'candidateArticleIds must contain only strings' });
  });

  it('rejects candidate pools over the cap with the canonical message', () => {
    const ids = Array.from({ length: REC_MAX_CANDIDATES + 1 }, (_, i) => `id${i}`);
    const res = parseRankRequest({
      method: 'POST', searchParams: params(), body: { candidateArticleIds: ids },
    });
    expect(res).toEqual({
      ok: false,
      message: `Too many candidateArticleIds in request; max ${REC_MAX_CANDIDATES}`,
    });
  });

  it('lets body.limit override the query-string limit', () => {
    const res = parseRankRequest({
      method: 'POST', searchParams: params({ limit: '10' }), body: { limit: 25 },
    });
    expect(res.ok && res.value.limit).toBe(25);
  });

  it('keeps the query-string limit when the body omits it', () => {
    const res = parseRankRequest({
      method: 'POST', searchParams: params({ limit: '10' }), body: {},
    });
    expect(res.ok && res.value.limit).toBe(10);
  });

  it('parses topicWeights, capping multipliers at 10', () => {
    const res = parseRankRequest({
      method: 'POST', searchParams: params(), body: { topicWeights: { science: 50 } },
    });
    expect(res.ok && res.value.topicWeights).toEqual({ science: 10 });
  });

  it('rejects invalid topicWeights with the canonical message', () => {
    const res = parseRankRequest({
      method: 'POST', searchParams: params(), body: { topicWeights: { science: -1 } },
    });
    expect(res).toEqual({
      ok: false,
      message: 'topicWeights["science"] must be a non-negative finite number',
    });
  });
});
