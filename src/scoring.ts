import type { Action } from './types';

// ─── BiasedMF ────────────────────────────────────────────────────────────────

/**
 * Maps each interaction action to a numeric training signal.
 * Use these values when building your own rating matrix outside the Worker.
 */
export const ACTION_RATING: Record<Action, number> = {
  save:     2.0,
  upvote:   1.0,
  read:     0.5,
  seen:     0.1,
  downvote: -1.0,
};

/** Hyperparameters for the Biased Matrix Factorization model. */
export interface MfParams {
  /** Number of latent factors per user/item vector. Default: 10. */
  nFactors:     number;
  /** Learning rate for bias terms. Default: 0.05. */
  lrBias:       number;
  /** Learning rate for latent factor vectors. Default: 0.05. */
  lrLatent:     number;
  /** L2 regularisation coefficient for biases (0 = no regularisation). Default: 0. */
  l2Bias:       number;
  /** L2 regularisation coefficient for latent vectors. Default: 0.05. */
  l2Latent:     number;
  /** Clips the residual error before gradient computation to prevent runaway updates. Default: 10. */
  clipError: number;
  /** Standard deviation for random normal factor initialisation. Default: 0.1. */
  sigmaInit:    number;
}

/**
 * Production-tuned defaults. Override individual fields with the spread operator:
 * `{ ...DEFAULT_MF_PARAMS, nFactors: 20 }`.
 */
export const DEFAULT_MF_PARAMS: MfParams = {
  nFactors:     10,
  lrBias:       0.05,
  lrLatent:     0.05,
  l2Bias:       0.0,
  l2Latent:     0.05,
  clipError: 10.0,
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
  // Box-Muller formula literals (-2, ε=1e-10, 2π) are the spec, not hidden constants
  // eslint-disable-next-line no-magic-numbers
  return sigma * Math.sqrt(-2 * Math.log(u1 + 1e-10)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Allocates a new factor row with bias 0 and latent vector initialised from
 * N(0, `params.sigmaInit`). Use for a freshly seen user or item.
 */
export function newFactorRow(params: MfParams): FactorRow {
  return {
    bias: 0,
    v: Array.from({ length: params.nFactors }, () => normalSample(params.sigmaInit)),
  };
}

/**
 * Allocates a factor row of all zeros. Used for cold-start scoring:
 * `mfPredict(globalMean, zeroUser, itemFactor)` reduces to `globalMean + item.bias`.
 */
export function zeroFactorRow(params: MfParams): FactorRow {
  return { bias: 0, v: new Array<number>(params.nFactors).fill(0) };
}

/**
 * Computes the BiasedMF predicted score for a (user, item) pair.
 *
 * Formula: `ŷ = globalMean + user.bias + item.bias + dot(user.v, item.v)`
 *
 * @param globalMean - Running mean of all observed ratings.
 * @param user - Learned user factor row (`bias` + latent vector `v`).
 * @param item - Learned item factor row (`bias` + latent vector `v`).
 * @returns Predicted rating (unbounded float).
 */
export function mfPredict(
  globalMean: number,
  user: FactorRow,
  item: FactorRow,
): number {
  let dot = 0;
  for (let f = 0; f < user.v.length; f++) dot += user.v[f] * item.v[f];
  return globalMean + user.bias + item.bias + dot;
}

/** Inputs to one online SGD step of Biased Matrix Factorization. */
export interface MfLearnInput {
  /** Hyperparameters controlling learning rates, regularisation, and clipping. */
  params:     MfParams;
  /** Current running mean of all observed ratings. */
  globalMean: number;
  /** Number of ratings seen so far (before this one). */
  n:          number;
  /** Current user factor row. */
  user:       FactorRow;
  /** Current item factor row. */
  item:       FactorRow;
  /** Observed rating for this (user, item) pair (see `ACTION_RATING`). */
  rating:     number;
}

/**
 * Performs one online SGD step of Biased Matrix Factorization.
 *
 * Returns updated copies of `globalMean`, `n`, `user`, and `item` — inputs
 * are never mutated. Latent vectors are updated simultaneously (both gradients
 * are computed from the old vectors before either is applied).
 *
 * @returns `{ globalMean, n, user, item }` — updated state after one SGD step.
 */
export function mfLearnOne(
  input: MfLearnInput,
): { globalMean: number; n: number; user: FactorRow; item: FactorRow } {
  const { params, globalMean, n, user, item, rating } = input;
  const pred   = mfPredict(globalMean, user, item);
  const rawErr = rating - pred;
  const err    = Math.max(-params.clipError, Math.min(params.clipError, rawErr));

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
