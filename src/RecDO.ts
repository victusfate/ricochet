import type { InteractionEvent } from './types';
import { ACTION_COLUMN, scoreDelta } from './scoring';

const SQLITE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

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
      CREATE TABLE IF NOT EXISTS article_scores (
        article_id TEXT PRIMARY KEY,
        score      REAL    NOT NULL DEFAULT 0,
        reads      INTEGER NOT NULL DEFAULT 0,
        upvotes    INTEGER NOT NULL DEFAULT 0,
        downvotes  INTEGER NOT NULL DEFAULT 0,
        saves      INTEGER NOT NULL DEFAULT 0,
        seens      INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
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
      this.ingestEvents(events);
      return new Response(null, { status: 204 });
    }

    const recsMatch = url.pathname.match(/^\/recs\/(.+)$/);
    if (recsMatch && request.method === 'GET') {
      const userId = decodeURIComponent(recsMatch[1]);
      const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
      const articleIds = this.getRecommendations(userId, limit);
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

    // Debug endpoints (used by tests — not exposed through the public Worker)
    if (url.pathname === '/debug/global-state' && request.method === 'GET') {
      type GsRow = { mean: number; n: number };
      const [row] = [...this.state.storage.sql.exec<GsRow>(`SELECT mean, n FROM global_state WHERE id = 1`)];
      return Response.json(row ?? { mean: 0, n: 0 });
    }
    if (url.pathname === '/debug/user-factors-count' && request.method === 'GET') {
      type CountRow = { count: number };
      const [row] = [...this.state.storage.sql.exec<CountRow>(`SELECT COUNT(*) AS count FROM user_factors`)];
      return Response.json(row);
    }
    if (url.pathname === '/debug/item-factors-count' && request.method === 'GET') {
      type CountRow = { count: number };
      const [row] = [...this.state.storage.sql.exec<CountRow>(`SELECT COUNT(*) AS count FROM item_factors`)];
      return Response.json(row);
    }
    if (url.pathname === '/debug/interactions-count' && request.method === 'GET') {
      type CountRow = { count: number };
      const [row] = [...this.state.storage.sql.exec<CountRow>(`SELECT COUNT(*) AS count FROM interactions`)];
      return Response.json(row);
    }

    return new Response('Not Found', { status: 404 });
  }

  ingestEvents(events: InteractionEvent[]): void {
    const now = Date.now();
    for (const event of events) {
      const col = ACTION_COLUMN[event.action];
      if (!col) continue;
      const delta = scoreDelta(event.action);

      // Upsert interaction — PRIMARY KEY (user_id, article_id, action) prevents double-counting
      this.state.storage.sql.exec(
        `INSERT INTO interactions (user_id, article_id, source_id, action, topics, ts)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, article_id, action) DO UPDATE SET
           source_id = excluded.source_id,
           topics    = excluded.topics,
           ts        = excluded.ts`,
        event.userId, event.articleId, event.sourceId,
        event.action, JSON.stringify(event.topics), event.ts,
      );

      // Upsert article score — column name is safe (comes from ACTION_COLUMN map, not user input)
      this.state.storage.sql.exec(
        `INSERT INTO article_scores (article_id, score, ${col}, updated_at)
         VALUES (?, ?, 1, ?)
         ON CONFLICT(article_id) DO UPDATE SET
           score      = score + ?,
           ${col}     = ${col} + 1,
           updated_at = ?`,
        event.articleId, delta, now, delta, now,
      );
    }
  }

  getRecommendations(userId: string, limit: number): string[] {
    // Collect articles this user has downvoted
    type IdRow = { article_id: string };
    const downvoted = new Set(
      [...this.state.storage.sql.exec<IdRow>(
        `SELECT article_id FROM interactions WHERE user_id = ? AND action = 'downvote'`,
        userId,
      )].map(r => r.article_id),
    );

    // Fetch top articles ordered by score descending
    type ScoreRow = { article_id: string; score: number };
    const rows = [...this.state.storage.sql.exec<ScoreRow>(
      `SELECT article_id, score FROM article_scores ORDER BY score DESC LIMIT ?`,
      limit + downvoted.size + 1,
    )];

    return rows
      .filter(r => !downvoted.has(r.article_id))
      .slice(0, limit)
      .map(r => r.article_id);
  }

  prune(cutoff = Date.now() - SQLITE_RETENTION_MS): void {
    // Remove old interactions
    this.state.storage.sql.exec(
      `DELETE FROM interactions WHERE ts < ?`,
      cutoff,
    );

    // Remove article_scores rows that have no remaining interactions
    this.state.storage.sql.exec(
      `DELETE FROM article_scores
       WHERE article_id NOT IN (SELECT DISTINCT article_id FROM interactions)`,
    );
  }
}
