/**
 * TOTP enrollment + disable endpoints — SOC 2 CC6.1/CC6.6.
 *
 * Authenticated (Bearer access token via getSessionFromRequest). The login
 * handler in authApi.ts consults the user's totp_secret + totp_enabled_at
 * columns on every login and requires a 6-digit code in the request body
 * when both are set.
 *
 *   POST /api/auth/totp/enroll-start
 *     Body: {}
 *     Returns: { secret, otpauth_uri }
 *     - Generates a fresh base32 secret + otpauth URI for QR display.
 *     - Persists the secret with totp_enabled_at = NULL (pending confirmation).
 *     - Rejects (409) if the user is already enrolled.
 *
 *   POST /api/auth/totp/enroll-confirm
 *     Body: { code }
 *     Returns: { ok: true, totp_enabled_at }
 *     - Verifies the supplied 6-digit code against the pending secret.
 *     - On success, sets totp_enabled_at = now().
 *     - On failure, leaves columns untouched so the caller can retry.
 *
 *   POST /api/auth/totp/disable
 *     Body: { password, code }
 *     Returns: { ok: true }
 *     - Requires BOTH the user's current password AND a current TOTP code
 *       — defense in depth against a compromised session disabling MFA.
 *     - Clears totp_secret + totp_enabled_at.
 *
 * Audit events: every state change writes an auth.totp_* row via the
 * recordAuditEvent helper so an auditor can trace enrollment / disable /
 * failed-disable attempts. SOC 2 CC7.2.
 */

import type { Env } from "../types";
import {
  verifyAndMaybeRehash,
} from "../auth";
import {
  recordAuditEvent,
  clientIpFromRequest,
  hashClientIp,
  requestIdFromRequest,
} from "../lib/auditLog";
import {
  generateTotpSecret,
  verifyTotpCode,
  buildOtpauthUri,
} from "../lib/totp";
import { getSessionFromRequest } from "./authApi";
import { withCors } from "../lib/cors";

function jsonErr(status: number, error: string, request: Request): Response {
  return withCors(
    new Response(JSON.stringify({ error }), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
    request,
    { credentials: true },
  );
}

function jsonOk(body: unknown, request: Request, status = 200): Response {
  return withCors(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
    request,
    { credentials: true },
  );
}

interface UserTotpRow {
  id: string;
  email: string;
  password_hash: string;
  salt: string;
  totp_secret: string | null;
  totp_enabled_at: string | null;
}

async function loadUserTotp(env: Env, userId: string): Promise<UserTotpRow | null> {
  return env.DB
    .prepare(
      `SELECT id, email, password_hash, salt, totp_secret, totp_enabled_at
       FROM users WHERE id = ? LIMIT 1`,
    )
    .bind(userId)
    .first<UserTotpRow>() ?? null;
}

const TOTP_ISSUER = "AdvocateMCP";

// ── POST /api/auth/totp/enroll-start ──────────────────────────────────────

export async function handleTotpEnrollStart(request: Request, env: Env): Promise<Response> {
  const ctx = await getSessionFromRequest(request, env);
  if (!ctx) return jsonErr(401, "unauthorized", request);

  const user = await loadUserTotp(env, ctx.user_id);
  if (!user) return jsonErr(404, "user_not_found", request);

  if (user.totp_enabled_at) {
    // Already enrolled — caller must disable first. Returning 409 prevents
    // an accidental re-enrollment that would silently replace the secret
    // and lock the user out of their existing authenticator app.
    return jsonErr(409, "totp_already_enabled", request);
  }

  const secret = generateTotpSecret();
  const otpauth = buildOtpauthUri({
    label: user.email,
    issuer: TOTP_ISSUER,
    secret,
  });

  // Persist the secret with totp_enabled_at = NULL. A fresh enroll-start
  // overwrites any previous pending secret, which is intentional — the
  // user may have scanned the QR into the wrong app and want to retry.
  try {
    await env.DB
      .prepare(
        "UPDATE users SET totp_secret = ?, totp_enabled_at = NULL, updated_at = ? WHERE id = ?",
      )
      .bind(secret, new Date().toISOString(), user.id)
      .run();
  } catch (err) {
    console.error(JSON.stringify({
      auth: true,
      event: "totp_enroll_start_d1_failed",
      user_id: user.id,
      error: String(err),
    }));
    return jsonErr(500, "platform_error", request);
  }

  await recordAuditEvent(env.DB, {
    actorType: "user",
    actorId: user.id,
    eventType: "auth.totp_enroll_started",
    targetType: "user",
    targetId: user.id,
    ipHash: await hashClientIp(clientIpFromRequest(request)),
    requestId: requestIdFromRequest(request),
  });

  return jsonOk({ secret, otpauth_uri: otpauth }, request);
}

// ── POST /api/auth/totp/enroll-confirm ────────────────────────────────────

export async function handleTotpEnrollConfirm(request: Request, env: Env): Promise<Response> {
  const ctx = await getSessionFromRequest(request, env);
  if (!ctx) return jsonErr(401, "unauthorized", request);

  let code = "";
  try {
    const body = await request.json() as Record<string, unknown>;
    code = typeof body.code === "string" ? body.code : "";
  } catch {
    return jsonErr(400, "invalid_body", request);
  }
  if (!code) return jsonErr(400, "invalid_body", request);

  const user = await loadUserTotp(env, ctx.user_id);
  if (!user) return jsonErr(404, "user_not_found", request);
  if (!user.totp_secret) return jsonErr(409, "totp_not_pending", request);
  if (user.totp_enabled_at) return jsonErr(409, "totp_already_enabled", request);

  const ok = await verifyTotpCode(user.totp_secret, code);
  if (!ok) {
    await recordAuditEvent(env.DB, {
      actorType: "user",
      actorId: user.id,
      eventType: "auth.totp_enroll_confirm_failed",
      targetType: "user",
      targetId: user.id,
      ipHash: await hashClientIp(clientIpFromRequest(request)),
      requestId: requestIdFromRequest(request),
    });
    return jsonErr(400, "invalid_code", request);
  }

  const enabledAt = new Date().toISOString();
  try {
    await env.DB
      .prepare(
        "UPDATE users SET totp_enabled_at = ?, updated_at = ? WHERE id = ?",
      )
      .bind(enabledAt, enabledAt, user.id)
      .run();
  } catch (err) {
    console.error(JSON.stringify({
      auth: true,
      event: "totp_enroll_confirm_d1_failed",
      user_id: user.id,
      error: String(err),
    }));
    return jsonErr(500, "platform_error", request);
  }

  await recordAuditEvent(env.DB, {
    actorType: "user",
    actorId: user.id,
    eventType: "auth.totp_enrolled",
    targetType: "user",
    targetId: user.id,
    ipHash: await hashClientIp(clientIpFromRequest(request)),
    requestId: requestIdFromRequest(request),
  });

  return jsonOk({ ok: true, totp_enabled_at: enabledAt }, request);
}

// ── POST /api/auth/totp/disable ───────────────────────────────────────────

export async function handleTotpDisable(request: Request, env: Env): Promise<Response> {
  const ctx = await getSessionFromRequest(request, env);
  if (!ctx) return jsonErr(401, "unauthorized", request);

  let password = "";
  let code = "";
  try {
    const body = await request.json() as Record<string, unknown>;
    password = typeof body.password === "string" ? body.password : "";
    code = typeof body.code === "string" ? body.code : "";
  } catch {
    return jsonErr(400, "invalid_body", request);
  }
  if (!password || !code) return jsonErr(400, "invalid_body", request);

  const user = await loadUserTotp(env, ctx.user_id);
  if (!user) return jsonErr(404, "user_not_found", request);
  if (!user.totp_secret || !user.totp_enabled_at) {
    return jsonErr(409, "totp_not_enabled", request);
  }

  // Require BOTH factors — current password AND current code. A compromised
  // session token alone cannot disable MFA.
  const pwOk = (await verifyAndMaybeRehash(password, user.salt, user.password_hash)).ok;
  const codeOk = await verifyTotpCode(user.totp_secret, code);
  if (!pwOk || !codeOk) {
    await recordAuditEvent(env.DB, {
      actorType: "user",
      actorId: user.id,
      eventType: "auth.totp_disable_failed",
      targetType: "user",
      targetId: user.id,
      metadata: { password_ok: pwOk, code_ok: codeOk },
      ipHash: await hashClientIp(clientIpFromRequest(request)),
      requestId: requestIdFromRequest(request),
    });
    return jsonErr(401, "invalid_credentials", request);
  }

  try {
    await env.DB
      .prepare(
        "UPDATE users SET totp_secret = NULL, totp_enabled_at = NULL, updated_at = ? WHERE id = ?",
      )
      .bind(new Date().toISOString(), user.id)
      .run();
  } catch (err) {
    console.error(JSON.stringify({
      auth: true,
      event: "totp_disable_d1_failed",
      user_id: user.id,
      error: String(err),
    }));
    return jsonErr(500, "platform_error", request);
  }

  await recordAuditEvent(env.DB, {
    actorType: "user",
    actorId: user.id,
    eventType: "auth.totp_disabled",
    targetType: "user",
    targetId: user.id,
    ipHash: await hashClientIp(clientIpFromRequest(request)),
    requestId: requestIdFromRequest(request),
  });

  return jsonOk({ ok: true }, request);
}
