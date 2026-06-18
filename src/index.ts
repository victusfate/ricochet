import { RecDO } from './RecDO';
export { RecDO };
export type { RecWorkerEnv } from './worker-env';
import type { RecWorkerEnv } from './worker-env';
import { corsHeaders } from './cors';
import { json } from './http';
import {
  getRecDOStub,
  handleArticles,
  handleInteractions,
  handleRecommendations,
} from './handlers';

// Re-exported for tests and downstream consumers that import from the Worker entry.
export { isAllowedOrigin } from './cors';
export { buildRecCacheKey } from './rec-cache';

export default {
  async scheduled(_controller: ScheduledController, env: RecWorkerEnv, ctx: ExecutionContext): Promise<void> {
    const stub = getRecDOStub(env);
    ctx.waitUntil(stub.fetch(new Request('http://do-internal/prune', { method: 'POST' })));
  },

  async fetch(request: Request, env: RecWorkerEnv, _ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';

    if (pathname === '/health' && request.method === 'GET') {
      return json({ ok: true, service: 'ricochet-rec' }, request, env);
    }

    if (pathname === '/interactions' && request.method === 'POST') {
      return handleInteractions(request, env);
    }

    const recsMatch = pathname.match(/^\/recommendations\/(.+)$/);
    if (recsMatch && (request.method === 'GET' || request.method === 'POST')) {
      return handleRecommendations(request, env, url, recsMatch[1]);
    }

    if (pathname === '/rec/articles') {
      return handleArticles(request, env, url);
    }

    return new Response('Not Found', { status: 404, headers: corsHeaders(request, env) });
  },
} satisfies ExportedHandler<RecWorkerEnv>;
