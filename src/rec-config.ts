// Tunable constants for the RecDO: retention windows, model params, candidate pools.

import { DEFAULT_MF_PARAMS } from './scoring';

export const INTERACTION_RETENTION_MS = 30  * 24 * 60 * 60 * 1000; // 30 days
export const FACTOR_RETENTION_MS      = 180 * 24 * 60 * 60 * 1000; // 180 days — decoupled from interactions
export const MF_PARAMS = DEFAULT_MF_PARAMS;
export const GLOBAL_CANDIDATE_LIMIT = 200;

/**
 * Users with fewer than this many interactions get a diversity-bucketed candidate
 * pool (top-N per topic) rather than pure top-by-bias, breaking the popularity loop.
 */
export const COLD_START_THRESHOLD = 30;
export const PER_TOPIC_DIVERSITY  = 10; // max articles per topic in cold-start pool
