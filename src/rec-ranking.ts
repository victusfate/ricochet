// Read-side candidate generation and BiasedMF scoring for the RecDO.

import type { ScoredArticle } from './types';
import { mfPredict, zeroFactorRow } from './scoring';
import { MF_PARAMS, PER_TOPIC_DIVERSITY } from './rec-config';
import { dbRowToFactorRow, parseTopicsJson, readGlobalState, selectByIdsChunked, type FactorsDbRow } from './rec-db';

/** Returns top-N articles by item bias — used for warm users (≥ COLD_START_THRESHOLD interactions). */
export function getTopCandidates(sql: SqlStorage, limit: number): string[] {
  type Row = { article_id: string };
  return [...sql.exec<Row>(
    `SELECT article_id FROM item_factors ORDER BY bias DESC LIMIT ?`,
    limit,
  )].map(r => r.article_id);
}

/**
 * Returns a diversity-bucketed candidate pool for cold-start users.
 * Takes up to PER_TOPIC_DIVERSITY articles per topic (breaking the popularity
 * feedback loop), then fills remaining slots with top-by-bias articles.
 */
export function getDiverseCandidates(sql: SqlStorage, totalLimit: number): string[] {
  type Row = { article_id: string };

  // Top PER_TOPIC_DIVERSITY per topic using SQLite window functions.
  const diverseRows = [...sql.exec<Row>(`
    SELECT article_id FROM (
      SELECT article_id,
        ROW_NUMBER() OVER (PARTITION BY topic ORDER BY bias DESC) AS rn
      FROM item_factors
      WHERE topic != ''
    ) WHERE rn <= ?
  `, PER_TOPIC_DIVERSITY)];

  const seen = new Set(diverseRows.map(r => r.article_id));

  // Fill remaining slots (and handle articles with empty topic) with top-by-bias overall.
  if (seen.size < totalLimit) {
    const fillRows = [...sql.exec<Row>(
      `SELECT article_id FROM item_factors ORDER BY bias DESC LIMIT ?`,
      // Overfetch by seen.size: up to that many results will be diverse-set duplicates.
      totalLimit + seen.size,
    )];
    for (const r of fillRows) {
      if (seen.size >= totalLimit) break;
      if (!seen.has(r.article_id)) {
        diverseRows.push(r);
        seen.add(r.article_id);
      }
    }
  }

  return diverseRows.slice(0, totalLimit).map(r => r.article_id);
}

/** Returns the number of interactions recorded for a given user. */
export function getInteractionCount(sql: SqlStorage, userId: string): number {
  type Row = { cnt: number };
  const [row] = [...sql.exec<Row>(
    `SELECT COUNT(*) AS cnt FROM interactions WHERE user_id = ?`,
    userId,
  )];
  return row?.cnt ?? 0;
}

/**
 * Scores and ranks candidates for a user using BiasedMF.
 * Applies optional topicWeights multipliers to shift ranking toward preferred topics.
 */
export function scoreCandidates(
  sql: SqlStorage,
  userId: string,
  candidateIds: string[],
  topicWeights?: Record<string, number>,
): {
  ranked: ScoredArticle[];
  excludedDownvotes: number;
  coldStart: boolean;
  coldItemCount: number;
  warmItemCount: number;
} {
  const globalMean = readGlobalState(sql).mean;

  const [uDbRow] = [...sql.exec<FactorsDbRow>(
    `SELECT bias,v0,v1,v2,v3,v4,v5,v6,v7,v8,v9
     FROM user_factors WHERE user_id = ?`,
    userId,
  )];
  // Cold start: zero vector → score = globalMean + bi_i
  const coldStart = !uDbRow;
  const uFactor = uDbRow ? dbRowToFactorRow(uDbRow) : zeroFactorRow(MF_PARAMS);

  type IdRow = { article_id: string };
  const downvoted = new Set(
    [...sql.exec<IdRow>(
      `SELECT article_id FROM interactions WHERE user_id = ? AND action = 'downvote'`,
      userId,
    )].map(r => r.article_id),
  );

  type ItemRow = FactorsDbRow & { article_id: string; topic: string; all_topics: string };
  const itemRows = selectByIdsChunked<ItemRow>(
    sql,
    `SELECT article_id,bias,v0,v1,v2,v3,v4,v5,v6,v7,v8,v9,topic,all_topics
     FROM item_factors WHERE article_id IN`,
    candidateIds,
  );
  // Pre-parse topics once per row — not inside the per-candidate loop.
  // Fallback to primary topic for rows written before all_topics was added.
  const itemById = new Map(itemRows.map(row => {
    let topics = parseTopicsJson(row.all_topics);
    if (topics.length === 0) topics = [row.topic];
    return [row.article_id, { row, topics }] as const;
  }));
  const coldItem = zeroFactorRow(MF_PARAMS);

  let excludedDownvotes = 0;
  let coldItemCount = 0;
  let warmItemCount = 0;
  const ranked: ScoredArticle[] = [];

  for (const candidateId of candidateIds) {
    if (downvoted.has(candidateId)) {
      excludedDownvotes += 1;
      continue;
    }
    const item = itemById.get(candidateId);
    const baseScore = mfPredict(globalMean, uFactor, item ? dbRowToFactorRow(item.row) : coldItem);
    let weight = 1.0;
    if (topicWeights && item) {
      // Check all stored topics so multi-topic articles match any weighted topic.
      weight = item.topics.reduce((best, t) => Math.max(best, topicWeights[t] ?? 1.0), 1.0);
    }
    if (item) {
      warmItemCount += 1;
    } else {
      coldItemCount += 1;
    }
    ranked.push({ articleId: candidateId, score: baseScore * weight });
  }
  ranked.sort((a, b) => b.score - a.score || a.articleId.localeCompare(b.articleId));

  return {
    ranked,
    excludedDownvotes,
    coldStart,
    coldItemCount,
    warmItemCount,
  };
}
