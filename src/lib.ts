// Public library API — no Cloudflare Worker dependencies.
// Safe to import in Node, browsers, and edge runtimes.

export type {
  Topic, Action, InteractionEvent, RecCoreResponse, RecResponse, ScoredArticle,
  RecDiagnostics, RecTraceInfo, RecCacheInfo, RecTimingMs,
} from './types';
export { isValidEvent } from './validation';
export {
  ACTION_RATING,
  DEFAULT_MF_PARAMS,
  mfPredict,
  mfLearnOne,
  newFactorRow,
  zeroFactorRow,
} from './scoring';
export type { MfParams, FactorRow } from './scoring';
