// Client portal: login, logout, dashboard, and protected JSON API.
// All HTML is server-rendered — no client-side framework required.

import type { Env } from "../types";
import {
  generateSalt, hashPassword, verifyPassword,
  getSessionToken, sessionCookieHeader, clearSessionCookieHeader,
} from "../auth";
import {
  getUserByEmail, createUser, updateUserPassword, createSession, getSessionByToken,
  deleteSession, getUserBusinesses, getAllBusinesses, getBusinessBySlug, createBusiness,
  grantAccess, checkRateLimit, recordLoginAttempt, updateBusinessApiKey,
} from "../portalDb";
import type { Business, User, SessionWithUser } from "../portalDb";
import { buildDashboard, type AnalyticsData } from "./dashboard";
import { handleActivateDomain, handleDomainStatus } from "./domains";
import {
  handleOnboard, handleOnboardStatus, handleOnboardList,
  handleVerifyDomain, handleVerifyAll, handleDisableTenant,
  getTenant,
} from "./onboard";
import { handleOnboardPage } from "./onboardPage";
import { handleActivatePage } from "./activatePage";
import { handleActivate, handleActivateHosted, handleActivationToken, handleGetActivation, handleResendActivation } from "./activate";
import {
  getSessionFromRequest,
  handleAuthLogin,
  handleAuthLogout,
  handleAuthRefresh,
  handleAuthPreflight,
} from "./authApi";
import { withCors, handleCorsPreflight } from "../lib/cors";
import {
  handleBasicOnboard,
  handlePublicOnboard,
  handlePublicOnboardPreflight,
  handleStripeWebhook,
  handleSessionStatus,
} from "./stripe";
import { handleSaveDraft, handleLoadDraft } from "./onboardDraft";

// ── Public route dispatcher ────────────────────────────────────────────────
// Returns a Response if this is a portal path, or null to fall through to
// the existing AI-crawler logic.

export async function handlePortal(request: Request, env: Env): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  const method = request.method;

  if (pathname === "/login"               && method === "GET")  return Response.redirect("https://advocatemcp.com/login.html", 301);
  if (pathname === "/auth/login"          && method === "POST") return authLogin(request, env);
  if (pathname === "/auth/logout"         && method === "POST") return authLogout(request, env);
  if (pathname === "/dashboard"           && method === "GET")  return Response.redirect("https://advocatemcp.com/dashboard.html", 301);
  if (pathname === "/api/client/me"       && method === "GET")  return apiMe(request, env);
  if (pathname === "/api/client/metrics"  && method === "GET")  return apiMetrics(request, env);
  if (pathname === "/api/client/activity"   && method === "GET")  return apiActivity(request, env);
  if (pathname === "/api/client/rotate-key" && method === "POST") return apiRotateKey(request, env);
  if (pathname === "/admin/create-client"      && method === "POST") return adminCreateClient(request, env);
  if (pathname === "/admin/domains/activate"   && method === "POST") return handleActivateDomain(request, env);
  if (pathname === "/status"                   && method === "GET")  return statusPage(request, env);
  if (pathname === "/onboard"                  && method === "GET")  return handleOnboardPage(request, env);

  // ── Phase 3 self-serve activation (post-payment, token-gated) ──────────
  // Separate flow from the existing /onboard wizard. See feat(worker):
  // phase 3 spine commit for the full design rationale.
  if (pathname === "/activate"                 && method === "GET")  return handleActivatePage(request, env);
  if (pathname === "/api/activate"             && method === "OPTIONS") return handleCorsPreflight(request);
  if (pathname === "/api/activate"             && method === "POST")    return handleActivate(request, env);
  if (pathname === "/api/activate/hosted"      && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/activate/hosted"      && method === "POST")    return handleActivateHosted(request, env);
  if (pathname === "/admin/activation-token"   && method === "POST") return handleActivationToken(request, env);

  // ── Phase C cross-origin auth endpoints ────────────────────────────────
  // See docs/rearchitecture-plan-2026-04-10.md Section 8 Phase C and the
  // Phase C session notes in docs/session-2026-04-11-phase-c-*.md for the
  // full design (hybrid Bearer access + refresh cookie pattern). All three
  // endpoints use credentials: true on CORS because they read and/or write
  // the amcp_refresh cookie.
  if (pathname === "/api/auth/login"   && method === "OPTIONS") return handleAuthPreflight(request);
  if (pathname === "/api/auth/login"   && method === "POST")    return handleAuthLogin(request, env);
  if (pathname === "/api/auth/logout"  && method === "OPTIONS") return handleAuthPreflight(request);
  if (pathname === "/api/auth/logout"  && method === "POST")    return handleAuthLogout(request, env);
  if (pathname === "/api/auth/refresh" && method === "OPTIONS") return handleAuthPreflight(request);
  if (pathname === "/api/auth/refresh" && method === "POST")    return handleAuthRefresh(request, env);

  // ── Phase C CORS preflight for the existing /api/client/* endpoints ────
  // credentials: true is required because the dashboard frontend at
  // advocatemcp.com sends credentials: 'include' on every fetch so
  // the refresh cookie can flow cross-origin. Without the flag the
  // browser rejects the preflight with: "The value of the
  // 'Access-Control-Allow-Credentials' header in the response is ''
  // which must be 'true'".
  if (pathname === "/api/client/me"         && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/metrics"    && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/activity"   && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/rotate-key" && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });

  // ── Stripe / new onboarding API ──────────────────────────────────────────
  if (pathname === "/api/onboard/basic"     && method === "POST") return handleBasicOnboard(request, env);
  if (pathname === "/api/stripe/webhook"    && method === "POST") return handleStripeWebhook(request, env);

  // Public wizard endpoint (advocatemcp.com → customers.advocatemcp.com)
  if (pathname === "/api/onboard/public"    && method === "OPTIONS") return handlePublicOnboardPreflight(request);
  if (pathname === "/api/onboard/public"    && method === "POST")    return handlePublicOnboard(request, env);

  // GET /api/onboard/session/:session_id (CORS; public for skipDns tenants)
  const sessionMatch = pathname.match(/^\/api\/onboard\/session\/([^/]+)$/);
  if (sessionMatch && method === "OPTIONS") return handlePublicOnboardPreflight(request);
  if (sessionMatch && method === "GET") return handleSessionStatus(request, env, sessionMatch[1]);

  // Save & Exit — wizard draft persistence (Task 8)
  if (pathname === "/api/onboard/draft" && method === "POST") return handleSaveDraft(request, env);
  const draftLoadMatch = pathname.match(/^\/api\/onboard\/draft\/([^/]+)$/);
  if (draftLoadMatch && method === "GET") return handleLoadDraft(request, env, decodeURIComponent(draftLoadMatch[1]));

  // ── Onboarding API (legacy + admin) ────────────────────────────────────
  if (pathname === "/api/onboard"           && method === "POST") return handleOnboard(request, env);
  if (pathname === "/api/onboard/list"      && method === "GET")  return handleOnboardList(request, env);
  if (pathname === "/api/onboard/verify-all" && method === "POST") return handleVerifyAll(request, env);

  // /api/onboard/:domain/status | /verify | /disable
  const onboardMatch = pathname.match(/^\/api\/onboard\/([^/]+)\/(status|verify|disable)$/);
  if (onboardMatch) {
    const [, rawDomain, action] = onboardMatch;
    if (action === "status"  && method === "GET")  return handleOnboardStatus(request, env, rawDomain);
    if (action === "verify"  && method === "POST") return handleVerifyDomain(request, env, rawDomain);
    if (action === "disable" && method === "POST") return handleDisableTenant(request, env, rawDomain);
  }

  // GET /admin/domains/:slug/status (legacy endpoint)
  const domainStatusMatch = pathname.match(/^\/admin\/domains\/([^/]+)\/status$/);
  if (domainStatusMatch && method === "GET") {
    return handleDomainStatus(request, env, domainStatusMatch[1]);
  }

  // GET /admin/businesses/:slug/activation (Phase F Part 1 — read
  // activation token minted by the Stripe webhook for operator manual
  // delivery until the email worker ships in a later session).
  const activationMatch = pathname.match(/^\/admin\/businesses\/([^/]+)\/activation$/);
  if (activationMatch && method === "GET") {
    return handleGetActivation(request, env, activationMatch[1]);
  }

  // POST /admin/businesses/:slug/resend-activation (Phase F Part 2 —
  // operator backstop to re-send the activation email if the webhook's
  // automatic send failed or was missed).
  const resendMatch = pathname.match(/^\/admin\/businesses\/([^/]+)\/resend-activation$/);
  if (resendMatch && method === "POST") {
    return handleResendActivation(request, env, resendMatch[1]);
  }

  return null;
}

// ── Session helper ─────────────────────────────────────────────────────────

/**
 * Legacy session helper — intentionally preserved from pre-Phase-C as a
 * single-use wrapper for `loginPage` below. All other auth checks in this
 * file (dashboard, apiMe, apiMetrics, apiActivity, apiRotateKey) go through
 * `getSessionFromRequest` from `./authApi`, which supports both the new
 * Phase C Bearer access token path and the legacy amcp_session cookie.
 *
 * This helper exists solely because `loginPage` was explicitly excluded
 * from modification in the Phase C Commit 5 scope, and updating its one
 * call site would have counted as a modification. Delete this helper
 * alongside `loginPage` itself during Phase E when the legacy admin HTML
 * pages are deprecated per `docs/rearchitecture-plan-2026-04-10.md`
 * Section 8 Phase E.
 *
 * See commit `48c5978` (Phase C Commit 4) for the introduction of
 * `getSessionFromRequest` and the rationale for the unified auth flow.
 */
async function requireSession(request: Request, env: Env): Promise<SessionWithUser | null> {
  const token = getSessionToken(request);
  if (!token) return null;
  return getSessionByToken(env.DB, token);
}

// ── GET /login ─────────────────────────────────────────────────────────────

async function loginPage(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env);
  if (session) return redirect("/dashboard");

  const error = new URL(request.url).searchParams.get("error");
  const msgs: Record<string, string> = {
    invalid:      "Invalid email or password.",
    rate_limited: "Too many login attempts. Please wait 15 minutes.",
    expired:      "Your session has expired. Please sign in again.",
  };
  return html(loginHtml(msgs[error ?? ""] ?? null));
}

// ── POST /auth/login ───────────────────────────────────────────────────────

async function authLogin(request: Request, env: Env): Promise<Response> {
  const ct = request.headers.get("Content-Type") ?? "";
  let email = "", password = "";

  if (ct.includes("application/json")) {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    email    = String(body.email ?? "");
    password = String(body.password ?? "");
  } else {
    const form = await request.formData().catch(() => new FormData());
    email    = String(form.get("email") ?? "");
    password = String(form.get("password") ?? "");
  }

  if (!email || !password) return redirect("/login?error=invalid");

  const identifier = email.toLowerCase().trim();

  const allowed = await checkRateLimit(env.DB, identifier);
  if (!allowed) return redirect("/login?error=rate_limited");

  const user = await getUserByEmail(env.DB, email);
  if (!user) {
    await recordLoginAttempt(env.DB, identifier);
    return redirect("/login?error=invalid");
  }

  const ok = await verifyPassword(password, user.salt, user.password_hash);
  if (!ok) {
    await recordLoginAttempt(env.DB, identifier);
    return redirect("/login?error=invalid");
  }

  const { token } = await createSession(env.DB, user.id);
  return new Response(null, {
    status: 302,
    headers: { Location: "/dashboard", "Set-Cookie": sessionCookieHeader(token) },
  });
}

// ── POST /auth/logout ──────────────────────────────────────────────────────

async function authLogout(request: Request, env: Env): Promise<Response> {
  const token = getSessionToken(request);
  if (token) await deleteSession(env.DB, token);
  return new Response(null, {
    status: 302,
    headers: { Location: "/login", "Set-Cookie": clearSessionCookieHeader() },
  });
}

// ── GET /dashboard ─────────────────────────────────────────────────────────

async function dashboard(request: Request, env: Env): Promise<Response> {
  const ctx = await getSessionFromRequest(request, env);
  if (!ctx) return redirect("/login?error=expired");

  const businesses = ctx.role === "admin"
    ? await getAllBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);

  // Dashboard gating: redirect non-admin users whose tenant isn't active yet
  if (ctx.role !== "admin" && businesses.length > 0) {
    const biz = businesses[0];
    if (biz.domain) {
      const tenant = await getTenant(env, biz.domain);
      if (tenant) {
        const gatedStatuses = ["pending_payment", "paid_pending_dns", "free_pending_dns", "pending_verification"];
        if (gatedStatuses.includes(tenant.status)) {
          return redirect("/onboard");
        }
      }
    }
  }

  const slug = new URL(request.url).searchParams.get("slug");
  const selected = (slug ? businesses.find((b) => b.slug === slug) : null) ?? businesses[0] ?? null;
  const analytics = selected ? await fetchAnalytics(selected, env) : null;

  // Synthesize a minimal User object for buildDashboard. buildDashboard
  // (see worker/src/routes/dashboard.ts) only reads user.full_name and
  // user.email from this parameter — verified via grep during Phase C
  // Commit 5 implementation. The other User fields (password_hash, salt,
  // created_at, updated_at) are provided as empty strings to satisfy the
  // User interface without doing an extra getUserById D1 query.
  const userForDashboard: User = {
    id:            ctx.user_id,
    email:         ctx.email,
    password_hash: "",
    salt:          "",
    full_name:     ctx.full_name,
    role:          ctx.role,
    created_at:    "",
    updated_at:    "",
  };
  return html(buildDashboard(userForDashboard, businesses, selected, analytics));
}

// ── GET /api/client/me ─────────────────────────────────────────────────────

async function apiMe(request: Request, env: Env): Promise<Response> {
  const ctx = await getSessionFromRequest(request, env);
  if (!ctx) return withCors(jsonErr(401, "Unauthorized"), request, { credentials: true });
  return withCors(
    jsonOk({ id: ctx.user_id, email: ctx.email, full_name: ctx.full_name, role: ctx.role }),
    request,
    { credentials: true },
  );
}

// ── GET /api/client/metrics ────────────────────────────────────────────────

async function apiMetrics(request: Request, env: Env): Promise<Response> {
  const ctx = await getSessionFromRequest(request, env);
  if (!ctx) return withCors(jsonErr(401, "Unauthorized"), request, { credentials: true });

  const businesses = ctx.role === "admin"
    ? await getAllBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const slug = new URL(request.url).searchParams.get("slug");
  const biz  = (slug ? businesses.find((b) => b.slug === slug) : null) ?? businesses[0] ?? null;
  if (!biz) return withCors(jsonErr(404, "No business found for this account"), request, { credentials: true });

  const data = await fetchAnalytics(biz, env);
  return withCors(jsonOk(data ?? { message: "No data available yet", slug: biz.slug }), request, { credentials: true });
}

// ── GET /api/client/activity ───────────────────────────────────────────────

async function apiActivity(request: Request, env: Env): Promise<Response> {
  const ctx = await getSessionFromRequest(request, env);
  if (!ctx) return withCors(jsonErr(401, "Unauthorized"), request, { credentials: true });

  const businesses = ctx.role === "admin"
    ? await getAllBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const slug = new URL(request.url).searchParams.get("slug");
  const biz  = (slug ? businesses.find((b) => b.slug === slug) : null) ?? businesses[0] ?? null;
  if (!biz) return withCors(jsonErr(404, "No business found for this account"), request, { credentials: true });

  const data = await fetchAnalytics(biz, env);
  return withCors(jsonOk(data?.recent_queries ?? []), request, { credentials: true });
}

// ── POST /api/client/rotate-key ───────────────────────────────────────────

async function apiRotateKey(request: Request, env: Env): Promise<Response> {
  const ctx = await getSessionFromRequest(request, env);
  if (!ctx) return withCors(jsonErr(401, "Unauthorized"), request, { credentials: true });

  const businesses = await getUserBusinesses(env.DB, ctx.user_id);
  const slug = new URL(request.url).searchParams.get("slug");
  const biz  = (slug ? businesses.find((b) => b.slug === slug) : null) ?? businesses[0] ?? null;
  if (!biz) return withCors(jsonErr(404, "No business found for this account"), request, { credentials: true });

  const base = env.API_BASE_URL ?? "https://advocate-production-2887.up.railway.app";
  let rotateRes: Response;
  try {
    rotateRes = await fetch(`${base}/agents/${biz.slug}/rotate-key`, {
      method: "POST",
      headers: { ...(env.API_KEY ? { "X-API-Key": env.API_KEY } : {}) },
    });
  } catch (err) {
    return withCors(jsonErr(502, `Backend unreachable: ${String(err)}`), request, { credentials: true });
  }

  if (!rotateRes.ok) return withCors(jsonErr(502, "Backend failed to rotate key"), request, { credentials: true });
  const data = await rotateRes.json() as { ok: boolean; new_api_key: string };
  if (!data.ok || !data.new_api_key) return withCors(jsonErr(502, "Invalid response from backend"), request, { credentials: true });

  await updateBusinessApiKey(env.DB, biz.slug, data.new_api_key);
  return withCors(jsonOk({ ok: true, new_api_key: data.new_api_key }), request, { credentials: true });
}

// ── POST /admin/create-client ──────────────────────────────────────────────
// Protected by Bearer ADMIN_SECRET (wrangler secret put ADMIN_SECRET).
// Returns 401 for any auth failure — no detail that distinguishes wrong secret
// from unconfigured secret, preventing enumeration.

async function adminCreateClient(request: Request, env: Env): Promise<Response> {
  // Reject non-JSON content types before touching the body.
  const ct = request.headers.get("Content-Type") ?? "";
  if (!ct.includes("application/json")) {
    return jsonErr(415, "Content-Type must be application/json");
  }

  // Constant-time-equivalent auth: evaluate both sides before branching.
  const given  = request.headers.get("Authorization") ?? "";
  const secret = env.ADMIN_SECRET ?? "";
  const credentialValid = secret.length > 0 && given === `Bearer ${secret}`;
  if (!credentialValid) return jsonErr(401, "Unauthorized");

  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; }
  catch { return jsonErr(400, "Body must be valid JSON"); }

  const { email, password, full_name, slug, business_name, api_key, role: rawRole } = body as {
    email?: string; password?: string; full_name?: string;
    slug?: string; business_name?: string; api_key?: string; role?: string;
  };

  const userRole = rawRole === "admin" ? "admin" : "client";

  // email + password always required; slug/business_name/api_key only for clients
  const baseMissing  = ["email", "password"].filter((k) => !body[k] || typeof body[k] !== "string");
  const bizMissing   = userRole === "client"
    ? ["slug", "business_name", "api_key"].filter((k) => !body[k] || typeof body[k] !== "string")
    : [];
  const missing = [...baseMissing, ...bizMissing];
  if (missing.length > 0) {
    return jsonErr(400, `Missing or invalid fields: ${missing.join(", ")}`);
  }

  try {
    const salt         = generateSalt();
    const passwordHash = await hashPassword(password!, salt);

    let user = await getUserByEmail(env.DB, email!);
    if (!user) {
      user = await createUser(env.DB, email!, passwordHash, salt, full_name, userRole);
    } else {
      await updateUserPassword(env.DB, user.id, passwordHash, salt);
    }

    let biz: Awaited<ReturnType<typeof getBusinessBySlug>> = null;
    if (userRole === "client" && slug && business_name && api_key) {
      biz = await getBusinessBySlug(env.DB, slug);
      if (!biz) biz = await createBusiness(env.DB, slug, business_name, api_key);
      await grantAccess(env.DB, user.id, biz.id);
    }

    return jsonOk({
      message:  "Client created. They can log in at /login.",
      user:     { id: user.id, email: user.email, full_name: user.full_name, role: user.role },
      business: biz ? { id: biz.id, slug: biz.slug, business_name: biz.business_name } : null,
    });
  } catch (err) {
    return jsonErr(500, String(err));
  }
}

// ── GET /status ─────────────────────────────────────────────────────────────
// Public dashboard: all active SMBs + global recent crawler hits.

interface GlobalAnalytics {
  total_queries: number;
  total_referral_clicks: number;
  queries_by_crawler: Record<string, number>;
  recent_hits: Array<{
    id: number;
    business_slug: string;
    business_name: string | null;
    crawler_agent: string | null;
    query_text: string;
    intent: string | null;
    referral_clicked: number;
    timestamp: string;
  }>;
}

interface RegistryBusiness {
  slug: string;
  name: string;
  description: string;
  category: string | null;
  location: string | null;
  website: string | null;
  star_rating: number | null;
  review_count: number | null;
  pricing_tier: string | null;
  availability: string | null;
  differentiator: string | null;
  created_at: string;
  agent_endpoint: string;
  profile_endpoint: string;
}

async function statusPage(_request: Request, env: Env): Promise<Response> {
  const base = env.API_BASE_URL ?? "https://advocate-production-2887.up.railway.app";

  const [registryRes, analyticsRes] = await Promise.allSettled([
    fetch(`${base}/registry`),
    fetch(`${base}/analytics`),
  ]);

  const registry = registryRes.status === "fulfilled" && registryRes.value.ok
    ? (await registryRes.value.json() as { count: number; businesses: RegistryBusiness[] })
    : { count: 0, businesses: [] };

  const analytics = analyticsRes.status === "fulfilled" && analyticsRes.value.ok
    ? (await analyticsRes.value.json() as GlobalAnalytics)
    : null;

  return html(statusHtml(registry, analytics));
}

function statusHtml(
  registry: { count: number; businesses: RegistryBusiness[] },
  analytics: GlobalAnalytics | null
): string {
  const total   = analytics?.total_queries ?? 0;
  const clicks  = analytics?.total_referral_clicks ?? 0;
  const topBot  = analytics
    ? Object.entries(analytics.queries_by_crawler).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "—"
    : "—";

  const smbRows = registry.businesses.map((b) => `
    <tr>
      <td><strong>${esc(b.name)}</strong>${b.category ? `<br><span class="ts">${esc(b.category)}</span>` : ""}</td>
      <td class="ts">${esc(b.location ?? "—")}</td>
      <td>${b.pricing_tier ? `<span class="badge">${esc(b.pricing_tier)}</span>` : "—"}</td>
      <td class="ts">${esc(b.availability ?? "—")}</td>
      <td><a href="${esc(b.website ?? "#")}" target="_blank" rel="noopener" style="color:#2563eb">${esc(b.slug)}</a></td>
    </tr>`).join("");

  const hitRows = (analytics?.recent_hits ?? []).map((h) => `
    <tr>
      <td class="ts">${esc(fmtDate(h.timestamp))}</td>
      <td><strong>${esc(h.business_name ?? h.business_slug)}</strong></td>
      <td><span class="badge">${esc(h.crawler_agent ?? "unknown")}</span></td>
      <td>${h.intent ? `<span class="badge">${esc(h.intent)}</span>` : "<span class='ts'>—</span>"}</td>
      <td class="qt">${esc(h.query_text.length > 80 ? h.query_text.slice(0, 80) + "…" : h.query_text)}</td>
      <td class="${h.referral_clicked ? "yes" : "no"}">${h.referral_clicked ? "✓" : "—"}</td>
    </tr>`).join("");

  const crawlerBadges = analytics
    ? Object.entries(analytics.queries_by_crawler)
        .sort((a, b) => b[1] - a[1])
        .map(([bot, n]) => `<span class="badge" style="margin:.2rem">${esc(bot)}: ${n}</span>`)
        .join(" ")
    : "<span class='ts'>No data yet</span>";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Platform Status — AdvocateMCP</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
@import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--text:#111827;--sub:#6b7280;--muted:#9ca3af;--border:#e5e7eb;--page:#f9fafb;--card:#fff;--accent:#111827;--al:#f3f4f6}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;background:var(--page);color:var(--text);font-size:.875rem;line-height:1.5}
h1,h2,h3,h4,h5,h6{font-family:'Poppins',sans-serif}
.header{background:var(--accent);color:#fff;padding:1.25rem 2rem;display:flex;align-items:center;gap:.75rem}
.hlogo{width:28px;height:28px;background:rgba(255,255,255,.15);border-radius:5px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:.8125rem}
.hname{font-size:.9375rem;font-weight:600}
.hsub{font-size:.8125rem;color:rgba(255,255,255,.5);margin-left:auto}
.wrap{max-width:1100px;margin:0 auto;padding:1.5rem}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:1rem;margin-bottom:1.5rem}
.kpi{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:1.125rem}
.kpi-lbl{font-size:.6875rem;font-weight:600;color:var(--sub);text-transform:uppercase;letter-spacing:.06em;margin-bottom:.375rem}
.kpi-val{font-size:1.625rem;font-weight:700;color:var(--text);line-height:1}
.kpi-hint{font-size:.6875rem;color:var(--muted);margin-top:.25rem}
.sec{background:var(--card);border:1px solid var(--border);border-radius:10px;margin-bottom:1.25rem}
.sec-hd{padding:.875rem 1.125rem;border-bottom:1px solid var(--border);font-weight:600;font-size:.875rem;display:flex;align-items:center;justify-content:space-between}
.sec-hd .cnt{font-size:.75rem;font-weight:400;color:var(--sub)}
.sec-bd{padding:1.125rem}
.tw{overflow-x:auto}
table{width:100%;border-collapse:collapse}
th{text-align:left;font-size:.6875rem;font-weight:600;color:var(--sub);text-transform:uppercase;letter-spacing:.06em;padding:.5rem 1rem;border-bottom:1px solid var(--border)}
td{padding:.5625rem 1rem;border-bottom:1px solid #f3f4f6;vertical-align:top}
tr:last-child td{border-bottom:none}
.ts{color:var(--muted);white-space:nowrap;font-size:.8125rem}
.badge{background:var(--al);border-radius:4px;padding:.1rem .4rem;font-size:.75rem;font-weight:500;white-space:nowrap}
.qt{color:var(--sub);max-width:280px;font-size:.8125rem}
.yes{color:#059669;font-weight:500;font-size:.8125rem}
.no{color:var(--muted);font-size:.8125rem}
.empty{text-align:center;padding:2rem;color:var(--muted);font-size:.8125rem}
@media(max-width:640px){.kpis{grid-template-columns:1fr 1fr}.hsub{display:none}}
</style>
</head>
<body>
<header class="header">
  <div class="hlogo">A</div>
  <div class="hname">AdvocateMCP</div>
  <div class="hsub">Platform Status &amp; Activity</div>
</header>
<div class="wrap">

  <!-- KPIs -->
  <div class="kpis">
    <div class="kpi">
      <div class="kpi-lbl">Active Businesses</div>
      <div class="kpi-val">${registry.count}</div>
      <div class="kpi-hint">Registered SMBs</div>
    </div>
    <div class="kpi">
      <div class="kpi-lbl">Total AI Requests</div>
      <div class="kpi-val">${total.toLocaleString()}</div>
      <div class="kpi-hint">All time</div>
    </div>
    <div class="kpi">
      <div class="kpi-lbl">Referral Clicks</div>
      <div class="kpi-val">${clicks.toLocaleString()}</div>
      <div class="kpi-hint">Tracked site visits</div>
    </div>
    <div class="kpi">
      <div class="kpi-lbl">Top Crawler</div>
      <div class="kpi-val" style="font-size:1rem;margin-top:.25rem">${esc(topBot)}</div>
      <div class="kpi-hint">Most active bot</div>
    </div>
  </div>

  <!-- Crawler breakdown -->
  <div class="sec">
    <div class="sec-hd">Crawler Breakdown</div>
    <div class="sec-bd">${crawlerBadges}</div>
  </div>

  <!-- Active SMBs -->
  <div class="sec">
    <div class="sec-hd">Active Businesses <span class="cnt">${registry.count} registered</span></div>
    <div class="tw">
      ${registry.businesses.length ? `
      <table>
        <thead><tr>
          <th>Business</th><th>Location</th><th>Tier</th><th>Availability</th><th>Slug</th>
        </tr></thead>
        <tbody>${smbRows}</tbody>
      </table>` : `<div class="empty">No businesses registered yet.</div>`}
    </div>
  </div>

  <!-- Recent hits -->
  <div class="sec">
    <div class="sec-hd">Recent Crawler Hits <span class="cnt">last 50</span></div>
    <div class="tw">
      ${hitRows ? `
      <table>
        <thead><tr>
          <th>Time</th><th>Business</th><th>Crawler</th><th>Intent</th><th>Query</th><th>Referral</th>
        </tr></thead>
        <tbody>${hitRows}</tbody>
      </table>` : `<div class="empty">No crawler activity yet.</div>`}
    </div>
  </div>

</div>
</body>
</html>`;
}

// ── Analytics proxy ────────────────────────────────────────────────────────

async function fetchAnalytics(biz: Business, env: Env): Promise<AnalyticsData | null> {
  const base = env.API_BASE_URL ?? "https://advocate-production-2887.up.railway.app";
  try {
    const res = await fetch(`${base}/analytics/${biz.slug}`, {
      headers: { Authorization: `Bearer ${biz.api_key}` },
    });
    if (!res.ok) return null;
    return res.json() as Promise<AnalyticsData>;
  } catch {
    return null;
  }
}

// ── Response helpers ───────────────────────────────────────────────────────

function redirect(loc: string): Response {
  return new Response(null, { status: 302, headers: { Location: loc } });
}

function html(body: string): Response {
  return new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function jsonOk(data: unknown): Response {
  return new Response(JSON.stringify(data, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
}

function jsonErr(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ── HTML escaping ──────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── Template helpers ───────────────────────────────────────────────────────

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
  } catch { return iso; }
}

// ── Login page HTML ────────────────────────────────────────────────────────

function loginHtml(errorMsg: string | null): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in — AdvocateMCP</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
@import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
h1,h2,h3,h4,h5,h6{font-family:'Poppins',sans-serif}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;background:#f4f5f7;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem}
.card{background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.08),0 4px 24px rgba(0,0,0,.07);padding:2.5rem 2rem;width:100%;max-width:400px}
.logo{display:flex;align-items:center;gap:.5rem;margin-bottom:2rem}
.logo-icon{width:30px;height:30px;background:#111;border-radius:6px;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:.875rem}
.logo-name{font-size:.9375rem;font-weight:600;color:#111}
.logo-name span{color:#9ca3af;font-weight:400}
h1{font-size:1.1875rem;font-weight:600;color:#111;margin-bottom:.25rem}
.sub{font-size:.8125rem;color:#6b7280;margin-bottom:1.75rem}
.err{background:#fef2f2;border:1px solid #fecaca;border-radius:6px;color:#dc2626;font-size:.8125rem;padding:.625rem .875rem;margin-bottom:1rem}
label{display:block;font-size:.8125rem;font-weight:500;color:#374151;margin-bottom:.375rem}
input{width:100%;border:1px solid #d1d5db;border-radius:6px;padding:.625rem .75rem;font-size:.875rem;color:#111;outline:none;margin-bottom:1rem;transition:border-color .15s}
input:focus{border-color:#111;box-shadow:0 0 0 3px rgba(17,17,17,.06)}
button{width:100%;background:#111;color:#fff;border:none;border-radius:6px;padding:.6875rem 1rem;font-size:.875rem;font-weight:500;cursor:pointer;transition:background .15s}
button:hover{background:#333}
.note{font-size:.75rem;color:#9ca3af;text-align:center;margin-top:1.5rem}
</style>
</head>
<body>
<div class="card">
  <div class="logo">
    <div class="logo-icon">A</div>
    <div class="logo-name">Advocate<span>MCP</span></div>
  </div>
  <h1>Client Portal</h1>
  <p class="sub">Sign in to view your AI referral analytics.</p>
  ${errorMsg ? `<div class="err">${esc(errorMsg)}</div>` : ""}
  <form method="POST" action="/auth/login">
    <label for="email">Email address</label>
    <input type="email" id="email" name="email" required autocomplete="email" placeholder="you@example.com">
    <label for="password">Password</label>
    <input type="password" id="password" name="password" required autocomplete="current-password" placeholder="••••••••">
    <button type="submit">Sign in</button>
  </form>
  <p class="note">Need access? Contact AdvocateMCP support.</p>
</div>
</body>
</html>`;
}

