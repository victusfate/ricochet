import type {
  InteractionEvent, RecCoreResponse, RecRankRequest, RecDiagnostics, ScoredArticle,
} from './types';
import type { RecWorkerEnv } from './worker-env';
import {
  ACTION_RATING, DEFAULT_MF_PARAMS, newFactorRow, zeroFactorRow,
  mfLearnOne, mfPredict,
} from './scoring';
import type { FactorRow } from './scoring';

const SQLITE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MF_PARAMS = DEFAULT_MF_PARAMS;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const GLOBAL_CANDIDATE_LIMIT = 200;
const MAX_CANDIDATES = 100;

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

function parseLimit(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(value)));
  }
  if (typeof value === 'string') {
    const parsed = parseInt(value, 10);
    if (!Number.isNaN(parsed)) return Math.max(1, Math.min(MAX_LIMIT, parsed));
  }
  return DEFAULT_LIMIT;
}

function parseCandidateArticleIds(value: unknown): { ids?: string[]; message?: string } {
  if (value === undefined) return {};
  if (!Array.isArray(value)) {
    return { message: 'candidateArticleIds must be an array of non-empty strings' };
  }
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== 'string') {
      return { message: 'candidateArticleIds must contain only strings' };
    }
    const id = raw.trim();
    if (!id) {
      return { message: 'candidateArticleIds must not contain empty IDs' };
    }
    if (!seen.has(id)) {
      seen.add(id);
      deduped.push(id);
    }
  }
  if (deduped.length > MAX_CANDIDATES) {
    return { message: `Too many candidateArticleIds in request; max ${MAX_CANDIDATES}` };
  }
  return { ids: deduped };
}

function parseCsvCandidates(raw: string | null): string[] | undefined {
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

export class RecDO implements DurableObject {
  constructor(private state: DurableObjectState, private _env: RecWorkerEnv) {
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
    if (recsMatch && (request.method === 'GET' || request.method === 'POST')) {
      const userId = decodeURIComponent(recsMatch[1]);
      let limit = parseLimit(url.searchParams.get('limit'));
      let parsedCandidates: string[] | undefined;

      if (request.method === 'GET') {
        parsedCandidates = parseCsvCandidates(url.searchParams.get('candidates'));
      } else {
        let body: RecRankRequest | null;
        try {
          body = await request.json() as RecRankRequest | null;
        } catch {
          return Response.json({ ok: false, message: 'Invalid JSON body' }, { status: 400 });
        }
        if (body !== null && typeof body !== 'object') {
          return Response.json({ ok: false, message: 'Invalid JSON body' }, { status: 400 });
        }
        const parsed = parseCandidateArticleIds(body?.candidateArticleIds);
        if (parsed.message) {
          return Response.json({ ok: false, message: parsed.message }, { status: 400 });
        }
        parsedCandidates = parsed.ids;
        if (body?.limit !== undefined) limit = parseLimit(body.limit);
      }

      if (parsedCandidates && parsedCandidates.length > MAX_CANDIDATES) {
        return Response.json(
          { ok: false, message: `Too many candidateArticleIds in request; max ${MAX_CANDIDATES}` },
          { status: 400 },
        );
      }

      const candidateMode: RecDiagnostics['candidateMode'] = parsedCandidates ? 'feed-pool' : 'global';
      const candidates = parsedCandidates ?? this.getTopCandidates(GLOBAL_CANDIDATE_LIMIT);
      const scored = this.scoreCandidates(userId, candidates);
      const topScored = scored.ranked.slice(0, limit);
      const body: RecCoreResponse = {
        articleIds: topScored.map(r => r.articleId),
        generatedAt: Date.now(),
        scoredArticleIds: topScored,
        diagnostics: {
          model: 'biased-mf',
          modelVersion: 'v1',
          factorCount: MF_PARAMS.nFactors,
          candidateMode,
          candidateCount: candidates.length,
          rankedCount: scored.ranked.length,
          returnedCount: topScored.length,
          excludedDownvotes: scored.excludedDownvotes,
          coldItemCount: scored.coldItemCount,
          warmItemCount: scored.warmItemCount,
          coldStart: scored.coldStart,
          limit,
        },
      };
      return new Response(
        JSON.stringify(body),
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

  scoreCandidates(
    userId: string,
    candidateIds: string[],
  ): {
    ranked: ScoredArticle[];
    excludedDownvotes: number;
    coldStart: boolean;
    coldItemCount: number;
    warmItemCount: number;
  } {

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
    const coldStart = !uDbRow;
    const uFactor = uDbRow ? dbRowToFactorRow(uDbRow) : zeroFactorRow(MF_PARAMS);

    type IdRow = { article_id: string };
    const downvoted = new Set(
      [...this.state.storage.sql.exec<IdRow>(
        `SELECT article_id FROM interactions WHERE user_id = ? AND action = 'downvote'`,
        userId,
      )].map(r => r.article_id),
    );

    type ItemRow = FactorsDbRow & { article_id: string };
    const itemRows = candidateIds.length === 0
      ? []
      : [...this.state.storage.sql.exec<ItemRow>(
        `SELECT article_id,bias,v0,v1,v2,v3,v4,v5,v6,v7,v8,v9
         FROM item_factors WHERE article_id IN (${candidateIds.map(() => '?').join(',')})`,
        ...candidateIds,
      )];
    const itemById = new Map(itemRows.map(row => [row.article_id, row]));
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
      const row = itemById.get(candidateId);
      if (row) {
        warmItemCount += 1;
        ranked.push({
          articleId: candidateId,
          score: mfPredict(globalMean, uFactor, dbRowToFactorRow(row)),
        });
        continue;
      }
      coldItemCount += 1;
      ranked.push({
        articleId: candidateId,
        score: mfPredict(globalMean, uFactor, coldItem),
      });
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

  prune(cutoff = Date.now() - SQLITE_RETENTION_MS): void {
    this.state.storage.sql.exec(`DELETE FROM interactions WHERE ts < ?`, cutoff);
    // Remove item_factors for articles with no remaining interactions
    this.state.storage.sql.exec(
      `DELETE FROM item_factors
       WHERE article_id NOT IN (SELECT DISTINCT article_id FROM interactions)`,
    );
  }
}
