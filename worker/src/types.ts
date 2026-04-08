// Shared Cloudflare Worker environment bindings.
// Imported by both index.ts and portal route handlers.

export interface Env {
  // ── Existing bindings ────────────────────────────────────────────────────
  /** KV: domain hostname → business slug */
  BUSINESS_MAP: KVNamespace;
  /** Secret forwarded to the backend as X-API-Key */
  API_KEY?: string;
  /** Railway backend base URL */
  API_BASE_URL?: string;

  // ── Auth portal bindings ─────────────────────────────────────────────────
  /** D1 database for users, sessions, business access */
  DB: D1Database;
  /** Secret for the POST /admin/create-client endpoint */
  ADMIN_SECRET?: string;
}
