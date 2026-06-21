// Tunable constants for the RecDO: retention windows, model params, candidate pools.

import { DEFAULT_MF_PARAMS } from './scoring';

const HOURS_PER_DAY      = 24;
const MINUTES_PER_HOUR   = 60;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND      = 1000;
const MS_PER_DAY = HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND;

const INTERACTION_RETENTION_DAYS = 30;
const FACTOR_RETENTION_DAYS      = 180; // decoupled from interactions

export const INTERACTION_RETENTION_MS = INTERACTION_RETENTION_DAYS * MS_PER_DAY;
export const FACTOR_RETENTION_MS      = FACTOR_RETENTION_DAYS * MS_PER_DAY;
export const MF_PARAMS = DEFAULT_MF_PARAMS;
// quality-ok: magic-number — value is the definition of this named constant
export const GLOBAL_CANDIDATE_LIMIT = 200;

/**
 * Users with fewer than this many interactions get a diversity-bucketed candidate
 * pool (top-N per topic) rather than pure top-by-bias, breaking the popularity loop.
 */
// quality-ok: magic-number — value is the definition of this named constant
export const COLD_START_THRESHOLD = 30;
// quality-ok: magic-number — value is the definition of this named constant
export const PER_TOPIC_DIVERSITY  = 10; // max articles per topic in cold-start pool
