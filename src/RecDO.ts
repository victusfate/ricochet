import type {
  InteractionEvent, RecCoreResponse, RecDiagnostics, ScoredArticle,
} from './types';
import type { RecWorkerEnv } from './worker-env';
import {
  ACTION_RATING, DEFAULT_MF_PARAMS, newFactorRow, zeroFactorRow,
  mfLearnOne, mfPredict,
} from './scoring';
import type { FactorRow } from './scoring';
import { parseRankRequest } from './parsing';

const INTERACTION_RETENTION_MS = 30  * 24 * 60 * 60 * 1000; // 30 days
const FACTOR_RETENTION_MS      = 180 * 24 * 60 * 60 * 1000; // 180 days — decoupled from interactions
const MF_PARAMS = DEFAULT_MF_PARAMS;
const GLOBAL_CANDIDATE_LIMIT = 200;

/**
 * Users with fewer than this many interactions get a diversity-bucketed candidate
 * pool (top-N per topic) rather than pure top-by-bias, breaking the popularity loop.
 */
const COLD_START_THRESHOLD = 30;
const PER_TOPIC_DIVERSITY  = 10; // max articles per topic in cold-start pool

// workerd Durable Object SQLite caps bound parameters at 100 (SQLITE_MAX_VARIABLE_NUMBER).
const SQL_VAR_LIMIT = 100;

/** Canonical error response: `{ ok: false, message }` (no CORS — DO is internal-only). */
function badRequest(message: string): Response {
  return Response.json({ ok: false, message }, { status: 400 });
}

/** Defensively decodes an `all_topics` JSON column; malformed or empty values yield []. */
function parseTopicsJson(raw: string): string[] {
  try { return JSON.parse(raw || '[]') as string[]; } catch { return []; }
}

// Debug count endpoints — fixed allowlist of table names (never user input).
const DEBUG_COUNT_TABLES: Record<string, string> = {
  '/debug/user-factors-count': 'user_factors',
  '/debug/item-factors-count': 'item_factors',
  '/debug/interactions-count': 'interactions',
};

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
  constructor(protected state: DurableObjectState, protected _env: RecWorkerEnv) {
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
    // Index on ts enables O(log n) prune scans instead of O(n) full table scans.
    this.state.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_interactions_ts ON interactions(ts)`,
    );
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
    // Migration: add all_topics column for multi-topic weight scoring.
    // topic retains the primary topic for diversity bucketing; all_topics stores
    // the full JSON array so topicWeights can match any of an article's topics.
    try {
      this.state.storage.sql.exec(
        `ALTER TABLE item_factors ADD COLUMN all_topics TEXT NOT NULL DEFAULT '[]'`,
      );
    } catch { /* column already exists — safe to ignore */ }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/ingest' && request.method === 'POST') {
      let events: unknown;
      try {
        events = await request.json();
      } catch {
        return badRequest('Invalid JSON body');
      }
      if (!Array.isArray(events)) {
        return badRequest('body must be an InteractionEvent[] array');
      }
      this.state.storage.transactionSync(() => {
        // Read global_state once per batch and write it once — per-event math is
        // unchanged because the running mean is threaded through learnOne.
        const gs = this.readGlobalState();
        for (const event of events as InteractionEvent[]) this.learnOne(event, gs);
        this.state.storage.sql.exec(
          `UPDATE global_state SET mean = ?, n = ? WHERE id = 1`,
          gs.mean, gs.n,
        );
      });
      return new Response(null, { status: 204 });
    }

    const recsMatch = url.pathname.match(/^\/recs\/(.+)$/);
    if (recsMatch && (request.method === 'GET' || request.method === 'POST')) {
      return this.handleRecs(request, url, recsMatch[1]);
    }

    if (url.pathname === '/articles' && request.method === 'POST') {
      return this.handleArticles(request);
    }

    if (url.pathname === '/prune' && request.method === 'POST') {
      const interactionCutoffParam = url.searchParams.get('cutoff');
      const factorCutoffParam      = url.searchParams.get('factorCutoff');
      const interactionCutoff = interactionCutoffParam !== null
        ? parseInt(interactionCutoffParam, 10)
        : Date.now() - INTERACTION_RETENTION_MS;
      const factorCutoff = factorCutoffParam !== null
        ? parseInt(factorCutoffParam, 10)
        : Date.now() - FACTOR_RETENTION_MS;
      this.prune(interactionCutoff, factorCutoff);
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
    const countTable = DEBUG_COUNT_TABLES[url.pathname];
    if (countTable && request.method === 'GET') {
      type CountRow = { count: number };
      const [row] = [...this.state.storage.sql.exec<CountRow>(
        `SELECT COUNT(*) AS count FROM ${countTable}`,
      )];
      return Response.json(row);
    }

    return new Response('Not Found', { status: 404 });
  }

  private async handleRecs(request: Request, url: URL, rawUserId: string): Promise<Response> {
    let userId: string;
    try {
      userId = decodeURIComponent(rawUserId);
    } catch {
      return badRequest('Invalid userId encoding');
    }
    let reqBody: unknown = null;
    if (request.method === 'POST') {
      try {
        reqBody = await request.json();
      } catch {
        return badRequest('Invalid JSON body');
      }
    }
    const parsedReq = request.method === 'GET'
      ? parseRankRequest({ method: 'GET', searchParams: url.searchParams })
      : parseRankRequest({ method: 'POST', searchParams: url.searchParams, body: reqBody });
    if (!parsedReq.ok) {
      return badRequest(parsedReq.message);
    }
    const { candidateArticleIds: parsedCandidates, topicWeights } = parsedReq.value;
    let limit = parsedReq.value.limit;

    const candidateMode: RecDiagnostics['candidateMode'] = parsedCandidates ? 'feed-pool' : 'global';
    // Clamp limit to the effective pool ceiling for each mode so returnedCount
    // never silently falls short of the requested limit.
    limit = Math.min(limit, parsedCandidates ? parsedCandidates.length : GLOBAL_CANDIDATE_LIMIT);
    let candidates: string[];
    let candidateStrategy: RecDiagnostics['candidateStrategy'];
    if (parsedCandidates) {
      candidates = parsedCandidates;
      candidateStrategy = 'feed-pool';
    } else {
      // Use diversity-bucketed candidates for cold-start users to break the
      // popularity feedback loop; warm users get pure top-by-bias candidates.
      const interactionCount = this.getInteractionCount(userId);
      const isColdStart = interactionCount < COLD_START_THRESHOLD;
      if (isColdStart) {
        candidates = this.getDiverseCandidates(GLOBAL_CANDIDATE_LIMIT);
        candidateStrategy = 'diverse';
      } else {
        candidates = this.getTopCandidates(GLOBAL_CANDIDATE_LIMIT);
        candidateStrategy = 'top-bias';
      }
    }

    const scored = this.scoreCandidates(userId, candidates, topicWeights);
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
        candidateStrategy,
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
    return Response.json(body);
  }

  private async handleArticles(request: Request): Promise<Response> {
    let parsed: unknown;
    try {
      parsed = await request.json();
    } catch {
      return badRequest('Invalid JSON body');
    }
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray((parsed as { ids?: unknown }).ids)) {
      return badRequest('body must be { ids: string[] }');
    }
    const ids = ((parsed as { ids: unknown[] }).ids).map(String);
    type MetaRow = { article_id: string; source_id: string; all_topics: string };
    const rows = this.selectByIdsChunked<MetaRow>(
      `SELECT article_id, source_id, all_topics FROM item_factors WHERE article_id IN`,
      ids,
    );
    const articles = rows.map(r => ({
      articleId: r.article_id,
      sourceId: r.source_id,
      topics: parseTopicsJson(r.all_topics),
    }));
    return Response.json({ articles });
  }

  /**
   * Runs `sqlPrefix (?,?,...)` over `ids` in chunks of SQL_VAR_LIMIT so no
   * statement exceeds workerd's bound-parameter cap.
   */
  private selectByIdsChunked<T extends Record<string, SqlStorageValue>>(
    sqlPrefix: string,
    ids: string[],
  ): T[] {
    const rows: T[] = [];
    for (let i = 0; i < ids.length; i += SQL_VAR_LIMIT) {
      const chunk = ids.slice(i, i + SQL_VAR_LIMIT);
      rows.push(...this.state.storage.sql.exec<T>(
        `${sqlPrefix} (${chunk.map(() => '?').join(',')})`,
        ...chunk,
      ));
    }
    return rows;
  }

  // ── S3: BiasedMF online learning ──────────────────────────────────────────

  /** Reads the singleton global_state row. */
  private readGlobalState(): { mean: number; n: number } {
    type GsRow = { mean: number; n: number };
    const [gs] = [...this.state.storage.sql.exec<GsRow>(
      `SELECT mean, n FROM global_state WHERE id = 1`,
    )];
    return { mean: gs?.mean ?? 0, n: gs?.n ?? 0 };
  }

  /**
   * Learns from one event, updating factor tables and the passed-in global
   * state (mutated; the caller persists it once per batch).
   */
  learnOne(event: InteractionEvent, gs: { mean: number; n: number }): void {
    const rating = ACTION_RATING[event.action];
    if (rating === undefined) return;

    const now = Date.now();

    // Dedup — only learn from each (user, article, action) triple once.
    // The UPDATE doubles as the existence check (rowsWritten > 0 means dup);
    // it refreshes ts with server-side `now` rather than event.ts because
    // client-supplied timestamps could bypass the 30-day prune window.
    const dup = this.state.storage.sql.exec(
      `UPDATE interactions SET ts = ? WHERE user_id = ? AND article_id = ? AND action = ?`,
      now, event.userId, event.articleId, event.action,
    );
    if (dup.rowsWritten > 0) return;

    this.state.storage.sql.exec(
      `INSERT INTO interactions (user_id, article_id, source_id, action, topics, ts)
       VALUES (?, ?, ?, ?, ?, ?)`,
      event.userId, event.articleId, event.sourceId,
      // Use server-side `now` to prevent timestamp spoofing that could bypass pruning.
      event.action, JSON.stringify(event.topics), now,
    );

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

    const res = mfLearnOne(MF_PARAMS, gs.mean, gs.n, uFactor, iFactor, rating);
    gs.mean = res.globalMean;
    gs.n    = res.n;

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
         (article_id,bias,v0,v1,v2,v3,v4,v5,v6,v7,v8,v9,source_id,topic,all_topics,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(article_id) DO UPDATE SET
         bias=excluded.bias,
         v0=excluded.v0,v1=excluded.v1,v2=excluded.v2,v3=excluded.v3,v4=excluded.v4,
         v5=excluded.v5,v6=excluded.v6,v7=excluded.v7,v8=excluded.v8,v9=excluded.v9,
         source_id=excluded.source_id, topic=excluded.topic,
         all_topics=excluded.all_topics, updated_at=excluded.updated_at`,
      event.articleId, res.item.bias,
      iv[0], iv[1], iv[2], iv[3], iv[4], iv[5], iv[6], iv[7], iv[8], iv[9],
      event.sourceId, event.topics[0] ?? '', JSON.stringify(event.topics), now,
    );
  }

  // ── S4: Candidate generation and BiasedMF scoring ─────────────────────────

  /** Returns top-N articles by item bias — used for warm users (≥ COLD_START_THRESHOLD interactions). */
  getTopCandidates(limit: number): string[] {
    type Row = { article_id: string };
    return [...this.state.storage.sql.exec<Row>(
      `SELECT article_id FROM item_factors ORDER BY bias DESC LIMIT ?`,
      limit,
    )].map(r => r.article_id);
  }

  /**
   * Returns a diversity-bucketed candidate pool for cold-start users.
   * Takes up to PER_TOPIC_DIVERSITY articles per topic (breaking the popularity
   * feedback loop), then fills remaining slots with top-by-bias articles.
   */
  getDiverseCandidates(totalLimit: number): string[] {
    type Row = { article_id: string };

    // Top PER_TOPIC_DIVERSITY per topic using SQLite window functions.
    const diverseRows = [...this.state.storage.sql.exec<Row>(`
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
      const fillRows = [...this.state.storage.sql.exec<Row>(
        `SELECT article_id FROM item_factors ORDER BY bias DESC LIMIT ?`,
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
  private getInteractionCount(userId: string): number {
    type Row = { cnt: number };
    const [row] = [...this.state.storage.sql.exec<Row>(
      `SELECT COUNT(*) AS cnt FROM interactions WHERE user_id = ?`,
      userId,
    )];
    return row?.cnt ?? 0;
  }

  /**
   * Scores and ranks candidates for a user using BiasedMF.
   * Applies optional topicWeights multipliers to shift ranking toward preferred topics.
   */
  scoreCandidates(
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
    const globalMean = this.readGlobalState().mean;

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

    type ItemRow = FactorsDbRow & { article_id: string; topic: string; all_topics: string };
    const itemRows = this.selectByIdsChunked<ItemRow>(
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

  /**
   * Removes stale data on two independent schedules:
   * - interactions: pruned after 30 days (high-volume, drives model freshness)
   * - item_factors and user_factors: pruned after 180 days based on updated_at
   *   (retains learned quality for seasonal / long-tail articles and returning
   *   users even after interaction rows age out)
   *
   * Decoupling the two cutoffs means an article quiet for 31 days keeps its learned
   * bias until 180 days have elapsed, avoiding cold-restart quality regression.
   */
  prune(
    interactionCutoff = Date.now() - INTERACTION_RETENTION_MS,
    factorCutoff      = Date.now() - FACTOR_RETENTION_MS,
  ): void {
    this.state.storage.sql.exec(`DELETE FROM interactions WHERE ts < ?`, interactionCutoff);
    // Guard updated_at > 0 prevents accidental deletion of rows with the schema default value.
    this.state.storage.sql.exec(
      `DELETE FROM item_factors WHERE updated_at < ? AND updated_at > 0`,
      factorCutoff,
    );
    // user_factors shares the factor retention window — without this, anonymous
    // client-minted userIds grow the table without bound.
    this.state.storage.sql.exec(
      `DELETE FROM user_factors WHERE updated_at < ? AND updated_at > 0`,
      factorCutoff,
    );
  }
}
