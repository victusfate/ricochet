import type { Action } from './types';

// ─── Legacy popularity scoring (retained until S6 cleanup) ───────────────────

export const ACTION_SCORE: Record<Action, number> = {
  read:     1,
  upvote:   3,
  save:     2,
  seen:     0.1,
  downvote: -2,
};

export const ACTION_COLUMN: Record<Action, string> = {
  read:     'reads',
  upvote:   'upvotes',
  downvote: 'downvotes',
  save:     'saves',
  seen:     'seens',
};

export function scoreDelta(action: Action): number {
  return ACTION_SCORE[action] ?? 0;
}

// ─── BiasedMF ────────────────────────────────────────────────────────────────

export const ACTION_RATING: Record<Action, number> = {
  save:     2.0,
  upvote:   1.0,
  read:     0.5,
  seen:     0.1,
  downvote: -1.0,
};

export interface MfParams {
  nFactors:     number;
  lrBias:       number;
  lrLatent:     number;
  l2Bias:       number;
  l2Latent:     number;
  clipGradient: number;
  sigmaInit:    number;
}

export const DEFAULT_MF_PARAMS: MfParams = {
  nFactors:     10,
  lrBias:       0.05,
  lrLatent:     0.05,
  l2Bias:       0.0,
  l2Latent:     0.05,
  clipGradient: 10.0,
  sigmaInit:    0.1,
};

export interface FactorRow {
  bias: number;
  v:    number[];  // length === nFactors
}

function normalSample(sigma: number): number {
  // Box-Muller transform — N(0, sigma)
  const u1 = Math.random();
  const u2 = Math.random();
  return sigma * Math.sqrt(-2 * Math.log(u1 + 1e-10)) * Math.cos(2 * Math.PI * u2);
}

export function newFactorRow(params: MfParams): FactorRow {
  return {
    bias: 0,
    v: Array.from({ length: params.nFactors }, () => normalSample(params.sigmaInit)),
  };
}

export function zeroFactorRow(params: MfParams): FactorRow {
  return { bias: 0, v: new Array(params.nFactors).fill(0) };
}

/** ŷ = ȳ + bu_u + bi_i + ⟨v_u, v_i⟩ */
export function mfPredict(
  globalMean: number,
  user: FactorRow,
  item: FactorRow,
): number {
  let dot = 0;
  for (let f = 0; f < user.v.length; f++) dot += user.v[f] * item.v[f];
  return globalMean + user.bias + item.bias + dot;
}

/**
 * One online SGD step. Returns updated copies — does not mutate inputs.
 * Latent vectors use simultaneous update: both gradients are computed from
 * old vectors before either is applied.
 */
export function mfLearnOne(
  params:     MfParams,
  globalMean: number,
  n:          number,
  user:       FactorRow,
  item:       FactorRow,
  rating:     number,
): { globalMean: number; n: number; user: FactorRow; item: FactorRow } {
  const pred   = mfPredict(globalMean, user, item);
  const rawErr = rating - pred;
  const err    = Math.max(-params.clipGradient, Math.min(params.clipGradient, rawErr));

  const newN    = n + 1;
  const newMean = globalMean + (rating - globalMean) / newN;

  const newUserBias = user.bias + params.lrBias * (err - params.l2Bias * user.bias);
  const newItemBias = item.bias + params.lrBias * (err - params.l2Bias * item.bias);

  const newUV = new Array<number>(params.nFactors);
  const newIV = new Array<number>(params.nFactors);
  for (let f = 0; f < params.nFactors; f++) {
    newUV[f] = user.v[f] + params.lrLatent * (err * item.v[f] - params.l2Latent * user.v[f]);
    newIV[f] = item.v[f] + params.lrLatent * (err * user.v[f] - params.l2Latent * item.v[f]);
  }

  return {
    globalMean: newMean,
    n:    newN,
    user: { bias: newUserBias, v: newUV },
    item: { bias: newItemBias, v: newIV },
  };
}
