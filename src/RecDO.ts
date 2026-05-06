import type { InteractionEvent } from './types';
import {
  ACTION_RATING, DEFAULT_MF_PARAMS, newFactorRow, zeroFactorRow,
  mfLearnOne, mfPredict,
} from './scoring';
import type { FactorRow } from './scoring';

const SQLITE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MF_PARAMS = DEFAULT_MF_PARAMS;

type FactorsDbRow = {
  bias: number;
  v0: number; v1: number; v2: number; v3: number; v4: number;
  v5: number; v6: number; v7: number; v8: number; v9: number;
};

function dbRowToFactorRow(row: FactorsDbRow): FactorRow {
  return {
    bias: row.bias,
    v: [row.v0, row.v1, row.v2, row.v3, row.v4,
        row.v5, row.v6, row.v7, row.v8, row.v9],
  };
}

export class RecDO implements DurableObject {
  constructor(private state: DurableObjectState, private _env: Env) {
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS interactions (
        user_id    TEXT NOT NULL,
        article_id TEXT NOT NULL,
        source_id  TEXT NOT NULL,
        action     TEXT NOT NULL,
        topics     TEXT NOT NULL,
        ts         INTEGER NOT NULL,
        PRIMARY KEY (user_id, article_id, action)
      )
    `);
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS global_state (
        id   INTEGER PRIMARY KEY DEFAULT 1,
        mean REAL    NOT NULL DEFAULT 0,
        n    INTEGER NOT NULL DEFAULT 0
      )
    `);
    this.state.storage.sql.exec(
      `INSERT OR IGNORE INTO global_state (id, mean, n) VALUES (1, 0, 0)`,
    );
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS user_factors (
        user_id    TEXT    PRIMARY KEY,
        bias       REAL    NOT NULL DEFAULT 0,
        v0  REAL NOT NULL DEFAULT 0, v1  REAL NOT NULL DEFAULT 0,
        v2  REAL NOT NULL DEFAULT 0, v3  REAL NOT NULL DEFAULT 0,
        v4  REAL NOT NULL DEFAULT 0, v5  REAL NOT NULL DEFAULT 0,
        v6  REAL NOT NULL DEFAULT 0, v7  REAL NOT NULL DEFAULT 0,
        v8  REAL NOT NULL DEFAULT 0, v9  REAL NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0
      )
    `);
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS item_factors (
        article_id TEXT    PRIMARY KEY,
        bias       REAL    NOT NULL DEFAULT 0,
        v0  REAL NOT NULL DEFAULT 0, v1  REAL NOT NULL DEFAULT 0,
        v2  REAL NOT NULL DEFAULT 0, v3  REAL NOT NULL DEFAULT 0,
        v4  REAL NOT NULL DEFAULT 0, v5  REAL NOT NULL DEFAULT 0,
        v6  REAL NOT NULL DEFAULT 0, v7  REAL NOT NULL DEFAULT 0,
        v8  REAL NOT NULL DEFAULT 0, v9  REAL NOT NULL DEFAULT 0,
        source_id  TEXT    NOT NULL DEFAULT '',
        topic      TEXT    NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL DEFAULT 0
      )
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/ingest' && request.method === 'POST') {
      const events = await request.json() as InteractionEvent[];
      for (const event of events) this.learnOne(event);
      return new Response(null, { status: 204 });
    }

    const recsMatch = url.pathname.match(/^\/recs\/(.+)$/);
    if (recsMatch && request.method === 'GET') {
      const userId = decodeURIComponent(recsMatch[1]);
      const limit  = parseInt(url.searchParams.get('limit') ?? '50', 10);
      const candidates = this.getTopCandidates(200);
      const articleIds = this.score(userId, candidates).slice(0, limit);
      return new Response(
        JSON.stringify({ articleIds, generatedAt: Date.now() }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }

    if (url.pathname === '/prune' && request.method === 'POST') {
      const cutoffParam = url.searchParams.get('cutoff');
      const cutoff = cutoffParam !== null
        ? parseInt(cutoffParam, 10)
        : Date.now() - SQLITE_RETENTION_MS;
      this.prune(cutoff);
      return new Response(null, { status: 204 });
    }

    // Debug endpoints — not exposed through the public Worker
    if (url.pathname === '/debug/global-state' && request.method === 'GET') {
      type GsRow = { mean: number; n: number };
      const [row] = [...this.state.storage.sql.exec<GsRow>(
        `SELECT mean, n FROM global_state WHERE id = 1`,
      )];
      return Response.json(row ?? { mean: 0, n: 0 });
    }
    if (url.pathname === '/debug/user-factors-count' && request.method === 'GET') {
      type CountRow = { count: number };
      const [row] = [...this.state.storage.sql.exec<CountRow>(
        `SELECT COUNT(*) AS count FROM user_factors`,
      )];
      return Response.json(row);
    }
    if (url.pathname === '/debug/item-factors-count' && request.method === 'GET') {
      type CountRow = { count: number };
      const [row] = [...this.state.storage.sql.exec<CountRow>(
        `SELECT COUNT(*) AS count FROM item_factors`,
      )];
      return Response.json(row);
    }
    if (url.pathname === '/debug/interactions-count' && request.method === 'GET') {
      type CountRow = { count: number };
      const [row] = [...this.state.storage.sql.exec<CountRow>(
        `SELECT COUNT(*) AS count FROM interactions`,
      )];
      return Response.json(row);
    }

    return new Response('Not Found', { status: 404 });
  }

  // ── S3: BiasedMF online learning ──────────────────────────────────────────

  learnOne(event: InteractionEvent): void {
    const rating = ACTION_RATING[event.action];
    if (rating === undefined) return;

    const now = Date.now();

    // Dedup — only learn from each (user, article, action) triple once
    type CntRow = { cnt: number };
    const [dup] = [...this.state.storage.sql.exec<CntRow>(
      `SELECT COUNT(*) AS cnt FROM interactions
       WHERE user_id = ? AND article_id = ? AND action = ?`,
      event.userId, event.articleId, event.action,
    )];
    if ((dup?.cnt ?? 0) > 0) {
      this.state.storage.sql.exec(
        `UPDATE interactions SET ts = ? WHERE user_id = ? AND article_id = ? AND action = ?`,
        event.ts, event.userId, event.articleId, event.action,
      );
      return;
    }

    this.state.storage.sql.exec(
      `INSERT INTO interactions (user_id, article_id, source_id, action, topics, ts)
       VALUES (?, ?, ?, ?, ?, ?)`,
      event.userId, event.articleId, event.sourceId,
      event.action, JSON.stringify(event.topics), event.ts,
    );

    type GsRow = { mean: number; n: number };
    const [gs] = [...this.state.storage.sql.exec<GsRow>(
      `SELECT mean, n FROM global_state WHERE id = 1`,
    )];
    const globalMean = gs?.mean ?? 0;
    const n          = gs?.n   ?? 0;

    const [uDbRow] = [...this.state.storage.sql.exec<FactorsDbRow>(
      `SELECT bias,v0,v1,v2,v3,v4,v5,v6,v7,v8,v9
       FROM user_factors WHERE user_id = ?`,
      event.userId,
    )];
    const uFactor = uDbRow ? dbRowToFactorRow(uDbRow) : newFactorRow(MF_PARAMS);

    const [iDbRow] = [...this.state.storage.sql.exec<FactorsDbRow>(
      `SELECT bias,v0,v1,v2,v3,v4,v5,v6,v7,v8,v9
       FROM item_factors WHERE article_id = ?`,
      event.articleId,
    )];
    const iFactor = iDbRow ? dbRowToFactorRow(iDbRow) : newFactorRow(MF_PARAMS);

    const res = mfLearnOne(MF_PARAMS, globalMean, n, uFactor, iFactor, rating);

    this.state.storage.sql.exec(
      `UPDATE global_state SET mean = ?, n = ? WHERE id = 1`,
      res.globalMean, res.n,
    );

    const uv = res.user.v;
    this.state.storage.sql.exec(
      `INSERT INTO user_factors
         (user_id,bias,v0,v1,v2,v3,v4,v5,v6,v7,v8,v9,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(user_id) DO UPDATE SET
         bias=excluded.bias,
         v0=excluded.v0,v1=excluded.v1,v2=excluded.v2,v3=excluded.v3,v4=excluded.v4,
         v5=excluded.v5,v6=excluded.v6,v7=excluded.v7,v8=excluded.v8,v9=excluded.v9,
         updated_at=excluded.updated_at`,
      event.userId, res.user.bias,
      uv[0], uv[1], uv[2], uv[3], uv[4], uv[5], uv[6], uv[7], uv[8], uv[9],
      now,
    );

    const iv = res.item.v;
    this.state.storage.sql.exec(
      `INSERT INTO item_factors
         (article_id,bias,v0,v1,v2,v3,v4,v5,v6,v7,v8,v9,source_id,topic,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(article_id) DO UPDATE SET
         bias=excluded.bias,
         v0=excluded.v0,v1=excluded.v1,v2=excluded.v2,v3=excluded.v3,v4=excluded.v4,
         v5=excluded.v5,v6=excluded.v6,v7=excluded.v7,v8=excluded.v8,v9=excluded.v9,
         source_id=excluded.source_id, topic=excluded.topic,
         updated_at=excluded.updated_at`,
      event.articleId, res.item.bias,
      iv[0], iv[1], iv[2], iv[3], iv[4], iv[5], iv[6], iv[7], iv[8], iv[9],
      event.sourceId, event.topics[0] ?? '', now,
    );
  }

  // ── S4: Candidate generation and BiasedMF scoring ─────────────────────────

  getTopCandidates(limit: number): string[] {
    type Row = { article_id: string };
    return [...this.state.storage.sql.exec<Row>(
      `SELECT article_id FROM item_factors ORDER BY bias DESC LIMIT ?`,
      limit,
    )].map(r => r.article_id);
  }

  score(userId: string, candidateIds: string[]): string[] {
    if (candidateIds.length === 0) return [];

    type GsRow = { mean: number };
    const [gs] = [...this.state.storage.sql.exec<GsRow>(
      `SELECT mean FROM global_state WHERE id = 1`,
    )];
    const globalMean = gs?.mean ?? 0;

    const [uDbRow] = [...this.state.storage.sql.exec<FactorsDbRow>(
      `SELECT bias,v0,v1,v2,v3,v4,v5,v6,v7,v8,v9
       FROM user_factors WHERE user_id = ?`,
      userId,
    )];
    // Cold start: zero vector → score = globalMean + bi_i
    const uFactor = uDbRow ? dbRowToFactorRow(uDbRow) : zeroFactorRow(MF_PARAMS);

    type IdRow = { article_id: string };
    const downvoted = new Set(
      [...this.state.storage.sql.exec<IdRow>(
        `SELECT article_id FROM interactions WHERE user_id = ? AND action = 'downvote'`,
        userId,
      )].map(r => r.article_id),
    );

    const placeholders = candidateIds.map(() => '?').join(',');
    type ItemRow = FactorsDbRow & { article_id: string };
    const itemRows = [...this.state.storage.sql.exec<ItemRow>(
      `SELECT article_id,bias,v0,v1,v2,v3,v4,v5,v6,v7,v8,v9
       FROM item_factors WHERE article_id IN (${placeholders})`,
      ...candidateIds,
    )];

    return itemRows
      .filter(r => !downvoted.has(r.article_id))
      .map(r => ({ id: r.article_id, sc: mfPredict(globalMean, uFactor, dbRowToFactorRow(r)) }))
      .sort((a, b) => b.sc - a.sc)
      .map(r => r.id);
  }

  prune(cutoff = Date.now() - SQLITE_RETENTION_MS): void {
    this.state.storage.sql.exec(`DELETE FROM interactions WHERE ts < ?`, cutoff);
    // Remove item_factors for articles with no remaining interactions
    this.state.storage.sql.exec(
      `DELETE FROM item_factors
       WHERE article_id NOT IN (SELECT DISTINCT article_id FROM interactions)`,
    );
  }
}
