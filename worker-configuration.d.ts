interface Env {
  REC_STORE: KVNamespace;
  REC_DO: DurableObjectNamespace;
  /** Comma-separated `https://` origins (e.g. custom Cloudflare Pages domain). */
  EXTRA_CORS_ORIGINS?: string;
}

// Augment Cloudflare namespace so `env` from `cloudflare:test` includes our bindings
declare namespace Cloudflare {
  interface Env {
    REC_STORE: KVNamespace;
    REC_DO: DurableObjectNamespace;
    EXTRA_CORS_ORIGINS?: string;
  }
}
