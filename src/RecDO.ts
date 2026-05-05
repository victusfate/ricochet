import type { InteractionEvent } from './types';

const SQLITE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Score contribution of each action type
const ACTION_SCORE: Record<string, number> = {
  read:     1,
  upvote:   3,
  save:     2,
  seen:     0.1,
  downvote: -2,
};

// Map action → count column name in article_scores
const ACTION_COLUMN: Record<string, string> = {
  read:     'reads',
  upvote:   'upvotes',
  downvote: 'downvotes',
  save:     'saves',
  seen:     'seens',
};

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

    return new Response('Not Found', { status: 404 });
  }

  ingestEvents(events: InteractionEvent[]): void {
    const now = Date.now();
    for (const event of events) {
      const col = ACTION_COLUMN[event.action];
      if (!col) continue;
      const scoreDelta = ACTION_SCORE[event.action] ?? 0;

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
        event.articleId, scoreDelta, now, scoreDelta, now,
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
