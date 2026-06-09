import { describe, it, expect } from 'vitest';
import { isValidEvent } from './validation';
import { TOPICS, ACTIONS } from './types';
import { ACTION_RATING, DEFAULT_MF_PARAMS, zeroFactorRow } from './scoring';

const validEvent = {
  userId: 'u-123',
  articleId: 'a1b2c3d4e5f60718',
  sourceId: 'ars-technica',
  topics: ['science'],
  action: 'upvote',
  ts: 1_700_000_000_000,
};

describe('isValidEvent — topic taxonomy', () => {
  it('accepts events whose topics are all in the taxonomy', () => {
    expect(isValidEvent({ ...validEvent, topics: ['science', 'technology'] })).toBe(true);
  });

  it('rejects events with an off-taxonomy topic', () => {
    expect(isValidEvent({ ...validEvent, topics: ['science', 'astrology'] })).toBe(false);
  });

  it('accepts every taxonomy topic', () => {
    for (const topic of TOPICS) {
      expect(isValidEvent({ ...validEvent, topics: [topic] })).toBe(true);
    }
  });
});

describe('canonical action vocabulary', () => {
  it('accepts every canonical action and rejects unknown ones', () => {
    for (const action of ACTIONS) {
      expect(isValidEvent({ ...validEvent, action })).toBe(true);
    }
    expect(isValidEvent({ ...validEvent, action: 'share' })).toBe(false);
  });

  it('keeps ACTION_RATING keys in lockstep with the canonical action list', () => {
    expect(Object.keys(ACTION_RATING).sort()).toEqual([...ACTIONS].sort());
  });
});

describe('factor schema tie', () => {
  // The user_factors/item_factors tables persist exactly v0..v9. If nFactors
  // drifts from 10, persistence silently corrupts — this is the tripwire.
  it('DEFAULT_MF_PARAMS.nFactors matches the v0..v9 column schema width', () => {
    expect(DEFAULT_MF_PARAMS.nFactors).toBe(10);
    expect(zeroFactorRow(DEFAULT_MF_PARAMS).v).toHaveLength(10);
  });
});
