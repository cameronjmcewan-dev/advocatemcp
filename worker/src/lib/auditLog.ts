/**
 * audit_events writer — SOC 2 CC7.2 evidence trail.
 *
 * Every security-relevant action (auth login/logout, API key issuance or
 * rotation, tenant lifecycle transition, admin secret rotation, impersonation)
 * MUST call recordAuditEvent. Audit writes are best-effort: a write failure
 * MUST NOT block the calling action — losing one audit row is preferable to
 * failing a Stripe webhook or a customer login. The failure is captured to
 * console.error (Sentry picks it up) so the gap is visible.
 *
 * Schema: see worker/migrations/0025_audit_events.sql.
 *
 * Event-type naming: dotted namespace, lowercase, snake_case within segments.
 *   auth.login_success
 *   auth.login_failure
 *   auth.logout
 *   tenant.api_key_issued
 *   tenant.api_key_revoked
 *   tenant.status_changed
 *   stripe.checkout_completed
 *   stripe.subscription_deleted
 *   stripe.subscription_updated
 *   stripe.invoice_payment_failed
 *   admin.impersonation_started
 *   admin.secret_rotated
 *
 * metadata_json constraints:
 *   - MUST NOT contain plaintext passwords, full API keys, full session
 *     tokens, or full Stripe secrets. Use prefixes (first 8 chars) where
 *     identification is needed.
 *   - MUST NOT contain raw client IPs. Use hashClientIp() to populate
 *     the dedicated ip_hash column instead.
 *   - MUST be JSON-serialisable. Non-serialisable values raise on
 *     JSON.stringify and the audit write is dropped (logged).
 *   - SHOULD be kept under ~4KB. D1 column is TEXT (unbounded) but large
 *     blobs make analytic queries slow.
 */

import { newId } from "../auth";

export type ActorType = "system" | "user" | "tenant" | "stripe" | "admin";

export interface AuditEventInput {
  actorType: ActorType;
  actorId?: string | null;
  eventType: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown> | null;
  ipHash?: string | null;
  requestId?: string | null;
}

/**
 * Insert one audit_events row. Never throws — write failures are logged and
 * swallowed so the calling business logic is unaffected.
 */
export async function recordAuditEvent(
  db: D1Database,
  input: AuditEventInput,
): Promise<void> {
  let metaJson: string | null = null;
  if (input.metadata) {
    try {
      metaJson = JSON.stringify(input.metadata);
    } catch (err) {
      // Non-serialisable metadata is a programmer error, not a runtime one.
      // Drop the metadata but still write the event so the trail exists.
      console.error(JSON.stringify({
        audit: true,
        event: "audit_event_metadata_unserialisable",
        attempted_event: input.eventType,
        error: String(err),
      }));
      metaJson = null;
    }
  }

  try {
    await db
      .prepare(
        `INSERT INTO audit_events
           (id, occurred_at, actor_type, actor_id, event_type,
            target_type, target_id, metadata_json, ip_hash, request_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        newId(),
        new Date().toISOString(),
        input.actorType,
        input.actorId ?? null,
        input.eventType,
        input.targetType ?? null,
        input.targetId ?? null,
        metaJson,
        input.ipHash ?? null,
        input.requestId ?? null,
      )
      .run();
  } catch (err) {
    console.error(JSON.stringify({
      audit: true,
      event: "audit_event_write_failed",
      attempted_event: input.eventType,
      error: String(err),
    }));
  }
}

/**
 * SHA-256 a client IP so audit rows can be correlated across events without
 * storing the raw IP. Returns null for null input. Hex-encoded, 64 chars.
 *
 * NOT a cryptographic protection — IPv4 space is small enough that a rainbow
 * table is trivial. The purpose is to remove the raw IP from at-rest storage
 * while preserving equality matching for forensic correlation.
 */
export async function hashClientIp(ip: string | null | undefined): Promise<string | null> {
  if (!ip) return null;
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(ip));
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Extract the client IP from a Cloudflare Worker request. Prefers the
 * canonical CF-Connecting-IP header (set by Cloudflare's edge for every
 * inbound request) and falls back to X-Forwarded-For's leftmost value.
 * Returns null if no header is present (e.g. local dev with no proxy).
 */
export function clientIpFromRequest(request: Request): string | null {
  const cf = request.headers.get("CF-Connecting-IP");
  if (cf) return cf;
  const xff = request.headers.get("X-Forwarded-For");
  if (xff) return xff.split(",")[0].trim();
  return null;
}

/**
 * Cloudflare assigns each request a unique Ray ID. Including it in audit
 * rows lets a forensic investigator pivot from Sentry / wrangler tail to
 * the audit_events row for the same request.
 */
export function requestIdFromRequest(request: Request): string | null {
  return request.headers.get("CF-Ray");
}
