// Named env interface for the ricochet Worker and RecDO.
// Callers importing the worker source (e.g. boomerang's rec-worker) must
// configure matching bindings in their own wrangler.jsonc.
export interface RecWorkerEnv {
  REC_STORE: KVNamespace;
  REC_DO: DurableObjectNamespace;
  /** Optional comma-separated extra CORS origins (https:// only). */
  EXTRA_CORS_ORIGINS?: string;
}
