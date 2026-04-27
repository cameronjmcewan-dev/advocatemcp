// Client portal: login, logout, dashboard, and protected JSON API.
// All HTML is server-rendered — no client-side framework required.

import type { Env } from "../types";
import {
  generateSalt, hashPassword, verifyPassword,
  getSessionToken, sessionCookieHeader, clearSessionCookieHeader,
} from "../auth";
import {
  getUserByEmail, createUser, updateUserPassword, createSession, getSessionByToken,
  deleteSession, getUserBusinesses, getAllBusinesses, getActiveBusinesses, getBusinessBySlug, createBusiness,
  grantAccess, checkRateLimit, recordLoginAttempt, updateBusinessApiKey,
  getOnboardingState, markOnboardingStep, touchFirstDashboardIfNull,
  type OnboardingSnapshot, type OnboardingState,
} from "../portalDb";
import type { Business, User, SessionWithUser } from "../portalDb";
import { buildDashboard, type AnalyticsData } from "./dashboard";
import { handleActivateDomain, handleDomainStatus, handleDomainRaw, handleSetFallbackOrigin, handleEnsureWorkerRoute, handleBackfillVariants, cfRequest } from "./domains";
import {
  handleOnboard, handleOnboardStatus, handleOnboardList,
  handleVerifyDomain, handleVerifyAll, handleDisableTenant,
  getTenant,
} from "./onboard";
import { handleOnboardPage } from "./onboardPage";
import { handleActivatePage } from "./activatePage";
import { handleActivate, handleActivateHosted, handleActivatePreview, handleActivateStatus, handleActivateDnsProvider, handleActivationToken, handleGetActivation, handleResendActivation } from "./activate";
import { handleCloudflareValidate, handleCloudflareApply, handleGoDaddyValidate, handleGoDaddyApply, handleNamecheapValidate, handleNamecheapApply, handleRoute53Validate, handleRoute53Apply, handleIonosValidate, handleIonosApply } from "./dnsAuto";
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
  handleBillingPortal,
  handleSessionStatus,
  handleRetryRailwayRegistration,
} from "./stripe";
import { handleSaveDraft, handleLoadDraft } from "./onboardDraft";
import { handleContact, handleContactPreflight } from "./contact";
import { handleSupportChat, handleSupportChatPreflight } from "./supportChat";
import { handleRevenueEvent, ensureRevenueWebhookSecret } from "./revenueEvent";
import { signMagicToken, verifyMagicToken } from "../lib/magicToken";
import {
  handleAdminInsightsProxy,
  handleAdminInsightsProxyPreflight,
  handleAdminExperimentFormatJudge,
  handleAdminExperimentFormatJudgePreflight,
  handleAdminProfileScores,
} from "./adminInsightsProxy";

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
  if (pathname === "/api/client/clicks"          && method === "GET")  return apiClicks(request, env);
  if (pathname === "/api/client/recommendations" && method === "GET")  return apiRecommendations(request, env);
  if (pathname === "/api/client/profile"         && method === "GET")  return apiGetProfile(request, env);
  if (pathname === "/api/client/profile"         && method === "POST") return apiUpdateProfile(request, env);
  if (pathname === "/api/client/rotate-key" && method === "POST") return apiRotateKey(request, env);

  // Revenue attribution (Pro feature, Apr 27 2026). Three tenant-side
  // endpoints — read summary, set/clear AOV, generate-or-rotate the
  // webhook signing secret. Plus the public webhook receiver scoped by
  // slug below. All tenant-side endpoints require the portal session
  // cookie (handled by the Bearer/session auth helpers inside).
  if (pathname === "/api/client/revenue-summary"     && method === "GET")  return apiRevenueSummary(request, env);
  if (pathname === "/api/client/revenue-aov"          && method === "POST") return apiRevenueSetAov(request, env);
  if (pathname === "/api/client/revenue-webhook"      && method === "POST") return apiRevenueWebhookSecret(request, env);

  // Multi-location CRUD (Pro/Enterprise feature, Apr 27 2026). Worker
  // is a thin proxy to Railway's /agents/:slug/locations endpoints.
  // We don't reimplement the plan-tier cap here — Railway is the source
  // of truth for plan + count.
  if (pathname === "/api/client/locations"            && method === "GET")    return apiLocationsList(request, env);
  if (pathname === "/api/client/locations"            && method === "POST")   return apiLocationsAdd(request, env);
  const locUpdMatch = pathname.match(/^\/api\/client\/locations\/([a-zA-Z0-9_]+)$/);
  if (locUpdMatch && method === "PATCH")   return apiLocationsUpdate(request, env, locUpdMatch[1]);
  if (locUpdMatch && method === "DELETE")  return apiLocationsDelete(request, env, locUpdMatch[1]);
  const locPromoteMatch = pathname.match(/^\/api\/client\/locations\/([a-zA-Z0-9_]+)\/promote$/);
  if (locPromoteMatch && method === "POST") return apiLocationsPromote(request, env, locPromoteMatch[1]);
  if (pathname === "/api/client/radar"         && method === "GET")    return apiRadar(request, env);
  const radarBasketDel = pathname.match(/^\/api\/client\/radar\/basket\/([^/]+)$/);
  if (pathname === "/api/client/radar/basket"  && method === "POST")   return apiRadarBasketAdd(request, env);
  if (radarBasketDel && method === "DELETE")                            return apiRadarBasketDelete(request, env, radarBasketDel[1]);
  if (pathname === "/api/client/domain-info"   && method === "GET")    return apiDomainInfo(request, env);
  if (pathname === "/api/client/domain-test"   && method === "GET")    return apiDomainTest(request, env);
  if (pathname === "/api/client/onboarding"      && method === "GET")  return apiGetOnboarding(request, env);
  if (pathname === "/api/client/onboarding/step" && method === "POST") return apiMarkOnboardingStep(request, env);
  if (pathname === "/api/client/preview-voice"   && method === "POST") return apiPreviewVoice(request, env);
  if (pathname === "/api/client/profile-score"   && method === "GET")  return apiProfileScore(request, env);
  if (pathname === "/api/client/profile-score"   && method === "POST") return apiProfileScore(request, env);
  if (pathname === "/api/client/verify-rating"   && method === "POST") return apiVerifyRating(request, env);
  if (pathname === "/admin/create-client"      && method === "POST") return adminCreateClient(request, env);
  // Magic-login: admin issues a 5-min token, opens it in incognito, gets a
  // tenant-role session. Used to verify data isolation visually (no admin
  // UI, only-this-tenant data) without sharing tenant credentials.
  if (pathname === "/admin/magic-login"        && method === "POST") return adminMagicLogin(request, env);
  if (pathname === "/admin/beta-tenants"       && method === "GET")  return adminBetaTenants(request, env);
  if (pathname === "/auth/magic"               && method === "GET")  return handleMagicLogin(request, env);
  const resyncMatch = pathname.match(/^\/admin\/businesses\/([^/]+)\/resync-api-key$/);
  if (resyncMatch && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (resyncMatch && method === "POST") return adminResyncApiKey(request, env, resyncMatch[1]);
  if (pathname === "/admin/domains/activate"              && method === "POST") return handleActivateDomain(request, env);
  if (pathname === "/admin/domains/saas-fallback-origin"  && method === "POST") return handleSetFallbackOrigin(request, env);
  if (pathname === "/admin/domains/ensure-worker-route"   && method === "POST") return handleEnsureWorkerRoute(request, env);
  if (pathname === "/admin/domains/backfill-variants"     && method === "POST") return handleBackfillVariants(request, env);
  if (pathname === "/admin/onboard/retry-railway"         && method === "POST") return handleRetryRailwayRegistration(request, env);
  if (pathname === "/status"                   && method === "GET")  return statusPage(request, env);
  if (pathname === "/onboard"                  && method === "GET")  return handleOnboardPage(request, env);

  // ── Phase 3 self-serve activation (post-payment, token-gated) ──────────
  // Separate flow from the existing /onboard wizard. See feat(worker):
  // phase 3 spine commit for the full design rationale.
  if (pathname === "/activate"                 && method === "GET")  return handleActivatePage(request, env);
  if (pathname === "/api/activate/preview"     && method === "OPTIONS") return handleCorsPreflight(request);
  if (pathname === "/api/activate/preview"     && method === "GET")     return handleActivatePreview(request, env);
  if (pathname === "/api/activate/status"      && method === "OPTIONS") return handleCorsPreflight(request);
  if (pathname === "/api/activate/status"      && method === "GET")     return handleActivateStatus(request, env);
  if (pathname === "/api/activate/dns-provider" && method === "OPTIONS") return handleCorsPreflight(request);
  if (pathname === "/api/activate/dns-provider" && method === "GET")     return handleActivateDnsProvider(request, env);
  if (pathname === "/api/dns-auto/cloudflare/validate" && method === "OPTIONS") return handleCorsPreflight(request);
  if (pathname === "/api/dns-auto/cloudflare/validate" && method === "POST")    return handleCloudflareValidate(request, env);
  if (pathname === "/api/dns-auto/cloudflare/apply"    && method === "OPTIONS") return handleCorsPreflight(request);
  if (pathname === "/api/dns-auto/cloudflare/apply"    && method === "POST")    return handleCloudflareApply(request, env);
  if (pathname === "/api/dns-auto/godaddy/validate"    && method === "OPTIONS") return handleCorsPreflight(request);
  if (pathname === "/api/dns-auto/godaddy/validate"    && method === "POST")    return handleGoDaddyValidate(request, env);
  if (pathname === "/api/dns-auto/godaddy/apply"       && method === "OPTIONS") return handleCorsPreflight(request);
  if (pathname === "/api/dns-auto/godaddy/apply"       && method === "POST")    return handleGoDaddyApply(request, env);
  if (pathname === "/api/dns-auto/namecheap/validate"  && method === "OPTIONS") return handleCorsPreflight(request);
  if (pathname === "/api/dns-auto/namecheap/validate"  && method === "POST")    return handleNamecheapValidate(request, env);
  if (pathname === "/api/dns-auto/namecheap/apply"     && method === "OPTIONS") return handleCorsPreflight(request);
  if (pathname === "/api/dns-auto/namecheap/apply"     && method === "POST")    return handleNamecheapApply(request, env);
  if (pathname === "/api/dns-auto/route53/validate"    && method === "OPTIONS") return handleCorsPreflight(request);
  if (pathname === "/api/dns-auto/route53/validate"    && method === "POST")    return handleRoute53Validate(request, env);
  if (pathname === "/api/dns-auto/route53/apply"       && method === "OPTIONS") return handleCorsPreflight(request);
  if (pathname === "/api/dns-auto/route53/apply"       && method === "POST")    return handleRoute53Apply(request, env);
  if (pathname === "/api/dns-auto/ionos/validate"      && method === "OPTIONS") return handleCorsPreflight(request);
  if (pathname === "/api/dns-auto/ionos/validate"      && method === "POST")    return handleIonosValidate(request, env);
  if (pathname === "/api/dns-auto/ionos/apply"         && method === "OPTIONS") return handleCorsPreflight(request);
  if (pathname === "/api/dns-auto/ionos/apply"         && method === "POST")    return handleIonosApply(request, env);
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
  if (pathname === "/api/client/metrics"      && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/all-metrics" && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/all-metrics" && method === "GET")     return apiAllMetrics(request, env);
  if (pathname === "/api/client/activity-detail" && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/activity-detail" && method === "GET")     return apiActivityDetail(request, env);
  if (pathname === "/api/client/activity"    && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/clicks"          && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/recommendations" && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/profile"         && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/rotate-key"  && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/radar"         && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/radar/basket"  && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (radarBasketDel && method === "OPTIONS")                            return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/domain-info"   && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/domain-test"   && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/onboarding"      && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/onboarding/step" && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/preview-voice"   && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/profile-score"   && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/verify-rating"   && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });

  // ── Stripe / new onboarding API ──────────────────────────────────────────
  if (pathname === "/api/onboard/basic"     && method === "POST") return handleBasicOnboard(request, env);
  if (pathname === "/api/stripe/webhook"    && method === "POST") return handleStripeWebhook(request, env);

  // Stripe Customer Portal — self-serve plan switching + cancellation.
  // Replaces the prior mailto:hello@... fallback on the Billing page.
  if (pathname === "/api/client/billing-portal" && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/billing-portal" && method === "POST")    return handleBillingPortal(request, env);

  // Public wizard endpoint (advocatemcp.com → customers.advocatemcp.com)
  if (pathname === "/api/onboard/public"    && method === "OPTIONS") return handlePublicOnboardPreflight(request);
  if (pathname === "/api/onboard/public"    && method === "POST")    return handlePublicOnboard(request, env);

  // Public marketing contact form → Resend → max@advocate-mcp.com
  if (pathname === "/api/contact"           && method === "OPTIONS") return handleContactPreflight(request);
  if (pathname === "/api/contact"           && method === "POST")    return handleContact(request, env);

  // Public Claude-powered support chat for the floating widget on Contact.html.
  // Stateless on our side; the frontend POSTs the full message history each turn.
  if (pathname === "/api/support-chat"      && method === "OPTIONS") return handleSupportChatPreflight(request);
  if (pathname === "/api/support-chat"      && method === "POST")    return handleSupportChat(request, env);

  // Public verified-revenue webhook receiver. Customer's booking system
  // POSTs HMAC-signed events to /api/revenue-event/<slug>. Auth is
  // signature-based (no portal session), so this lives in the public
  // route block. Bad signature → 401 (no detail).
  const revenueEventMatch = pathname.match(/^\/api\/revenue-event\/([a-z0-9][a-z0-9-]*[a-z0-9])$/);
  if (revenueEventMatch && method === "POST") {
    return handleRevenueEvent(request, env, revenueEventMatch[1]);
  }

  // Phase B.1 (Apr 25 2026) — live MCP demo widget on the marketing
  // homepage. Public, no auth, IP-rate-limited at Railway. Worker just
  // proxies the request to Railway, forwards X-Forwarded-For so Railway
  // sees the visitor IP for rate-limit keying. CORS allows the
  // advocatemcp.com origin since the widget runs there.
  if (pathname === "/demo/agent/run"          && method === "OPTIONS") return handleDemoPreflight(request);
  if (pathname === "/demo/agent/run"          && method === "POST")    return handleDemoProxy(request, env, "/demo/agent/run");
  if (pathname === "/demo/agent/availability" && method === "OPTIONS") return handleDemoPreflight(request);
  if (pathname === "/demo/agent/availability" && method === "POST")    return handleDemoProxy(request, env, "/demo/agent/availability");

  // Admin insights proxy — bridges Pages-side admin console to Railway's
  // Bearer-auth'd /admin/insights/* endpoints (ADMIN_API_KEY injected
  // server-side). Admin-role gate inside handler; allowlisted subpaths only.
  const adminInsightsMatch = pathname.match(/^\/api\/admin\/insights-proxy\/([a-z0-9-]+)$/);
  if (adminInsightsMatch && method === "OPTIONS") return handleAdminInsightsProxyPreflight(request);
  if (adminInsightsMatch && method === "GET")     return handleAdminInsightsProxy(request, env, adminInsightsMatch[1]);

  // Format-judge experiments — POST proxy to Railway. Bearer-auth via
  // ADMIN_API_KEY env on Worker, same pattern as insights proxy.
  if (pathname === "/api/admin/experiments/format-judge" && method === "OPTIONS")
    return handleAdminExperimentFormatJudgePreflight(request);
  if (pathname === "/api/admin/experiments/format-judge" && method === "POST")
    return handleAdminExperimentFormatJudge(request, env);
  if (pathname === "/api/admin/profile-scores" && method === "OPTIONS")
    return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/admin/profile-scores" && method === "GET")
    return handleAdminProfileScores(request, env);

  // GET /api/onboard/session/:session_id (CORS; public for skipDns tenants)
  const sessionMatch = pathname.match(/^\/api\/onboard\/session\/([^/]+)$/);
  if (sessionMatch && method === "OPTIONS") return handlePublicOnboardPreflight(request);
  if (sessionMatch && method === "GET") return handleSessionStatus(request, env, sessionMatch[1]);

  // Save & Exit — wizard draft persistence (Task 8)
  if (pathname === "/api/onboard/draft" && method === "OPTIONS") return handlePublicOnboardPreflight(request);
  if (pathname === "/api/onboard/draft" && method === "POST")    return handleSaveDraft(request, env);
  const draftLoadMatch = pathname.match(/^\/api\/onboard\/draft\/([^/]+)$/);
  if (draftLoadMatch && method === "OPTIONS") return handlePublicOnboardPreflight(request);
  if (draftLoadMatch && method === "GET")     return handleLoadDraft(request, env, decodeURIComponent(draftLoadMatch[1]));

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

  // GET /admin/domains/:slug/raw (diagnostic — full CF record + fallback origin)
  const domainRawMatch = pathname.match(/^\/admin\/domains\/([^/]+)\/raw$/);
  if (domainRawMatch && method === "GET") {
    return handleDomainRaw(request, env, domainRawMatch[1]);
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
    ? await getActiveBusinesses(env.DB)
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
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const slug = new URL(request.url).searchParams.get("slug");
  const biz  = (slug ? businesses.find((b) => b.slug === slug) : null) ?? businesses[0] ?? null;
  if (!biz) return withCors(jsonErr(404, "No business found for this account"), request, { credentials: true });

  const analytics = await fetchAnalytics(biz, env);
  // Augment with tenant-type metadata the dashboard uses to gate UI (e.g.
  // hide the Domains section for hosted/wizard-signup tenants who don't
  // configure their own DNS). `is_hosted` is derived from the domain
  // pattern the wizard assigns, so it stays correct even if we later add
  // skipDns-like flags on the D1 row.
  const domain    = biz.domain ?? null;
  const isHosted  = !!domain && domain.endsWith(".hosted.advocatemcp.com");

  // Round 4: piggyback the onboarding snapshot on the metrics response
  // so the dashboard shell has it on boot without a second round-trip.
  // Also idempotently stamps first_dashboard_at for non-admin sessions
  // — this is the "is first login?" signal that triggers the welcome
  // overlay. Admin impersonation never writes, preserving a tenant's
  // real first-login timestamp even if an admin viewed their dashboard
  // first.
  let onboardingSnapshot: OnboardingSnapshot | null = null;
  try {
    if (ctx.role !== "admin") {
      await touchFirstDashboardIfNull(env.DB, biz.slug, new Date().toISOString());
    }
    onboardingSnapshot = await getOnboardingState(env.DB, biz.slug);
  } catch {
    // Non-fatal — onboarding state is additive. If D1 hiccups, the
    // dashboard falls back to "no onboarding data, skip welcome."
    onboardingSnapshot = null;
  }

  // Beta cohort metadata. Set when this tenant signed up with a Stripe
  // promotion code on our beta-coupon allowlist (BETA_COUPON_IDS env var).
  // Dashboard shell reads beta_started_at + beta_ends_at to render the
  // "you're in beta — N days left" banner. Computed days_left server-
  // side so the UI doesn't have to handle date math (and stays correct
  // across timezones).
  let beta: {
    started_at: string;
    ends_at: string;
    days_left: number;
    cohort: string | null;
  } | null = null;
  try {
    const row = await env.DB
      .prepare(
        "SELECT beta_started_at, beta_ends_at, beta_cohort FROM businesses WHERE slug = ? LIMIT 1",
      )
      .bind(biz.slug)
      .first<{ beta_started_at: string | null; beta_ends_at: string | null; beta_cohort: string | null }>();
    if (row?.beta_started_at && row.beta_ends_at) {
      const endsMs = Date.parse(row.beta_ends_at);
      const daysLeft = Math.max(0, Math.ceil((endsMs - Date.now()) / 86_400_000));
      beta = {
        started_at: row.beta_started_at,
        ends_at:    row.beta_ends_at,
        days_left:  daysLeft,
        cohort:     row.beta_cohort,
      };
    }
  } catch {
    // Pre-migration tenants: column doesn't exist yet. Leave beta null.
  }

  const data = {
    ...(analytics ?? { message: "No data available yet", slug: biz.slug }),
    domain,
    is_hosted: isHosted,
    onboarding: onboardingSnapshot,
    beta,
  };
  return withCors(jsonOk(data), request, { credentials: true });
}

// ── GET /api/client/all-metrics (admin only) ──────────────────────────────
// Parallel-fetches analytics for every business. Returns an array of
// {slug, name, domain, analytics} objects plus aggregated totals.

async function apiAllMetrics(request: Request, env: Env): Promise<Response> {
  const ctx = await getSessionFromRequest(request, env);
  if (!ctx) return withCors(jsonErr(401, "Unauthorized"), request, { credentials: true });
  if (ctx.role !== "admin") return withCors(jsonErr(403, "Admin only"), request, { credentials: true });

  const businesses = await getActiveBusinesses(env.DB);
  const results = await Promise.all(
    businesses.map(async (biz) => {
      const analytics = await fetchAnalytics(biz, env);
      return {
        slug: biz.slug,
        name: biz.business_name,
        domain: biz.domain ?? null,
        plan: biz.plan ?? "free",
        analytics,
      };
    }),
  );

  // Aggregate totals across all businesses
  let totalQueries = 0;
  let totalClicks = 0;
  let totalClicks30d = 0;
  const crawlerTotals: Record<string, number> = {};

  for (const r of results) {
    if (!r.analytics) continue;
    totalQueries += r.analytics.total_queries ?? 0;
    totalClicks += r.analytics.referral_clicks ?? 0;
    totalClicks30d += r.analytics.referral_clicks_last_30_days ?? 0;
    for (const [crawler, count] of Object.entries(r.analytics.queries_by_crawler ?? {})) {
      crawlerTotals[crawler] = (crawlerTotals[crawler] ?? 0) + count;
    }
  }

  return withCors(
    jsonOk({
      businesses: results,
      totals: {
        business_count: businesses.length,
        total_queries: totalQueries,
        total_clicks: totalClicks,
        total_clicks_30d: totalClicks30d,
        queries_by_crawler: crawlerTotals,
      },
    }),
    request,
    { credentials: true },
  );
}

// ── GET /api/client/activity-detail ────────────────────────────────────────
// Proxy to Railway's /analytics/:slug/activity — surfaces the new-feature
// data (reservations, handoffs, agent_requests, competitor radar) for the
// selected business. Admin users can query any slug via ?slug=<slug>.
//
// Aggregate mode: ?scope=all (admin only) parallel-fetches every active
// business and merges reservations / handoffs / agent_requests into a unified
// recent-events feed sorted by timestamp desc. Non-admin callers receive 403.

type ActivityPayload = {
  slug: string;
  reservations?: Array<{
    id: string;
    agent_id: string | null;
    status: string;
    window_start: string;
    window_end: string;
    requested_at: string;
    expires_at: string;
  }>;
  handoffs?: Array<{
    id: string;
    mode: string;
    delivered_via: string | null;
    reservation_id: string | null;
    agent_id: string | null;
    created_at: string;
  }>;
  agent_requests?: Array<{
    id: number;
    tool_called: string;
    agent_id: string;
    agent_id_source: string;
    outcome_signal: string;
    latency_ms: number | null;
    cost_cents: number | null;
    timestamp: string;
  }>;
  totals?: {
    reservations?: { held?: number; confirmed?: number; expired?: number; total?: number };
    handoffs?: { human?: number; agent?: number; total?: number };
    agent_requests?: { unique_agents?: number; total_calls?: number };
  };
  [key: string]: unknown;
};

type AggregateFeedItem =
  | { type: "reservation"; business_slug: string; business_name: string; id: string; status: string; agent_id: string | null; timestamp: string }
  | { type: "handoff"; business_slug: string; business_name: string; id: string; mode: string; delivered_via: string | null; timestamp: string }
  | { type: "agent_call"; business_slug: string; business_name: string; tool_called: string; agent_id: string; outcome_signal: string; latency_ms: number | null; timestamp: string };

async function apiActivityDetail(request: Request, env: Env): Promise<Response> {
  const ctx = await getSessionFromRequest(request, env);
  if (!ctx) return withCors(jsonErr(401, "Unauthorized"), request, { credentials: true });

  const url = new URL(request.url);
  const scope = url.searchParams.get("scope");
  const slug  = url.searchParams.get("slug");

  // ── Aggregate mode (admin only) ──────────────────────────────────────────
  if (scope === "all") {
    if (ctx.role !== "admin") {
      return withCors(jsonErr(403, "Admin only"), request, { credentials: true });
    }
    const businesses = await getActiveBusinesses(env.DB);
    const base = env.API_BASE_URL ?? "https://advocate-production-2887.up.railway.app";

    const perBusiness = await Promise.all(
      businesses.map(async (biz) => {
        try {
          const res = await fetch(`${base}/analytics/${biz.slug}/activity`, {
            headers: { Authorization: `Bearer ${biz.api_key}` },
            // Cap each per-business fetch so one stalled tenant can't hold the
            // whole admin aggregate hostage (Worker subrequests have a 30s
            // ceiling; 5s × N in parallel keeps us well under it).
            signal: AbortSignal.timeout(5000),
          });
          if (!res.ok) return { biz, data: null as ActivityPayload | null };
          const data = await res.json() as ActivityPayload;
          return { biz, data };
        } catch {
          return { biz, data: null as ActivityPayload | null };
        }
      }),
    );

    // Per-business summary (totals + most recent items)
    const perBizSummary = perBusiness.map(({ biz, data }) => ({
      slug: biz.slug,
      name: biz.business_name,
      totals: data?.totals ?? null,
      recent_items: [
        ...(data?.reservations ?? []).slice(0, 5).map((r) => ({ type: "reservation", ...r })),
        ...(data?.handoffs ?? []).slice(0, 5).map((h) => ({ type: "handoff", ...h })),
        ...(data?.agent_requests ?? []).slice(0, 5).map((a) => ({ type: "agent_call", ...a })),
      ],
    }));

    // Aggregate totals across all businesses
    const aggregate_totals = {
      reservations: { held: 0, confirmed: 0, expired: 0, total: 0 },
      handoffs: { human: 0, agent: 0, total: 0 },
      agent_requests: { unique_agents: 0, total_calls: 0 },
    };
    const uniqueAgents = new Set<string>();
    for (const { data } of perBusiness) {
      if (!data) continue;
      const r = data.totals?.reservations;
      if (r) {
        aggregate_totals.reservations.held      += r.held ?? 0;
        aggregate_totals.reservations.confirmed += r.confirmed ?? 0;
        aggregate_totals.reservations.expired   += r.expired ?? 0;
        aggregate_totals.reservations.total     += r.total ?? 0;
      }
      const h = data.totals?.handoffs;
      if (h) {
        aggregate_totals.handoffs.human += h.human ?? 0;
        aggregate_totals.handoffs.agent += h.agent ?? 0;
        aggregate_totals.handoffs.total += h.total ?? 0;
      }
      const a = data.totals?.agent_requests;
      if (a) {
        aggregate_totals.agent_requests.total_calls += a.total_calls ?? 0;
      }
      for (const ar of data.agent_requests ?? []) {
        if (ar.agent_id) uniqueAgents.add(ar.agent_id);
      }
    }
    aggregate_totals.agent_requests.unique_agents = uniqueAgents.size;

    // Build unified feed: merge reservations + handoffs + agent_requests,
    // stamp each with business_slug + business_name, sort by timestamp desc,
    // limit to 50.
    const feed: AggregateFeedItem[] = [];
    for (const { biz, data } of perBusiness) {
      if (!data) continue;
      for (const r of data.reservations ?? []) {
        feed.push({
          type: "reservation",
          business_slug: biz.slug,
          business_name: biz.business_name,
          id: r.id,
          status: r.status,
          agent_id: r.agent_id,
          timestamp: r.requested_at,
        });
      }
      for (const h of data.handoffs ?? []) {
        feed.push({
          type: "handoff",
          business_slug: biz.slug,
          business_name: biz.business_name,
          id: h.id,
          mode: h.mode,
          delivered_via: h.delivered_via,
          timestamp: h.created_at,
        });
      }
      for (const a of data.agent_requests ?? []) {
        feed.push({
          type: "agent_call",
          business_slug: biz.slug,
          business_name: biz.business_name,
          tool_called: a.tool_called,
          agent_id: a.agent_id,
          outcome_signal: a.outcome_signal,
          latency_ms: a.latency_ms,
          timestamp: a.timestamp,
        });
      }
    }
    feed.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
    const trimmedFeed = feed.slice(0, 50);

    return withCors(
      jsonOk({
        scope: "all",
        businesses: perBizSummary,
        aggregate_totals,
        feed: trimmedFeed,
      }),
      request,
      { credentials: true },
    );
  }

  // ── Single-business mode (default) ───────────────────────────────────────
  const businesses = ctx.role === "admin"
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const biz = (slug ? businesses.find((b) => b.slug === slug) : null) ?? businesses[0] ?? null;
  if (!biz) return withCors(jsonErr(404, "No business found for this account"), request, { credentials: true });

  const base = env.API_BASE_URL ?? "https://advocate-production-2887.up.railway.app";
  try {
    const res = await fetch(`${base}/analytics/${biz.slug}/activity`, {
      headers: { Authorization: `Bearer ${biz.api_key}` },
    });
    if (!res.ok) {
      return withCors(jsonErr(res.status, "Activity fetch failed"), request, { credentials: true });
    }
    const data = await res.json();
    return withCors(jsonOk(data), request, { credentials: true });
  } catch (err) {
    return withCors(jsonErr(502, `Backend unreachable: ${String(err)}`), request, { credentials: true });
  }
}

// ── GET /api/client/activity ───────────────────────────────────────────────

async function apiActivity(request: Request, env: Env): Promise<Response> {
  const ctx = await getSessionFromRequest(request, env);
  if (!ctx) return withCors(jsonErr(401, "Unauthorized"), request, { credentials: true });

  const businesses = ctx.role === "admin"
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const slug = new URL(request.url).searchParams.get("slug");
  const biz  = (slug ? businesses.find((b) => b.slug === slug) : null) ?? businesses[0] ?? null;
  if (!biz) return withCors(jsonErr(404, "No business found for this account"), request, { credentials: true });

  const data = await fetchAnalytics(biz, env);
  return withCors(jsonOk(data?.recent_queries ?? []), request, { credentials: true });
}

// ── GET /api/client/clicks ─────────────────────────────────────────────────
// Proxy to Railway's GET /analytics/:slug/clicks — returns the 50 most
// recent referral click events for the selected tenant.

interface ClickRow {
  id: number;
  ref: string | null;
  user_agent: string | null;
  timestamp: string;
}

async function apiClicks(request: Request, env: Env): Promise<Response> {
  const ctx = await getSessionFromRequest(request, env);
  if (!ctx) return withCors(jsonErr(401, "Unauthorized"), request, { credentials: true });

  const businesses = ctx.role === "admin"
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const slug = new URL(request.url).searchParams.get("slug");
  const biz  = (slug ? businesses.find((b) => b.slug === slug) : null) ?? businesses[0] ?? null;
  if (!biz) return withCors(jsonErr(404, "No business found for this account"), request, { credentials: true });

  const base = env.API_BASE_URL ?? "https://advocate-production-2887.up.railway.app";
  try {
    const res = await fetch(`${base}/analytics/${biz.slug}/clicks`, {
      headers: { Authorization: `Bearer ${biz.api_key}` },
    });
    if (!res.ok) {
      return withCors(jsonErr(res.status, "Clicks fetch failed"), request, { credentials: true });
    }
    const data = await res.json() as { slug: string; clicks: ClickRow[] };
    return withCors(jsonOk(data), request, { credentials: true });
  } catch (err) {
    return withCors(jsonErr(502, `Backend unreachable: ${String(err)}`), request, { credentials: true });
  }
}

// ── GET /api/client/recommendations ────────────────────────────────────────
// Derives dynamic recs + checklist from the tenant's analytics data. Pure
// server-side rules — no external fetch beyond the existing analytics proxy.

interface RecOut {
  id: string;
  title: string;
  body: string;
  priority: "high" | "med" | "low";
  impact: string;
  action_label?: string;
  action_url?: string;
}
interface ChecklistItem {
  id: string;
  label: string;
  done: boolean;
}

interface ProfileOut {
  name?: string;
  description?: string;
  category?: string;
  services?: string[];
  website?: string;
  pricing_json_v2?: unknown;
}

async function fetchProfile(biz: Business, env: Env): Promise<ProfileOut | null> {
  const base = env.API_BASE_URL ?? "https://advocate-production-2887.up.railway.app";
  try {
    const res = await fetch(`${base}/agents/${biz.slug}/profile`, {
      headers: { Authorization: `Bearer ${biz.api_key}` },
    });
    if (!res.ok) return null;
    return await res.json() as ProfileOut;
  } catch {
    return null;
  }
}

function buildRecommendations(
  analytics: AnalyticsData | null,
  profile: ProfileOut | null,
): { recommendations: RecOut[]; checklist: ChecklistItem[] } {
  const total   = analytics?.total_queries ?? 0;
  const clicks  = analytics?.referral_clicks ?? 0;
  const intents = analytics?.queries_by_intent ?? {};
  const ctr     = total > 0 ? clicks / total : 0;

  const recs: RecOut[] = [];

  if (total < 10) {
    recs.push({
      id: "no-traffic",
      title: "Verify your site is receiving AI crawler traffic",
      body: "Your profile has fewer than 10 recorded queries. Confirm that your domain is routed through Advocate and that /.well-known/ai-agent.json is reachable.",
      priority: "high",
      impact: "High — no traffic means no citations, no referrals, no attribution.",
      action_label: "Open activation guide",
      action_url: "/activate.html",
    });
  } else if (ctr < 0.05) {
    recs.push({
      id: "low-ctr",
      title: "Improve referral click-through rate",
      body: `Only ${(ctr * 100).toFixed(1)}% of AI queries lead to a click. Tighten your response copy — include a clear CTA, service-area details, and a booking or contact link above the fold.`,
      priority: "high",
      impact: "High — CTR is the main lever once traffic arrives.",
    });
  }

  if (!intents["brand_direct"] || intents["brand_direct"] === 0) {
    recs.push({
      id: "no-brand-queries",
      title: "Invest in brand awareness",
      body: "No direct-brand queries yet — customers aren't searching for you by name. Consider Reddit/Wikidata seeding, review outreach, and local PR to build the brand signal AI systems reward.",
      priority: "med",
      impact: "Med — direct-brand queries convert 3–5× better than generic.",
    });
  }

  const profileIncomplete =
    !profile ||
    !profile.name ||
    !profile.description ||
    !profile.category ||
    !Array.isArray(profile.services) || profile.services.length === 0 ||
    !profile.pricing_json_v2;
  if (profileIncomplete) {
    recs.push({
      id: "incomplete-profile",
      title: "Complete your business profile",
      body: "Missing profile fields reduce how richly AI citations describe your business. Fill in services, structured pricing, and a category to unlock better-matched queries.",
      priority: "med",
      impact: "Med — richer profile = more specific AI citations.",
      action_label: "Edit profile",
      action_url: "#settings",
    });
  }

  if (recs.length === 0) {
    recs.push({
      id: "all-good",
      title: "You're in great shape",
      body: "Traffic is healthy, CTR is solid, and your profile is complete. Explore Pro features — Competitor Radar and the off-site authority kit will compound your lead.",
      priority: "low",
      impact: "Low — keep momentum, no action required.",
    });
  }

  const servicesOk = Array.isArray(profile?.services) && (profile?.services?.length ?? 0) > 0;
  const profileComplete = Boolean(
    profile?.name && profile?.description && profile?.category && servicesOk,
  );

  const checklist: ChecklistItem[] = [
    { id: "profile-complete",   label: "Business profile complete (name, description, category, services)", done: profileComplete },
    { id: "domain-active",      label: "Domain routed through Advocate",                                    done: total > 0 },
    { id: "first-query",        label: "First AI query received",                                           done: total >= 1 },
    { id: "first-click",        label: "First referral click tracked",                                      done: clicks >= 1 },
    { id: "api-key-fresh",      label: "API key rotated within the last 90 days",                           done: false },
  ];

  return { recommendations: recs, checklist };
}

async function apiRecommendations(request: Request, env: Env): Promise<Response> {
  const ctx = await getSessionFromRequest(request, env);
  if (!ctx) return withCors(jsonErr(401, "Unauthorized"), request, { credentials: true });

  const businesses = ctx.role === "admin"
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const slug = new URL(request.url).searchParams.get("slug");
  const biz  = (slug ? businesses.find((b) => b.slug === slug) : null) ?? businesses[0] ?? null;
  if (!biz) return withCors(jsonErr(404, "No business found for this account"), request, { credentials: true });

  const [analytics, profile] = await Promise.all([
    fetchAnalytics(biz, env),
    fetchProfile(biz, env),
  ]);

  const out = buildRecommendations(analytics, profile);
  return withCors(jsonOk(out), request, { credentials: true });
}

// ── GET /api/client/profile ────────────────────────────────────────────────
// Proxy to Railway's GET /agents/:slug/profile so the Settings edit form can
// pre-fill with the tenant's current values instead of empty defaults.
// Session auth + slug scope-check via getUserBusinesses.

async function apiGetProfile(request: Request, env: Env): Promise<Response> {
  const ctx = await getSessionFromRequest(request, env);
  if (!ctx) return withCors(jsonErr(401, "Unauthorized"), request, { credentials: true });

  const businesses = ctx.role === "admin"
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const slug = new URL(request.url).searchParams.get("slug");
  const biz  = (slug ? businesses.find((b) => b.slug === slug) : null) ?? businesses[0] ?? null;
  if (!biz) return withCors(jsonErr(404, "No business found for this account"), request, { credentials: true });

  const profile = await fetchProfile(biz, env);
  if (!profile) return withCors(jsonErr(502, "Profile unavailable"), request, { credentials: true });
  return withCors(jsonOk(profile), request, { credentials: true });
}

// ── Revenue attribution endpoints (Pro feature, Apr 27 2026) ──────────────
//
// Three tenant-side endpoints that back the dashboard revenue card and
// the Settings "Revenue tracking" panel:
//
//   GET  /api/client/revenue-summary  — current-month + prior-month numbers
//   POST /api/client/revenue-aov      — set or clear the average ticket
//   POST /api/client/revenue-webhook  — generate or rotate the webhook secret
//
// All require the portal session cookie. Admins viewing as a tenant get
// the same surface; impersonation is fine (admin doesn't pollute the
// tenant's first_dashboard_at, but they can still configure on behalf).
//
// Server-side compute lives in server/src/lib/revenue.ts —
// computeRevenueWindow(). The summary endpoint here proxies to Railway's
// /agents/:slug/revenue-summary so the worker doesn't reimplement the
// SQLite joins. Worker D1 is the source of truth for verified webhook
// events; Railway's mirror is best-effort and trails by seconds.

async function apiRevenueSummary(request: Request, env: Env): Promise<Response> {
  const ctx = await getSessionFromRequest(request, env);
  if (!ctx) return withCors(jsonErr(401, "Unauthorized"), request, { credentials: true });

  const businesses = ctx.role === "admin"
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const slugQuery = new URL(request.url).searchParams.get("slug");
  const biz = (slugQuery ? businesses.find((b) => b.slug === slugQuery) : null) ?? businesses[0] ?? null;
  if (!biz) return withCors(jsonErr(404, "No business found for this account"), request, { credentials: true });

  // Compute directly from D1 — verified events are written here by the
  // webhook receiver. We replicate the lightweight version of
  // computeRevenueWindow() inline rather than round-tripping to Railway,
  // because the dashboard renders this on every page load and we don't
  // want to add a Railway hop to that path. The Railway-side helper is
  // kept in lockstep so the monthly-review email cron uses the same
  // numbers the dashboard does.
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const monthEnd   = now.toISOString();

  // Pull tenant config + verified totals + estimated count in three
  // parallel D1 reads. (D1's prepared-statement API doesn't support a
  // single multi-result query, so this is the cheapest shape.)
  const [tenantRow, verifiedAgg, confirmedAgg] = await Promise.all([
    env.DB
      .prepare("SELECT avg_booking_value_cents, revenue_currency, revenue_webhook_secret FROM businesses WHERE slug = ?")
      .bind(biz.slug)
      .first<{ avg_booking_value_cents: number | null; revenue_currency: string | null; revenue_webhook_secret: string | null }>(),
    env.DB
      .prepare(
        `SELECT COALESCE(SUM(amount_cents), 0) AS total_cents,
                COUNT(*)                       AS event_count
           FROM revenue_events
          WHERE business_slug = ? AND occurred_at >= ? AND occurred_at <= ?`,
      )
      .bind(biz.slug, monthStart, monthEnd)
      .first<{ total_cents: number; event_count: number }>(),
    // Confirmed reservations from worker D1 — the worker mirrors the
    // 'confirmed' state via /a2a/confirm. If reservations live only on
    // Railway in this codebase, this returns 0 and we'll fall through
    // to unconfigured rather than estimated. The monthly-review job
    // computes the same number from Railway and is authoritative.
    env.DB
      .prepare(
        `SELECT COUNT(*) AS confirmed_count
           FROM reservations
          WHERE business_slug = ? AND status = 'confirmed'
            AND created_at >= ? AND created_at <= ?`,
      )
      .bind(biz.slug, monthStart, monthEnd)
      .first<{ confirmed_count: number }>()
      .catch(() => ({ confirmed_count: 0 })), // worker D1 may not mirror reservations yet
  ]);

  const aov      = tenantRow?.avg_booking_value_cents ?? null;
  const currency = tenantRow?.revenue_currency ?? "USD";
  const verifiedCount = verifiedAgg?.event_count ?? 0;
  const verifiedSum   = verifiedAgg?.total_cents ?? 0;
  const confirmedCount = confirmedAgg?.confirmed_count ?? 0;

  let summary;
  if (verifiedCount > 0) {
    summary = {
      source: "verified" as const,
      amount_cents: verifiedSum,
      event_count: verifiedCount,
      currency,
      aov_cents: null as number | null,
    };
  } else if (aov !== null && aov > 0) {
    summary = {
      source: "estimated" as const,
      amount_cents: confirmedCount * aov,
      event_count: confirmedCount,
      currency,
      aov_cents: aov,
    };
  } else {
    summary = {
      source: "unconfigured" as const,
      amount_cents: null as number | null,
      event_count: confirmedCount,
      currency,
      aov_cents: null as number | null,
    };
  }

  return withCors(
    jsonOk({
      window_start: monthStart,
      window_end: monthEnd,
      ...summary,
      webhook_configured: !!tenantRow?.revenue_webhook_secret,
    }),
    request,
    { credentials: true },
  );
}

async function apiRevenueSetAov(request: Request, env: Env): Promise<Response> {
  const ctx = await getSessionFromRequest(request, env);
  if (!ctx) return withCors(jsonErr(401, "Unauthorized"), request, { credentials: true });

  const businesses = ctx.role === "admin"
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const slugQuery = new URL(request.url).searchParams.get("slug");
  const biz = (slugQuery ? businesses.find((b) => b.slug === slugQuery) : null) ?? businesses[0] ?? null;
  if (!biz) return withCors(jsonErr(404, "No business found for this account"), request, { credentials: true });

  let body: { avg_booking_value_cents?: unknown; revenue_currency?: unknown };
  try { body = await request.json(); }
  catch { return withCors(jsonErr(400, "Body must be JSON"), request, { credentials: true }); }

  // null / 0 / undefined all clear the AOV (returning the tenant to the
  // unconfigured state). Otherwise must be a positive integer ≤ 10M cents
  // ($100k) — sane upper bound to catch typos like "45000000" instead of "4500".
  let aovCents: number | null = null;
  if (body.avg_booking_value_cents !== null && body.avg_booking_value_cents !== undefined && body.avg_booking_value_cents !== 0) {
    if (typeof body.avg_booking_value_cents !== "number" || !Number.isInteger(body.avg_booking_value_cents)) {
      return withCors(jsonErr(400, "avg_booking_value_cents must be an integer"), request, { credentials: true });
    }
    if (body.avg_booking_value_cents < 0 || body.avg_booking_value_cents > 10_000_000) {
      return withCors(jsonErr(400, "avg_booking_value_cents must be between 0 and 10_000_000"), request, { credentials: true });
    }
    aovCents = body.avg_booking_value_cents;
  }

  let currency = "USD";
  if (typeof body.revenue_currency === "string" && /^[A-Z]{3}$/.test(body.revenue_currency)) {
    currency = body.revenue_currency;
  }

  await env.DB
    .prepare("UPDATE businesses SET avg_booking_value_cents = ?, revenue_currency = ? WHERE slug = ?")
    .bind(aovCents, currency, biz.slug)
    .run();

  return withCors(jsonOk({ ok: true, avg_booking_value_cents: aovCents, revenue_currency: currency }), request, { credentials: true });
}

async function apiRevenueWebhookSecret(request: Request, env: Env): Promise<Response> {
  const ctx = await getSessionFromRequest(request, env);
  if (!ctx) return withCors(jsonErr(401, "Unauthorized"), request, { credentials: true });

  const businesses = ctx.role === "admin"
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const slugQuery = new URL(request.url).searchParams.get("slug");
  const biz = (slugQuery ? businesses.find((b) => b.slug === slugQuery) : null) ?? businesses[0] ?? null;
  if (!biz) return withCors(jsonErr(404, "No business found for this account"), request, { credentials: true });

  let body: { rotate?: unknown };
  try { body = await request.json(); }
  catch { body = {}; }
  const rotate = body.rotate === true;

  const result = await ensureRevenueWebhookSecret(env, biz.slug, rotate);
  return withCors(jsonOk(result), request, { credentials: true });
}

// ── Multi-location proxy helpers (Pro/Enterprise feature, Apr 27 2026) ────
//
// Worker is a thin auth-and-CORS gateway to Railway's
// /agents/:slug/locations* endpoints. Railway holds the source-of-truth
// data + enforces plan-tier caps. We intentionally don't reimplement
// the cap logic here — that would split the cap rule across two
// codebases and create drift opportunities. Worker just passes through
// the 402 from Railway as-is so the dashboard can render the upgrade CTA.

async function locationsBackendUrl(env: Env, slug: string, suffix = ""): Promise<string> {
  const base = (env as { API_BASE_URL?: string }).API_BASE_URL ?? "https://advocate-production-2887.up.railway.app";
  return `${base}/agents/${encodeURIComponent(slug)}/locations${suffix}`;
}

async function resolveTenantSlug(request: Request, env: Env): Promise<{ slug: string; api_key: string } | { error: Response }> {
  const ctx = await getSessionFromRequest(request, env);
  if (!ctx) return { error: withCors(jsonErr(401, "Unauthorized"), request, { credentials: true }) };
  const businesses = ctx.role === "admin"
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const slugQuery = new URL(request.url).searchParams.get("slug");
  const biz = (slugQuery ? businesses.find((b) => b.slug === slugQuery) : null) ?? businesses[0] ?? null;
  if (!biz) return { error: withCors(jsonErr(404, "No business found for this account"), request, { credentials: true }) };
  return { slug: biz.slug, api_key: biz.api_key };
}

async function apiLocationsList(request: Request, env: Env): Promise<Response> {
  const ctxOrErr = await resolveTenantSlug(request, env);
  if ("error" in ctxOrErr) return ctxOrErr.error;
  const url = await locationsBackendUrl(env, ctxOrErr.slug);
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${ctxOrErr.api_key}` } });
  const body = await resp.text();
  return withCors(
    new Response(body, { status: resp.status, headers: { "Content-Type": "application/json" } }),
    request,
    { credentials: true },
  );
}

async function apiLocationsAdd(request: Request, env: Env): Promise<Response> {
  const ctxOrErr = await resolveTenantSlug(request, env);
  if ("error" in ctxOrErr) return ctxOrErr.error;
  const body = await request.text();
  const url = await locationsBackendUrl(env, ctxOrErr.slug);
  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${ctxOrErr.api_key}`, "Content-Type": "application/json" },
    body,
  });
  return withCors(
    new Response(await resp.text(), { status: resp.status, headers: { "Content-Type": "application/json" } }),
    request,
    { credentials: true },
  );
}

async function apiLocationsUpdate(request: Request, env: Env, locationId: string): Promise<Response> {
  const ctxOrErr = await resolveTenantSlug(request, env);
  if ("error" in ctxOrErr) return ctxOrErr.error;
  const body = await request.text();
  const url = await locationsBackendUrl(env, ctxOrErr.slug, `/${encodeURIComponent(locationId)}`);
  const resp = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${ctxOrErr.api_key}`, "Content-Type": "application/json" },
    body,
  });
  return withCors(
    new Response(await resp.text(), { status: resp.status, headers: { "Content-Type": "application/json" } }),
    request,
    { credentials: true },
  );
}

async function apiLocationsDelete(request: Request, env: Env, locationId: string): Promise<Response> {
  const ctxOrErr = await resolveTenantSlug(request, env);
  if ("error" in ctxOrErr) return ctxOrErr.error;
  const url = await locationsBackendUrl(env, ctxOrErr.slug, `/${encodeURIComponent(locationId)}`);
  const resp = await fetch(url, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${ctxOrErr.api_key}` },
  });
  return withCors(
    new Response(await resp.text(), { status: resp.status, headers: { "Content-Type": "application/json" } }),
    request,
    { credentials: true },
  );
}

async function apiLocationsPromote(request: Request, env: Env, locationId: string): Promise<Response> {
  const ctxOrErr = await resolveTenantSlug(request, env);
  if ("error" in ctxOrErr) return ctxOrErr.error;
  const url = await locationsBackendUrl(env, ctxOrErr.slug, `/${encodeURIComponent(locationId)}/promote`);
  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${ctxOrErr.api_key}` },
  });
  return withCors(
    new Response(await resp.text(), { status: resp.status, headers: { "Content-Type": "application/json" } }),
    request,
    { credentials: true },
  );
}

// ── POST /api/client/profile ───────────────────────────────────────────────
// Proxy to Railway's PATCH /agents/:slug/profile. Only forwards fields the
// Railway endpoint declares mutable; anything else is silently dropped.

async function apiUpdateProfile(request: Request, env: Env): Promise<Response> {
  const ctx = await getSessionFromRequest(request, env);
  if (!ctx) return withCors(jsonErr(401, "Unauthorized"), request, { credentials: true });

  const businesses = ctx.role === "admin"
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const slug = new URL(request.url).searchParams.get("slug");
  const biz  = (slug ? businesses.find((b) => b.slug === slug) : null) ?? businesses[0] ?? null;
  if (!biz) return withCors(jsonErr(404, "No business found for this account"), request, { credentials: true });

  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return withCors(jsonErr(400, "Invalid JSON body"), request, { credentials: true });
  }

  // Whitelist — mirrors Railway's PATCH /agents/:slug/profile allow-list.
  // `name` is intentionally NOT included because Railway's PATCH does not
  // accept it; business_name is immutable once created.
  const allowed = [
    "description", "category", "services", "pricing", "location", "phone",
    "website", "referral_url", "tone", "star_rating", "review_count",
    "years_in_business", "top_services", "availability", "differentiator",
    "service_radius_miles", "certifications", "pricing_tier",
    "service_area_keywords",
    "hours_json", "pricing_json_v2", "lead_routing_json", "timezone",
    "availability_webhook_url",
    // Phase A iter8: third-party verification data so the per-bot
    // HTML renderer can emit publisher-attributed Review JSON-LD.
    "ratings_json", "customer_quotes_json", "credentials_json",
    "case_stories_json", "differentiators_text", "guarantee_text",
  ] as const;

  const payload: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in body) payload[key] = body[key];
  }

  if (Object.keys(payload).length === 0) {
    return withCors(jsonErr(400, "No updatable fields provided"), request, { credentials: true });
  }

  const base = env.API_BASE_URL ?? "https://advocate-production-2887.up.railway.app";
  try {
    const res = await fetch(`${base}/agents/${biz.slug}/profile`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${biz.api_key}`,
      },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return withCors(jsonErr(res.status, "Profile update failed"), request, { credentials: true });
    }
    return withCors(jsonOk(data), request, { credentials: true });
  } catch (err) {
    return withCors(jsonErr(502, `Backend unreachable: ${String(err)}`), request, { credentials: true });
  }
}

// ── GET /api/client/radar ─────────────────────────────────────────────────
// Proxy to Railway Competitor Radar — combines summary, basket, and losses
// into a single response so the dashboard only makes one round-trip.
// Non-admin users must be bound to the slug via getUserBusinesses.

async function apiRadar(request: Request, env: Env): Promise<Response> {
  const ctx = await getSessionFromRequest(request, env);
  if (!ctx) return withCors(jsonErr(401, "Unauthorized"), request, { credentials: true });

  const businesses = ctx.role === "admin"
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const slug = new URL(request.url).searchParams.get("slug");
  const biz  = (slug ? businesses.find((b) => b.slug === slug) : null) ?? businesses[0] ?? null;
  if (!biz) return withCors(jsonErr(404, "No business found for this account"), request, { credentials: true });

  const base = env.API_BASE_URL ?? "https://advocate-production-2887.up.railway.app";
  try {
    const [summaryRes, basketRes, lossesRes, authorityRes] = await Promise.all([
      fetch(`${base}/api/competitor-radar/${biz.slug}/summary`, {
        headers: { Authorization: `Bearer ${biz.api_key}` },
      }),
      fetch(`${base}/api/competitor-basket/${biz.slug}`, {
        headers: { Authorization: `Bearer ${biz.api_key}` },
      }),
      fetch(`${base}/api/competitor-radar/${biz.slug}/losses`, {
        headers: { Authorization: `Bearer ${biz.api_key}` },
      }),
      fetch(`${base}/api/competitor-radar/${biz.slug}/authority-report`, {
        headers: { Authorization: `Bearer ${biz.api_key}` },
      }),
    ]);

    const summary   = summaryRes.ok   ? await summaryRes.json()   : null;
    const basket    = basketRes.ok    ? await basketRes.json()    : null;
    const losses    = lossesRes.ok    ? await lossesRes.json()    : null;
    const authority = authorityRes.ok ? await authorityRes.json() : null;

    return withCors(jsonOk({ summary, basket, losses, authority }), request, { credentials: true });
  } catch (err) {
    return withCors(jsonErr(502, `Backend unreachable: ${String(err)}`), request, { credentials: true });
  }
}

// ── POST /api/client/radar/basket ─────────────────────────────────────────
// Add a query phrasing to the tenant's radar basket. Body: { query_phrasing }.

async function apiRadarBasketAdd(request: Request, env: Env): Promise<Response> {
  const ctx = await getSessionFromRequest(request, env);
  if (!ctx) return withCors(jsonErr(401, "Unauthorized"), request, { credentials: true });

  const businesses = ctx.role === "admin"
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const slug = new URL(request.url).searchParams.get("slug");
  const biz  = (slug ? businesses.find((b) => b.slug === slug) : null) ?? businesses[0] ?? null;
  if (!biz) return withCors(jsonErr(404, "No business found for this account"), request, { credentials: true });

  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; }
  catch { return withCors(jsonErr(400, "Invalid JSON body"), request, { credentials: true }); }

  const qp = typeof body.query_phrasing === "string" ? body.query_phrasing.trim() : "";
  if (!qp) return withCors(jsonErr(400, "Missing query_phrasing"), request, { credentials: true });

  const base = env.API_BASE_URL ?? "https://advocate-production-2887.up.railway.app";
  try {
    // Server route is /api/competitor-basket/:slug/queries with body { query }.
    // We accept { query_phrasing } from the browser to keep the public proxy
    // contract stable, and translate to { query } here for the upstream.
    const res = await fetch(`${base}/api/competitor-basket/${biz.slug}/queries`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${biz.api_key}`,
      },
      body: JSON.stringify({ query: qp }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return withCors(jsonErr(res.status, "Radar basket add failed"), request, { credentials: true });
    }
    return withCors(jsonOk(data), request, { credentials: true });
  } catch (err) {
    return withCors(jsonErr(502, `Backend unreachable: ${String(err)}`), request, { credentials: true });
  }
}

// ── DELETE /api/client/radar/basket/:basket_id ────────────────────────────

async function apiRadarBasketDelete(request: Request, env: Env, basketId: string): Promise<Response> {
  const ctx = await getSessionFromRequest(request, env);
  if (!ctx) return withCors(jsonErr(401, "Unauthorized"), request, { credentials: true });

  const businesses = ctx.role === "admin"
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const slug = new URL(request.url).searchParams.get("slug");
  const biz  = (slug ? businesses.find((b) => b.slug === slug) : null) ?? businesses[0] ?? null;
  if (!biz) return withCors(jsonErr(404, "No business found for this account"), request, { credentials: true });

  const base = env.API_BASE_URL ?? "https://advocate-production-2887.up.railway.app";
  try {
    const res = await fetch(`${base}/api/competitor-basket/${biz.slug}/queries/${encodeURIComponent(basketId)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${biz.api_key}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return withCors(jsonErr(res.status, "Radar basket delete failed"), request, { credentials: true });
    }
    return withCors(jsonOk(data), request, { credentials: true });
  } catch (err) {
    return withCors(jsonErr(502, `Backend unreachable: ${String(err)}`), request, { credentials: true });
  }
}

// ── GET /api/client/domain-info ───────────────────────────────────────────
// Session-authed status surface for the Domains dashboard section.
//
// Combines three sources:
//   1. cf_hostname   — pulled live from the Cloudflare API when
//                      CF_API_TOKEN/CF_ZONE_ID are set on the Worker;
//                      otherwise surfaced as "permission check required".
//   2. worker_route  — full introspection requires Workers Routes:Read scope
//                      which this token lacks. Return present: null with a
//                      computed pattern so the UI can signal "unknown".
//   3. last_bot_hit  — derived from the tenant's /analytics/:slug payload
//                      (max timestamp across recent_queries).

async function apiDomainInfo(request: Request, env: Env): Promise<Response> {
  const ctx = await getSessionFromRequest(request, env);
  if (!ctx) return withCors(jsonErr(401, "Unauthorized"), request, { credentials: true });

  const businesses = ctx.role === "admin"
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const slug = new URL(request.url).searchParams.get("slug");
  const biz  = (slug ? businesses.find((b) => b.slug === slug) : null) ?? businesses[0] ?? null;
  if (!biz) return withCors(jsonErr(404, "No business found for this account"), request, { credentials: true });

  // Pull cf_hostname_id from D1 — the raw admin endpoint does this too but
  // we keep the query here so the session-authed helper does not leak the
  // admin secret to anyone.
  const row = await env.DB
    .prepare("SELECT cf_hostname_id FROM businesses WHERE slug = ? LIMIT 1")
    .bind(biz.slug)
    .first<{ cf_hostname_id: string | null }>();

  let cfHostname: {
    status: string;
    ssl_status: string;
    ownership_verified: boolean | null;
    note?: string;
  } = {
    status:             "unknown",
    ssl_status:         "unknown",
    ownership_verified: null,
    note:               "no cf_hostname_id on record",
  };

  if (row?.cf_hostname_id) {
    if (env.CF_API_TOKEN && env.CF_ZONE_ID) {
      const { ok, data } = await cfRequest(env, "GET", `/${row.cf_hostname_id}`);
      if (ok) {
        const result = data.result as Record<string, unknown> | undefined;
        const ssl    = result?.ssl as Record<string, unknown> | undefined;
        const ownershipStatus = result?.ownership_verification_status as string | undefined;
        cfHostname = {
          status:             (result?.status as string) ?? "unknown",
          ssl_status:         (ssl?.status as string) ?? "unknown",
          ownership_verified: ownershipStatus === "success",
        };
      } else {
        cfHostname.note = "cloudflare API error";
      }
    } else {
      cfHostname.note = "permission check required — CF_API_TOKEN / CF_ZONE_ID not configured on Worker";
    }
  }

  // Worker Route introspection via CF Workers Routes API.
  //
  // We previously did an empirical self-probe (fetch https://{domain}/ with a
  // bot UA and check for `ai_generated:true + powered_by:"AdvocateMCP"`). That
  // approach fails on Cloudflare Workers because a Worker's fetch() to a URL
  // served by the same Worker script hits CF's subrequest-loop protection
  // and returns 522/empty/timeout — producing a false "missing" even when
  // the route is live and serving real bot traffic (verified via direct
  // curl + queries.last_bot_hit showing recent activity).
  //
  // Now: query CF's authoritative Workers Routes list and check for a
  // pattern matching `{domain}/*`. Requires `Workers Routes: Read` scope
  // on CF_API_TOKEN (we added this Apr 16 2026 for auto-provisioning).
  const workerRoutePattern = biz.domain ? `${biz.domain}/*` : null;
  let workerRoutePresent: boolean | null = null;
  let workerRouteNote: string | undefined;

  if (biz.domain && workerRoutePattern) {
    if (!env.CF_API_TOKEN || !env.CF_ZONE_ID) {
      workerRouteNote = "CF_API_TOKEN / CF_ZONE_ID not configured; cannot verify";
    } else {
      try {
        const listRes = await fetch(
          `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/workers/routes`,
          {
            headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` },
            signal: AbortSignal.timeout(5000),
          },
        );
        if (!listRes.ok) {
          workerRouteNote = `CF routes API returned HTTP ${listRes.status}`;
        } else {
          const data = await listRes.json() as {
            success?: boolean;
            result?: Array<{ pattern: string; script: string; id: string }>;
          };
          if (data.success === true && Array.isArray(data.result)) {
            const matching = data.result.find((r) => r.pattern === workerRoutePattern);
            workerRoutePresent = Boolean(matching);
            if (!matching) {
              // Also accept wildcard parent matches (e.g. *.hosted.advocatemcp.com/*
              // covers any subdomain under our hosted namespace without a
              // per-tenant entry).
              const wildcardMatch = data.result.find((r) => {
                if (!r.pattern.startsWith("*.")) return false;
                const parent = r.pattern.replace(/^\*\./, "").replace(/\/\*$/, "");
                return biz.domain!.endsWith("." + parent);
              });
              if (wildcardMatch) {
                workerRoutePresent = true;
                workerRouteNote = `covered by wildcard route ${wildcardMatch.pattern}`;
              }
            }
          } else {
            workerRouteNote = "CF routes API returned unexpected shape";
          }
        }
      } catch (err) {
        workerRouteNote = `CF routes API fetch failed: ${err instanceof Error ? err.message : "unknown"}`;
      }
    }
  }

  // last_bot_hit — piggyback on the analytics fetch we already do. Only read
  // max(timestamp) from recent_queries.
  let lastBotHit: string | null = null;
  try {
    const analytics = await fetchAnalytics(biz, env);
    const recents = analytics?.recent_queries ?? [];
    if (recents.length > 0) {
      const maxTs = recents
        .map((q) => q.timestamp)
        .filter((t): t is string => typeof t === "string")
        .sort()
        .pop();
      lastBotHit = maxTs ?? null;
    }
  } catch {
    /* non-fatal */
  }

  return withCors(
    jsonOk({
      slug:          biz.slug,
      business_name: biz.business_name,
      domain:        biz.domain ?? null,
      cf_hostname:   cfHostname,
      worker_route:  { present: workerRoutePresent, pattern: workerRoutePattern, note: workerRouteNote },
      last_bot_hit:  lastBotHit,
    }),
    request,
    { credentials: true },
  );
}

// ── GET /api/client/domain-test ───────────────────────────────────────────
// Server-side fetch of the tenant's domain with a crawler User-Agent so the
// dashboard can visually verify that bot traffic is flowing through the
// Worker. Browsers cannot override User-Agent on fetch() for security
// reasons, so the Worker does it on their behalf.
//
// Capped at ~10s total and returns the HTTP status + first 200 chars of
// the body. Only called from the authenticated portal; session-bound slug.

async function apiDomainTest(request: Request, env: Env): Promise<Response> {
  const ctx = await getSessionFromRequest(request, env);
  if (!ctx) return withCors(jsonErr(401, "Unauthorized"), request, { credentials: true });

  const businesses = ctx.role === "admin"
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const slug = new URL(request.url).searchParams.get("slug");
  const biz  = (slug ? businesses.find((b) => b.slug === slug) : null) ?? businesses[0] ?? null;
  if (!biz) return withCors(jsonErr(404, "No business found for this account"), request, { credentials: true });
  if (!biz.domain) {
    return withCors(jsonErr(400, "No domain registered for this business"), request, { credentials: true });
  }

  const target = `https://${biz.domain}/`;
  try {
    const res = await fetch(target, {
      headers: { "User-Agent": "PerplexityBot/1.0 (advocate dashboard test)" },
      signal: AbortSignal.timeout(10_000),
    });
    const body = await res.text();
    const snippet = body.length > 200 ? body.slice(0, 200) + "…" : body;
    return withCors(
      jsonOk({
        url:         target,
        status:      res.status,
        status_text: res.statusText,
        content_type: res.headers.get("Content-Type") ?? null,
        snippet,
      }),
      request,
      { credentials: true },
    );
  } catch (err) {
    return withCors(
      jsonErr(502, `Fetch failed: ${String(err)}`),
      request,
      { credentials: true },
    );
  }
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

// ── Round 4: onboarding endpoints ─────────────────────────────────────────
// Session-authed, per-business. Admin role viewing another tenant via
// ?slug=X is NOT allowed to mutate state (the guard lives in
// apiMarkOnboardingStep). Admins CAN read any tenant's state.

/** Which checklist keys a business must complete to be considered onboarded. */
function requiredChecklistKeys(isHosted: boolean): string[] {
  return isHosted
    ? ["watched_welcome", "previewed_voice", "took_tour", "simulated_bot_hit"]
    : ["watched_welcome", "dns_configured", "previewed_voice", "took_tour", "first_real_bot_hit"];
}

function isOnboardingComplete(state: OnboardingState, isHosted: boolean): boolean {
  const needed = requiredChecklistKeys(isHosted);
  const completed = state.checklist ?? {};
  return needed.every((key) => !!completed[key]?.completed_at);
}

async function apiGetOnboarding(request: Request, env: Env): Promise<Response> {
  const ctx = await getSessionFromRequest(request, env);
  if (!ctx) return withCors(jsonErr(401, "Unauthorized"), request, { credentials: true });

  const businesses = ctx.role === "admin"
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const slug = new URL(request.url).searchParams.get("slug");
  const biz  = (slug ? businesses.find((b) => b.slug === slug) : null) ?? businesses[0] ?? null;
  if (!biz) return withCors(jsonErr(404, "No business found for this account"), request, { credentials: true });

  const snap = await getOnboardingState(env.DB, biz.slug);
  if (!snap) return withCors(jsonErr(404, "Business not found"), request, { credentials: true });

  return withCors(jsonOk(snap), request, { credentials: true });
}

// ── POST /api/client/preview-voice ────────────────────────────────────────
// Server-side proxy to Railway's POST /agents/:slug/query so the dashboard
// can render an *actual* agent answer in the onboarding voice-preview step
// — not a hardcoded sample. The api_key for the bearer header is read from
// D1 server-side; never exposed to the browser.
//
// Body: { query?: string }   (optional; defaults to "Tell me about <name>")
// Returns: { answer: string, query: string }   on success
//          { error, hint }                     on failure
//
// Cost: each call is one paid Claude invocation (~$0.005-0.02 depending on
// profile size). Onboarding hits this once per tenant under normal use; the
// FE ratelimits clicks via a disabled-button pattern. No KV/DO budget cap
// here yet — add one if a tenant abuses it.

async function apiPreviewVoice(request: Request, env: Env): Promise<Response> {
  const ctx = await getSessionFromRequest(request, env);
  if (!ctx) return withCors(jsonErr(401, "Unauthorized"), request, { credentials: true });

  const businesses = ctx.role === "admin"
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const slug = new URL(request.url).searchParams.get("slug");
  const biz  = (slug ? businesses.find((b) => b.slug === slug) : null) ?? businesses[0] ?? null;
  if (!biz) return withCors(jsonErr(404, "No business found for this account"), request, { credentials: true });

  let query = "";
  try {
    const body = await request.json() as Record<string, unknown>;
    query = typeof body.query === "string" ? body.query.trim().slice(0, 500) : "";
  } catch { /* empty body is fine — we'll synthesize one below */ }
  if (!query) {
    const name = biz.business_name || biz.slug;
    query = `Tell me about ${name}.`;
  }

  if (!biz.api_key || biz.api_key === "pending") {
    return withCors(
      jsonErr(409, "Tenant has no usable api_key (Stripe webhook may still be in flight). Try again in a minute."),
      request, { credentials: true },
    );
  }

  const base = env.API_BASE_URL ?? "https://advocate-production-2887.up.railway.app";
  try {
    const r = await fetch(`${base}/agents/${biz.slug}/query`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${biz.api_key}`,
        ...(env.API_KEY ? { "X-API-Key": env.API_KEY } : {}),
      },
      body: JSON.stringify({ query, crawler: "PerplexityBot" }),
    });
    // Railway returns AgentQueryResult — answer text is in `response`,
    // not `answer`. (See server/src/agent/query.ts AgentQueryResult.)
    const data = await r.json().catch(() => ({})) as {
      response?: string;
      answer?: string;        // tolerate either name in case the upstream renames
      error?: string;
      referral_url?: string | null;
    };
    if (!r.ok) {
      return withCors(
        jsonErr(r.status, data.error || `Preview failed (HTTP ${r.status})`),
        request, { credentials: true },
      );
    }
    const answerText = (data.response ?? data.answer ?? "").trim();
    return withCors(
      jsonOk({
        query,
        answer: answerText || "(no answer returned)",
        referral_url: data.referral_url ?? null,
      }),
      request, { credentials: true },
    );
  } catch (err) {
    return withCors(jsonErr(502, `Preview backend unreachable: ${String(err)}`), request, { credentials: true });
  }
}

// ── POST /api/client/profile-score ────────────────────────────────────────
// Server-side proxy for the customer-facing AI citation score. Calls
// Railway POST /agents/:slug/profile-score, which runs the format-judge
// harness against the tenant's own profile and returns:
//   { score, score_max, cite_rate, per_variant[], improvements[], ... }
//
// Same auth shape as preview-voice: customer session bearer (or admin
// session impersonating via ?as=<slug>). The api_key the worker forwards
// to Railway is the tenant's own — never the admin key — so even an
// impersonating admin gets the customer's view.
//
// Cost: ~$0.04 per call (4 trials × ~$0.01). Worker is the only public
// surface for this; no rate-limit on the worker side yet beyond the
// existing per-IP rateLimitMiddleware. Add per-tenant throttling here
// if cost becomes a concern.
//
// Latency: ~30-45 seconds (one Claude call per trial × 4 trials,
// sequential on Railway). Caller should show a progress indicator.
// Cloudflare's edge proxy timeout (~100s) is comfortably above this.

async function apiProfileScore(request: Request, env: Env): Promise<Response> {
  const ctx = await getSessionFromRequest(request, env);
  if (!ctx) return withCors(jsonErr(401, "Unauthorized"), request, { credentials: true });

  const businesses = ctx.role === "admin"
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const slug = new URL(request.url).searchParams.get("slug");
  const biz  = (slug ? businesses.find((b) => b.slug === slug) : null) ?? businesses[0] ?? null;
  if (!biz) return withCors(jsonErr(404, "No business found for this account"), request, { credentials: true });

  if (!biz.api_key || biz.api_key === "pending") {
    return withCors(
      jsonErr(409, "Tenant has no usable api_key (Stripe webhook may still be in flight). Try again in a minute."),
      request, { credentials: true },
    );
  }

  // GET = fast cache read (no API spend, no run). POST = run on
  // cache miss. Both forwarded transparently to Railway.
  const isGet = request.method === "GET";
  let body = "{}";
  if (!isGet) {
    try { body = await request.text(); } catch { /* empty body OK */ }
    if (!body || !body.trim()) body = "{}";
  }

  const base = env.API_BASE_URL ?? "https://advocate-production-2887.up.railway.app";
  try {
    // Server-side gate: profile-score requires the X-API-Key
    // (server admin key, only the Worker has it). Direct-Railway
    // requests with a leaked tenant Bearer alone get 401. The Worker
    // proxy is the only path through.
    const r = await fetch(`${base}/agents/${biz.slug}/profile-score`, {
      method: isGet ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${biz.api_key}`,
        ...(env.API_KEY ? { "X-API-Key": env.API_KEY } : {}),
      },
      ...(isGet ? {} : { body }),
    });
    const text = await r.text();
    return withCors(
      new Response(text, {
        status: r.status,
        headers: { "Content-Type": r.headers.get("content-type") ?? "application/json" },
      }),
      request, { credentials: true },
    );
  } catch (err) {
    return withCors(jsonErr(502, `Profile score backend unreachable: ${String(err)}`), request, { credentials: true });
  }
}

// ── POST /api/client/verify-rating ────────────────────────────────────────
// Server-side proxy for Google Places verification. Calls Railway
// POST /agents/:slug/profile/verify-rating, which hits the Places API
// (New) and returns the live rating + count + recent review snippets.
//
// Same auth shape as profile-score: customer session bearer (or admin
// session impersonating via ?slug=). The api_key the worker forwards
// is read from D1 server-side; never exposed to the browser. The X-API-Key
// header is also injected so direct-Railway access with a leaked tenant
// key alone is rejected (matches the require-server-key pattern used on
// profile-score).
//
// Body (forwarded as-is): { platform: "google", url: <maps URL> }
// Returns: { ok, rating, count, url, place_id, quotes[], verified_at }
//          or { ok:false, reason, message } on failure.
async function apiVerifyRating(request: Request, env: Env): Promise<Response> {
  const ctx = await getSessionFromRequest(request, env);
  if (!ctx) return withCors(jsonErr(401, "Unauthorized"), request, { credentials: true });

  const businesses = ctx.role === "admin"
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const slug = new URL(request.url).searchParams.get("slug");
  const biz  = (slug ? businesses.find((b) => b.slug === slug) : null) ?? businesses[0] ?? null;
  if (!biz) return withCors(jsonErr(404, "No business found for this account"), request, { credentials: true });

  if (!biz.api_key || biz.api_key === "pending") {
    return withCors(
      jsonErr(409, "Tenant has no usable api_key (Stripe webhook may still be in flight). Try again in a minute."),
      request, { credentials: true },
    );
  }

  let body = "{}";
  try { body = await request.text(); } catch { /* empty body falls through */ }
  if (!body || !body.trim()) body = "{}";

  const base = env.API_BASE_URL ?? "https://advocate-production-2887.up.railway.app";
  try {
    const r = await fetch(`${base}/agents/${biz.slug}/profile/verify-rating`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${biz.api_key}`,
        ...(env.API_KEY ? { "X-API-Key": env.API_KEY } : {}),
      },
      body,
    });
    const text = await r.text();
    return withCors(
      new Response(text, {
        status: r.status,
        headers: { "Content-Type": r.headers.get("content-type") ?? "application/json" },
      }),
      request, { credentials: true },
    );
  } catch (err) {
    return withCors(jsonErr(502, `Verify-rating backend unreachable: ${String(err)}`), request, { credentials: true });
  }
}

// ── Public demo proxy (Phase B.1, Apr 25 2026) ─────────────────────────
// /demo/agent/run + /demo/agent/availability are unauth public endpoints
// powering the homepage live-MCP demo widget. The Railway server enforces
// IP rate limits + budget caps; the worker just passes the request
// through. CORS allows the advocatemcp.com origin since the widget runs
// from there.
//
// We deliberately do NOT inject X-API-Key here. The Railway routes are
// already public — that's the design. Adding an admin key would suggest
// these endpoints are privileged, which they aren't.

function handleDemoPreflight(request: Request): Response {
  // No credentials needed — the demo is unauth, no cookies cross over.
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin":  request.headers.get("Origin") ?? "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age":       "86400",
      "Vary":                         "Origin",
    },
  });
}

async function handleDemoProxy(request: Request, env: Env, path: string): Promise<Response> {
  const base = env.API_BASE_URL ?? "https://advocate-production-2887.up.railway.app";
  let body = "{}";
  try { body = await request.text(); } catch { /* empty */ }
  if (!body || !body.trim()) body = "{}";
  // Forward visitor IP so Railway can rate-limit per-IP. The widget runs
  // in the visitor's browser → CF terminates TLS at the Worker → we get
  // CF-Connecting-IP. Pass it through as X-Forwarded-For so Railway sees
  // the visitor IP, not the Worker's IP (which would be the same for all
  // visitors).
  const visitorIp =
    request.headers.get("CF-Connecting-IP") ??
    request.headers.get("X-Forwarded-For") ??
    "";
  try {
    const r = await fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "Content-Type":    "application/json",
        ...(visitorIp ? { "X-Forwarded-For": visitorIp } : {}),
      },
      body,
    });
    const text = await r.text();
    const origin = request.headers.get("Origin") ?? "*";
    return new Response(text, {
      status: r.status,
      headers: {
        "Content-Type":                 r.headers.get("content-type") ?? "application/json",
        "Access-Control-Allow-Origin":  origin,
        "Vary":                         "Origin",
      },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "demo_backend_unreachable", message: String(err) }),
      {
        status: 502,
        headers: {
          "Content-Type":                "application/json",
          "Access-Control-Allow-Origin": request.headers.get("Origin") ?? "*",
          "Vary":                        "Origin",
        },
      },
    );
  }
}

async function apiMarkOnboardingStep(request: Request, env: Env): Promise<Response> {
  const ctx = await getSessionFromRequest(request, env);
  if (!ctx) return withCors(jsonErr(401, "Unauthorized"), request, { credentials: true });

  // Admin impersonation MUST NOT mutate a tenant's onboarding state.
  // Return 200 with a no-op so the dashboard JS doesn't spin on an error.
  if (ctx.role === "admin") {
    const snap: OnboardingSnapshot = {
      first_dashboard_at: null, onboarded_at: null, state: {},
    };
    return withCors(jsonOk({ ok: true, admin_noop: true, ...snap }), request, { credentials: true });
  }

  let body: { step?: string; value?: unknown };
  try {
    body = await request.json() as { step?: string; value?: unknown };
  } catch {
    return withCors(jsonErr(400, "Invalid JSON body"), request, { credentials: true });
  }
  const step = typeof body.step === "string" ? body.step.trim() : "";
  if (!step) return withCors(jsonErr(400, "Missing required field: step"), request, { credentials: true });

  const businesses = await getUserBusinesses(env.DB, ctx.user_id);
  const slug = new URL(request.url).searchParams.get("slug");
  const biz  = (slug ? businesses.find((b) => b.slug === slug) : null) ?? businesses[0] ?? null;
  if (!biz) return withCors(jsonErr(404, "No business found for this account"), request, { credentials: true });

  const isHosted = !!(biz.domain && biz.domain.endsWith(".hosted.advocatemcp.com"));
  const nowIso = new Date().toISOString();

  // Peek at current state to determine whether this step finishes the flow.
  const current = await getOnboardingState(env.DB, biz.slug);
  if (!current) return withCors(jsonErr(404, "Business not found"), request, { credentials: true });

  // Compute the post-merge state and check completion — lets us set
  // onboarded_at in the same atomic write.
  const previewValue = body.value ?? { completed_at: nowIso };
  const previewState = applyStepPreview(current.state, step, previewValue);
  const allDone = isOnboardingComplete(previewState, isHosted);

  const next = await markOnboardingStep(env.DB, biz.slug, step, previewValue, nowIso, allDone);
  if (!next) return withCors(jsonErr(404, "Business not found"), request, { credentials: true });

  return withCors(jsonOk({ ok: true, ...next }), request, { credentials: true });
}

/**
 * Mirror of portalDb.mergeStep for the preview-and-check path. Kept here
 * rather than exported from portalDb to avoid leaking the merge semantics
 * — portalDb's markOnboardingStep is the canonical writer.
 */
function applyStepPreview(base: OnboardingState, dottedKey: string, value: unknown): OnboardingState {
  const parts = dottedKey.split(".").filter(Boolean);
  if (parts.length === 0) return base;
  const out: OnboardingState = { ...base };
  let cursor: Record<string, unknown> = out as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    const existing = cursor[key];
    const nested: Record<string, unknown> =
      existing && typeof existing === "object" && !Array.isArray(existing)
        ? { ...(existing as Record<string, unknown>) }
        : {};
    cursor[key] = nested;
    cursor = nested;
  }
  cursor[parts[parts.length - 1]!] = value;
  return out;
}

// ── POST /admin/businesses/:slug/resync-api-key ────────────────────────────
// Recovers from D1/Railway api_key divergence by rotating Railway's key
// and writing the new value back to D1. Idempotent.
//
// The underlying cause of divergence is a Railway-side write that bypasses
// the Stripe webhook dual-write path — e.g. a direct curl to rotate-key
// without updating D1, or a Railway sqlite re-seed. This endpoint is the
// canonical recovery mechanism; do not paper over divergences with manual
// SQL except during the migration that introduced this endpoint.
//
// Auth: Bearer ADMIN_SECRET (same as /admin/create-client).
//
// CORS: exposed to the dashboard UI on advocatemcp.com. Every response
// goes through withCors(..., {credentials: true}) so the browser doesn't
// block the cross-origin response. Non-browser callers (curl, CI) ignore
// the extra headers. OPTIONS preflight handled in the route dispatcher.
async function adminResyncApiKey(request: Request, env: Env, slug: string): Promise<Response> {
  const given  = request.headers.get("Authorization") ?? "";
  const secret = env.ADMIN_SECRET ?? "";
  const credentialValid = secret.length > 0 && given === `Bearer ${secret}`;
  if (!credentialValid) return withCors(jsonErr(401, "Unauthorized"), request, { credentials: true });

  const biz = await getBusinessBySlug(env.DB, slug);
  if (!biz) return withCors(jsonErr(404, "Business not found in D1"), request, { credentials: true });

  const base = env.API_BASE_URL ?? "https://advocate-production-2887.up.railway.app";
  let rotateRes: Response;
  try {
    rotateRes = await fetch(`${base}/agents/${slug}/rotate-key`, {
      method: "POST",
      headers: { ...(env.API_KEY ? { "X-API-Key": env.API_KEY } : {}) },
    });
  } catch (err) {
    return withCors(jsonErr(502, `Backend unreachable: ${String(err)}`), request, { credentials: true });
  }

  if (!rotateRes.ok) {
    return withCors(jsonErr(502, `Backend rotate failed with ${rotateRes.status}`), request, { credentials: true });
  }
  const data = await rotateRes.json() as { ok?: boolean; new_api_key?: string };
  if (!data.ok || !data.new_api_key) {
    return withCors(jsonErr(502, "Invalid response from backend"), request, { credentials: true });
  }

  await updateBusinessApiKey(env.DB, slug, data.new_api_key);
  return withCors(
    jsonOk({
      ok: true,
      slug,
      message: "API key resynced. D1 and Railway are now aligned.",
      // Deliberately does NOT return the new key — operator sees it via
      // the rotate-key endpoint if they need it; this endpoint is for ops
      // recovery, not key discovery.
    }),
    request,
    { credentials: true },
  );
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

// ── Admin magic-login (Apr 26 2026) ─────────────────────────────────────
//
// Lets an admin issue a 5-minute signed token that, when redeemed at
// /auth/magic, creates a real tenant-role session for the chosen slug's
// linked user. Use case: verify data isolation visually — admin opens
// the magic URL in incognito, lands on the dashboard with NO admin
// sidebar / NO cross-tenant data, exactly as the tenant sees it.
//
// Why not just use ?as=<slug> impersonation? Because impersonation
// keeps the session role as 'admin', so admin UI elements still
// render. Magic-login swaps to the tenant's actual user_id, with
// role: 'client' — same auth context as if WCC logged in normally.
//
// Auth: Bearer ADMIN_SECRET (same pattern as /admin/create-client).
// Token TTL: 5 minutes. Token is NOT single-use; the short window is
// the main protection.

/**
 * GET /admin/beta-tenants
 *
 * Lists every tenant whose checkout used a Stripe promo code on the
 * BETA_COUPON_IDS allowlist. Sorted by ends_at ascending so the soonest
 * to convert / churn appear first. Used by the founder to track the
 * beta cohort in real time during launch:
 *
 *   curl -s -H "X-Admin-Secret: $ADMIN_SECRET" \
 *     https://customers.advocatemcp.com/admin/beta-tenants | jq
 *
 * Returns:
 *   {
 *     ok: true,
 *     count: <int>,
 *     tenants: [{ slug, name, domain, plan, beta_started_at,
 *                 beta_ends_at, days_left, beta_cohort, beta_coupon_id,
 *                 stripe_customer_id, stripe_subscription_id }]
 *   }
 */
async function adminBetaTenants(request: Request, env: Env): Promise<Response> {
  const provided = request.headers.get("X-Admin-Secret") ?? "";
  if (!env.ADMIN_SECRET || provided !== env.ADMIN_SECRET) {
    return withCors(jsonErr(401, "Unauthorized"), request, { credentials: true });
  }
  let rows: Array<Record<string, string | number | null>> = [];
  try {
    const result = await env.DB
      .prepare(
        `SELECT
            slug, business_name AS name, domain, plan,
            beta_started_at, beta_ends_at, beta_cohort, beta_coupon_id,
            stripe_customer_id, stripe_subscription_id
           FROM businesses
          WHERE beta_started_at IS NOT NULL
          ORDER BY beta_ends_at ASC`,
      )
      .all();
    rows = (result.results ?? []) as typeof rows;
  } catch (err) {
    return withCors(
      jsonErr(500, `DB error: ${String(err).slice(0, 200)}`),
      request,
      { credentials: true },
    );
  }
  const now = Date.now();
  const tenants = rows.map((r) => {
    const endsAt = r.beta_ends_at ? Date.parse(String(r.beta_ends_at)) : null;
    const daysLeft = endsAt !== null ? Math.max(0, Math.ceil((endsAt - now) / 86_400_000)) : null;
    return { ...r, days_left: daysLeft };
  });
  return withCors(
    jsonOk({ ok: true, count: tenants.length, tenants }),
    request,
    { credentials: true },
  );
}

async function adminMagicLogin(request: Request, env: Env): Promise<Response> {
  // Reject non-JSON content types before touching the body.
  const ct = request.headers.get("Content-Type") ?? "";
  if (!ct.includes("application/json")) {
    return jsonErr(415, "Content-Type must be application/json");
  }
  const given  = request.headers.get("Authorization") ?? "";
  const secret = env.ADMIN_SECRET ?? "";
  const credentialValid = secret.length > 0 && given === `Bearer ${secret}`;
  if (!credentialValid) return jsonErr(401, "Unauthorized");

  if (!env.TOKEN_SIGNING_KEY) {
    return jsonErr(503, "TOKEN_SIGNING_KEY not configured on this worker");
  }

  let body: { slug?: unknown };
  try { body = await request.json() as { slug?: unknown }; }
  catch { return jsonErr(400, "Body must be valid JSON with { slug }"); }
  const slug = typeof body.slug === "string" ? body.slug.trim() : "";
  if (!slug) return jsonErr(400, "slug is required");

  // Resolve the business → its TENANT user (role='client'). Admins also
  // get user_business_access rows for tenants they create, so a naïve
  // LIMIT 1 query can return the admin's user_id, which would defeat
  // the whole purpose of magic-login (you'd land back in your admin
  // dashboard). Filter for role='client' explicitly so we only match
  // the actual tenant account.
  const business = await getBusinessBySlug(env.DB, slug);
  if (!business) return jsonErr(404, `No business with slug '${slug}'`);
  const accessRow = await env.DB
    .prepare(
      `SELECT u.id AS user_id, u.email AS email
         FROM user_business_access uba
         JOIN users u ON u.id = uba.user_id
        WHERE uba.business_id = ?
          AND u.role = 'client'
        ORDER BY u.created_at ASC
        LIMIT 1`,
    )
    .bind(business.id)
    .first<{ user_id: string; email: string }>();
  if (!accessRow) {
    return jsonErr(
      404,
      `No client-role user linked to slug '${slug}'. ` +
      `Either no tenant account has been created yet, or only admin users are linked.`,
    );
  }

  const tokenStr = await signMagicToken(
    { user_id: accessRow.user_id, ts: Math.floor(Date.now() / 1000) },
    env.TOKEN_SIGNING_KEY,
  );

  // Build the redemption URL on the same hostname as this request so the
  // resulting cookie binds to the right domain.
  const url = new URL(request.url);
  const magicUrl = `${url.protocol}//${url.host}/auth/magic?token=${encodeURIComponent(tokenStr)}`;

  return jsonOk({
    magic_url:        magicUrl,
    expires_in_sec:   5 * 60,
    impersonating:    {
      slug,
      business_name: business.business_name,
      user_id:       accessRow.user_id,
      email:         accessRow.email,
      role:          "client",  // confirmed in the SQL filter above
    },
    note:             "Open this URL in an incognito/private window so it doesn't replace your admin session.",
  });
}

async function handleMagicLogin(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const tokenStr = url.searchParams.get("token") ?? "";
  if (!tokenStr) return jsonErr(400, "missing token");
  if (!env.TOKEN_SIGNING_KEY) return jsonErr(503, "signing key not configured");

  let payload;
  try {
    payload = await verifyMagicToken(tokenStr, env.TOKEN_SIGNING_KEY);
  } catch (err) {
    // err is "malformed" | "bad_signature" | "expired" — surface the
    // reason so admin can debug a stale link without poking the server.
    return jsonErr(401, `magic token rejected: ${String(err)}`);
  }

  // Exchange the validated user_id for a real session cookie. Same
  // session-creation path as /api/auth/login, so the resulting session
  // is indistinguishable from a normal tenant login.
  const { token: sessionToken } = await createSession(env.DB, payload.user_id);

  // Redirect to /dashboard — the same target normal login uses (line
  // ~329 in this file). /dashboard 301s to advocatemcp.com/dashboard.html
  // which then redirects to /app.html (the v2 dashboard). Plain "/" on
  // customers.advocatemcp.com falls through to bot detection because
  // there's no root handler there, which is what produced the
  // "Non-crawler request" response on first redemption.
  return new Response(null, {
    status: 302,
    headers: {
      Location:     "/dashboard",
      "Set-Cookie": sessionCookieHeader(sessionToken),
    },
  });
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

