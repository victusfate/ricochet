import { describe, it, expect } from 'vitest';
import {
  ACTION_RATING,
  DEFAULT_MF_PARAMS,
  mfPredict,
  mfLearnOne,
  zeroFactorRow,
} from './scoring';

// ── S1 — BiasedMF pure math ───────────────────────────────────────────────────

describe('S1 — ACTION_RATING', () => {
  it('has correct value for every action', () => {
    expect(ACTION_RATING.save).toBe(2.0);
    expect(ACTION_RATING.upvote).toBe(1.0);
    expect(ACTION_RATING.read).toBe(0.5);
    expect(ACTION_RATING.seen).toBe(0.1);
    expect(ACTION_RATING.downvote).toBe(-1.0);
  });
});

describe('S1 — mfPredict', () => {
  it('returns ȳ + bu + bi + dot(vu, vi) for known inputs', () => {
    const user = { bias: 0.1, v: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0] };
    const item = { bias: 0.2, v: [0.5, 0, 0, 0, 0, 0, 0, 0, 0, 0] };
    // ŷ = 0.3 + 0.1 + 0.2 + (1×0.5) = 1.1
    expect(mfPredict(0.3, user, item)).toBeCloseTo(1.1);
  });
});

describe('S1 — mfLearnOne', () => {
  it('reduces prediction error after one step', () => {
    const user = zeroFactorRow(DEFAULT_MF_PARAMS);
    const item = { bias: 0, v: new Array(10).fill(0.1) };
    const rating = 2.0;

    const errBefore = Math.abs(rating - mfPredict(0.3, user, item));
    const res = mfLearnOne({ params: DEFAULT_MF_PARAMS, globalMean: 0.3, n: 10, user, item, rating });
    const errAfter = Math.abs(rating - mfPredict(res.globalMean, res.user, res.item));

    expect(errAfter).toBeLessThan(errBefore);
  });

  it('converges prediction toward rating after many steps', () => {
    const params = DEFAULT_MF_PARAMS;
    let mean = 0;
    let n = 0;
    let u = zeroFactorRow(params);
    let i = { bias: 0, v: new Array(10).fill(0.1) };
    const rating = 1.0;

    for (let iter = 0; iter < 200; iter++) {
      const res = mfLearnOne({ params, globalMean: mean, n, user: u, item: i, rating });
      mean = res.globalMean; n = res.n; u = res.user; i = res.item;
    }

    expect(mfPredict(mean, u, i)).toBeCloseTo(rating, 1);
  });

  it('save (2.0) produces larger bias update than upvote (1.0)', () => {
    const params = DEFAULT_MF_PARAMS;
    const baseUser = zeroFactorRow(params);
    const baseItem = zeroFactorRow(params);

    const resSave   = mfLearnOne({ params, globalMean: 0, n: 0, user: baseUser, item: { ...baseItem, v: [...baseItem.v] }, rating: 2.0 });
    const resUpvote = mfLearnOne({ params, globalMean: 0, n: 0, user: baseUser, item: { ...baseItem, v: [...baseItem.v] }, rating: 1.0 });

    expect(Math.abs(resSave.item.bias)).toBeGreaterThan(Math.abs(resUpvote.item.bias));
  });

  it('downvote (-1.0) moves prediction below global mean after repeated steps', () => {
    const params = DEFAULT_MF_PARAMS;
    let mean = 0, n = 0;
    let u = zeroFactorRow(params);
    let i = { bias: 0, v: new Array(10).fill(0.1) };

    for (let iter = 0; iter < 100; iter++) {
      const res = mfLearnOne({ params, globalMean: mean, n, user: u, item: i, rating: -1.0 });
      mean = res.globalMean; n = res.n; u = res.user; i = res.item;
    }

    expect(mfPredict(mean, u, i)).toBeLessThan(0);
  });

  it('clips gradient when error exceeds clipError', () => {
    const params = { ...DEFAULT_MF_PARAMS, clipError: 1.0, l2Bias: 0 };
    const user = zeroFactorRow(params);
    const item = zeroFactorRow(params);

    // pred = 0, rating = 100 → raw err = 100, clipped to 1.0
    // bias update = lrBias * 1.0 = 0.05
    const res = mfLearnOne({ params, globalMean: 0, n: 0, user, item, rating: 100 });
    expect(res.user.bias).toBeCloseTo(0.05);
    expect(res.item.bias).toBeCloseTo(0.05);
  });

  it('l2 regularisation shrinks latent weights when err = 0', () => {
    const params = { ...DEFAULT_MF_PARAMS, l2Latent: 0.2, lrLatent: 0.1, clipError: 1e12 };
    const user = { bias: 0, v: new Array(10).fill(0.5) };
    const item = { bias: 0, v: new Array(10).fill(0.5) };

    // Set rating = current prediction so err = 0; only l2 acts on latent weights
    const pred = mfPredict(0, user, item);
    const res  = mfLearnOne({ params, globalMean: 0, n: 100, user, item, rating: pred });

    // new v[f] = v[f] + lrLatent * (0 - l2 * v[f]) = v[f] * (1 - lrLatent * l2) < v[f]
    expect(res.user.v[0]).toBeLessThan(user.v[0]);
    expect(res.item.v[0]).toBeLessThan(item.v[0]);
  });

  it('global mean tracks running average of ratings', () => {
    const params = DEFAULT_MF_PARAMS;
    let mean = 0, n = 0;
    let u = zeroFactorRow(params);
    let i = zeroFactorRow(params);

    const ratings = [2.0, 1.0, 0.5, -1.0, 2.0];
    for (const rating of ratings) {
      const res = mfLearnOne({ params, globalMean: mean, n, user: u, item: i, rating });
      mean = res.globalMean; n = res.n; u = res.user; i = res.item;
    }

    const expected = ratings.reduce((a, b) => a + b, 0) / ratings.length;
    expect(mean).toBeCloseTo(expected, 10);
  });
});
