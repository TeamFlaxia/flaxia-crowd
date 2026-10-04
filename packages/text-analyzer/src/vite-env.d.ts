/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Orchestrator origin baked into the bundle. Empty by default: an
   * unconfigured build must fail loudly instead of falling back to production.
   */
  readonly VITE_ORCHESTRATOR_URL?: string;
  /**
   * Comma-separated allowlist of origins that may override the orchestrator
   * through localStorage. Empty by default, which ignores every override.
   */
  readonly VITE_ALLOWED_ORCHESTRATOR_ORIGINS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}