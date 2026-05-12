/**
 * Tenant scope resolver — SOC 2 CC6.6 (logical access controls).
 *
 * Replaces the recurring pattern in `worker/src/routes/portal.ts`:
 *
 *   const businesses = ctx.role === "admin"
 *     ? await getActiveBusinesses(env.DB)
 *     : await getUserBusinesses(env.DB, ctx.user_id);
 *   const slug = new URL(request.url).searchParams.get("slug");
 *   const biz  = (slug ? businesses.find((b) => b.slug === slug) : null) ?? businesses[0] ?? null;
 *
 * Two security gaps in the original pattern that this helper closes:
 *
 *   1. Non-admin user supplies a `?slug=` they don't own → the
 *      `?? businesses[0]` fallback silently returns DATA FOR A
 *      DIFFERENT BUSINESS (the user's own first one) instead of 403.
 *      Not a privilege escalation (the user only ever sees their own
 *      data) but a confused security posture an auditor will flag.
 *      This helper returns 403 forbidden_slug instead.
 *
 *   2. Admin user supplies a `?slug=` that's NOT one of their own
 *      `user_business_access` rows → the original code processes the
 *      request without recording WHO accessed WHAT. This is the
 *      'admin impersonation' surface the SOC 2 gap assessment H1
 *      flagged. This helper writes an `auth.tenant_impersonation`
 *      audit row when it happens.
 *
 * Discriminated-union return shape mirrors `requireVerifiedSession` in
 * portal.ts so callers handle the error path the same way.
 */

import type { Env } from "../types";
import {
  getActiveBusinesses,
  getUserBusinesses,
  type Business,
} from "../portalDb";
import type { AuthContext } from "../routes/authApi";
import {
  recordAuditEvent,
  clientIpFromRequest,
  hashClientIp,
  requestIdFromRequest,
} from "./auditLog";
import { withCors } from "./cors";

export interface ResolvedTenantScope {
  ok: true;
  /** The selected business row. */
  business: Business;
  /** Authorized businesses for the caller (admin: all active). */
  businesses: Business[];
  /**
   * True iff an admin selected a slug that is NOT in their own
   * user_business_access. Useful for callers that want to surface a
   * banner ("you are viewing as <slug>") in the UI.
   */
  impersonating: boolean;
}

export interface RejectedTenantScope {
  ok: false;
  /** Pre-built JSON Response the caller should `return` directly. */
  resp: Response;
}

const FORBIDDEN_SLUG_BODY = JSON.stringify({
  ok: false,
  error_code: "forbidden_slug",
  message: "You do not have access to that tenant.",
});

const NO_BUSINESS_BODY = JSON.stringify({
  ok: false,
  error_code: "no_business",
  message: "No business found for this account.",
});

function jsonResp(status: number, body: string, request: Request): Response {
  return withCors(
    new Response(body, { status, headers: { "Content-Type": "application/json" } }),
    request,
    { credentials: true },
  );
}

/**
 * Resolve the tenant scope for a per-tenant `/api/client/*` request.
 *
 * Behaviour matrix:
 *
 *   role     | ?slug supplied | slug authorised | result
 *   ---------|----------------|-----------------|----------------------------
 *   <none>   | n/a            | n/a             | (caller must auth first)
 *   non-admin| no             | n/a             | businesses[0] (or 404)
 *   non-admin| yes            | yes             | the matched row
 *   non-admin| yes            | NO              | 403 forbidden_slug
 *   admin    | no             | n/a             | businesses[0] (admin's first if any, else null)
 *   admin    | yes            | yes             | the matched row, no audit
 *   admin    | yes            | NO (other tnt)  | the matched row + audit row written
 *   admin    | yes            | unknown slug    | 404
 *
 * Pre-conditions:
 *   - `ctx` is the authenticated AuthContext from getSessionFromRequest.
 *     Callers MUST run that check before invoking this helper.
 *
 * Side effects:
 *   - May write one `audit_events` row of event_type
 *     `auth.tenant_impersonation` when admin impersonation occurs.
 */
export async function resolveTenantScope(
  ctx: AuthContext,
  request: Request,
  env: Env,
): Promise<ResolvedTenantScope | RejectedTenantScope> {
  const isAdmin = ctx.role === "admin";

  // For admins we list all active businesses (existing behavior). For
  // non-admins we list ONLY their authorized rows.
  const businesses = isAdmin
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);

  // For admins we ALSO need to know which businesses they actually own
  // (vs. impersonate). Cheap second query — only fires for admins.
  const ownedBusinesses = isAdmin
    ? await getUserBusinesses(env.DB, ctx.user_id)
    : businesses;
  const ownedSlugs = new Set(ownedBusinesses.map((b) => b.slug));

  const requestedSlug = new URL(request.url).searchParams.get("slug");

  // ── No slug supplied — fall back to the caller's first business. ───────
  if (!requestedSlug) {
    const fallback = ownedBusinesses[0] ?? businesses[0] ?? null;
    if (!fallback) {
      return { ok: false, resp: jsonResp(404, NO_BUSINESS_BODY, request) };
    }
    return {
      ok: true,
      business: fallback,
      businesses,
      impersonating: false,
    };
  }

  // ── Slug supplied. Look it up in the caller's authorized set. ─────────
  // For non-admins this is the only set we ever consider — unauthorised
  // slugs hit 403, NOT a silent fallback.
  const matchedOwned = ownedBusinesses.find((b) => b.slug === requestedSlug);
  if (matchedOwned) {
    return {
      ok: true,
      business: matchedOwned,
      businesses,
      impersonating: false,
    };
  }

  // ── Non-admin asked for a slug they do not own → 403. ──────────────────
  if (!isAdmin) {
    return { ok: false, resp: jsonResp(403, FORBIDDEN_SLUG_BODY, request) };
  }

  // ── Admin path: supplied slug is not one of their own rows. ───────────
  // Look it up in the all-actives set. If it doesn't exist there either,
  // 404. If it does, fall through with an audit-event side effect.
  const matchedActive = businesses.find((b) => b.slug === requestedSlug);
  if (!matchedActive) {
    return { ok: false, resp: jsonResp(404, NO_BUSINESS_BODY, request) };
  }

  // SOC 2 CC7.2: every admin-as-tenant request leaves an audit trail.
  // Logged at info-level (no Sentry) — impersonation is normal admin
  // operation, not an alarm condition.
  await recordAuditEvent(env.DB, {
    actorType: "admin",
    actorId: ctx.user_id,
    eventType: "auth.tenant_impersonation",
    targetType: "business",
    targetId: matchedActive.slug,
    metadata: {
      method: request.method,
      path: new URL(request.url).pathname,
      admin_email: ctx.email,
      auth_method: ctx.auth_method,
      owned_slugs: [...ownedSlugs],
    },
    ipHash: await hashClientIp(clientIpFromRequest(request)),
    requestId: requestIdFromRequest(request),
  });

  return {
    ok: true,
    business: matchedActive,
    businesses,
    impersonating: true,
  };
}

/**
 * Light-weight companion to `resolveTenantScope` for handlers that follow
 * the legacy `(slug ? businesses.find(...) : null) ?? businesses[0]`
 * pattern and aren't being refactored in this pass. Drops one line into
 * the handler right after `biz` is resolved:
 *
 *     await auditAdminImpersonation(ctx, request, env, biz.slug);
 *
 * Writes an `auth.tenant_impersonation` audit row when the caller is an
 * admin AND `selectedSlug` is NOT in their own user_business_access.
 * Otherwise no-op. Best-effort (recordAuditEvent never throws). Returns
 * the boolean for callers that want to surface "you're acting as X" in
 * their response shape; most callers can ignore it.
 *
 * Why this exists: portal.ts has 45 instances of the resolve-and-pick
 * pattern. Refactoring them all to `resolveTenantScope` is an obvious
 * follow-up but high blast-radius for one PR. Until then, this hook
 * closes the SOC 2 CC7.2 audit-trail gap (no log of admin impersonation)
 * with a one-line addition per handler — no data-flow change.
 */
export async function auditAdminImpersonation(
  ctx: AuthContext,
  request: Request,
  env: Env,
  selectedSlug: string,
): Promise<boolean> {
  if (ctx.role !== "admin") return false;
  // Cheap second query — only fires for admins, who are <1% of traffic.
  const owned = await getUserBusinesses(env.DB, ctx.user_id);
  if (owned.some((b) => b.slug === selectedSlug)) return false;

  await recordAuditEvent(env.DB, {
    actorType: "admin",
    actorId: ctx.user_id,
    eventType: "auth.tenant_impersonation",
    targetType: "business",
    targetId: selectedSlug,
    metadata: {
      method: request.method,
      path: new URL(request.url).pathname,
      admin_email: ctx.email,
      auth_method: ctx.auth_method,
    },
    ipHash: await hashClientIp(clientIpFromRequest(request)),
    requestId: requestIdFromRequest(request),
  });
  return true;
}
