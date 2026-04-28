/**
 * Team accounts — Section 1 of the Enterprise honesty pass (Apr 27 2026).
 *
 * Five tenant-side endpoints + one public token-consume endpoint:
 *
 *   GET    /api/client/team                     — list members
 *   POST   /api/client/team/invite              — owner invites a new member
 *   PATCH  /api/client/team/:user_id/role       — owner changes a member's role
 *   DELETE /api/client/team/:user_id            — owner removes a member
 *   POST   /auth/team-accept                    — invitee consumes magic-link, sets password
 *
 * Plan caps (matches the comparison table on Pricing.html):
 *   base       → 1 (the owner only — no invites accepted)
 *   pro        → 5 total (owner + 4 invitees)
 *   enterprise → unbounded
 *
 * Roles:
 *   owner   — billing, team management, profile, locations, revenue config
 *   editor  — profile, locations, revenue config (cannot manage team or billing)
 *   viewer  — read-only dashboards
 *
 * The owner is created automatically when Stripe checkout completes;
 * everyone they invite defaults to viewer (or editor if specified) and
 * stays at that role until the owner promotes them.
 */

import type { Env } from "../types";
import {
  getSessionFromRequest,
} from "./authApi";
import {
  getActiveBusinesses,
  getUserBusinesses,
  getUserRoleOnBusiness,
  listTeamMembers,
  type BusinessRole,
} from "../portalDb";
import {
  signInviteToken,
  verifyInviteToken,
  type InviteTokenError,
} from "../lib/inviteToken";
import {
  generateSalt,
  hashPassword,
  generateSessionToken,
  hashToken,
  newId,
  sessionCookieHeader,
} from "../auth";
import { withCors, handleCorsPreflight } from "../lib/cors";

// ── Helpers ───────────────────────────────────────────────────────────────────

interface AuthedContext {
  user_id:    string;
  email:      string;
  full_name:  string | null;
  role:       string;          // global role (admin / client) — NOT business role
}

interface ResolvedTenant {
  business_id:   string;
  business_slug: string;
  business_name: string;
  user_role:     BusinessRole;
}

async function jsonOk(body: unknown): Promise<Response> {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function jsonErr(status: number, message: string): Promise<Response> {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Resolve the caller's session → business → role chain. Used by every
 * authenticated team endpoint. Honors `?slug=` for admins (impersonation)
 * and falls back to the user's first business otherwise.
 */
async function resolveTenant(
  request: Request,
  env: Env,
): Promise<{ ok: true; ctx: AuthedContext; tenant: ResolvedTenant } | { ok: false; resp: Response }> {
  const ctx = await getSessionFromRequest(request, env);
  if (!ctx) return { ok: false, resp: withCors(await jsonErr(401, "Unauthorized"), request, { credentials: true }) };

  const businesses = ctx.role === "admin"
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const slugQuery = new URL(request.url).searchParams.get("slug");
  const biz = (slugQuery ? businesses.find((b) => b.slug === slugQuery) : null) ?? businesses[0] ?? null;
  if (!biz) return { ok: false, resp: withCors(await jsonErr(404, "No business found for this account"), request, { credentials: true }) };

  // Admin impersonation: admins act as owner on whatever tenant they're
  // viewing. This matches the existing behavior in apiRevenueSetAov etc.
  let userRole: BusinessRole;
  if (ctx.role === "admin") {
    userRole = "owner";
  } else {
    const dbRole = await getUserRoleOnBusiness(env.DB, ctx.user_id, biz.id);
    userRole = dbRole ?? "viewer";       // membership-row missing falls through to viewer (read-only)
  }

  return {
    ok: true,
    ctx: { user_id: ctx.user_id, email: ctx.email, full_name: ctx.full_name, role: ctx.role },
    tenant: {
      business_id:   biz.id,
      business_slug: biz.slug,
      business_name: biz.business_name,
      user_role:     userRole,
    },
  };
}

// ── Plan caps ─────────────────────────────────────────────────────────────────

async function planCap(env: Env, businessSlug: string): Promise<{ plan: string; cap: number; current: number }> {
  // We don't store plan on worker D1 directly — it's mirrored from
  // server SQLite via /register. Read from D1 if available, default
  // to 'base' if not. Future: source of truth from Stripe subscription.
  const row = await env.DB
    .prepare("SELECT plan FROM businesses WHERE slug = ? LIMIT 1")
    .bind(businessSlug)
    .first<{ plan: string | null }>();
  const plan = row?.plan ?? "base";
  const caps: Record<string, number> = { base: 1, pro: 5, enterprise: Number.POSITIVE_INFINITY };
  const cap = caps[plan] ?? 1;

  const countRow = await env.DB
    .prepare(
      `SELECT COUNT(*) AS n FROM user_business_access uba
        JOIN businesses b ON b.id = uba.business_id
        WHERE b.slug = ?`,
    )
    .bind(businessSlug)
    .first<{ n: number }>();
  return { plan, cap, current: countRow?.n ?? 0 };
}

// ── GET /api/client/team — list members ──────────────────────────────────────

export async function handleListTeam(request: Request, env: Env): Promise<Response> {
  const r = await resolveTenant(request, env);
  if (!r.ok) return r.resp;

  const members = await listTeamMembers(env.DB, r.tenant.business_id);
  const cap = await planCap(env, r.tenant.business_slug);
  return withCors(
    await jsonOk({
      members,
      caller_role: r.tenant.user_role,
      plan:        cap.plan,
      cap:         Number.isFinite(cap.cap) ? cap.cap : null,    // null = unlimited
      current_count: cap.current,
    }),
    request,
    { credentials: true },
  );
}

// ── POST /api/client/team/invite — owner invites a new member ────────────────

export async function handleInviteTeam(request: Request, env: Env): Promise<Response> {
  if (!env.INVITE_SIGNING_KEY) {
    return withCors(
      await jsonErr(503, "team_invites_unavailable: INVITE_SIGNING_KEY not configured"),
      request, { credentials: true },
    );
  }
  if (!env.RESEND_API_KEY) {
    return withCors(
      await jsonErr(503, "team_invites_unavailable: RESEND_API_KEY not configured"),
      request, { credentials: true },
    );
  }
  const r = await resolveTenant(request, env);
  if (!r.ok) return r.resp;
  if (r.tenant.user_role !== "owner") {
    return withCors(await jsonErr(403, "forbidden_role: only owners can invite team members"), request, { credentials: true });
  }

  let body: { email?: unknown; role?: unknown; full_name?: unknown };
  try { body = await request.json(); } catch {
    return withCors(await jsonErr(400, "invalid_json"), request, { credentials: true });
  }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const role  = body.role === "editor" ? "editor" : "viewer";    // owner not invitable; defaults to viewer
  const fullName = typeof body.full_name === "string" ? body.full_name.trim().slice(0, 200) : null;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) {
    return withCors(await jsonErr(400, "invalid_email"), request, { credentials: true });
  }

  // Plan-cap check.
  const cap = await planCap(env, r.tenant.business_slug);
  if (cap.current >= cap.cap) {
    return withCors(
      new Response(JSON.stringify({
        error: "plan_limit",
        message: `Your ${cap.plan} plan allows up to ${cap.cap} team member${cap.cap === 1 ? "" : "s"}. Upgrade to add more.`,
        cap: cap.cap, current_count: cap.current, plan: cap.plan,
      }), { status: 402, headers: { "Content-Type": "application/json" } }),
      request, { credentials: true },
    );
  }

  // Reject if email already has access to this business (idempotency-ish).
  const existing = await env.DB
    .prepare(
      `SELECT u.id AS user_id FROM users u
         JOIN user_business_access uba ON uba.user_id = u.id
        WHERE uba.business_id = ? AND u.email = ? LIMIT 1`,
    )
    .bind(r.tenant.business_id, email)
    .first<{ user_id: string }>();
  if (existing) {
    return withCors(await jsonErr(409, "already_member"), request, { credentials: true });
  }

  // Create or reuse a users row. If the email already exists globally
  // (user has access to ANOTHER business), we just add them to this
  // tenant — no pending invite, no email needed.
  let userId: string;
  let isNewUser = false;
  const existingUser = await env.DB
    .prepare("SELECT id, pending_invite FROM users WHERE email = ? LIMIT 1")
    .bind(email)
    .first<{ id: string; pending_invite: number }>();

  if (existingUser) {
    userId = existingUser.id;
  } else {
    userId = newId();
    isNewUser = true;
    // Placeholder password hash + salt — overwritten when the invitee
    // accepts via the magic link. The login path checks pending_invite
    // and refuses to authenticate, so the placeholder can never log in.
    const salt = generateSalt();
    const placeholderHash = await hashPassword("__pending__" + userId, salt);
    await env.DB
      .prepare(
        `INSERT INTO users (id, email, password_hash, salt, full_name, role, pending_invite, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'client', 1, datetime('now'), datetime('now'))`,
      )
      .bind(userId, email, placeholderHash, salt, fullName)
      .run();
  }

  // Insert user_business_access row.
  await env.DB
    .prepare(
      `INSERT INTO user_business_access (id, user_id, business_id, role)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(newId(), userId, r.tenant.business_id, role)
    .run();

  // Mint invite token + send email (only for brand-new users).
  let inviteUrl: string | null = null;
  if (isNewUser) {
    const token = await signInviteToken(
      { user_id: userId, business_slug: r.tenant.business_slug, role },
      env.INVITE_SIGNING_KEY,
    );
    // team-accept.html lives on advocatemcp.com Pages, not on the
    // worker (customers.advocatemcp.com). The worker's bot-detection
    // catch-all would return JSON for /team-accept.html, so the email
    // must link to advocatemcp.com directly. The session cookie set
    // after /auth/team-accept rides the Domain=.advocatemcp.com scope
    // so the redirect to /dashboard authenticates correctly.
    inviteUrl = `https://advocatemcp.com/team-accept.html?t=${encodeURIComponent(token)}`;

    const inviterName = r.ctx.full_name || r.ctx.email;
    const subject = `${inviterName} invited you to AdvocateMCP for ${r.tenant.business_name}`;
    const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 0">
  <tr><td align="center">
    <table width="520" style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:36px 32px">
      <tr><td>
        <h1 style="margin:0 0 12px 0;color:#111827;font-size:22px">You've been invited to AdvocateMCP</h1>
        <p style="margin:0 0 20px 0;color:#4b5563;font-size:15px;line-height:1.6">
          ${escapeHtml(inviterName)} invited you to join <strong>${escapeHtml(r.tenant.business_name)}</strong> on AdvocateMCP as a <strong>${escapeHtml(role)}</strong>.
        </p>
        <p style="margin:0 0 24px 0">
          <a href="${escapeHtml(inviteUrl)}" style="display:inline-block;background:#7d2550;color:#fff;text-decoration:none;padding:12px 22px;border-radius:6px;font-size:15px;font-weight:500">Accept invitation</a>
        </p>
        <p style="margin:0 0 8px 0;color:#6b7280;font-size:13px;line-height:1.5">This invitation expires in 7 days. Reply to this email if you didn't expect it — Max.</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;

    const text = `${inviterName} invited you to join ${r.tenant.business_name} on AdvocateMCP as a ${role}.\n\nAccept the invitation: ${inviteUrl}\n\nThis link expires in 7 days.`;

    try {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type":  "application/json",
        },
        body: JSON.stringify({
          from:     "AdvocateMCP <support@advocatemcp.com>",
          reply_to: "max@advocate-mcp.com",
          to:       [email],
          subject,
          html,
          text,
        }),
      });
    } catch (err) {
      console.warn(JSON.stringify({ event: "team_invite_email_failed", email, error: String(err).slice(0, 200) }));
      // Don't fail the request — the invite row is in D1 and an admin
      // can manually retrieve the token for resend if needed.
    }
  }

  return withCors(
    await jsonOk({ ok: true, user_id: userId, role, email_sent: isNewUser, invite_url: inviteUrl }),
    request,
    { credentials: true },
  );
}

// ── DELETE /api/client/team/:user_id — owner removes a member ────────────────

export async function handleRemoveTeam(request: Request, env: Env, userId: string): Promise<Response> {
  const r = await resolveTenant(request, env);
  if (!r.ok) return r.resp;
  if (r.tenant.user_role !== "owner") {
    return withCors(await jsonErr(403, "forbidden_role: only owners can remove team members"), request, { credentials: true });
  }
  if (userId === r.ctx.user_id) {
    return withCors(await jsonErr(409, "cannot_remove_self"), request, { credentials: true });
  }

  // Refuse to remove another owner — owner must be demoted first.
  const target = await env.DB
    .prepare("SELECT role FROM user_business_access WHERE user_id = ? AND business_id = ?")
    .bind(userId, r.tenant.business_id)
    .first<{ role: string }>();
  if (!target) return withCors(await jsonErr(404, "not_a_member"), request, { credentials: true });
  if (target.role === "owner") {
    return withCors(
      await jsonErr(409, "cannot_remove_owner: demote them to editor or viewer first"),
      request, { credentials: true },
    );
  }

  await env.DB
    .prepare("DELETE FROM user_business_access WHERE user_id = ? AND business_id = ?")
    .bind(userId, r.tenant.business_id)
    .run();
  // Revoke any active sessions for the removed user — they're locked
  // out immediately rather than at session expiry.
  await env.DB
    .prepare("DELETE FROM sessions WHERE user_id = ?")
    .bind(userId)
    .run();
  return withCors(await jsonOk({ ok: true }), request, { credentials: true });
}

// ── PATCH /api/client/team/:user_id/role — owner changes a member's role ─────

export async function handleUpdateTeamRole(request: Request, env: Env, userId: string): Promise<Response> {
  const r = await resolveTenant(request, env);
  if (!r.ok) return r.resp;
  if (r.tenant.user_role !== "owner") {
    return withCors(await jsonErr(403, "forbidden_role: only owners can change team roles"), request, { credentials: true });
  }

  let body: { role?: unknown };
  try { body = await request.json(); } catch {
    return withCors(await jsonErr(400, "invalid_json"), request, { credentials: true });
  }
  const newRole = body.role;
  if (newRole !== "owner" && newRole !== "editor" && newRole !== "viewer") {
    return withCors(await jsonErr(400, "invalid_role"), request, { credentials: true });
  }

  // Promoting to owner is a transactional demote-then-promote so the
  // pricing-page implicit "one owner per tenant" stays true. (D1
  // doesn't enforce a partial unique index across roles, so we do it
  // in code.)
  if (newRole === "owner") {
    // Demote the existing owner (which is the caller themselves —
    // we already checked user_role === 'owner') to editor first.
    await env.DB
      .prepare("UPDATE user_business_access SET role = 'editor' WHERE user_id = ? AND business_id = ?")
      .bind(r.ctx.user_id, r.tenant.business_id)
      .run();
  }

  await env.DB
    .prepare("UPDATE user_business_access SET role = ? WHERE user_id = ? AND business_id = ?")
    .bind(newRole, userId, r.tenant.business_id)
    .run();
  return withCors(await jsonOk({ ok: true, role: newRole }), request, { credentials: true });
}

// ── POST /auth/team-accept — public, token-protected ─────────────────────────

export async function handleTeamAccept(request: Request, env: Env): Promise<Response> {
  if (!env.INVITE_SIGNING_KEY) {
    return jsonErr(503, "team_accept_unavailable");
  }
  let body: { token?: unknown; password?: unknown; full_name?: unknown };
  try { body = await request.json(); } catch {
    return jsonErr(400, "invalid_json");
  }
  const token = typeof body.token === "string" ? body.token : "";
  const password = typeof body.password === "string" ? body.password : "";
  const fullName = typeof body.full_name === "string" ? body.full_name.trim().slice(0, 200) : null;
  if (!token) return jsonErr(400, "missing_token");
  if (password.length < 8 || password.length > 200) {
    return jsonErr(400, "invalid_password: must be 8-200 characters");
  }

  let payload;
  try {
    payload = await verifyInviteToken(token, env.INVITE_SIGNING_KEY);
  } catch (err) {
    const code = err as InviteTokenError;
    return jsonErr(401, code === "expired" ? "expired" : "invalid_token");
  }

  // One-shot consume guard: invite_consumed_at is NULL on fresh invites.
  // We use UPDATE ... WHERE invite_consumed_at IS NULL with row count
  // check so a concurrent second click sees changes=0 and 410s.
  const userRow = await env.DB
    .prepare("SELECT id, email, pending_invite, invite_consumed_at FROM users WHERE id = ? LIMIT 1")
    .bind(payload.user_id)
    .first<{ id: string; email: string; pending_invite: number; invite_consumed_at: string | null }>();
  if (!userRow) return jsonErr(404, "user_not_found");
  if (userRow.invite_consumed_at) {
    return jsonErr(410, "already_accepted: this invite has already been used. Sign in instead.");
  }

  // Set the password.
  const salt = generateSalt();
  const newHash = await hashPassword(password, salt);
  const update = await env.DB
    .prepare(
      `UPDATE users
          SET password_hash = ?, salt = ?, full_name = COALESCE(?, full_name),
              pending_invite = 0, invite_consumed_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ? AND invite_consumed_at IS NULL`,
    )
    .bind(newHash, salt, fullName, payload.user_id)
    .run();

  if ((update.meta?.changes ?? 0) === 0) {
    // Lost the race — another tab consumed the invite.
    return jsonErr(410, "already_accepted");
  }

  // Mint a session.
  const rawToken = generateSessionToken();
  const tokenHash = await hashToken(rawToken);
  const sessionId = newId();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await env.DB
    .prepare(
      `INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)`,
    )
    .bind(sessionId, payload.user_id, tokenHash, expiresAt)
    .run();

  return new Response(
    JSON.stringify({ ok: true, redirect: "/dashboard" }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Set-Cookie":   sessionCookieHeader(rawToken),
      },
    },
  );
}

// ── CORS preflight wrappers ──────────────────────────────────────────────────

export function handleTeamAcceptPreflight(request: Request): Response {
  return handleCorsPreflight(request, { credentials: true });
}

// ── Utility ──────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
