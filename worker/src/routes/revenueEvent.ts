/**
 * POST /api/revenue-event/:slug — verified-revenue webhook receiver.
 *
 * Customer's booking system POSTs an HMAC-SHA256-signed event whenever a
 * booking attributed to AdvocateMCP closes. The worker:
 *
 *   1. Looks up the tenant's `revenue_webhook_secret` in D1.
 *   2. Computes HMAC-SHA256(secret, raw_request_body) as hex.
 *   3. Compares against the `X-Advocate-Signature: sha256=<hex>` header
 *      using a timing-safe constant-time compare.
 *   4. Validates the body shape with a tiny inline schema (no zod here —
 *      we keep this endpoint lean for the public-internet surface).
 *   5. INSERT-OR-IGNORE into `revenue_events` keyed by
 *      (business_slug, external_ref) so a customer's webhook retry
 *      can't double-count revenue.
 *
 * Failure modes deliberately don't leak structure: bad signature, unknown
 * tenant, and missing secret all return 401 with the same body. Validation
 * errors return 400 with a generic "invalid payload" message — the
 * customer's integration tests run against a curl example we publish in
 * the dashboard; they don't need rich error detail in production.
 *
 * No CORS — this endpoint is server-to-server, not browser-callable.
 *
 * Two HTTP error contracts customers care about:
 *   - 401 when their secret is wrong (rotate it from Settings)
 *   - 400 when their body is malformed (check the schema we publish)
 *   - 200 even on dedup (idempotent retries are normal and OK)
 */

import type { Env } from "../types";

// ── Inline HMAC-SHA256 + constant-time compare ────────────────────────────────
// We don't reuse worker/src/lib/tracked-url.ts because that one signs
// base64url-encoded payloads — webhook signatures from booking systems sign
// the raw body. Different bytes in, different verification.

async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Constant-time compare — prevents timing attacks against the secret.
 *
 * Web Crypto doesn't expose timingSafeEqual; this is the standard
 * length-safe XOR-and-OR pattern. The earlier implementation early-
 * returned on length mismatch which leaked timing information about
 * the expected signature length. The current form always loops the
 * MAX of the two lengths, folding the length difference into the
 * accumulator so mismatched lengths still take constant time relative
 * to the expected signature length (HMAC-SHA256 hex is always 64
 * chars, so attacker-controlled input length never reveals anything).
 */
function constantTimeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;        // length mismatch flagged in accumulator
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

// ── Body validation ───────────────────────────────────────────────────────────

interface RevenueEventBody {
  amount_cents:  number;
  occurred_at:   string;            // ISO-8601
  external_ref:  string;            // customer's booking-system ID
  reservation_id?: string;          // links back to our reservations.id when known
  currency?:     string;            // ISO-4217, defaults to tenant's revenue_currency
}

function validateBody(raw: unknown): { ok: true; data: RevenueEventBody } | { ok: false } {
  if (!raw || typeof raw !== "object") return { ok: false };
  const r = raw as Record<string, unknown>;

  if (typeof r.amount_cents !== "number" || !Number.isInteger(r.amount_cents) || r.amount_cents < 0) {
    return { ok: false };
  }
  if (typeof r.occurred_at !== "string" || Number.isNaN(Date.parse(r.occurred_at))) {
    return { ok: false };
  }
  if (typeof r.external_ref !== "string" || r.external_ref.length === 0 || r.external_ref.length > 200) {
    return { ok: false };
  }
  if (r.reservation_id !== undefined && (typeof r.reservation_id !== "string" || r.reservation_id.length > 200)) {
    return { ok: false };
  }
  if (r.currency !== undefined && (typeof r.currency !== "string" || !/^[A-Z]{3}$/.test(r.currency))) {
    return { ok: false };
  }

  return {
    ok: true,
    data: {
      amount_cents:   r.amount_cents,
      occurred_at:    r.occurred_at,
      external_ref:   r.external_ref,
      reservation_id: r.reservation_id as string | undefined,
      currency:       r.currency as string | undefined,
    },
  };
}

// ── Handler ──────────────────────────────────────────────────────────────────

/** Generated server-side, opaque to the customer except as a copy-paste
 * blob from the Settings page. Random 32 bytes hex = 64 chars. */
function newWebhookSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** ULID-ish ID for the revenue_events row. Sortable by time + 16 random bytes. */
function eventId(): string {
  const ts = Date.now().toString(36);
  const r = new Uint8Array(8);
  crypto.getRandomValues(r);
  const rand = Array.from(r).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `rev_${ts}_${rand}`;
}

export async function handleRevenueEvent(
  request: Request,
  env: Env,
  slug: string,
): Promise<Response> {
  // Read raw body BEFORE parsing — HMAC must be computed over the exact
  // bytes the customer signed, not over a re-serialized JSON.
  const rawBody = await request.text();

  // Look up tenant + their webhook secret + plan. Plan gate is enforced
  // here so a base-tier tenant who somehow obtained a secret (manual D1
  // edit, a future leak) can't post events — defense-in-depth alongside
  // the Settings UI's plan gate.
  const row = await env.DB
    .prepare(
      `SELECT slug,
              revenue_webhook_secret,
              revenue_currency,
              COALESCE((SELECT plan FROM businesses WHERE slug = ?), 'base') AS plan_value
         FROM businesses WHERE slug = ?`,
    )
    .bind(slug, slug)
    .first<{ slug: string; revenue_webhook_secret: string | null; revenue_currency: string | null; plan_value: string }>();

  if (!row || !row.revenue_webhook_secret) {
    // Same response for "tenant doesn't exist" and "tenant exists but
    // hasn't configured a webhook" — don't leak which case we're in.
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (row.plan_value !== "pro" && row.plan_value !== "enterprise") {
    // Plan-gate on the webhook receiver. Same opaque 401 so an
    // attacker can't tell whether the secret is wrong or the tenant
    // is on the wrong plan — operationally these are equivalent
    // conditions for the customer.
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const sigHeader = request.headers.get("X-Advocate-Signature") ?? "";
  if (!sigHeader.startsWith("sha256=")) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  const providedSig = sigHeader.slice("sha256=".length).toLowerCase();
  const expectedSig = await hmacSha256Hex(row.revenue_webhook_secret, rawBody);
  if (!constantTimeEqual(providedSig, expectedSig)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Parse + validate body. We only do this AFTER signature verification —
  // an attacker shouldn't be able to probe our schema by spamming malformed
  // bodies (signature fails first → 401, not 400).
  let parsed: unknown;
  try { parsed = JSON.parse(rawBody); }
  catch {
    return new Response(JSON.stringify({ error: "invalid_payload" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  const validation = validateBody(parsed);
  if (!validation.ok) {
    return new Response(JSON.stringify({ error: "invalid_payload" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  const body = validation.data;
  const currency = body.currency ?? row.revenue_currency ?? "USD";

  // INSERT OR IGNORE — UNIQUE(business_slug, external_ref) handles dedup
  // when the customer's webhook retries. We log inserted=true|false so
  // operators can tell from wrangler tail whether a delivery was new.
  const id = eventId();
  const result = await env.DB
    .prepare(
      `INSERT OR IGNORE INTO revenue_events
         (id, business_slug, reservation_id, amount_cents, currency,
          occurred_at, source, external_ref)
       VALUES (?, ?, ?, ?, ?, ?, 'webhook', ?)`,
    )
    .bind(
      id,
      slug,
      body.reservation_id ?? null,
      body.amount_cents,
      currency,
      body.occurred_at,
      body.external_ref,
    )
    .run();

  // D1 .run() returns { meta: { changes } } — changes=0 means the row
  // was a duplicate (dedup'd by UNIQUE constraint). Either way the
  // customer-side response is 200; the operational difference is
  // logged for our own observability.
  const inserted = (result.meta?.changes ?? 0) > 0;

  // Mirror to Railway so the monthly review email cron and the
  // dashboard's revenue summary endpoint (both server-side, both
  // reading from server SQLite's revenue_events) actually see this
  // event. Audit fix Apr 27 2026 — without the mirror, verified
  // events written here on D1 never reach the cron, so the monthly
  // email always showed zero verified revenue.
  //
  // Best-effort: a Railway hiccup doesn't cause us to lose the event
  // (D1 has it) and shouldn't fail the customer's webhook (200 to
  // them stays 200). On next D1 mirror or manual reconciliation, the
  // miss can be backfilled. We log the mirror status so operators
  // can spot persistent drift in wrangler tail.
  if (inserted && env.API_BASE_URL && env.API_KEY) {
    try {
      const mirrorResp = await fetch(`${env.API_BASE_URL}/admin/revenue-events/mirror`, {
        method:  "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": `Bearer ${env.API_KEY}`,
        },
        body: JSON.stringify({
          business_slug:  slug,
          id,
          reservation_id: body.reservation_id ?? null,
          amount_cents:   body.amount_cents,
          currency,
          occurred_at:    body.occurred_at,
          external_ref:   body.external_ref,
        }),
      });
      if (!mirrorResp.ok) {
        console.warn(JSON.stringify({
          event:        "revenue_event_mirror_failed",
          slug,
          status:       mirrorResp.status,
          external_ref: body.external_ref,
        }));
      }
    } catch (err) {
      console.warn(JSON.stringify({
        event:        "revenue_event_mirror_threw",
        slug,
        error:        String(err).slice(0, 200),
        external_ref: body.external_ref,
      }));
    }
  }

  console.log(JSON.stringify({
    onboarding: false,
    event:      "revenue_event_received",
    slug,
    inserted,
    amount_cents: body.amount_cents,
    external_ref: body.external_ref,
  }));

  return new Response(
    JSON.stringify({ ok: true, deduplicated: !inserted, id: inserted ? id : null }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

// ── Settings-side helpers — generate / rotate the webhook secret ───────────

/**
 * Authenticated by the portal session middleware (caller has already
 * confirmed the caller owns the tenant). Generates a fresh secret if
 * none exists, or rotates if `rotate=true`. Returns the secret in the
 * response so the dashboard can copy it once — it's hashed at rest in
 * a future hardening pass; for v1 we store plaintext to keep the
 * webhook-signing implementation simple.
 */
export async function ensureRevenueWebhookSecret(
  env: Env,
  slug: string,
  rotate: boolean,
): Promise<{ secret: string; webhook_url: string }> {
  let secret: string | null = null;
  if (!rotate) {
    const row = await env.DB
      .prepare("SELECT revenue_webhook_secret FROM businesses WHERE slug = ?")
      .bind(slug)
      .first<{ revenue_webhook_secret: string | null }>();
    secret = row?.revenue_webhook_secret ?? null;
  }
  if (!secret) {
    secret = newWebhookSecret();
    await env.DB
      .prepare("UPDATE businesses SET revenue_webhook_secret = ? WHERE slug = ?")
      .bind(secret, slug)
      .run();
  }
  return {
    secret,
    webhook_url: `https://customers.advocatemcp.com/api/revenue-event/${encodeURIComponent(slug)}`,
  };
}
