// Shared Cloudflare Worker environment bindings.
// Imported by both index.ts and portal route handlers.

export interface Env {
  // ── Existing bindings ────────────────────────────────────────────────────
  /** KV: domain hostname → business slug */
  BUSINESS_MAP: KVNamespace;
  /** KV: domain hostname → full tenant JSON record */
  TENANT_DATA: KVNamespace;
  /** Secret forwarded to the backend as X-API-Key */
  API_KEY?: string;
  /** Railway backend base URL */
  API_BASE_URL?: string;

  /** HMAC-SHA256 signing key for attribution tokens — must match Railway TOKEN_SIGNING_KEY */
  TOKEN_SIGNING_KEY?: string;

  /**
   * HMAC-SHA256 signing key for Phase 3 self-serve activation tokens.
   * Isolated from TOKEN_SIGNING_KEY by purpose — a leak of one key should
   * not compromise the other. Used by worker/src/lib/activation-token.ts
   * and the POST /api/activate + POST /admin/activation-token endpoints.
   * Set via: `cd worker && npx wrangler secret put ACTIVATION_SIGNING_KEY`
   */
  ACTIVATION_SIGNING_KEY?: string;

  /**
   * HMAC-SHA256 signing key for Phase C cross-origin auth access tokens.
   * Isolated from TOKEN_SIGNING_KEY and ACTIVATION_SIGNING_KEY by purpose
   * — the access token is a stateless short-lived (15-minute) bearer
   * token used for all authenticated customer API calls from
   * advocatemcp.com. A leak of one key must not compromise the others.
   * Used by worker/src/lib/access-token.ts and the POST /api/auth/login,
   * POST /api/auth/refresh endpoints (sign) plus the Bearer middleware
   * in worker/src/routes/authApi.ts (verify). Refresh tokens are opaque
   * random values stored in the sessions D1 table and do not use this
   * key — only access tokens do.
   * Set via: `cd worker && npx wrangler secret put ACCESS_TOKEN_SIGNING_KEY`
   */
  ACCESS_TOKEN_SIGNING_KEY?: string;

  // ── Auth portal bindings ─────────────────────────────────────────────────
  /** D1 database for users, sessions, business access */
  DB: D1Database;
  /** Secret for the POST /admin/create-client endpoint */
  ADMIN_SECRET?: string;

  // ── Cloudflare for SaaS ──────────────────────────────────────────────────
  /** Cloudflare API token — needs custom_hostnames:edit + zone:read scopes */
  CF_API_TOKEN?: string;
  /** Zone ID of the SaaS zone (e.g. advocatemcp.com) */
  CF_ZONE_ID?: string;

  // ── Stripe ──────────────────────────────────────────────────────────────
  /** Stripe secret key (sk_test_... or sk_live_...) */
  STRIPE_SECRET_KEY?: string;
  /** Stripe webhook signing secret (whsec_...) */
  STRIPE_WEBHOOK_SECRET?: string;
  /** Stripe Price ID for $100/mo base plan */
  STRIPE_PRICE_ID_BASE?: string;
  /** Stripe Price ID for $250/mo pro plan */
  STRIPE_PRICE_ID_PRO?: string;
}
