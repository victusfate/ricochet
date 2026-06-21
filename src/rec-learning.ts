// Write-side BiasedMF online learning: ingest one interaction event.

import type { InteractionEvent } from './types';
import { ACTION_RATING, mfLearnOne, newFactorRow } from './scoring';
import { MF_PARAMS } from './rec-config';
import { dbRowToFactorRow, factorRowToBindParams, type FactorsDbRow } from './rec-db';

/**
 * Learns from one event, updating factor tables and the passed-in global
 * state (mutated; the caller persists it once per batch).
 */
export function learnOne(
  sql: SqlStorage,
  event: InteractionEvent,
  gs: { mean: number; n: number },
): void {
  const rating = ACTION_RATING[event.action];
  if (rating === undefined) return;

  const now = Date.now();

  // Dedup — only learn from each (user, article, action) triple once.
  // The UPDATE doubles as the existence check (rowsWritten > 0 means dup);
  // it refreshes ts with server-side `now` rather than event.ts because
  // client-supplied timestamps could bypass the 30-day prune window.
  const dup = sql.exec(
    `UPDATE interactions SET ts = ? WHERE user_id = ? AND article_id = ? AND action = ?`,
    now, event.userId, event.articleId, event.action,
  );
  if (dup.rowsWritten > 0) return;

  sql.exec(
    `INSERT INTO interactions (user_id, article_id, source_id, action, topics, ts)
     VALUES (?, ?, ?, ?, ?, ?)`,
    event.userId, event.articleId, event.sourceId,
    // Use server-side `now` to prevent timestamp spoofing that could bypass pruning.
    event.action, JSON.stringify(event.topics), now,
  );

  const [uDbRow] = [...sql.exec<FactorsDbRow>(
    `SELECT bias,v0,v1,v2,v3,v4,v5,v6,v7,v8,v9
     FROM user_factors WHERE user_id = ?`,
    event.userId,
  )];
  const uFactor = uDbRow ? dbRowToFactorRow(uDbRow) : newFactorRow(MF_PARAMS);

  const [iDbRow] = [...sql.exec<FactorsDbRow>(
    `SELECT bias,v0,v1,v2,v3,v4,v5,v6,v7,v8,v9
     FROM item_factors WHERE article_id = ?`,
    event.articleId,
  )];
  const iFactor = iDbRow ? dbRowToFactorRow(iDbRow) : newFactorRow(MF_PARAMS);

  const res = mfLearnOne({
    params: MF_PARAMS, globalMean: gs.mean, n: gs.n, user: uFactor, item: iFactor, rating,
  });
  gs.mean = res.globalMean;
  gs.n    = res.n;

  // v-column update clause shared by both upserts; defined once to prevent schema drift.
  const V_UPDATE = 'v0=excluded.v0,v1=excluded.v1,v2=excluded.v2,v3=excluded.v3,v4=excluded.v4,'
                 + 'v5=excluded.v5,v6=excluded.v6,v7=excluded.v7,v8=excluded.v8,v9=excluded.v9';

  sql.exec(
    `INSERT INTO user_factors
       (user_id,bias,v0,v1,v2,v3,v4,v5,v6,v7,v8,v9,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET
       bias=excluded.bias,${V_UPDATE},
       updated_at=excluded.updated_at`,
    event.userId, res.user.bias,
    ...factorRowToBindParams(res.user.v),
    now,
  );

  sql.exec(
    `INSERT INTO item_factors
       (article_id,bias,v0,v1,v2,v3,v4,v5,v6,v7,v8,v9,source_id,topic,all_topics,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(article_id) DO UPDATE SET
       bias=excluded.bias,${V_UPDATE},
       source_id=excluded.source_id, topic=excluded.topic,
       all_topics=excluded.all_topics, updated_at=excluded.updated_at`,
    event.articleId, res.item.bias,
    ...factorRowToBindParams(res.item.v),
    event.sourceId, event.topics[0] ?? '', JSON.stringify(event.topics), now,
  );
}
