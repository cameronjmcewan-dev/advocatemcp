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
