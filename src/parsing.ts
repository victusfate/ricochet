/** Shared parsing utilities — used by both the Worker edge layer and the RecDO. */

import { REC_MAX_CANDIDATES } from './types';

export const MAX_LIMIT    = 200;
export const DEFAULT_LIMIT = 50;

// Caps on the topicWeights map from an untrusted source.
const MAX_TOPIC_WEIGHT_ENTRIES = 20;  // reject maps with too many topics
const MAX_TOPIC_WEIGHT         = 10;  // clamp each multiplier to prevent runaway score skewing

export function parseLimit(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(value)));
  }
  if (typeof value === 'string') {
    const parsed = parseInt(value, 10);
    if (!Number.isNaN(parsed)) return Math.max(1, Math.min(MAX_LIMIT, parsed));
  }
  return DEFAULT_LIMIT;
}

/** Discriminated parse outcome — success carries the value, failure the canonical message. */
export type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string };

export function parseCandidateArticleIds(value: unknown): ParseResult<string[] | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(value)) {
    return { ok: false, message: 'candidateArticleIds must be an array of non-empty strings' };
  }
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== 'string') {
      return { ok: false, message: 'candidateArticleIds must contain only strings' };
    }
    const id = raw.trim();
    if (!id) return { ok: false, message: 'candidateArticleIds must not contain empty IDs' };
    if (seen.has(id)) continue;
    seen.add(id);
    deduped.push(id);
  }
  return { ok: true, value: deduped };
}

export function parseCandidatesCsv(raw: string | null): string[] | undefined {
  if (raw === null) return undefined;
  if (!raw.trim()) return [];
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const id = part.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push(id);
  }
  return deduped;
}

/**
 * Parses and validates a topic-weights map from an untrusted source.
 * Keys are topic names; values are non-negative multipliers capped at 10×.
 */
export function parseTopicWeights(
  value: unknown,
): { weights?: Record<string, number>; message?: string } {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { message: 'topicWeights must be an object mapping topic names to numeric weights' };
  }
  const raw = value as Record<string, unknown>;
  const keys = Object.keys(raw);
  if (keys.length > MAX_TOPIC_WEIGHT_ENTRIES) {
    return { message: `topicWeights must not exceed ${MAX_TOPIC_WEIGHT_ENTRIES} entries` };
  }
  const result: Record<string, number> = {};
  for (const k of keys) {
    const v = raw[k];
    if (!k) return { message: 'topicWeights keys must be non-empty strings' };
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      return { message: `topicWeights["${k}"] must be a non-negative finite number` };
    }
    result[k] = Math.min(v, MAX_TOPIC_WEIGHT);
  }
  return { weights: result };
}

/** Builds the discriminated input object for `parseRankRequest` from raw HTTP primitives. */
export function makeRankInput(
  method: 'GET' | 'POST',
  searchParams: URLSearchParams,
  body?: unknown,
): { method: 'GET'; searchParams: URLSearchParams } | { method: 'POST'; searchParams: URLSearchParams; body: unknown } {
  return method === 'GET'
    ? { method: 'GET', searchParams }
    : { method: 'POST', searchParams, body };
}

/** Fully parsed and validated inputs of a /recommendations rank request. */
export interface RankRequest {
  limit: number;
  /** True when the request explicitly supplied a candidate pool (even an empty one). */
  candidateModeProvided: boolean;
  candidateArticleIds?: string[];
  topicWeights?: Record<string, number>;
}

/**
 * Parses a rank request from either a GET query string or a POST JSON body.
 * Shared by the Worker edge layer and the RecDO so validation and the
 * REC_MAX_CANDIDATES cap are enforced identically for CSV and array input.
 * The `body` is the already-JSON-parsed POST payload (JSON syntax errors are
 * the caller's concern).
 */
export function parseRankRequest(
  input:
    | { method: 'GET'; searchParams: URLSearchParams }
    | { method: 'POST'; searchParams: URLSearchParams; body: unknown },
): ParseResult<RankRequest> {
  let limit = parseLimit(input.searchParams.get('limit'));
  let candidateModeProvided: boolean;
  let candidateArticleIds: string[] | undefined;
  let topicWeights: Record<string, number> | undefined;

  if (input.method === 'GET') {
    candidateModeProvided = input.searchParams.has('candidates');
    candidateArticleIds = parseCandidatesCsv(input.searchParams.get('candidates'));
  } else {
    const body = input.body;
    if (body !== null && typeof body !== 'object') {
      return { ok: false, message: 'Invalid JSON body' };
    }
    const obj = body as { candidateArticleIds?: unknown; limit?: unknown; topicWeights?: unknown } | null;
    candidateModeProvided = obj !== null && Object.prototype.hasOwnProperty.call(obj, 'candidateArticleIds');
    const parsed = parseCandidateArticleIds(obj?.candidateArticleIds);
    if (!parsed.ok) return parsed;
    candidateArticleIds = parsed.value;
    if (obj?.limit !== undefined) limit = parseLimit(obj.limit);
    if (obj?.topicWeights !== undefined) {
      const parsedTw = parseTopicWeights(obj.topicWeights);
      if (parsedTw.message) return { ok: false, message: parsedTw.message };
      topicWeights = parsedTw.weights;
    }
  }

  if (candidateArticleIds && candidateArticleIds.length > REC_MAX_CANDIDATES) {
    return { ok: false, message: `Too many candidateArticleIds in request; max ${REC_MAX_CANDIDATES}` };
  }

  return { ok: true, value: { limit, candidateModeProvided, candidateArticleIds, topicWeights } };
}
