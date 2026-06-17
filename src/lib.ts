// Public library API — no Cloudflare Worker dependencies.
// Safe to import in Node, browsers, and edge runtimes.

export * from './types';
export { isValidEvent } from './validation';
export { parseTopicWeights } from './parsing';
export {
  ACTION_RATING,
  DEFAULT_MF_PARAMS,
  mfPredict,
  mfLearnOne,
  newFactorRow,
  zeroFactorRow,
} from './scoring';
export type { MfParams, FactorRow, MfLearnInput } from './scoring';
