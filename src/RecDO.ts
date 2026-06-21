import type { InteractionEvent, RecCoreResponse, RecDiagnostics } from './types';
import type { RecWorkerEnv } from './worker-env';
import { parseRankRequest } from './parsing';
import {
  COLD_START_THRESHOLD, FACTOR_RETENTION_MS, GLOBAL_CANDIDATE_LIMIT,
  INTERACTION_RETENTION_MS, MF_PARAMS,
} from './rec-config';
import { initRecSchema, parseTopicsJson, readGlobalState, selectByIdsChunked } from './rec-db';
import { learnOne } from './rec-learning';
import {
  getDiverseCandidates, getInteractionCount, getTopCandidates, scoreCandidates,
} from './rec-ranking';

/** Canonical error response: `{ ok: false, message }` (no CORS — DO is internal-only). */
function badRequest(message: string): Response {
  return Response.json({ ok: false, message }, { status: 400 });
}

// Debug count endpoints — fixed allowlist of table names (never user input).
const DEBUG_COUNT_TABLES: Record<string, string> = {
  '/debug/user-factors-count': 'user_factors',
  '/debug/item-factors-count': 'item_factors',
  '/debug/interactions-count': 'interactions',
};

export class RecDO implements DurableObject {
  constructor(protected state: DurableObjectState, protected _env: RecWorkerEnv) {
    initRecSchema(this.state.storage.sql);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const sql = this.state.storage.sql;

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
        const gs = readGlobalState(sql);
        for (const event of events as InteractionEvent[]) learnOne(sql, event, gs);
        sql.exec(
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
        // quality-ok: magic-number — base-10 is the standard radix for decimal parseInt
        ? parseInt(interactionCutoffParam, 10)
        : Date.now() - INTERACTION_RETENTION_MS;
      const factorCutoff = factorCutoffParam !== null
        // quality-ok: magic-number — base-10 is the standard radix for decimal parseInt
        ? parseInt(factorCutoffParam, 10)
        : Date.now() - FACTOR_RETENTION_MS;
      this.prune(interactionCutoff, factorCutoff);
      return new Response(null, { status: 204 });
    }

    // Debug endpoints — not exposed through the public Worker
    if (url.pathname === '/debug/global-state' && request.method === 'GET') {
      type GsRow = { mean: number; n: number };
      const [row] = [...sql.exec<GsRow>(
        `SELECT mean, n FROM global_state WHERE id = 1`,
      )];
      return Response.json(row ?? { mean: 0, n: 0 });
    }
    const countTable = DEBUG_COUNT_TABLES[url.pathname];
    if (countTable && request.method === 'GET') {
      type CountRow = { count: number };
      const [row] = [...sql.exec<CountRow>(
        `SELECT COUNT(*) AS count FROM ${countTable}`,
      )];
      return Response.json(row);
    }

    return new Response('Not Found', { status: 404 });
  }

  private async handleRecs(request: Request, url: URL, rawUserId: string): Promise<Response> {
    const sql = this.state.storage.sql;
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
      const interactionCount = getInteractionCount(sql, userId);
      const isColdStart = interactionCount < COLD_START_THRESHOLD;
      if (isColdStart) {
        candidates = getDiverseCandidates(sql, GLOBAL_CANDIDATE_LIMIT);
        candidateStrategy = 'diverse';
      } else {
        candidates = getTopCandidates(sql, GLOBAL_CANDIDATE_LIMIT);
        candidateStrategy = 'top-bias';
      }
    }

    const scored = scoreCandidates(sql, userId, candidates, topicWeights);
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
    const sql = this.state.storage.sql;
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
    const rows = selectByIdsChunked<MetaRow>(
      sql,
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
    const sql = this.state.storage.sql;
    sql.exec(`DELETE FROM interactions WHERE ts < ?`, interactionCutoff);
    // Guard updated_at > 0 prevents accidental deletion of rows with the schema default value.
    sql.exec(
      `DELETE FROM item_factors WHERE updated_at < ? AND updated_at > 0`,
      factorCutoff,
    );
    // user_factors shares the factor retention window — without this, anonymous
    // client-minted userIds grow the table without bound.
    sql.exec(
      `DELETE FROM user_factors WHERE updated_at < ? AND updated_at > 0`,
      factorCutoff,
    );
  }
}
