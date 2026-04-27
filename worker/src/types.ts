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
  /**
   * Comma-separated list of Stripe coupon IDs (e.g.
   * "coup_betacam_2_months,coup_design_partners_q2") that flag a tenant
   * as a beta cohort member when applied at checkout. The Stripe webhook
   * inspects the subscription's discount; if its coupon is on this list,
   * the tenant gets beta_started_at / beta_ends_at / beta_coupon_id /
   * beta_cohort populated in D1.
   *
   * Leave unset to disable beta flagging entirely. Coupons NOT on this
   * list (e.g. permanent friend discounts) won't accidentally tag
   * tenants as beta.
   */
  BETA_COUPON_IDS?: string;

  // ── Email (Resend) ──────────────────────────────────────────────────
  /**
   * Resend API key for transactional email delivery. Used by
   * worker/src/lib/resend.ts to send activation emails after
   * successful Stripe checkout. The advocatemcp.com domain must be
   * verified in Resend (DKIM + SPF) for delivery from
   * max@advocate-mcp.com.
   * Set via: `cd worker && npx wrangler secret put RESEND_API_KEY`
   */
  RESEND_API_KEY?: string;

  // ── Marketing-site support chat ─────────────────────────────────────
  /**
   * Anthropic API key for the public /api/support-chat endpoint that
   * powers the floating chat widget on advocatemcp.com/Contact. The
   * worker calls Anthropic directly (no Railway hop) on each turn with
   * a baked-in system prompt (worker/src/lib/supportChatPrompt.ts).
   * When unset, the endpoint returns 503 and the frontend falls back
   * to surfacing the email + phone + Calendly contact options.
   * Set via: `cd worker && npx wrangler secret put ANTHROPIC_API_KEY`
   */
  ANTHROPIC_API_KEY?: string;

  // ── Admin tooling ───────────────────────────────────────────────────
  /**
   * Bearer token for Railway's /admin/insights/* JSON endpoints (server-
   * side admin dashboard). Used by the Worker's /api/admin/insights-proxy
   * route to surface cross-tenant analytics (topClusters,
   * embeddingsHealth, overview, trends) inside the Pages-side admin
   * console without exposing the key to the browser. Must match Railway's
   * ADMIN_API_KEY env var. Set via:
   *   cd worker && npx wrangler secret put ADMIN_API_KEY
   */
  ADMIN_API_KEY?: string;

  // ── Per-bot HTML rendering (Phase A, validated by format-judge harness) ──
  /**
   * Feature flag for the Phase A per-bot HTML rendering rollout. When
   * "true" (string), the worker's bot interception path requests
   * format=html from Railway, which renders the agent's answer wrapped
   * in HTML+JSON-LD using a per-bot variant. Iter7 of the format-judge
   * harness validated this lifts the variant from 4/10 (0% cite rate)
   * to 8/10 (100% cite rate) per bot.
   *
   * Default OFF. Flip to "true" once a tenant's next radar polling
   * cycle confirms the predicted citation lift. Set via:
   *   cd worker && npx wrangler secret put BOT_HTML_RENDERING_ENABLED
   */
  BOT_HTML_RENDERING_ENABLED?: string;

  // ── Rate limiting (Session 3) ───────────────────────────────────────
  /**
   * Global per-IP rate limiter for `/mcp` proxy traffic. See
   * `worker/src/lib/mcpRateLimitDO.ts` for the class + helper, and the
   * `[[durable_objects.bindings]]` + `[[migrations]]` stanzas in
   * `wrangler.toml` for the deployment wiring. Absent in dev/test envs
   * that don't define the binding; callers must fail-open in that case.
   */
  MCP_RATE_LIMITER?: DurableObjectNamespace;
}
