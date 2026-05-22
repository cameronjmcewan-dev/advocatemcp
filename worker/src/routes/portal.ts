// Client portal: login, logout, dashboard, and protected JSON API.
// All HTML is server-rendered — no client-side framework required.

import type { Env } from "../types";
import {
  generateSalt, hashPassword, verifyPassword, verifyAndMaybeRehash,
  getSessionToken, sessionCookieHeader, clearSessionCookieHeader,
} from "../auth";
import {
  getUserByEmail, createUser, updateUserPassword, createSession, getSessionByToken,
  deleteSession, getUserBusinesses, getAllBusinesses, getActiveBusinesses, getBusinessBySlug, createBusiness,
  grantAccess, checkRateLimit, recordLoginAttempt, updateBusinessApiKey,
  getOnboardingState, markOnboardingStep, touchFirstDashboardIfNull,
  getDashboards, getOrSeedDefaultDashboard,
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
import { serveOnboardDnsPage } from "./onboardDnsPage";
import { handleActivatePage } from "./activatePage";
import { handleActivate, handleActivateHosted, handleActivatePreview, handleActivateStatus, handleActivateDnsProvider, handleActivationToken, handleGetActivation, handleResendActivation } from "./activate";
import { handleCloudflareValidate, handleCloudflareApply, handleGoDaddyValidate, handleGoDaddyApply, handleNamecheapValidate, handleNamecheapApply, handleRoute53Validate, handleRoute53Apply, handleIonosValidate, handleIonosApply } from "./dnsAuto";
import {
  getSessionFromRequest,
  type AuthContext,
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
  handleRotateRailwayKey,
} from "./stripe";
import { handleSaveDraft, handleLoadDraft } from "./onboardDraft";
import * as dashboardApi from "./dashboard/api";
import { handleContact, handleContactPreflight } from "./contact";
import { handleSupportChat, handleSupportChatPreflight } from "./supportChat";
import { handleRevenueEvent, ensureRevenueWebhookSecret } from "./revenueEvent";
import {
  handleListTeam,
  handleInviteTeam,
  handleRemoveTeam,
  handleUpdateTeamRole,
  handleTeamAccept,
  handleTeamAcceptPreflight,
} from "./team";
import { handleClientSwitchDomain } from "./clientSwitchDomain";
import { signMagicToken, verifyMagicToken } from "../lib/magicToken";
import {
  handleAdminInsightsProxy,
  handleAdminInsightsProxyPreflight,
  handleAdminExperimentFormatJudge,
  handleAdminExperimentFormatJudgePreflight,
  handleAdminProfileScores,
} from "./adminInsightsProxy";
import { handleGA4Start, handleGA4Callback } from "./ga4Oauth";
import { handleGSCStart, handleGSCCallback } from "./gscOauth";
import { handleHubspotStart, handleHubspotCallback } from "./hubspotOauth";
import { handleSalesforceStart, handleSalesforceCallback } from "./salesforceOauth";
import { signGA4State } from "../lib/ga4State";
import { signState } from "../lib/oauthState";
import { decryptToken } from "../lib/ga4TokenCrypto";
import { refreshAccessToken, listProperties, fetchDailyTraffic, fetchDailyGeography, fetchDailyConversions } from "../lib/ga4";
import { listSites, fetchSearchAnalytics, fetchAiOverviewQueries } from "../lib/gsc";
import { refreshHubspotAccessToken, fetchContactsWithRevenue } from "../lib/hubspot";
import { refreshSalesforceAccessToken, fetchContactsWithRevenue as fetchSalesforceContactsWithRevenue } from "../lib/salesforce";
import { aggregateLtv } from "../lib/ltvAggregator";
import { aggregateGeoRows } from "../lib/geoAggregator";
import { aggregateConversionRows } from "../lib/conversionAggregator";
import { classifyTrafficSource } from "../lib/aiTrafficClassifier";
import { trafficImpactPayload } from "../lib/trafficImpactPayload";
import { fetchIntegrationsStatus } from "../lib/integrationsStatusOrchestrator.js";

// ── Public route dispatcher ────────────────────────────────────────────────
// Returns a Response if this is a portal path, or null to fall through to
// the existing AI-crawler logic.

// Portal routes are hostname-scoped to the customers + workers.dev preview
// hosts. Without this guard, adding advocatemcp.com to the worker's route
// list (so we can intercept AI crawlers on our own domain — full dogfood)
// would have the worker also hijack /api/client/*, /auth/*, /Pricing.html
// etc on advocatemcp.com — which would either 401 the whole marketing
// site (auth endpoints) or trigger the customers→advocatemcp.com HTML
// redirect loop. Apr 28 2026.
const PORTAL_HOSTS = new Set([
  "customers.advocatemcp.com",
  "advocatecameron.workers.dev",
  "advocatemcp-worker.advocatecameron.workers.dev",
]);

export async function handlePortal(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method;

  // Fall through if this isn't the portal host — let the bot-detection /
  // human-proxy logic in index.ts handle it.
  if (!PORTAL_HOSTS.has(url.hostname)) return null;

  if (pathname === "/login"               && method === "GET")  return Response.redirect("https://advocatemcp.com/login.html", 301);
  if (pathname === "/auth/login"          && method === "POST") return authLogin(request, env);
  if (pathname === "/auth/logout"         && method === "POST") return authLogout(request, env);
  if (pathname === "/dashboard"           && method === "GET")  return Response.redirect("https://advocatemcp.com/dashboard.html", 301);

  // HTML-page redirects (Apr 27 2026 hotfix). Pages serves the actual
  // dashboard / billing / team-accept / etc. HTML on advocatemcp.com.
  // Without these redirects, customers.advocatemcp.com/<path>.html
  // falls through to the worker's bot-detection catch-all and a real
  // human user sees a JSON error response. Redirect everything that's
  // a known HTML page in site/ to its Pages-hosted equivalent. Query
  // strings + hash fragments are preserved automatically by the
  // browser when it follows a 301 (the URL components survive across
  // origin redirects).
  if (method === "GET") {
    // Every dashboard / marketing HTML page Pages serves needs a
    // worker-side redirect for the customers.advocatemcp.com host.
    // Without this the page falls through to the bot-detection
    // catch-all and a real human user gets a JSON error response.
    // (Apr 28 2026: audit caught Settings.html + every dashboard
    // section page that wasn't in the original list.)
    const htmlRedirects: Record<string, string> = {
      // Dashboard surfaces
      "/app":                  "https://advocatemcp.com/app.html",
      "/app.html":             "https://advocatemcp.com/app.html",
      "/dashboard":            "https://advocatemcp.com/dashboard.html",
      "/dashboard.html":       "https://advocatemcp.com/dashboard.html",
      "/Settings":             "https://advocatemcp.com/Settings.html",
      "/Settings.html":        "https://advocatemcp.com/Settings.html",
      "/Billing":              "https://advocatemcp.com/Billing.html",
      "/billing":              "https://advocatemcp.com/Billing.html",
      "/Billing.html":         "https://advocatemcp.com/Billing.html",
      "/BusinessProfile":      "https://advocatemcp.com/BusinessProfile.html",
      "/BusinessProfile.html": "https://advocatemcp.com/BusinessProfile.html",
      "/BotTraffic":           "https://advocatemcp.com/Mentions.html",
      "/BotTraffic.html":      "https://advocatemcp.com/Mentions.html",
      "/Mentions":             "https://advocatemcp.com/Mentions.html",
      "/Mentions.html":        "https://advocatemcp.com/Mentions.html",
      "/ClickThroughs":        "https://advocatemcp.com/TrafficImpact.html",
      "/ClickThroughs.html":   "https://advocatemcp.com/TrafficImpact.html",
      "/TrafficImpact":        "https://advocatemcp.com/TrafficImpact.html",
      "/TrafficImpact.html":   "https://advocatemcp.com/TrafficImpact.html",
      "/CompetitorRadar":      "https://advocatemcp.com/CompetitorRadar.html",
      "/CompetitorRadar.html": "https://advocatemcp.com/CompetitorRadar.html",
      "/A2APipeline":          "https://advocatemcp.com/A2APipeline.html",
      "/A2APipeline.html":     "https://advocatemcp.com/A2APipeline.html",
      "/ActivityFeed":         "https://advocatemcp.com/ActivityFeed.html",
      "/ActivityFeed.html":    "https://advocatemcp.com/ActivityFeed.html",
      // Onboarding + auth flows
      "/team-accept":          "https://advocatemcp.com/team-accept.html",
      "/team-accept.html":     "https://advocatemcp.com/team-accept.html",
      "/onboarding":           "https://advocatemcp.com/onboarding.html",
      "/onboarding.html":      "https://advocatemcp.com/onboarding.html",
      // Activation pages are now ALL Pages-rendered with brand CSS — both
      // the hosted "Set your password" form and the DNS "Enter your domain"
      // form live in site/activate.html, branched at runtime by
      // dashboard-activate.js based on /api/activate/preview.skip_dns.
      // The brief detour through worker/handleActivatePage (May 3 2026,
      // commit 9a855b9) is reverted now that the Pages site handles both
      // tenant types correctly. handleActivatePage + renderHostedPage in
      // worker/src/routes/activatePage.ts are kept as dormant fallback
      // for one release; remove in a follow-up commit.
      "/activate":             "https://advocatemcp.com/activate.html",
      "/activate.html":        "https://advocatemcp.com/activate.html",
      "/login":                "https://advocatemcp.com/login.html",
      "/login.html":           "https://advocatemcp.com/login.html",
      "/admin":                "https://advocatemcp.com/admin.html",
      "/admin.html":           "https://advocatemcp.com/admin.html",
      // Marketing pages
      "/Contact":              "https://advocatemcp.com/Contact.html",
      "/Contact.html":         "https://advocatemcp.com/Contact.html",
      "/FAQs":                 "https://advocatemcp.com/FAQs.html",
      "/FAQs.html":            "https://advocatemcp.com/FAQs.html",
      "/Pricing":              "https://advocatemcp.com/Pricing.html",
      "/Pricing.html":         "https://advocatemcp.com/Pricing.html",
      "/Features":             "https://advocatemcp.com/Features.html",
      "/Features.html":        "https://advocatemcp.com/Features.html",
      "/Industries":           "https://advocatemcp.com/Industries.html",
      "/Industries.html":      "https://advocatemcp.com/Industries.html",
      "/methodology":          "https://advocatemcp.com/methodology.html",
      "/methodology.html":     "https://advocatemcp.com/methodology.html",
      "/privacy":              "https://advocatemcp.com/privacy.html",
      "/privacy.html":         "https://advocatemcp.com/privacy.html",
      "/terms":                "https://advocatemcp.com/terms.html",
      "/terms.html":           "https://advocatemcp.com/terms.html",
    };
    const target = htmlRedirects[pathname];
    if (target) {
      // Preserve query string on the redirect — the team-accept link
      // depends on `?t=<token>` surviving across origin.
      const search = new URL(request.url).search ?? "";
      return Response.redirect(target + search, 301);
    }
  }
  if (pathname === "/oauth/ga4/start"     && method === "GET")  return handleGA4StartProtected(request, env);
  if (pathname === "/oauth/ga4/callback"  && method === "GET")  return handleGA4Callback(request, env);
  if (pathname === "/api/client/ga4/status"          && method === "GET")  return apiGA4Status(request, env);
  if (pathname === "/api/client/ga4/start-link"      && method === "POST") return apiGA4StartLink(request, env);
  if (pathname === "/api/client/ga4/properties"      && method === "GET")  return apiGA4Properties(request, env);
  if (pathname === "/api/client/ga4/select-property" && method === "POST") return apiGA4SelectProperty(request, env);
  if (pathname === "/api/client/ga4/resync"          && method === "POST") return apiGA4Resync(request, env);
  if (pathname === "/api/client/ga4/disconnect"      && method === "POST") return apiGA4Disconnect(request, env);
  if (pathname === "/oauth/gsc/start"      && method === "GET")  return handleGSCStartProtected(request, env);
  if (pathname === "/oauth/gsc/callback"   && method === "GET")  return handleGSCCallback(request, env);
  if (pathname === "/api/client/gsc/status"      && method === "GET")  return apiGSCStatus(request, env);
  if (pathname === "/api/client/gsc/start-link"  && method === "POST") return apiGSCStartLink(request, env);
  if (pathname === "/api/client/gsc/disconnect"  && method === "POST") return apiGSCDisconnect(request, env);
  if (pathname === "/api/client/gsc/sites"       && method === "GET")  return apiGSCSites(request, env);
  if (pathname === "/api/client/gsc/select-site" && method === "POST") return apiGSCSelectSite(request, env);
  if (pathname === "/api/client/gsc/resync"      && method === "POST") return apiGSCResync(request, env);
  if (pathname === "/api/client/integrations/status" && method === "GET")     return apiIntegrationsStatus(request, env);
  if (pathname === "/api/client/integrations/status" && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/traffic-impact"                          && method === "GET")     return apiTrafficImpact(request, env);
  if (pathname === "/api/client/traffic-impact/geography"               && method === "GET")     return apiTrafficImpactGeography(request, env);
  if (pathname === "/api/client/traffic-impact/conversions"             && method === "GET")     return apiTrafficImpactConversions(request, env);
  if (pathname === "/api/client/traffic-impact/gsc"                     && method === "GET")     return apiTrafficImpactGSC(request, env);
  if (pathname === "/api/client/traffic-impact/verified-revenue"        && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/traffic-impact/verified-revenue"        && method === "GET")     return apiTrafficImpactVerifiedRevenue(request, env);
  if (pathname === "/api/client/traffic-impact/ltv"                     && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/traffic-impact/ltv"                     && method === "GET")     return apiTrafficImpactLtv(request, env);
  if (pathname === "/api/client/traffic-impact/authority"               && method === "GET")     return apiTrafficImpactAuthority(request, env);
  if (pathname === "/oauth/hubspot/start"         && method === "GET")  return handleHubspotStartProtected(request, env);
  if (pathname === "/oauth/hubspot/callback"      && method === "GET")  return handleHubspotCallback(request, env);
  if (pathname === "/oauth/salesforce/start"      && method === "GET")  return handleSalesforceStartProtected(request, env);
  if (pathname === "/oauth/salesforce/callback"   && method === "GET")  return handleSalesforceCallback(request, env);
  if (pathname === "/api/client/crm/status"      && method === "GET")  return apiCrmStatus(request, env);
  if (pathname === "/api/client/crm/start-link"  && method === "POST") return apiCrmStartLink(request, env);
  if (pathname === "/api/client/crm/disconnect"  && method === "POST") return apiCrmDisconnect(request, env);
  if (pathname === "/api/client/me"       && method === "GET")  return apiMe(request, env);
  if (pathname === "/api/client/me"       && method === "PATCH") return apiPatchMe(request, env);
  // Marketing-site auth probe. Always returns 200 (with body indicating
  // logged-in state) so the marketing pages don't pollute the visitor's
  // browser console with 401 errors on every page load.
  if (pathname === "/api/client/auth-probe" && method === "GET")     return apiAuthProbe(request, env);
  if (pathname === "/api/client/auth-probe" && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/metrics"  && method === "GET")  return apiMetrics(request, env);
  if (pathname === "/api/client/activity"   && method === "GET")  return apiActivity(request, env);
  if (pathname === "/api/client/clicks"          && method === "GET")  return apiClicks(request, env);
  if (pathname === "/api/client/recommendations" && method === "GET")  return apiRecommendations(request, env);
  if (pathname === "/api/client/profile"         && method === "GET")  return apiGetProfile(request, env);
  if (pathname === "/api/client/profile"         && method === "POST") return apiUpdateProfile(request, env);
  if (pathname === "/api/client/rotate-key" && method === "POST") return apiRotateKey(request, env);

  // Dashboards CRUD (Phase B of the dashboard redesign).
  // CORS preflight first — every cross-origin call from advocatemcp.com
  // (the static-site /app dashboard) sends an OPTIONS preflight that
  // must be answered with the proper Allow-* headers before the real
  // request is dispatched. credentials:true so the bearer cookie can
  // travel with the request.
  if (pathname === "/api/client/dashboards" && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/dashboards" && method === "GET")  return dashboardApi.listDashboards(request, env);
  if (pathname === "/api/client/dashboards" && method === "POST") return dashboardApi.postDashboard(request, env);
  const dashIdMatch = pathname.match(/^\/api\/client\/dashboards\/(\d+)$/);
  if (dashIdMatch && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (dashIdMatch && method === "GET")    return dashboardApi.getOneDashboard(request, env, dashIdMatch[1]);
  if (dashIdMatch && method === "PATCH")  return dashboardApi.patchDashboard(request, env, dashIdMatch[1]);
  if (dashIdMatch && method === "DELETE") return dashboardApi.deleteOneDashboard(request, env, dashIdMatch[1]);
  const dashPromoteMatch = pathname.match(/^\/api\/client\/dashboards\/(\d+)\/promote-default$/);
  if (dashPromoteMatch && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (dashPromoteMatch && method === "POST") return dashboardApi.promoteDashboard(request, env, dashPromoteMatch[1]);

  // Revenue attribution (Pro feature, Apr 27 2026). Three tenant-side
  // endpoints — read summary, set/clear AOV, generate-or-rotate the
  // webhook signing secret. Plus the public webhook receiver scoped by
  // slug below. All tenant-side endpoints require the portal session
  // cookie (handled by the Bearer/session auth helpers inside).
  if (pathname === "/api/client/revenue-summary"     && method === "GET")  return apiRevenueSummary(request, env);
  if (pathname === "/api/client/revenue-aov"          && method === "POST") return apiRevenueSetAov(request, env);
  if (pathname === "/api/client/revenue-webhook"      && method === "POST") return apiRevenueWebhookSecret(request, env);

  // Team accounts (Apr 27 2026 Enterprise honesty pass). Owner-only
  // mutating endpoints + a public token-consume endpoint for invitees
  // setting their password from the magic link.
  if (pathname === "/api/client/team"          && method === "GET")  return handleListTeam(request, env);
  if (pathname === "/api/client/team/invite"   && method === "POST") return handleInviteTeam(request, env);

  // Tenant self-serve "switch from hosted subdomain to a custom domain"
  // flow. Owner-only, authenticated. Triggered from the DNS Wizard's
  // hosted-notice panel ("Use your own domain →" button). See
  // clientSwitchDomain.ts for the full edge-case ladder.
  if (pathname === "/api/client/tenant/switch-domain" && method === "POST")    return handleClientSwitchDomain(request, env);
  if (pathname === "/api/client/tenant/switch-domain" && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  const teamRoleMatch = pathname.match(/^\/api\/client\/team\/([a-zA-Z0-9_-]+)\/role$/);
  if (teamRoleMatch && method === "PATCH")    return handleUpdateTeamRole(request, env, teamRoleMatch[1]);
  if (teamRoleMatch && method === "OPTIONS")  return handleCorsPreflight(request, { credentials: true });
  const teamMemberMatch = pathname.match(/^\/api\/client\/team\/([a-zA-Z0-9_-]+)$/);
  if (teamMemberMatch && method === "DELETE")  return handleRemoveTeam(request, env, teamMemberMatch[1]);
  if (teamMemberMatch && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  // Public team-accept consume endpoint. Hosted on customers.advocatemcp.com
  // because the magic-link email goes there; CORS allowed from same
  // origin (the team-accept.html page on customers.advocatemcp.com).
  if (pathname === "/auth/team-accept"         && method === "OPTIONS") return handleTeamAcceptPreflight(request);
  if (pathname === "/auth/team-accept"         && method === "POST")    return handleTeamAccept(request, env);

  // Multi-location CRUD (Pro/Enterprise feature, Apr 27 2026). Worker
  // is a thin proxy to Railway's /agents/:slug/locations endpoints.
  // We don't reimplement the plan-tier cap here — Railway is the source
  // of truth for plan + count.
  if (pathname === "/api/client/locations"            && method === "GET")    return apiLocationsList(request, env);
  if (pathname === "/api/client/locations"            && method === "POST")   return apiLocationsAdd(request, env);
  const locUpdMatch = pathname.match(/^\/api\/client\/locations\/([a-zA-Z0-9_]+)$/);
  if (locUpdMatch && method === "PATCH")    return apiLocationsUpdate(request, env, locUpdMatch[1]);
  if (locUpdMatch && method === "DELETE")   return apiLocationsDelete(request, env, locUpdMatch[1]);
  if (locUpdMatch && method === "OPTIONS")  return handleCorsPreflight(request, { credentials: true });
  const locPromoteMatch = pathname.match(/^\/api\/client\/locations\/([a-zA-Z0-9_]+)\/promote$/);
  if (locPromoteMatch && method === "POST")    return apiLocationsPromote(request, env, locPromoteMatch[1]);
  if (locPromoteMatch && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/radar"             && method === "GET")    return apiRadar(request, env);
  if (pathname === "/api/client/radar/share-of-voice" && method === "GET") return apiRadarShareOfVoice(request, env);
  const radarBasketDel = pathname.match(/^\/api\/client\/radar\/basket\/([^/]+)$/);
  if (pathname === "/api/client/radar/basket"      && method === "POST")   return apiRadarBasketAdd(request, env);
  if (radarBasketDel && method === "DELETE")                                return apiRadarBasketDelete(request, env, radarBasketDel[1]);
  // Off-site authority config (Phase 6 PR 2) — Pro-gated.
  if (pathname === "/api/client/authority/status"     && method === "GET")  return apiAuthorityStatus(request, env);
  if (pathname === "/api/client/authority/configure"  && method === "POST") return apiAuthorityConfigure(request, env);
  if (pathname === "/api/client/authority/disconnect" && method === "POST") return apiAuthorityDisconnect(request, env);
  if (pathname === "/api/client/domain-info"   && method === "GET")    return apiDomainInfo(request, env);
  if (pathname === "/api/client/onboarding"      && method === "GET")  return apiGetOnboarding(request, env);
  if (pathname === "/api/client/onboarding/step" && method === "POST") return apiMarkOnboardingStep(request, env);
  if (pathname === "/api/client/preview-voice"   && method === "POST") return apiPreviewVoice(request, env);
  if (pathname === "/api/client/profile-score"   && method === "GET")  return apiProfileScore(request, env);
  if (pathname === "/api/client/profile-score"   && method === "POST") return apiProfileScore(request, env);
  if (pathname === "/api/client/ai-recommendations" && method === "GET")  return apiAIRecommendations(request, env);
  if (pathname === "/api/client/ai-recommendations" && method === "POST") return apiAIRecommendations(request, env);
  if (pathname === "/admin/cache/bump-version"     && method === "POST") return apiBumpCacheVersion(request, env);
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
  if (pathname === "/admin/onboard/rotate-railway-key"     && method === "POST") return handleRotateRailwayKey(request, env);
  if (pathname === "/status"                   && method === "GET")  return statusPage(request, env);
  if (pathname === "/onboard"                  && method === "GET")  return handleOnboardPage(request, env);
  if (pathname === "/onboard-dns"              && method === "GET")  return serveOnboardDnsPage(request, env);

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
  if (pathname === "/api/client/ga4/status"          && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/ga4/start-link"      && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/ga4/properties"      && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/ga4/select-property" && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/ga4/resync"          && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/ga4/disconnect"      && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/gsc/status"      && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/gsc/start-link"  && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/gsc/disconnect"  && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/gsc/sites"       && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/gsc/select-site" && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/gsc/resync"      && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/traffic-impact"               && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/traffic-impact/geography"    && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/traffic-impact/conversions"  && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/traffic-impact/gsc"          && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/all-metrics" && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/all-metrics" && method === "GET")     return apiAllMetrics(request, env);
  if (pathname === "/api/client/activity-detail" && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/activity-detail" && method === "GET")     return apiActivityDetail(request, env);
  if (pathname === "/api/client/activity"    && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/clicks"          && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/recommendations" && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/profile"         && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/rotate-key"  && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/radar"             && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/radar/share-of-voice" && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/radar/basket"      && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (radarBasketDel && method === "OPTIONS")                                return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/authority/status"     && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/authority/configure"  && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/authority/disconnect" && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/traffic-impact/authority" && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/domain-info"   && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/onboarding"      && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/onboarding/step" && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/preview-voice"   && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/profile-score"   && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/ai-recommendations" && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/verify-rating"   && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  // Missing OPTIONS preflights — without these, browser preflight hits the
  // worker's catch-all path which returns Access-Control-Allow-Origin:*,
  // and credentialed fetches from the dashboard fail CORS. Discovered
  // May 7 2026 via 4 red errors in the dashboard console for revenue-
  // summary + locations. Adding all 9 missing endpoints in one pass.
  if (pathname === "/api/client/revenue-summary" && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/revenue-aov"     && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/revenue-webhook" && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/locations"       && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/team"            && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/team/invite"     && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/crm/status"      && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/crm/start-link"  && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
  if (pathname === "/api/client/crm/disconnect"  && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });

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

// ── requireVerifiedSession ─────────────────────────────────────────────────

/**
 * Wraps getSessionFromRequest with an email_verified=1 gate. Returns the
 * AuthContext if all good, or a pre-built 401/403 response if not. Use
 * this on every dashboard and /api/client/* handler. Auth, activation,
 * and team-accept routes do NOT use this — those flows are how the user
 * becomes verified, so gating them would be a chicken-and-egg.
 */
async function requireVerifiedSession(
  request: Request,
  env: Env,
): Promise<{ ok: true; ctx: AuthContext } | { ok: false; resp: Response }> {
  const ctx = await getSessionFromRequest(request, env);
  if (!ctx) {
    return {
      ok: false,
      resp: withCors(
        new Response(
          JSON.stringify({ ok: false, error_code: "no_session" }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        ),
        request,
        { credentials: true },
      ),
    };
  }
  if (ctx.email_verified !== 1) {
    return {
      ok: false,
      resp: withCors(
        new Response(
          JSON.stringify({
            ok: false,
            error_code: "email_unverified",
            customer_message: "Please confirm your email — check your inbox for the activation link.",
          }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        ),
        request,
        { credentials: true },
      ),
    };
  }
  return { ok: true, ctx };
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

  // AMC-007: Use the rehash-aware verifier so legacy 100k-iteration
  // hashes get transparently upgraded to TARGET_ITERATIONS on the next
  // login. The user-visible behavior is unchanged.
  const verify = await verifyAndMaybeRehash(password, user.salt, user.password_hash);
  if (!verify.ok) {
    await recordLoginAttempt(env.DB, identifier);
    return redirect("/login?error=invalid");
  }
  if (verify.needsRehash && verify.rehashedEncoded) {
    // Best-effort upgrade. If the UPDATE fails the login still succeeds
    // (we already verified) and the next login will retry.
    try {
      // Salt column becomes irrelevant once the encoded format is
      // stored — parseStoredHash detects the prefix and ignores the
      // salt column. We pass empty string to avoid leaving a stale
      // salt visible in the DB.
      await updateUserPassword(env.DB, user.id, verify.rehashedEncoded, "");
    } catch (err) {
      console.warn(JSON.stringify({
        auth: true, event: "pbkdf2_rehash_failed", user_id: user.id, error: String(err),
      }));
    }
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

  // Phase B: hydrate the user's dashboards list for the active business.
  // Auto-seeds the Default dashboard on first call so a brand-new user
  // never lands on an empty sidebar. Failures are non-fatal — the
  // dashboard still renders without the multi-dashboard sidebar.
  let dashboards: import("../portalDb").Dashboard[] = [];
  let activeDashboardId: number | null = null;
  if (selected) {
    try {
      const seeded = await getOrSeedDefaultDashboard(env.DB, ctx.user_id, selected.id);
      activeDashboardId = seeded.id;
      const dashboardIdQS = new URL(request.url).searchParams.get("dashboardId");
      if (dashboardIdQS) {
        const n = Number.parseInt(dashboardIdQS, 10);
        if (Number.isFinite(n)) activeDashboardId = n;
      }
      dashboards = await getDashboards(env.DB, ctx.user_id, selected.id);
    } catch (err) {
      console.warn("[dashboard] failed to load dashboards list:", err);
    }
  }

  // Synthesize a minimal User object for buildDashboard. buildDashboard
  // (see worker/src/routes/dashboard.ts) only reads user.full_name and
  // user.email from this parameter — verified via grep during Phase C
  // Commit 5 implementation. The other User fields (password_hash, salt,
  // created_at, updated_at) are provided as empty strings to satisfy the
  // User interface without doing an extra getUserById D1 query.
  const userForDashboard: User = {
    id:             ctx.user_id,
    email:          ctx.email,
    password_hash:  "",
    salt:           "",
    full_name:      ctx.full_name,
    role:           ctx.role,
    email_verified: ctx.email_verified,
    created_at:     "",
    updated_at:     "",
  };
  return html(buildDashboard(
    userForDashboard,
    businesses,
    selected,
    analytics,
    { dashboards, activeDashboardId },
  ));
}

// ── GET /api/client/me ─────────────────────────────────────────────────────

async function apiMe(request: Request, env: Env): Promise<Response> {
  const guard = await requireVerifiedSession(request, env);
  if (!guard.ok) return guard.resp;
  const ctx = guard.ctx;

  // Compute dns_configured on every request (not in the token) — the value
  // can change without re-login (e.g. user wires DNS after logging in).
  let dns_configured = false;
  let apiMeDomain: string | null = null;
  let apiMeIsHosted = false;
  // Surfaced for the sidebar's business-switcher dropdown so the user can
  // jump between tenants they have access to without leaving the dashboard.
  // Admin can impersonate any tenant via /admin/tenants — the dropdown
  // only shows the user's own access list to keep the menu short.
  let accessible_businesses: Array<{ slug: string; name: string; domain: string | null; plan: string | null }> = [];
  try {
    const businesses = await getUserBusinesses(env.DB, ctx.user_id);
    accessible_businesses = businesses.map((b) => ({
      slug:   b.slug,
      name:   b.business_name,
      domain: b.domain ?? null,
      plan:   (b as { plan?: string }).plan ?? null,
    }));
    if (businesses.length > 0) {
      const biz = businesses[0];
      apiMeDomain = biz.domain ?? null;
      apiMeIsHosted = !!(biz.domain && biz.domain.endsWith('.hosted.advocatemcp.com'));
      // Hosted tenants (domains under our wildcard *.hosted.advocatemcp.com)
      // don't have per-tenant DNS setup — the wildcard route handles them.
      // Treat as automatically configured.
      if (biz.domain && biz.domain.endsWith('.hosted.advocatemcp.com')) {
        dns_configured = true;
      } else {
        // Custom-domain tenants: query cf_hostname_id + onboarding_state to
        // check whether the customer's CNAME is verified.
        // cf_hostname_id is not on the Business interface (added by migration
        // 0002 after the type was frozen), so we query it separately.
        const row = await env.DB
          .prepare("SELECT cf_hostname_id, onboarding_state FROM businesses WHERE id = ? LIMIT 1")
          .bind(biz.id)
          .first<{ cf_hostname_id: string | null; onboarding_state: string | null }>();
        if (row?.cf_hostname_id) {
          // CF SaaS hostname exists — check the checklist completion flag.
          try {
            const state = row.onboarding_state ? JSON.parse(row.onboarding_state) : null;
            dns_configured = !!(state?.checklist?.dns_configured?.completed_at);
          } catch {
            // Malformed JSON — fail closed (dns_configured stays false).
          }
        }
      }
    }
  } catch {
    // DB hiccup — fail closed so the DNS gate shows rather than being skipped.
    dns_configured = false;
  }

  return withCors(
    jsonOk({ id: ctx.user_id, email: ctx.email, full_name: ctx.full_name, role: ctx.role, dns_configured, domain: apiMeDomain, is_hosted: apiMeIsHosted, accessible_businesses }),
    request,
    { credentials: true },
  );
}

// ── GET /api/client/auth-probe ─────────────────────────────────────────────
//
// Marketing-site nav swap probe. Returns 200 in every case so a logged-out
// visitor's DevTools console doesn't show a red 401 on every marketing page
// load. (`/api/client/me` is the dashboard's own /me endpoint and DOES return
// 401 when there's no session — needed there because the dashboard relies on
// 401 to redirect to login. This endpoint exists so the marketing site can
// probe auth state without polluting the console.)
//
// Body shape:
//   { authenticated: false }                                  ← logged out
//   { authenticated: true, user: { id, email, full_name } }   ← logged in
//
// We deliberately return only the minimum identity needed to render the
// avatar dropdown — full /me payload (accessible_businesses, dns_configured,
// etc.) stays gated behind the real /api/client/me endpoint.

async function apiAuthProbe(request: Request, env: Env): Promise<Response> {
  const guard = await requireVerifiedSession(request, env);
  if (!guard.ok) {
    return withCors(
      jsonOk({ authenticated: false }),
      request,
      { credentials: true },
    );
  }
  const ctx = guard.ctx;
  return withCors(
    jsonOk({
      authenticated: true,
      user: { id: ctx.user_id, email: ctx.email, full_name: ctx.full_name },
    }),
    request,
    { credentials: true },
  );
}

// ── PATCH /api/client/me ───────────────────────────────────────────────────

async function apiPatchMe(request: Request, env: Env): Promise<Response> {
  const guard = await requireVerifiedSession(request, env);
  if (!guard.ok) return guard.resp;
  const ctx = guard.ctx;

  let body: { full_name?: unknown };
  try {
    body = await request.json();
  } catch {
    return withCors(jsonErr(400, "Invalid JSON"), request, { credentials: true });
  }

  const fullName = typeof body.full_name === "string" ? body.full_name.trim() : "";
  if (!fullName || fullName.length > 100) {
    return withCors(jsonErr(400, "full_name must be 1-100 characters"), request, { credentials: true });
  }

  try {
    await env.DB
      .prepare("UPDATE users SET full_name = ?, updated_at = ? WHERE id = ?")
      .bind(fullName, new Date().toISOString(), ctx.user_id)
      .run();
  } catch (err) {
    return withCors(jsonErr(500, "Database error"), request, { credentials: true });
  }

  return withCors(
    jsonOk({ id: ctx.user_id, email: ctx.email, full_name: fullName, role: ctx.role }),
    request,
    { credentials: true },
  );
}

// ── GET /api/client/metrics ────────────────────────────────────────────────

async function apiMetrics(request: Request, env: Env): Promise<Response> {
  const guard = await requireVerifiedSession(request, env);
  if (!guard.ok) return guard.resp;
  const ctx = guard.ctx;

  const businesses = ctx.role === "admin"
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const reqUrl = new URL(request.url);
  const slug = reqUrl.searchParams.get("slug");
  const biz  = (slug ? businesses.find((b) => b.slug === slug) : null) ?? businesses[0] ?? null;
  if (!biz) return withCors(jsonErr(404, "No business found for this account"), request, { credentials: true });

  // Forward the date-range filter to the server-side analytics endpoint.
  // The static-site Overview reads ?range= from its URL and passes it on
  // every /api/client/metrics call so charts re-fetch on filter change.
  const rangeQS = (() => {
    const r  = reqUrl.searchParams.get("range");
    const s  = reqUrl.searchParams.get("start_date");
    const e  = reqUrl.searchParams.get("end_date");
    if (s && e) return `start_date=${encodeURIComponent(s)}&end_date=${encodeURIComponent(e)}`;
    if (r)      return `range=${encodeURIComponent(r)}`;
    return undefined;
  })();
  const analytics = await fetchAnalytics(biz, env, rangeQS);
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
    // Surface the plan column (written by the Stripe webhook on
    // checkout.session.completed) so the dashboard sidebar + AI Insights
    // upgrade gate read from the canonical source. Without this, the
    // frontend's `m.plan || 'free'` fallback would show every tenant as
    // free regardless of the D1 row's actual plan. Mirrors apiAllMetrics.
    plan: biz.plan ?? "base",
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
  const guard = await requireVerifiedSession(request, env);
  if (!guard.ok) return guard.resp;
  const ctx = guard.ctx;
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
  const guard = await requireVerifiedSession(request, env);
  if (!guard.ok) return guard.resp;
  const ctx = guard.ctx;

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
            headers: env.API_KEY ? { "X-API-Key": env.API_KEY } : {},
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

  // Forward the date-range filter to /analytics/:slug/activity. Same shape
  // as apiMetrics — start_date+end_date wins over range; both fall through
  // to the server's 30d default when absent.
  const rangeQS = (() => {
    const r = url.searchParams.get("range");
    const s = url.searchParams.get("start_date");
    const e = url.searchParams.get("end_date");
    if (s && e) return `?start_date=${encodeURIComponent(s)}&end_date=${encodeURIComponent(e)}`;
    if (r)      return `?range=${encodeURIComponent(r)}`;
    return "";
  })();

  const base = env.API_BASE_URL ?? "https://advocate-production-2887.up.railway.app";
  try {
    const res = await fetch(`${base}/analytics/${biz.slug}/activity${rangeQS}`, {
      headers: env.API_KEY ? { "X-API-Key": env.API_KEY } : {},
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
  const guard = await requireVerifiedSession(request, env);
  if (!guard.ok) return guard.resp;
  const ctx = guard.ctx;

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
  const guard = await requireVerifiedSession(request, env);
  if (!guard.ok) return guard.resp;
  const ctx = guard.ctx;

  const businesses = ctx.role === "admin"
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const url  = new URL(request.url);
  const slug = url.searchParams.get("slug");
  const biz  = (slug ? businesses.find((b) => b.slug === slug) : null) ?? businesses[0] ?? null;
  if (!biz) return withCors(jsonErr(404, "No business found for this account"), request, { credentials: true });

  // Forward the global date-range filter to /analytics/:slug/clicks. Same
  // shape as apiMetrics + apiActivityDetail — start_date+end_date wins
  // over range; both fall through to the server's 30d default when absent.
  const rangeQS = (() => {
    const r = url.searchParams.get("range");
    const s = url.searchParams.get("start_date");
    const e = url.searchParams.get("end_date");
    if (s && e) return `?start_date=${encodeURIComponent(s)}&end_date=${encodeURIComponent(e)}`;
    if (r)      return `?range=${encodeURIComponent(r)}`;
    return "";
  })();

  const base = env.API_BASE_URL ?? "https://advocate-production-2887.up.railway.app";
  try {
    const res = await fetch(`${base}/analytics/${biz.slug}/clicks${rangeQS}`, {
      headers: env.API_KEY ? { "X-API-Key": env.API_KEY } : {},
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
      headers: env.API_KEY ? { "X-API-Key": env.API_KEY } : {},
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
  const guard = await requireVerifiedSession(request, env);
  if (!guard.ok) return guard.resp;
  const ctx = guard.ctx;

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
  const guard = await requireVerifiedSession(request, env);
  if (!guard.ok) return guard.resp;
  const ctx = guard.ctx;

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
  const guard = await requireVerifiedSession(request, env);
  if (!guard.ok) return guard.resp;
  const ctx = guard.ctx;

  const businesses = ctx.role === "admin"
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const slugQuery = new URL(request.url).searchParams.get("slug");
  const biz = (slugQuery ? businesses.find((b) => b.slug === slugQuery) : null) ?? businesses[0] ?? null;
  if (!biz) return withCors(jsonErr(404, "No business found for this account"), request, { credentials: true });

  // Source-of-truth fix (Apr 27 2026 audit):
  //
  // Reservations live on Railway, not in worker D1, so the previous
  // local-D1 compute returned 0 confirmed bookings for every tenant —
  // estimated revenue silently displayed $0 forever. Even worse, when
  // the customer's booking system POSTed verified events, the worker
  // wrote them to D1 but Railway's monthly review cron read its own
  // (empty) revenue_events table, so the monthly email also showed
  // zero verified revenue.
  //
  // Fix: route this through Railway's authoritative endpoint, which
  // uses computeRevenueWindow() from server/src/lib/revenue.ts. That's
  // the same function the monthly review email uses, so the dashboard
  // and the email show identical numbers byte-for-byte. The Railway
  // hop adds ~50-100ms to dashboard load — acceptable for the data
  // correctness we get back.
  //
  // Also enforces the Pro/Enterprise plan gate server-side: Railway
  // returns 402 for base-tier tenants, which we surface unchanged so
  // the dashboard hides the revenue card.
  //
  // Per-location filter (Apr 27 2026 Section 2): forward ?location_id
  // through to Railway. Railway validates ownership against the
  // locations table; an attacker can't read another tenant's revenue
  // by forging an id.
  const base = (env as { API_BASE_URL?: string }).API_BASE_URL ?? "https://advocate-production-2887.up.railway.app";
  const incomingLocId = new URL(request.url).searchParams.get("location_id");
  const locQuery = incomingLocId ? `?location_id=${encodeURIComponent(incomingLocId)}` : "";
  const url = `${base}/agents/${encodeURIComponent(biz.slug)}/revenue-summary${locQuery}`;
  const upstream = await fetch(url, {
    headers: env.API_KEY ? { "X-API-Key": env.API_KEY } : {},
  });
  const upstreamBody = await upstream.text();

  // Pull the webhook_configured flag from D1 separately — Railway doesn't
  // know whether a webhook secret has been generated (that lives only
  // on the worker side). Settings UI uses this to flip the "Generate"
  // button label to "Rotate".
  let webhookConfigured = false;
  try {
    const row = await env.DB
      .prepare("SELECT revenue_webhook_secret FROM businesses WHERE slug = ?")
      .bind(biz.slug)
      .first<{ revenue_webhook_secret: string | null }>();
    webhookConfigured = !!row?.revenue_webhook_secret;
  } catch {
    // Non-fatal — D1 hiccup just means the UI stays on "Generate".
  }

  if (!upstream.ok) {
    return withCors(
      new Response(upstreamBody, { status: upstream.status, headers: { "Content-Type": "application/json" } }),
      request,
      { credentials: true },
    );
  }

  // Splice webhook_configured into Railway's response. Railway returns
  // { source, amount_cents, event_count, currency, aov_cents,
  //   window_start, window_end }; we add webhook_configured for the UI.
  let merged: Record<string, unknown>;
  try {
    merged = { ...JSON.parse(upstreamBody), webhook_configured: webhookConfigured };
  } catch {
    return withCors(
      jsonErr(502, "upstream_parse_error: Could not parse Railway revenue summary"),
      request,
      { credentials: true },
    );
  }

  return withCors(jsonOk(merged), request, { credentials: true });

  // ── Legacy local compute (DELETED) ─────────────────────────────────
  // The block below is unreachable; left commented during the audit
  // fix to make the diff readable. Will be removed in a follow-up
  // pass once the Railway endpoint is verified live.
  /*
  */
}

async function apiRevenueSetAov(request: Request, env: Env): Promise<Response> {
  const guard = await requireVerifiedSession(request, env);
  if (!guard.ok) return guard.resp;
  const ctx = guard.ctx;

  const businesses = ctx.role === "admin"
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const slugQuery = new URL(request.url).searchParams.get("slug");
  const biz = (slugQuery ? businesses.find((b) => b.slug === slugQuery) : null) ?? businesses[0] ?? null;
  if (!biz) return withCors(jsonErr(404, "No business found for this account"), request, { credentials: true });

  // Plan gate (audit fix Apr 27 2026) — revenue attribution is a Pro
  // feature per the pricing page. Base tenants who somehow hit this
  // endpoint shouldn't be able to set an AOV that the dashboard would
  // then refuse to display anyway — surface the upgrade message here
  // rather than silently accept the write.
  const planRow = await env.DB
    .prepare("SELECT plan FROM businesses WHERE slug = ?")
    .bind(biz.slug)
    .first<{ plan: string | null }>();
  const plan = planRow?.plan ?? "base";
  if (plan !== "pro" && plan !== "enterprise") {
    return withCors(
      jsonErr(402, "plan_required"),
      request,
      { credentials: true },
    );
  }

  let body: { avg_booking_value_cents?: unknown; revenue_currency?: unknown };
  try { body = await request.json(); }
  catch { return withCors(jsonErr(400, "Body must be JSON"), request, { credentials: true }); }

  // null / 0 / undefined all clear the AOV (returning the tenant to the
  // unconfigured state). Otherwise must be a positive integer ≤ 5M cents
  // ($50k) — lowered from $100k after the audit flagged that a high-
  // volume tenant with $99k AOV could display absurd revenue numbers
  // ($99M+ on a 1k-booking month). $50k still covers high-end services
  // (luxury catering, weddings, dental implants) without inviting abuse.
  let aovCents: number | null = null;
  if (body.avg_booking_value_cents !== null && body.avg_booking_value_cents !== undefined && body.avg_booking_value_cents !== 0) {
    if (typeof body.avg_booking_value_cents !== "number" || !Number.isInteger(body.avg_booking_value_cents)) {
      return withCors(jsonErr(400, "avg_booking_value_cents must be an integer"), request, { credentials: true });
    }
    if (body.avg_booking_value_cents < 0 || body.avg_booking_value_cents > 5_000_000) {
      return withCors(jsonErr(400, "avg_booking_value_cents must be between 0 and 5_000_000 (max $50k per booking)"), request, { credentials: true });
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
  const guard = await requireVerifiedSession(request, env);
  if (!guard.ok) return guard.resp;
  const ctx = guard.ctx;

  const businesses = ctx.role === "admin"
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const slugQuery = new URL(request.url).searchParams.get("slug");
  const biz = (slugQuery ? businesses.find((b) => b.slug === slugQuery) : null) ?? businesses[0] ?? null;
  if (!biz) return withCors(jsonErr(404, "No business found for this account"), request, { credentials: true });

  // Plan gate — same as set-AOV. Don't generate a secret for a tenant
  // who can't actually use the verified-revenue feature.
  const planRow = await env.DB
    .prepare("SELECT plan FROM businesses WHERE slug = ?")
    .bind(biz.slug)
    .first<{ plan: string | null }>();
  const plan = planRow?.plan ?? "base";
  if (plan !== "pro" && plan !== "enterprise") {
    return withCors(jsonErr(402, "plan_required"), request, { credentials: true });
  }

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
  const guard = await requireVerifiedSession(request, env);
  if (!guard.ok) return { error: guard.resp };
  const ctx = guard.ctx;
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
  const guard = await requireVerifiedSession(request, env);
  if (!guard.ok) return guard.resp;
  const ctx = guard.ctx;

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
        ...(env.API_KEY ? { "X-API-Key": env.API_KEY } : {}),
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
  const guard = await requireVerifiedSession(request, env);
  if (!guard.ok) return guard.resp;
  const ctx = guard.ctx;

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
        headers: env.API_KEY ? { "X-API-Key": env.API_KEY } : {},
      }),
      fetch(`${base}/api/competitor-basket/${biz.slug}`, {
        headers: env.API_KEY ? { "X-API-Key": env.API_KEY } : {},
      }),
      fetch(`${base}/api/competitor-radar/${biz.slug}/losses`, {
        headers: env.API_KEY ? { "X-API-Key": env.API_KEY } : {},
      }),
      fetch(`${base}/api/competitor-radar/${biz.slug}/authority-report`, {
        headers: env.API_KEY ? { "X-API-Key": env.API_KEY } : {},
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

// ── GET /api/client/radar/share-of-voice ──────────────────────────────────
// Proxy to Railway's /api/competitor-radar/:slug/share-of-voice/weekly so
// the dashboard's weekly-trend chart can fetch behind a session-auth path
// (with proper credentialed CORS headers) instead of hitting the Railway
// path directly — that path isn't routed by the worker, so credentialed
// fetches to it get rejected by the catch-all's wildcard ACAO.
// Lazy-loaded by v2/radar.js after the page first renders so the heavier
// time-series chart doesn't block the KPI strip.

async function apiRadarShareOfVoice(request: Request, env: Env): Promise<Response> {
  const guard = await requireVerifiedSession(request, env);
  if (!guard.ok) return guard.resp;
  const ctx = guard.ctx;

  const businesses = ctx.role === "admin"
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const reqUrl = new URL(request.url);
  const slug = reqUrl.searchParams.get("slug");
  const biz  = (slug ? businesses.find((b) => b.slug === slug) : null) ?? businesses[0] ?? null;
  if (!biz) return withCors(jsonErr(404, "No business found for this account"), request, { credentials: true });

  // Forward `weeks` query param if present; default to 12 (matches the
  // chart's render assumption + the original frontend call signature).
  const weeks = reqUrl.searchParams.get("weeks") ?? "12";
  const base  = env.API_BASE_URL ?? "https://advocate-production-2887.up.railway.app";
  const url   = `${base}/api/competitor-radar/${encodeURIComponent(biz.slug)}/share-of-voice/weekly?weeks=${encodeURIComponent(weeks)}`;

  try {
    const upstream = await fetch(url, { headers: env.API_KEY ? { "X-API-Key": env.API_KEY } : {} });
    const body     = await upstream.text();
    if (!upstream.ok) {
      // Pass through upstream status so 402 plan-gates surface to the
      // dashboard's locked-view branch.
      return withCors(
        new Response(body, { status: upstream.status, headers: { "Content-Type": "application/json" } }),
        request,
        { credentials: true },
      );
    }
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch {
      return withCors(jsonErr(502, "upstream_parse_error: share-of-voice"), request, { credentials: true });
    }
    return withCors(jsonOk(parsed as Record<string, unknown>), request, { credentials: true });
  } catch (err) {
    return withCors(jsonErr(502, `Backend unreachable: ${String(err)}`), request, { credentials: true });
  }
}

// ── POST /api/client/radar/basket ─────────────────────────────────────────
// Add a query phrasing to the tenant's radar basket. Body: { query_phrasing }.

async function apiRadarBasketAdd(request: Request, env: Env): Promise<Response> {
  const guard = await requireVerifiedSession(request, env);
  if (!guard.ok) return guard.resp;
  const ctx = guard.ctx;

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
        ...(env.API_KEY ? { "X-API-Key": env.API_KEY } : {}),
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
  const guard = await requireVerifiedSession(request, env);
  if (!guard.ok) return guard.resp;
  const ctx = guard.ctx;

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
      headers: env.API_KEY ? { "X-API-Key": env.API_KEY } : {},
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
// Proxies to Railway's POST /admin/probe-domain for DNS + live-request
// signals (only Railway can reach arbitrary origins without CF loop
// protection). Overlays three CF-API-derived signals that only the Worker
// can fetch because the scoped CF_API_TOKEN lives here, not on Railway.

// ── Domain status cache ────────────────────────────────────────────────────
// 30s TTL absorbs the wizard's 10s polling cadence without hammering Railway.

// NOTE: Signal / DomainStatus must stay structurally in sync with
// server/src/routes/admin/probeDomain.ts — the Worker casts the Railway
// response directly to DomainStatus, so a server-side rename will silently
// break this contract until something at runtime explodes.
type SignalState = "ok" | "err" | "waiting";
type Signal<D = unknown> = { state: SignalState; message: string; detail?: D };

type DomainStatus = {
  domain: string;
  slug: string;
  checked_at: string;
  signals: {
    dns:           Signal<{ resolved_target?: string; expected_target?: string }>;
    cf_hostname:   Signal<{ cf_status?: string; ownership_verified?: boolean | null; ssl_status?: string }>;
    cf_ssl:        Signal<{ cf_ssl_status?: string }>;
    worker_route:  Signal<{ pattern_expected?: string }>;
    live_request:  Signal<{ status_code?: number; latency_ms?: number; marker_present?: boolean; error?: string }>;
  };
  all_green: boolean;
  // Optional: set true when the worker short-circuits the probe for hosted
  // tenants (subdomains under *.hosted.advocatemcp.com). Lets the frontend
  // render the hosted-friendly card instead of regex-matching the hostname.
  is_hosted?: boolean;
};

const DOMAIN_STATUS_CACHE = new Map<string, { value: DomainStatus; expires_at: number }>();
const DOMAIN_STATUS_CACHE_TTL_MS = 30_000;

function readDomainStatusCache(slug: string): DomainStatus | null {
  const hit = DOMAIN_STATUS_CACHE.get(slug);
  if (!hit) return null;
  if (Date.now() > hit.expires_at) {
    DOMAIN_STATUS_CACHE.delete(slug);
    return null;
  }
  return hit.value;
}

function writeDomainStatusCache(slug: string, value: DomainStatus): void {
  DOMAIN_STATUS_CACHE.set(slug, { value, expires_at: Date.now() + DOMAIN_STATUS_CACHE_TTL_MS });
}

// ── Cloudflare-derived signals (Worker-only — needs CF API token scopes) ──

async function fetchCfHostnameSignal(env: Env, slug: string): Promise<Signal<{
  cf_status?: string; ownership_verified?: boolean | null; ssl_status?: string;
}>> {
  let row: { cf_hostname_id: string | null } | null;
  try {
    row = await env.DB
      .prepare("SELECT cf_hostname_id FROM businesses WHERE slug = ? LIMIT 1")
      .bind(slug)
      .first<{ cf_hostname_id: string | null }>();
  } catch {
    return { state: "err", message: "Database read failed.", detail: {} };
  }

  if (!row?.cf_hostname_id) {
    return { state: "waiting", message: "Cloudflare hostname not yet created.", detail: {} };
  }
  if (!env.CF_API_TOKEN || !env.CF_ZONE_ID) {
    return { state: "err", message: "Server not configured for Cloudflare API access.", detail: {} };
  }

  const { ok, data } = await cfRequest(env, "GET", `/${row.cf_hostname_id}`);
  if (!ok) {
    return { state: "err", message: "Cloudflare API call failed.", detail: {} };
  }
  // CF API returns a loose shape; narrow at access sites.
  const result = (data as { result?: Record<string, unknown> }).result;
  const ssl = result?.ssl as Record<string, unknown> | undefined;
  const cfStatus = (result?.status as string) ?? "unknown";
  const sslStatus = (ssl?.status as string) ?? "unknown";
  const ownershipStatus = result?.ownership_verification_status as string | undefined;

  const detail = {
    cf_status: cfStatus,
    ownership_verified: ownershipStatus === "success",
    ssl_status: sslStatus,
  };

  if (cfStatus === "active") {
    return { state: "ok", message: "Cloudflare has activated your domain.", detail };
  }
  if (cfStatus === "pending_validation" || cfStatus === "pending") {
    return {
      state: "waiting",
      message: "Cloudflare is validating your domain — usually 2–10 minutes.",
      detail,
    };
  }
  return {
    state: "err",
    message: `Cloudflare hostname status: ${cfStatus}. Check that your TXT record matches what we sent you.`,
    detail,
  };
}

function deriveSslSignal(cfSignal: Signal<{ ssl_status?: string }>): Signal<{ cf_ssl_status?: string }> {
  const sslStatus = cfSignal.detail?.ssl_status ?? "unknown";
  if (sslStatus === "active") {
    return { state: "ok", message: "SSL certificate is issued.", detail: { cf_ssl_status: sslStatus } };
  }
  if (sslStatus === "pending_validation" || sslStatus === "pending_deployment" || sslStatus === "initializing") {
    return {
      state: "waiting",
      message: "SSL certificate is being issued — usually 2–10 minutes.",
      detail: { cf_ssl_status: sslStatus },
    };
  }
  return {
    state: "err",
    message: `SSL status: ${sslStatus}. May need a TXT record correction.`,
    detail: { cf_ssl_status: sslStatus },
  };
}

async function fetchWorkerRouteSignal(env: Env, domain: string): Promise<Signal<{ pattern_expected: string }>> {
  const pattern = `${domain}/*`;
  if (!env.CF_API_TOKEN || !env.CF_ZONE_ID) {
    return {
      state: "err",
      message: "Server not configured for Cloudflare API access.",
      detail: { pattern_expected: pattern },
    };
  }
  try {
    const r = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/workers/routes`,
      { headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` }, signal: AbortSignal.timeout(5_000) },
    );
    if (!r.ok) {
      return {
        state: "err",
        message: `Cloudflare routes API returned HTTP ${r.status}.`,
        detail: { pattern_expected: pattern },
      };
    }
    const data = (await r.json()) as { result?: Array<{ pattern: string }> };
    const exact = data.result?.find((rt) => rt.pattern === pattern);
    if (exact) {
      return { state: "ok", message: "Crawler route is active.", detail: { pattern_expected: pattern } };
    }
    const wildcard = data.result?.find((rt) => {
      if (!rt.pattern.startsWith("*.")) return false;
      const parent = rt.pattern.replace(/^\*\./, "").replace(/\/\*$/, "");
      return domain.endsWith(`.${parent}`);
    });
    if (wildcard) {
      return {
        state: "ok",
        message: `Crawler route is active (covered by wildcard ${wildcard.pattern}).`,
        detail: { pattern_expected: pattern },
      };
    }
    return {
      state: "waiting",
      message: "Crawler route hasn't been wired up on our side yet — we'll provision it automatically.",
      detail: { pattern_expected: pattern },
    };
  } catch (err) {
    return {
      state: "err",
      message: `Cloudflare routes API call failed: ${err instanceof Error ? err.message : String(err)}.`,
      detail: { pattern_expected: pattern },
    };
  }
}

async function apiDomainInfo(request: Request, env: Env): Promise<Response> {
  const guard = await requireVerifiedSession(request, env);
  if (!guard.ok) return guard.resp;
  const ctx = guard.ctx;

  const businesses = ctx.role === "admin"
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const slug = new URL(request.url).searchParams.get("slug");
  const biz  = (slug ? businesses.find((b) => b.slug === slug) : null) ?? businesses[0] ?? null;
  if (!biz) return withCors(jsonErr(404, "No business found for this account"), request, { credentials: true });
  if (!biz.domain) {
    return withCors(jsonErr(400, "No domain registered for this business"), request, { credentials: true });
  }

  // Hosted tenants live at <slug>.hosted.advocatemcp.com — fully provisioned at
  // signup, no DNS for the customer to configure. Short-circuit the probe and
  // return a synthetic "all green" status. The probe service can't meaningfully
  // verify our own subdomain (we own the zone), and forwarding the call would
  // return 502s that the frontend surfaces as "Couldn't check. Try again in a
  // moment." Detection mirrors the rest of portal.ts (hostname-suffix match).
  if (biz.domain.endsWith(".hosted.advocatemcp.com")) {
    const hostedStatus: DomainStatus = {
      domain: biz.domain,
      slug: biz.slug,
      checked_at: new Date().toISOString(),
      signals: {
        dns:          { state: "ok", message: "Hosted subdomain active." },
        cf_hostname:  { state: "ok", message: "Cloudflare hostname active." },
        cf_ssl:       { state: "ok", message: "SSL certificate active." },
        worker_route: { state: "ok", message: "Worker route configured." },
        live_request: { state: "ok", message: "Live and serving." },
      },
      all_green: true,
      is_hosted: true,
    };
    writeDomainStatusCache(biz.slug, hostedStatus);
    return withCors(jsonOk(hostedStatus), request, { credentials: true });
  }

  const cached = readDomainStatusCache(biz.slug);
  if (cached) {
    return withCors(jsonOk(cached), request, { credentials: true });
  }

  const railwayBase = env.API_BASE_URL ?? "https://advocate-production-2887.up.railway.app";
  let railwayStatus: DomainStatus;
  try {
    const r = await fetch(`${railwayBase}/admin/probe-domain`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(env.ADMIN_API_KEY ? { "X-Admin-Key": env.ADMIN_API_KEY, "Authorization": `Bearer ${env.ADMIN_API_KEY}` } : {}),
      },
      body: JSON.stringify({ domain: biz.domain, slug: biz.slug }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!r.ok) {
      return withCors(jsonErr(502, `Probe service returned HTTP ${r.status}`), request, { credentials: true });
    }
    railwayStatus = (await r.json()) as DomainStatus;
  } catch (err) {
    return withCors(
      jsonErr(502, `Probe service unreachable: ${err instanceof Error ? err.message : String(err)}`),
      request,
      { credentials: true },
    );
  }

  const cfHostnameSignal = await fetchCfHostnameSignal(env, biz.slug);
  const cfSslSignal      = deriveSslSignal(cfHostnameSignal);
  const workerRouteSignal = await fetchWorkerRouteSignal(env, biz.domain);

  railwayStatus.signals.cf_hostname  = cfHostnameSignal;
  railwayStatus.signals.cf_ssl       = cfSslSignal;
  railwayStatus.signals.worker_route = workerRouteSignal;

  railwayStatus.all_green = (["dns", "cf_hostname", "cf_ssl", "worker_route", "live_request"] as const)
    .every((k) => railwayStatus.signals[k]?.state === "ok");

  writeDomainStatusCache(biz.slug, railwayStatus);
  return withCors(jsonOk(railwayStatus), request, { credentials: true });
}

// ── POST /api/client/rotate-key ───────────────────────────────────────────

async function apiRotateKey(request: Request, env: Env): Promise<Response> {
  const guard = await requireVerifiedSession(request, env);
  if (!guard.ok) return guard.resp;
  const ctx = guard.ctx;

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
  const guard = await requireVerifiedSession(request, env);
  if (!guard.ok) return guard.resp;
  const ctx = guard.ctx;

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
  const guard = await requireVerifiedSession(request, env);
  if (!guard.ok) return guard.resp;
  const ctx = guard.ctx;

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
  const guard = await requireVerifiedSession(request, env);
  if (!guard.ok) return guard.resp;
  const ctx = guard.ctx;

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

// ── POST /admin/cache/bump-version ────────────────────────────────────────
//
// Bumps the per-slug cache version stored in BUSINESS_MAP KV under
// `version:<slug>`. The bot-dispatch path (worker/src/index.ts) reads
// this value and includes it in the (slug × botType × pathname) cache
// key for rendered bot HTML. Bumping the version on every successful
// PATCH /agents/:slug/profile means profile edits propagate to AI
// crawlers IMMEDIATELY — old cache keys orphan and age out via the
// 600s TTL, new requests hit a cold render with the fresh JSON-LD.
//
// Auth: SERVER_API_KEY only (X-API-Key header). Called by the Railway
// PATCH handler after a successful UPDATE; not exposed to tenants.
//
// Body: optional { reason?: string } — recorded in logs for ops
// triage but not enforced.
//
// Returns: { slug, prev_version, new_version }.
//
// Apr 30 2026.

async function apiBumpCacheVersion(request: Request, env: Env): Promise<Response> {
  // Server-key only. Tenant Bearer tokens MUST NOT reach this — a
  // leaked tenant key shouldn't be able to nuke another tenant's
  // cache.
  const xKey = request.headers.get("X-API-Key");
  if (!env.API_KEY || xKey !== env.API_KEY) {
    return jsonErr(401, "server_key_required");
  }

  const slug = new URL(request.url).searchParams.get("slug");
  if (!slug || !/^[a-z0-9][a-z0-9-]{0,62}$/i.test(slug)) {
    return jsonErr(400, "invalid_slug");
  }

  const key = `version:${slug}`;
  const prevRaw = await env.BUSINESS_MAP.get(key);
  // Use a date-encoded version string so two concurrent bumps don't
  // collide (unlike a counter which races on read-modify-write). The
  // worker's KV writes are eventually consistent globally, but the
  // string itself is monotonic per-bump regardless of write order.
  const next = `v${Date.now().toString(36)}`;
  await env.BUSINESS_MAP.put(key, next);

  console.log(JSON.stringify({
    cache_version_bump: true,
    slug,
    prev_version: prevRaw ?? "v0",
    new_version: next,
  }));

  return new Response(
    JSON.stringify({ slug, prev_version: prevRaw ?? "v0", new_version: next }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

// ── /api/client/ai-recommendations ────────────────────────────────────────
//
// Pro/Enterprise AI Insights surface. Mirrors apiProfileScore (above)
// but pre-checks the tenant's plan in D1 before round-tripping Railway —
// Base/Free tenants get 402 plan_required immediately, saving ~80-150ms
// + a fraction of a Railway compute slot per locked-tier hit. The
// pattern matches apiRevenueSetAov around line 1370.
//
// Server-side gate: Railway's POST /agents/:slug/ai-recommendations
// uses requireServerKeyOnly. Only the worker (with env.API_KEY) can
// reach it. Direct curl with a leaked tenant Bearer can't bypass the
// proxy.
//
// Apr 30 2026.

async function apiAIRecommendations(request: Request, env: Env): Promise<Response> {
  const guard = await requireVerifiedSession(request, env);
  if (!guard.ok) return guard.resp;
  const ctx = guard.ctx;

  const businesses = ctx.role === "admin"
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const slug = new URL(request.url).searchParams.get("slug");
  const biz  = (slug ? businesses.find((b) => b.slug === slug) : null) ?? businesses[0] ?? null;
  if (!biz) return withCors(jsonErr(404, "No business found for this account"), request, { credentials: true });

  // Plan pre-check. Reads businesses.plan from D1 directly (the row is
  // already loaded, but the access list type doesn't always carry the
  // plan column on impersonation paths — re-query is safest). Returns
  // 402 with a structured body the frontend uses to render the upsell
  // card. The Railway endpoint ALSO does its own plan check as defense-
  // in-depth; this just saves the round-trip on the locked path.
  const planRow = await env.DB
    .prepare("SELECT plan FROM businesses WHERE slug = ?")
    .bind(biz.slug)
    .first<{ plan: string | null }>();
  const plan = planRow?.plan ?? "base";
  if (plan !== "pro" && plan !== "enterprise") {
    return withCors(
      jsonErr(402, "AI Insights is a Pro feature. Upgrade to enable."),
      request,
      { credentials: true },
    );
  }

  if (!biz.api_key || biz.api_key === "pending") {
    return withCors(
      jsonErr(409, "Tenant has no usable api_key (Stripe webhook may still be in flight). Try again in a minute."),
      request, { credentials: true },
    );
  }

  // GET = fast cache read (no API spend). POST = run on cache miss
  // unless body.force=true. Both forwarded transparently — Railway is
  // the source of truth for cache and validation.
  const isGet = request.method === "GET";
  let body = "{}";
  if (!isGet) {
    try { body = await request.text(); } catch { /* empty body OK */ }
    if (!body || !body.trim()) body = "{}";
  }

  const base = env.API_BASE_URL ?? "https://advocate-production-2887.up.railway.app";
  try {
    const r = await fetch(`${base}/agents/${biz.slug}/ai-recommendations`, {
      method: isGet ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
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
    return withCors(jsonErr(502, `AI recommendations backend unreachable: ${String(err)}`), request, { credentials: true });
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
  const guard = await requireVerifiedSession(request, env);
  if (!guard.ok) return guard.resp;
  const ctx = guard.ctx;

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
  const guard = await requireVerifiedSession(request, env);
  if (!guard.ok) return guard.resp;
  const ctx = guard.ctx;

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
// role: 'client' — same auth context as if a real tenant logged in normally.
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

async function fetchAnalytics(
  biz: Business,
  env: Env,
  rangeQS?: string,
): Promise<AnalyticsData | null> {
  // Date range filter (Apr 29 2026). Caller passes a pre-built query
  // string (e.g. "range=7d" or "start_date=2026-04-01&end_date=...").
  // Server endpoint /analytics/:slug accepts these via the dateRange
  // helper shipped in PR #145. When omitted, server defaults to 30d.
  const base = env.API_BASE_URL ?? "https://advocate-production-2887.up.railway.app";
  const qs = rangeQS ? `?${rangeQS}` : "";
  try {
    const res = await fetch(`${base}/analytics/${biz.slug}${qs}`, {
      headers: env.API_KEY ? { "X-API-Key": env.API_KEY } : {},
    });
    if (!res.ok) return null;
    return res.json() as Promise<AnalyticsData>;
  } catch {
    return null;
  }
}

// ── GA4 OAuth protected start ─────────────────────────────────────────────

async function handleGA4StartProtected(request: Request, env: Env): Promise<Response> {
  const guard = await requireVerifiedSession(request, env);
  if (!guard.ok) return guard.resp;
  const ctx = guard.ctx;

  const reqUrl = new URL(request.url);
  const querySlug = reqUrl.searchParams.get("slug");
  if (!querySlug) {
    return withCors(jsonErr(400, "slug query param required"), request, { credentials: true });
  }

  // Confirm the session user actually has access to this slug.
  const businesses = ctx.role === "admin"
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const owns = businesses.some(b => b.slug === querySlug);
  if (!owns) {
    return withCors(jsonErr(403, "no access to this business"), request, { credentials: true });
  }

  // Authorized — delegate to the actual OAuth start handler.
  return handleGA4Start(request, env);
}

// ── POST /api/client/ga4/start-link ────────────────────────────────────────
//
// JSON-returning sibling of /oauth/ga4/start. Necessary because the customer
// dashboard's auth model is bearer-token in JS memory — URL-bar typed
// navigations to /oauth/ga4/start can't carry a bearer header, so the GET
// path 401s for everyone except legacy admin-cookie sessions.
//
// Frontend calls this with bearer auth, gets back {url}, then sets
// window.location.href = url. The signed state binds the slug so the OAuth
// callback knows which tenant the connection is for.

async function apiGA4StartLink(request: Request, env: Env): Promise<Response> {
  const guard = await requireVerifiedSession(request, env);
  if (!guard.ok) return guard.resp;
  const ctx = guard.ctx;

  // Slug resolution mirrors every other GA4 endpoint (apiGA4Status,
  // apiGA4Resync, apiGA4SelectProperty): take ?slug=<slug> when
  // provided, fall back to the caller's primary business. The legacy
  // strict-require here broke the Settings page's Connect button —
  // both wireGa4Card (settings.js:533) and startGoogleOauth
  // (settings.js:1221) POST to /api/client/ga4/start-link without a
  // slug param, so the endpoint 400'd and the frontend surfaced a
  // generic "Could not start" alert that read as a platform outage
  // when the actual problem was just this mismatched contract.
  const reqUrl = new URL(request.url);
  const querySlug = reqUrl.searchParams.get("slug");

  // Same ownership check as handleGA4StartProtected — resolves the
  // business via the user's access list and (when admin) every active
  // business. Defaulting to `businesses[0]` for non-slug callers is the
  // canonical pattern.
  const businesses = ctx.role === "admin"
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const biz = (querySlug ? businesses.find(b => b.slug === querySlug) : null) ?? businesses[0] ?? null;
  if (!biz) {
    return withCors(jsonErr(404, "no business found for this account"), request, { credentials: true });
  }
  if (querySlug && biz.slug !== querySlug) {
    // Slug was explicitly provided but doesn't belong to caller's
    // accessible set. Surface 403 so the frontend doesn't silently
    // OAuth-link the wrong tenant.
    return withCors(jsonErr(403, "no access to this business"), request, { credentials: true });
  }
  const slug = biz.slug;

  if (!env.TOKEN_SIGNING_KEY || !env.GA4_OAUTH_CLIENT_ID || !env.GA4_OAUTH_REDIRECT_URI) {
    return withCors(jsonErr(503, "GA4 integration not configured"), request, { credentials: true });
  }

  // Generate a 16-byte hex nonce + sign the state.
  const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
  const nonce = Array.from(nonceBytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  const state = await signGA4State(
    { slug, nonce, ts: Math.floor(Date.now() / 1000) },
    env.TOKEN_SIGNING_KEY,
  );

  const params = new URLSearchParams({
    client_id:     env.GA4_OAUTH_CLIENT_ID,
    redirect_uri:  env.GA4_OAUTH_REDIRECT_URI,
    response_type: "code",
    scope:         "https://www.googleapis.com/auth/analytics.readonly",
    access_type:   "offline",
    prompt:        "consent",
    state,
  });
  const url = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

  return withCors(jsonOk({ url }), request, { credentials: true });
}

// ── GET /api/client/integrations/status ────────────────────────────────────
//
// Aggregator for the unified Traffic Impact integrations hub on Settings.
// Returns the status of all 6 integrations (GA4, GSC, HubSpot, Salesforce,
// Stripe webhook, Authority Kit) in one round-trip. Read-only; mutating
// actions still go through the per-integration endpoints.

async function apiIntegrationsStatus(request: Request, env: Env): Promise<Response> {
  const guard = await requireVerifiedSession(request, env);
  if (!guard.ok) return guard.resp;
  const ctx = guard.ctx;

  const businesses = ctx.role === "admin"
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const reqUrl = new URL(request.url);
  const slugParam = reqUrl.searchParams.get("slug");
  const biz = (slugParam ? businesses.find(b => b.slug === slugParam) : null) ?? businesses[0] ?? null;
  if (!biz) {
    return withCors(jsonErr(404, "No business"), request, { credentials: true });
  }

  const status = await fetchIntegrationsStatus(env.DB, biz);
  return withCors(jsonOk(status), request, { credentials: true });
}

// ── GET /api/client/ga4/status ─────────────────────────────────────────────

async function apiGA4Status(request: Request, env: Env): Promise<Response> {
  const guard = await requireVerifiedSession(request, env);
  if (!guard.ok) return guard.resp;
  const ctx = guard.ctx;

  const businesses = ctx.role === "admin"
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const reqUrl = new URL(request.url);
  const slugParam = reqUrl.searchParams.get("slug");
  const biz = (slugParam ? businesses.find(b => b.slug === slugParam) : null) ?? businesses[0] ?? null;
  if (!biz) {
    return withCors(jsonOk({ connected: false }), request, { credentials: true });
  }

  const row = await env.DB
    .prepare("SELECT property_id, property_label, status, last_sync_at, last_sync_error, connected_at FROM ga4_connections WHERE slug = ? LIMIT 1")
    .bind(biz.slug)
    .first<{
      property_id: string | null;
      property_label: string | null;
      status: string;
      last_sync_at: string | null;
      last_sync_error: string | null;
      connected_at: string;
    }>();

  if (!row) {
    return withCors(jsonOk({ connected: false, slug: biz.slug }), request, { credentials: true });
  }

  return withCors(
    jsonOk({
      connected: true,
      slug: biz.slug,
      property_id: row.property_id,
      property_label: row.property_label,
      status: row.status,
      last_sync_at: row.last_sync_at,
      last_sync_error: row.last_sync_error,
      connected_at: row.connected_at,
    }),
    request,
    { credentials: true },
  );
}

// ── GET /api/client/ga4/properties ────────────────────────────────────────

async function apiGA4Properties(request: Request, env: Env): Promise<Response> {
  const guard = await requireVerifiedSession(request, env);
  if (!guard.ok) return guard.resp;
  const ctx = guard.ctx;

  const businesses = ctx.role === "admin"
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const reqUrl = new URL(request.url);
  const slugParam = reqUrl.searchParams.get("slug");
  const biz = (slugParam ? businesses.find(b => b.slug === slugParam) : null) ?? businesses[0] ?? null;
  if (!biz) {
    return withCors(jsonErr(404, "No business"), request, { credentials: true });
  }

  const row = await env.DB
    .prepare("SELECT refresh_token_enc FROM ga4_connections WHERE slug = ? LIMIT 1")
    .bind(biz.slug)
    .first<{ refresh_token_enc: string }>();
  if (!row) {
    return withCors(jsonErr(404, "GA4 not connected"), request, { credentials: true });
  }

  if (!env.GA4_TOKEN_ENCRYPTION_KEY || !env.GA4_OAUTH_CLIENT_ID || !env.GA4_OAUTH_CLIENT_SECRET) {
    return withCors(jsonErr(503, "GA4 integration not configured"), request, { credentials: true });
  }

  try {
    const refreshToken = await decryptToken(row.refresh_token_enc, env.GA4_TOKEN_ENCRYPTION_KEY);
    const { accessToken } = await refreshAccessToken(
      refreshToken,
      env.GA4_OAUTH_CLIENT_ID,
      env.GA4_OAUTH_CLIENT_SECRET,
    );
    const properties = await listProperties(accessToken);
    return withCors(jsonOk({ properties }), request, { credentials: true });
  } catch {
    return withCors(
      jsonErr(502, "Failed to list GA4 properties"),
      request,
      { credentials: true },
    );
  }
}

// ── POST /api/client/ga4/select-property ──────────────────────────────────

async function apiGA4SelectProperty(request: Request, env: Env): Promise<Response> {
  // Diagnostic counters surfaced in the response so we can tell, on a fresh
  // connection, whether GA4 returned any rows at all (vs the property being
  // empty / freshly installed). Settings UI can also display these.
  let backfillRowsReceived = 0;
  let backfillDaysUpserted = 0;
  let backfillStartDate: string | null = null;
  let backfillEndDate:   string | null = null;
  const guard = await requireVerifiedSession(request, env);
  if (!guard.ok) return guard.resp;
  const ctx = guard.ctx;

  let body: { property_id?: string; property_label?: string; slug?: string } = {};
  try { body = await request.json() as typeof body; } catch {
    return withCors(jsonErr(400, "Invalid JSON"), request, { credentials: true });
  }
  if (!body.property_id || typeof body.property_id !== "string") {
    return withCors(jsonErr(400, "property_id required"), request, { credentials: true });
  }
  if (!body.property_label || typeof body.property_label !== "string") {
    return withCors(jsonErr(400, "property_label required"), request, { credentials: true });
  }

  const businesses = ctx.role === "admin"
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const biz = (body.slug ? businesses.find(b => b.slug === body.slug) : null) ?? businesses[0] ?? null;
  if (!biz) {
    return withCors(jsonErr(404, "No business"), request, { credentials: true });
  }

  // Save the property choice immediately so even if backfill fails the
  // selection persists and a manual resync can be tried later.
  await env.DB
    .prepare("UPDATE ga4_connections SET property_id = ?, property_label = ? WHERE slug = ?")
    .bind(body.property_id, body.property_label, biz.slug)
    .run();

  // Inline backfill — 18 months in one report. Errors don't fail the request:
  // we surface them via last_sync_error so the Settings page can show them.
  if (env.GA4_TOKEN_ENCRYPTION_KEY && env.GA4_OAUTH_CLIENT_ID && env.GA4_OAUTH_CLIENT_SECRET) {
    try {
      const conn = await env.DB
        .prepare("SELECT refresh_token_enc FROM ga4_connections WHERE slug = ? LIMIT 1")
        .bind(biz.slug)
        .first<{ refresh_token_enc: string }>();
      if (conn) {
        const refreshToken = await decryptToken(conn.refresh_token_enc, env.GA4_TOKEN_ENCRYPTION_KEY);
        const { accessToken } = await refreshAccessToken(
          refreshToken,
          env.GA4_OAUTH_CLIENT_ID,
          env.GA4_OAUTH_CLIENT_SECRET,
        );
        const today = new Date();
        const start = new Date(today);
        start.setUTCDate(start.getUTCDate() - 540);  // ~18 months
        const startDate = start.toISOString().slice(0, 10);
        const endDate = new Date(today.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);  // yesterday
        backfillStartDate = startDate;
        backfillEndDate   = endDate;

        const rows = await fetchDailyTraffic({
          propertyId: body.property_id,
          startDate,
          endDate,
          accessToken,
        });
        backfillRowsReceived = rows.length;

        // Aggregate per (slug, date): sum AI rows + sum Human rows. Track top
        // sources for the dashboard tooltip. Rates (engagement_rate, bounce_rate)
        // are session-weighted so we accumulate counts and derive at write time.
        type Agg = {
          ai: number; human: number;
          engaged_sessions_total: number;
          total_session_seconds: number;   // sessions × averageSessionDuration
          bounced_sessions_total: number;  // sessions × bounceRate
          new_users: number;
          returning_users: number;         // totalUsers − newUsers
          sources: Record<string, number>;
        };
        const byDate = new Map<string, Agg>();
        for (const r of rows) {
          const key = r.date;
          let agg = byDate.get(key);
          if (!agg) {
            agg = {
              ai: 0, human: 0,
              engaged_sessions_total: 0, total_session_seconds: 0,
              bounced_sessions_total: 0, new_users: 0, returning_users: 0,
              sources: {},
            };
            byDate.set(key, agg);
          }
          const cls = classifyTrafficSource(r.source, r.medium);
          if (cls === "ai")    agg.ai    += r.sessions;
          else                 agg.human += r.sessions;
          agg.engaged_sessions_total += r.engagedSessions;
          agg.total_session_seconds  += r.sessions * r.averageSessionDuration;
          agg.bounced_sessions_total += r.sessions * r.bounceRate;
          agg.new_users              += r.newUsers;
          // Clamp to >= 0 — GA4 sampling can produce rows where totalUsers <
          // newUsers, which would otherwise write a negative integer into the
          // NOT NULL DEFAULT 0 column.
          agg.returning_users        += Math.max(0, r.totalUsers - r.newUsers);
          const srcKey = `${r.source}|${r.medium}`;
          agg.sources[srcKey] = (agg.sources[srcKey] || 0) + r.sessions;
        }

        // Upsert each daily row.
        const now = new Date().toISOString();
        backfillDaysUpserted = byDate.size;
        for (const [date, agg] of byDate.entries()) {
          // Top-5 source/medium tuples for tooltips
          const top = Object.entries(agg.sources)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([sm, n]) => { const [s, m] = sm.split("|"); return { source: s, medium: m, sessions: n }; });
          const total = agg.ai + agg.human;
          const engagement_rate          = total > 0 ? agg.engaged_sessions_total / total : null;
          const avg_session_duration_sec = total > 0 ? Math.round(agg.total_session_seconds / total) : null;
          const bounce_rate              = total > 0 ? agg.bounced_sessions_total / total : null;
          await env.DB.prepare(
            `INSERT INTO traffic_daily (
               slug, date, ai_sessions, human_sessions, total_sessions, top_sources_json,
               engagement_rate, avg_session_duration_sec, bounce_rate, new_users, returning_users
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(slug, date) DO UPDATE SET
               ai_sessions              = excluded.ai_sessions,
               human_sessions           = excluded.human_sessions,
               total_sessions           = excluded.total_sessions,
               top_sources_json         = excluded.top_sources_json,
               engagement_rate          = excluded.engagement_rate,
               avg_session_duration_sec = excluded.avg_session_duration_sec,
               bounce_rate              = excluded.bounce_rate,
               new_users                = excluded.new_users,
               returning_users          = excluded.returning_users`
          )
          .bind(
            biz.slug,
            date,
            agg.ai,
            agg.human,
            total,
            JSON.stringify(top),
            engagement_rate,
            avg_session_duration_sec,
            bounce_rate,
            agg.new_users,
            agg.returning_users,
          )
          .run();
        }

        await env.DB
          .prepare("UPDATE ga4_connections SET last_sync_at = ?, last_sync_error = NULL, status = 'connected' WHERE slug = ?")
          .bind(now, biz.slug)
          .run();

        // Geography sync — separate report, separate upserts. Failures here
        // don't fail the main sync (just logged); geography is supplementary.
        try {
          const geoRows = await fetchDailyGeography({ propertyId: body.property_id, startDate, endDate, accessToken });
          const buckets = aggregateGeoRows(geoRows);
          for (const b of buckets.values()) {
            await env.DB.prepare(
              `INSERT INTO traffic_geo_daily (slug, date, country, city, ai_sessions, human_sessions)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(slug, date, country, city) DO UPDATE SET
                 ai_sessions    = excluded.ai_sessions,
                 human_sessions = excluded.human_sessions`,
            )
            .bind(biz.slug, b.date, b.country, b.city, b.ai_sessions, b.human_sessions)
            .run();
          }
        } catch (geoErr) {
          // Geography is supplementary — log + continue. Main traffic_daily
          // already wrote successfully.
          console.error(JSON.stringify({
            cron:  "ga4Sync_geo",
            event: "geo_failed",
            slug:  biz.slug,
            error: String(geoErr instanceof Error ? geoErr.message : geoErr).slice(0, 500),
          }));
        }

        // Phase 3 PR 1 TODO: extract writeConversions(env, slug, buckets) helper.
        // This try/catch + upsert loop is duplicated across syncOneTenant,
        // apiGA4SelectProperty, and apiGA4Resync — three near-identical blocks.
        try {
          const convRows = await fetchDailyConversions({ propertyId: body.property_id, startDate, endDate, accessToken });
          const buckets = aggregateConversionRows(convRows);
          for (const b of buckets.values()) {
            await env.DB.prepare(
              `INSERT INTO conversion_daily (slug, date, source_class, event_name, event_count, total_revenue, currency)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(slug, date, source_class, event_name) DO UPDATE SET
                 event_count   = excluded.event_count,
                 total_revenue = excluded.total_revenue,
                 currency      = excluded.currency`,
            )
            .bind(biz.slug, b.date, b.source_class, b.event_name, b.event_count, b.total_revenue, b.currency)
            .run();
          }
        } catch (convErr) {
          // Conversions are supplementary — log + continue. Tenant may not
          // have key_events configured, which legitimately returns zero rows
          // (handled implicitly above), but actual fetch errors here surface.
          console.error(JSON.stringify({
            cron:  "ga4Sync_conv",
            event: "conv_failed",
            slug:  biz.slug,
            error: String(convErr instanceof Error ? convErr.message : convErr).slice(0, 500),
          }));
        }
      }
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err).slice(0, 500);
      await env.DB
        .prepare("UPDATE ga4_connections SET last_sync_error = ?, status = 'error' WHERE slug = ?")
        .bind(msg, biz.slug)
        .run();
      // Don't fail the request — selection succeeded; sync error is recoverable.
    }
  }

  return withCors(
    jsonOk({
      ok: true,
      backfill: {
        rows_received_from_ga4: backfillRowsReceived,
        days_upserted:           backfillDaysUpserted,
        start_date:              backfillStartDate,
        end_date:                backfillEndDate,
      },
    }),
    request,
    { credentials: true },
  );
}

// ── POST /api/client/ga4/resync ───────────────────────────────────────────
//
// Manual sync trigger. The nightly cron (ga4Sync.ts) handles the steady-
// state case; this endpoint exists for the Settings UI's "Resync now"
// button — useful when a customer just installed gtag.js and wants to
// confirm yesterday's data lands without waiting for the cron tick.
//
// Implementation: re-runs the same backfill logic as select-property,
// but only over the last 7 days instead of 18 months. Same upsert path,
// same classification, same last_sync_at update. Idempotent.

async function apiGA4Resync(request: Request, env: Env): Promise<Response> {
  const guard = await requireVerifiedSession(request, env);
  if (!guard.ok) return guard.resp;
  const ctx = guard.ctx;

  const businesses = ctx.role === "admin"
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const reqUrl = new URL(request.url);
  const slugParam = reqUrl.searchParams.get("slug");
  const biz = (slugParam ? businesses.find(b => b.slug === slugParam) : null) ?? businesses[0] ?? null;
  if (!biz) {
    return withCors(jsonErr(404, "No business"), request, { credentials: true });
  }

  if (!env.GA4_TOKEN_ENCRYPTION_KEY || !env.GA4_OAUTH_CLIENT_ID || !env.GA4_OAUTH_CLIENT_SECRET) {
    return withCors(jsonErr(503, "GA4 integration not configured"), request, { credentials: true });
  }

  const conn = await env.DB
    .prepare("SELECT refresh_token_enc, property_id FROM ga4_connections WHERE slug = ? LIMIT 1")
    .bind(biz.slug)
    .first<{ refresh_token_enc: string; property_id: string | null }>();
  if (!conn) {
    return withCors(jsonErr(404, "GA4 not connected"), request, { credentials: true });
  }
  if (!conn.property_id) {
    return withCors(jsonErr(409, "No property selected — pick one in Settings first"), request, { credentials: true });
  }

  let rowsReceived = 0;
  let daysUpserted = 0;
  let syncError:    string | null = null;

  try {
    const refreshToken = await decryptToken(conn.refresh_token_enc, env.GA4_TOKEN_ENCRYPTION_KEY);
    const { accessToken } = await refreshAccessToken(
      refreshToken,
      env.GA4_OAUTH_CLIENT_ID,
      env.GA4_OAUTH_CLIENT_SECRET,
    );

    // Last 7 days, ending yesterday (GA4's 24-48h finalization lag means
    // today's row would be partial).
    const today     = new Date();
    const startDate = new Date(today.getTime() - 8 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const endDate   = new Date(today.getTime() -     24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const ga4Rows = await fetchDailyTraffic({
      propertyId: conn.property_id,
      startDate,
      endDate,
      accessToken,
    });
    rowsReceived = ga4Rows.length;

    // Same aggregation as select-property backfill. Rates are session-weighted.
    type ResyncAgg = {
      ai: number; human: number;
      engaged_sessions_total: number;
      total_session_seconds: number;
      bounced_sessions_total: number;
      new_users: number;
      returning_users: number;
      sources: Record<string, number>;
    };
    const byDate = new Map<string, ResyncAgg>();
    for (const r of ga4Rows) {
      let agg = byDate.get(r.date);
      if (!agg) {
        agg = {
          ai: 0, human: 0,
          engaged_sessions_total: 0, total_session_seconds: 0,
          bounced_sessions_total: 0, new_users: 0, returning_users: 0,
          sources: {},
        };
        byDate.set(r.date, agg);
      }
      const cls = classifyTrafficSource(r.source, r.medium);
      if (cls === "ai") agg.ai    += r.sessions;
      else              agg.human += r.sessions;
      agg.engaged_sessions_total += r.engagedSessions;
      agg.total_session_seconds  += r.sessions * r.averageSessionDuration;
      agg.bounced_sessions_total += r.sessions * r.bounceRate;
      agg.new_users              += r.newUsers;
      // Clamp to >= 0 — GA4 sampling can produce rows where totalUsers <
      // newUsers, which would otherwise write a negative integer into the
      // NOT NULL DEFAULT 0 column.
      agg.returning_users        += Math.max(0, r.totalUsers - r.newUsers);
      const srcKey = `${r.source}|${r.medium}`;
      agg.sources[srcKey] = (agg.sources[srcKey] || 0) + r.sessions;
    }
    daysUpserted = byDate.size;

    for (const [date, agg] of byDate.entries()) {
      const top = Object.entries(agg.sources)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([sm, n]) => { const [s, m] = sm.split("|"); return { source: s, medium: m, sessions: n }; });
      const total = agg.ai + agg.human;
      const engagement_rate          = total > 0 ? agg.engaged_sessions_total / total : null;
      const avg_session_duration_sec = total > 0 ? Math.round(agg.total_session_seconds / total) : null;
      const bounce_rate              = total > 0 ? agg.bounced_sessions_total / total : null;
      await env.DB.prepare(
        `INSERT INTO traffic_daily (
           slug, date, ai_sessions, human_sessions, total_sessions, top_sources_json,
           engagement_rate, avg_session_duration_sec, bounce_rate, new_users, returning_users
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(slug, date) DO UPDATE SET
           ai_sessions              = excluded.ai_sessions,
           human_sessions           = excluded.human_sessions,
           total_sessions           = excluded.total_sessions,
           top_sources_json         = excluded.top_sources_json,
           engagement_rate          = excluded.engagement_rate,
           avg_session_duration_sec = excluded.avg_session_duration_sec,
           bounce_rate              = excluded.bounce_rate,
           new_users                = excluded.new_users,
           returning_users          = excluded.returning_users`
      )
      .bind(biz.slug, date, agg.ai, agg.human, total, JSON.stringify(top),
            engagement_rate, avg_session_duration_sec, bounce_rate,
            agg.new_users, agg.returning_users)
      .run();
    }

    await env.DB
      .prepare("UPDATE ga4_connections SET last_sync_at = ?, last_sync_error = NULL, status = 'connected' WHERE slug = ?")
      .bind(new Date().toISOString(), biz.slug)
      .run();

    // Geography sync — separate report, separate upserts. Failures here
    // don't fail the main sync (just logged); geography is supplementary.
    try {
      const geoRows = await fetchDailyGeography({ propertyId: conn.property_id, startDate, endDate, accessToken });
      const buckets = aggregateGeoRows(geoRows);
      for (const b of buckets.values()) {
        await env.DB.prepare(
          `INSERT INTO traffic_geo_daily (slug, date, country, city, ai_sessions, human_sessions)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(slug, date, country, city) DO UPDATE SET
             ai_sessions    = excluded.ai_sessions,
             human_sessions = excluded.human_sessions`,
        )
        .bind(biz.slug, b.date, b.country, b.city, b.ai_sessions, b.human_sessions)
        .run();
      }
    } catch (geoErr) {
      // Geography is supplementary — log + continue. Main traffic_daily
      // already wrote successfully.
      console.error(JSON.stringify({
        cron:  "ga4Sync_geo",
        event: "geo_failed",
        slug:  biz.slug,
        error: String(geoErr instanceof Error ? geoErr.message : geoErr).slice(0, 500),
      }));
    }

    // Phase 3 PR 1 TODO: extract writeConversions(env, slug, buckets) helper.
    // This try/catch + upsert loop is duplicated across syncOneTenant,
    // apiGA4SelectProperty, and apiGA4Resync — three near-identical blocks.
    try {
      const convRows = await fetchDailyConversions({ propertyId: conn.property_id, startDate, endDate, accessToken });
      const buckets = aggregateConversionRows(convRows);
      for (const b of buckets.values()) {
        await env.DB.prepare(
          `INSERT INTO conversion_daily (slug, date, source_class, event_name, event_count, total_revenue, currency)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(slug, date, source_class, event_name) DO UPDATE SET
             event_count   = excluded.event_count,
             total_revenue = excluded.total_revenue,
             currency      = excluded.currency`,
        )
        .bind(biz.slug, b.date, b.source_class, b.event_name, b.event_count, b.total_revenue, b.currency)
        .run();
      }
    } catch (convErr) {
      // Conversions are supplementary — log + continue. Tenant may not
      // have key_events configured, which legitimately returns zero rows
      // (handled implicitly above), but actual fetch errors here surface.
      console.error(JSON.stringify({
        cron:  "ga4Sync_conv",
        event: "conv_failed",
        slug:  biz.slug,
        error: String(convErr instanceof Error ? convErr.message : convErr).slice(0, 500),
      }));
    }
  } catch (err) {
    syncError = String(err instanceof Error ? err.message : err).slice(0, 500);
    await env.DB
      .prepare("UPDATE ga4_connections SET last_sync_error = ?, status = 'error' WHERE slug = ?")
      .bind(syncError, biz.slug)
      .run();
  }

  return withCors(
    jsonOk({ ok: true, rows_received: rowsReceived, days_upserted: daysUpserted, error: syncError }),
    request,
    { credentials: true },
  );
}

// ── POST /api/client/ga4/disconnect ───────────────────────────────────────

async function apiGA4Disconnect(request: Request, env: Env): Promise<Response> {
  const guard = await requireVerifiedSession(request, env);
  if (!guard.ok) return guard.resp;
  const ctx = guard.ctx;

  const businesses = ctx.role === "admin"
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const reqUrl = new URL(request.url);
  const slugParam = reqUrl.searchParams.get("slug");
  const biz = (slugParam ? businesses.find(b => b.slug === slugParam) : null) ?? businesses[0] ?? null;
  if (!biz) {
    return withCors(jsonErr(404, "No business"), request, { credentials: true });
  }

  await env.DB.prepare("DELETE FROM ga4_connections WHERE slug = ?").bind(biz.slug).run();
  return withCors(jsonOk({ ok: true }), request, { credentials: true });
}

// ── GSC OAuth protected start ─────────────────────────────────────────────
//
// Pro plan gate: GSC is a Pro-only feature per the Traffic Impact data-depth
// roadmap. Base tenants get a 402 rather than being redirected to Google —
// we never want a base tenant to complete the OAuth flow and end up with a
// gsc_connections row that the sync job won't touch.

async function handleGSCStartProtected(request: Request, env: Env): Promise<Response> {
  const guard = await requireVerifiedSession(request, env);
  if (!guard.ok) return guard.resp;
  const ctx = guard.ctx;

  const reqUrl = new URL(request.url);
  const querySlug = reqUrl.searchParams.get("slug");
  if (!querySlug) return withCors(jsonErr(400, "slug query param required"), request, { credentials: true });

  const businesses = ctx.role === "admin"
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const owns = businesses.some(b => b.slug === querySlug);
  if (!owns) return withCors(jsonErr(403, "no access to this business"), request, { credentials: true });

  // Plan gate — Pro only. GSC is a Pro feature per the data-depth roadmap.
  const planRow = await env.DB
    .prepare("SELECT plan FROM businesses WHERE slug = ?")
    .bind(querySlug)
    .first<{ plan: string | null }>();
  const plan = planRow?.plan ?? "base";
  if (plan !== "pro" && plan !== "enterprise") {
    return withCors(jsonErr(402, "plan_required"), request, { credentials: true });
  }

  return handleGSCStart(request, env);
}

// ── POST /api/client/gsc/start-link ────────────────────────────────────────
//
// JSON-returning sibling of /oauth/gsc/start. Necessary because the customer
// dashboard's auth model is bearer-token in JS memory — URL-bar typed
// navigations to /oauth/gsc/start can't carry a bearer header, so the GET
// path 401s for everyone except legacy admin-cookie sessions.
//
// Frontend calls this with bearer auth, gets back {url}, then sets
// window.location.href = url. The signed state binds the slug so the OAuth
// callback knows which tenant the connection is for.

async function apiGSCStartLink(request: Request, env: Env): Promise<Response> {
  const guard = await requireVerifiedSession(request, env);
  if (!guard.ok) return guard.resp;
  const ctx = guard.ctx;

  const reqUrl = new URL(request.url);
  const querySlug = reqUrl.searchParams.get("slug");
  if (!querySlug) {
    return withCors(jsonErr(400, "slug query param required"), request, { credentials: true });
  }

  // Same ownership check as handleGSCStartProtected.
  const businesses = ctx.role === "admin"
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const owns = businesses.some(b => b.slug === querySlug);
  if (!owns) {
    return withCors(jsonErr(403, "no access to this business"), request, { credentials: true });
  }

  // Plan gate — Pro only. Matches handleGSCStartProtected.
  const planRow = await env.DB
    .prepare("SELECT plan FROM businesses WHERE slug = ?")
    .bind(querySlug)
    .first<{ plan: string | null }>();
  const plan = planRow?.plan ?? "base";
  if (plan !== "pro" && plan !== "enterprise") {
    return withCors(jsonErr(402, "plan_required"), request, { credentials: true });
  }

  if (!env.TOKEN_SIGNING_KEY || !env.GSC_OAUTH_CLIENT_ID || !env.GSC_OAUTH_REDIRECT_URI) {
    return withCors(jsonErr(503, "GSC integration not configured"), request, { credentials: true });
  }

  // Generate a 16-byte hex nonce + sign the state with the GSC domain prefix.
  const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
  const nonce = Array.from(nonceBytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  const state = await signState(
    { slug: querySlug, nonce, ts: Math.floor(Date.now() / 1000) },
    env.TOKEN_SIGNING_KEY,
    "gsc-state:v1:",
  );

  const params = new URLSearchParams({
    client_id:     env.GSC_OAUTH_CLIENT_ID,
    redirect_uri:  env.GSC_OAUTH_REDIRECT_URI,
    response_type: "code",
    scope:         "https://www.googleapis.com/auth/webmasters.readonly",
    access_type:   "offline",
    prompt:        "consent",
    state,
  });
  const url = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

  return withCors(jsonOk({ url }), request, { credentials: true });
}

// ── GET /api/client/gsc/status ─────────────────────────────────────────────

async function apiGSCStatus(request: Request, env: Env): Promise<Response> {
  const guard = await requireVerifiedSession(request, env);
  if (!guard.ok) return guard.resp;
  const ctx = guard.ctx;

  const businesses = ctx.role === "admin"
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const reqUrl = new URL(request.url);
  const slugParam = reqUrl.searchParams.get("slug");
  const biz = (slugParam ? businesses.find(b => b.slug === slugParam) : null) ?? businesses[0] ?? null;
  if (!biz) {
    return withCors(jsonOk({ connected: false }), request, { credentials: true });
  }

  const row = await env.DB
    .prepare("SELECT site_url, status, last_sync_at, last_sync_error, connected_at FROM gsc_connections WHERE slug = ? LIMIT 1")
    .bind(biz.slug)
    .first<{
      site_url: string | null;
      status: string;
      last_sync_at: string | null;
      last_sync_error: string | null;
      connected_at: string;
    }>();

  if (!row) {
    return withCors(jsonOk({ connected: false, slug: biz.slug }), request, { credentials: true });
  }

  return withCors(
    jsonOk({
      connected: true,
      slug: biz.slug,
      site_url: row.site_url,
      status: row.status,
      last_sync_at: row.last_sync_at,
      last_sync_error: row.last_sync_error,
      connected_at: row.connected_at,
    }),
    request,
    { credentials: true },
  );
}

// ── POST /api/client/gsc/disconnect ───────────────────────────────────────

async function apiGSCDisconnect(request: Request, env: Env): Promise<Response> {
  const guard = await requireVerifiedSession(request, env);
  if (!guard.ok) return guard.resp;
  const ctx = guard.ctx;

  const businesses = ctx.role === "admin"
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const reqUrl = new URL(request.url);
  const slugParam = reqUrl.searchParams.get("slug");
  const biz = (slugParam ? businesses.find(b => b.slug === slugParam) : null) ?? businesses[0] ?? null;
  if (!biz) {
    return withCors(jsonErr(404, "No business"), request, { credentials: true });
  }

  await env.DB.prepare("DELETE FROM gsc_connections WHERE slug = ?").bind(biz.slug).run();
  return withCors(jsonOk({ ok: true }), request, { credentials: true });
}

// ── GET /api/client/gsc/sites ─────────────────────────────────────────────
//
// Lists the customer's verified GSC sites post-OAuth. Requires a live
// gsc_connections row (refresh token present). Mirrors apiGA4Properties.

async function apiGSCSites(request: Request, env: Env): Promise<Response> {
  const guard = await requireVerifiedSession(request, env);
  if (!guard.ok) return guard.resp;
  const ctx = guard.ctx;

  const businesses = ctx.role === "admin"
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const reqUrl = new URL(request.url);
  const slugParam = reqUrl.searchParams.get("slug");
  const biz = (slugParam ? businesses.find(b => b.slug === slugParam) : null) ?? businesses[0] ?? null;
  if (!biz) {
    return withCors(jsonErr(404, "No business"), request, { credentials: true });
  }

  // Pro plan gate — GSC is a Pro feature per the data-depth roadmap
  const planRow = await env.DB
    .prepare("SELECT plan FROM businesses WHERE slug = ?")
    .bind(biz.slug)
    .first<{ plan: string | null }>();
  const plan = planRow?.plan ?? "base";
  if (plan !== "pro" && plan !== "enterprise") {
    return withCors(jsonErr(402, "plan_required"), request, { credentials: true });
  }

  if (!env.GA4_TOKEN_ENCRYPTION_KEY || !env.GSC_OAUTH_CLIENT_ID || !env.GSC_OAUTH_CLIENT_SECRET) {
    return withCors(jsonErr(503, "GSC integration not configured"), request, { credentials: true });
  }

  const row = await env.DB
    .prepare("SELECT refresh_token_enc FROM gsc_connections WHERE slug = ? LIMIT 1")
    .bind(biz.slug)
    .first<{ refresh_token_enc: string }>();
  if (!row) {
    return withCors(jsonErr(404, "GSC not connected"), request, { credentials: true });
  }

  try {
    const refreshToken = await decryptToken(row.refresh_token_enc, env.GA4_TOKEN_ENCRYPTION_KEY);
    const { accessToken } = await refreshAccessToken(
      refreshToken,
      env.GSC_OAUTH_CLIENT_ID,
      env.GSC_OAUTH_CLIENT_SECRET,
    );
    const sites = await listSites(accessToken);
    return withCors(jsonOk({ sites }), request, { credentials: true });
  } catch {
    return withCors(
      jsonErr(502, "Failed to list GSC sites"),
      request,
      { credentials: true },
    );
  }
}

// ── POST /api/client/gsc/select-site ─────────────────────────────────────
//
// Saves the tenant's chosen GSC site_url and runs an inline 18-month
// backfill. Chunked by 90 days to stay within GSC date-range soft caps.
// Top-100 queries per day cap matches the cron sync.

async function apiGSCSelectSite(request: Request, env: Env): Promise<Response> {
  let backfillRowsReceived = 0;
  let backfillDaysUpserted = 0;
  let backfillStartDate: string | null = null;
  let backfillEndDate:   string | null = null;

  const guard = await requireVerifiedSession(request, env);
  if (!guard.ok) return guard.resp;
  const ctx = guard.ctx;

  let body: { site_url?: string; slug?: string } = {};
  try { body = await request.json() as typeof body; } catch {
    return withCors(jsonErr(400, "Invalid JSON"), request, { credentials: true });
  }
  if (!body.site_url || typeof body.site_url !== "string") {
    return withCors(jsonErr(400, "site_url required"), request, { credentials: true });
  }

  const businesses = ctx.role === "admin"
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const biz = (body.slug ? businesses.find(b => b.slug === body.slug) : null) ?? businesses[0] ?? null;
  if (!biz) {
    return withCors(jsonErr(404, "No business"), request, { credentials: true });
  }

  // Pro plan gate
  const planRow = await env.DB
    .prepare("SELECT plan FROM businesses WHERE slug = ?")
    .bind(biz.slug)
    .first<{ plan: string | null }>();
  const plan = planRow?.plan ?? "base";
  if (plan !== "pro" && plan !== "enterprise") {
    return withCors(jsonErr(402, "plan_required"), request, { credentials: true });
  }

  // Save site choice immediately so even if backfill fails the selection
  // persists and a manual resync can recover it.
  await env.DB
    .prepare("UPDATE gsc_connections SET site_url = ? WHERE slug = ?")
    .bind(body.site_url, biz.slug)
    .run();

  // Inline backfill — 18 months chunked by 90 days to respect GSC date-range
  // soft caps. Errors don't fail the request; surfaced via last_sync_error.
  if (env.GA4_TOKEN_ENCRYPTION_KEY && env.GSC_OAUTH_CLIENT_ID && env.GSC_OAUTH_CLIENT_SECRET) {
    try {
      const conn = await env.DB
        .prepare("SELECT refresh_token_enc FROM gsc_connections WHERE slug = ? LIMIT 1")
        .bind(biz.slug)
        .first<{ refresh_token_enc: string }>();
      if (conn) {
        const refreshToken = await decryptToken(conn.refresh_token_enc, env.GA4_TOKEN_ENCRYPTION_KEY);
        const { accessToken } = await refreshAccessToken(
          refreshToken,
          env.GSC_OAUTH_CLIENT_ID,
          env.GSC_OAUTH_CLIENT_SECRET,
        );

        const today     = new Date();
        const totalEnd  = new Date(today.getTime() - 24 * 60 * 60 * 1000);  // yesterday
        const totalStart = new Date(today.getTime() - 540 * 24 * 60 * 60 * 1000);  // ~18 months back
        backfillStartDate = totalStart.toISOString().slice(0, 10);
        backfillEndDate   = totalEnd.toISOString().slice(0, 10);

        // Build list of 90-day chunks covering the full backfill window
        const chunkDays = 90;
        const chunks: Array<{ start: string; end: string }> = [];
        let chunkStart = new Date(totalStart);
        while (chunkStart < totalEnd) {
          const chunkEnd = new Date(Math.min(
            chunkStart.getTime() + chunkDays * 24 * 60 * 60 * 1000 - 1,
            totalEnd.getTime(),
          ));
          chunks.push({
            start: chunkStart.toISOString().slice(0, 10),
            end:   chunkEnd.toISOString().slice(0, 10),
          });
          chunkStart = new Date(chunkEnd.getTime() + 24 * 60 * 60 * 1000);
        }

        // Aggregate across chunks into per-day top-100 query buckets
        const byDate = new Map<string, Array<{ query: string; impressions: number; clicks: number; ctr: number; position: number }>>();

        for (const chunk of chunks) {
          const rows = await fetchSearchAnalytics({
            siteUrl:     body.site_url,
            startDate:   chunk.start,
            endDate:     chunk.end,
            accessToken,
          });
          backfillRowsReceived += rows.length;

          for (const r of rows) {
            const bucket = byDate.get(r.date) ?? [];
            bucket.push({ query: r.query, impressions: r.impressions, clicks: r.clicks, ctr: r.ctr, position: r.position });
            byDate.set(r.date, bucket);
          }
        }

        const now = new Date().toISOString();
        backfillDaysUpserted = byDate.size;

        for (const [date, dayRows] of byDate.entries()) {
          // Top-100 by impressions — same cap as cron sync
          const top100 = dayRows
            .sort((a, b) => b.impressions - a.impressions)
            .slice(0, 100);

          for (const r of top100) {
            await env.DB.prepare(
              `INSERT INTO gsc_daily (slug, date, query, impressions, clicks, ctr, position)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(slug, date, query) DO UPDATE SET
                 impressions = excluded.impressions,
                 clicks      = excluded.clicks,
                 ctr         = excluded.ctr,
                 position    = excluded.position`,
            )
            .bind(biz.slug, date, r.query, r.impressions, r.clicks, r.ctr, r.position)
            .run();
          }
        }

        // AI Overview detection (Phase 3 PR 4): a SECOND GSC query filtered by
        // searchAppearance=aiOverview returns the (date, query) tuples where
        // Google showed an AI Overview at search time. Cross-reference into
        // gsc_daily and flip ai_overview_shown=1 on matching rows.
        //
        // Failure-isolated: AI Overview detection is supplementary. If the
        // filtered query fails (Google quota, transient error), the main
        // search analytics rows still upsert with ai_overview_shown=0 and
        // next sync corrects it.
        //
        // Phase 3 PR 1 future TODO: extract markAiOverviewRows(env, slug, rows)
        // helper. The same UPDATE loop now lives in 3 places (cron + select-site
        // + resync). Wait until the broader 3-site dedup happens — coupling
        // to the existing aggregation duplication.
        try {
          for (const chunk of chunks) {
            const aiOverviewRows = await fetchAiOverviewQueries({
              siteUrl:     body.site_url,
              startDate:   chunk.start,
              endDate:     chunk.end,
              accessToken,
            });
            for (const r of aiOverviewRows) {
              await env.DB
                .prepare("UPDATE gsc_daily SET ai_overview_shown = 1 WHERE slug = ? AND date = ? AND query = ?")
                .bind(biz.slug, r.date, r.query)
                .run();
            }
          }
        } catch (aiErr) {
          console.error(JSON.stringify({
            cron:  "gscSync_ai",
            event: "ai_overview_failed",
            slug:  biz.slug,
            error: String(aiErr instanceof Error ? aiErr.message : aiErr).slice(0, 500),
          }));
        }

        await env.DB
          .prepare("UPDATE gsc_connections SET last_sync_at = ?, last_sync_error = NULL, status = 'connected' WHERE slug = ?")
          .bind(now, biz.slug)
          .run();
      }
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err).slice(0, 500);
      await env.DB
        .prepare("UPDATE gsc_connections SET last_sync_error = ?, status = 'error' WHERE slug = ?")
        .bind(msg, biz.slug)
        .run();
      // Don't fail the request — site selection succeeded; backfill error is recoverable.
    }
  }

  return withCors(
    jsonOk({
      ok: true,
      backfill: {
        rows_received_from_gsc: backfillRowsReceived,
        days_upserted:          backfillDaysUpserted,
        start_date:             backfillStartDate,
        end_date:               backfillEndDate,
      },
    }),
    request,
    { credentials: true },
  );
}

// ── POST /api/client/gsc/resync ───────────────────────────────────────────
//
// Manual sync trigger — pulls last 7 days. Mirrors apiGA4Resync exactly.
// Useful for the Settings UI "Resync now" button to confirm recent data
// landed without waiting for the nightly cron tick. Pro-gated.

async function apiGSCResync(request: Request, env: Env): Promise<Response> {
  const guard = await requireVerifiedSession(request, env);
  if (!guard.ok) return guard.resp;
  const ctx = guard.ctx;

  const businesses = ctx.role === "admin"
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const reqUrl = new URL(request.url);
  const slugParam = reqUrl.searchParams.get("slug");
  const biz = (slugParam ? businesses.find(b => b.slug === slugParam) : null) ?? businesses[0] ?? null;
  if (!biz) {
    return withCors(jsonErr(404, "No business"), request, { credentials: true });
  }

  // Pro plan gate
  const planRow = await env.DB
    .prepare("SELECT plan FROM businesses WHERE slug = ?")
    .bind(biz.slug)
    .first<{ plan: string | null }>();
  const plan = planRow?.plan ?? "base";
  if (plan !== "pro" && plan !== "enterprise") {
    return withCors(jsonErr(402, "plan_required"), request, { credentials: true });
  }

  if (!env.GA4_TOKEN_ENCRYPTION_KEY || !env.GSC_OAUTH_CLIENT_ID || !env.GSC_OAUTH_CLIENT_SECRET) {
    return withCors(jsonErr(503, "GSC integration not configured"), request, { credentials: true });
  }

  const conn = await env.DB
    .prepare("SELECT refresh_token_enc, site_url FROM gsc_connections WHERE slug = ? LIMIT 1")
    .bind(biz.slug)
    .first<{ refresh_token_enc: string; site_url: string | null }>();
  if (!conn) {
    return withCors(jsonErr(404, "GSC not connected"), request, { credentials: true });
  }
  if (!conn.site_url) {
    return withCors(jsonErr(409, "No site selected — pick one in Settings first"), request, { credentials: true });
  }

  let rowsReceived = 0;
  let daysUpserted = 0;
  let syncError:    string | null = null;

  try {
    const refreshToken = await decryptToken(conn.refresh_token_enc, env.GA4_TOKEN_ENCRYPTION_KEY);
    const { accessToken } = await refreshAccessToken(
      refreshToken,
      env.GSC_OAUTH_CLIENT_ID,
      env.GSC_OAUTH_CLIENT_SECRET,
    );

    // Last 7 days ending yesterday (GSC's 2-3 day processing lag means
    // today's data would be partial or absent).
    const today     = new Date();
    const endDate   = new Date(today.getTime() -     24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const startDate = new Date(today.getTime() - 8 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const gscRows = await fetchSearchAnalytics({
      siteUrl:     conn.site_url,
      startDate,
      endDate,
      accessToken,
    });
    rowsReceived = gscRows.length;

    // Group by date, cap top-100 per day, upsert
    const byDate = new Map<string, typeof gscRows>();
    for (const r of gscRows) {
      const bucket = byDate.get(r.date) ?? [];
      bucket.push(r);
      byDate.set(r.date, bucket);
    }
    daysUpserted = byDate.size;

    for (const [date, dayRows] of byDate.entries()) {
      const top100 = dayRows
        .sort((a, b) => b.impressions - a.impressions)
        .slice(0, 100);

      for (const r of top100) {
        await env.DB.prepare(
          `INSERT INTO gsc_daily (slug, date, query, impressions, clicks, ctr, position)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(slug, date, query) DO UPDATE SET
             impressions = excluded.impressions,
             clicks      = excluded.clicks,
             ctr         = excluded.ctr,
             position    = excluded.position`,
        )
        .bind(biz.slug, date, r.query, r.impressions, r.clicks, r.ctr, r.position)
        .run();
      }
    }

    // AI Overview detection (Phase 3 PR 4): a SECOND GSC query filtered by
    // searchAppearance=aiOverview returns the (date, query) tuples where
    // Google showed an AI Overview at search time. Cross-reference into
    // gsc_daily and flip ai_overview_shown=1 on matching rows.
    //
    // Failure-isolated: AI Overview detection is supplementary. If the
    // filtered query fails (Google quota, transient error), the main
    // search analytics rows still upsert with ai_overview_shown=0 and
    // next sync corrects it.
    //
    // Phase 3 PR 1 future TODO: extract markAiOverviewRows(env, slug, rows)
    // helper. The same UPDATE loop now lives in 3 places (cron + select-site
    // + resync). Wait until the broader 3-site dedup happens — coupling
    // to the existing aggregation duplication.
    try {
      const aiOverviewRows = await fetchAiOverviewQueries({
        siteUrl:     conn.site_url,
        startDate,
        endDate,
        accessToken,
      });
      for (const r of aiOverviewRows) {
        await env.DB
          .prepare("UPDATE gsc_daily SET ai_overview_shown = 1 WHERE slug = ? AND date = ? AND query = ?")
          .bind(biz.slug, r.date, r.query)
          .run();
      }
    } catch (aiErr) {
      console.error(JSON.stringify({
        cron:  "gscSync_ai",
        event: "ai_overview_failed",
        slug:  biz.slug,
        error: String(aiErr instanceof Error ? aiErr.message : aiErr).slice(0, 500),
      }));
    }

    await env.DB
      .prepare("UPDATE gsc_connections SET last_sync_at = ?, last_sync_error = NULL, status = 'connected' WHERE slug = ?")
      .bind(new Date().toISOString(), biz.slug)
      .run();
  } catch (err) {
    syncError = String(err instanceof Error ? err.message : err).slice(0, 500);
    await env.DB
      .prepare("UPDATE gsc_connections SET last_sync_error = ?, status = 'error' WHERE slug = ?")
      .bind(syncError, biz.slug)
      .run();
  }

  return withCors(
    jsonOk({ ok: true, rows_received: rowsReceived, days_upserted: daysUpserted, error: syncError }),
    request,
    { credentials: true },
  );
}

// ── GET /api/client/traffic-impact ────────────────────────────────────────

async function apiTrafficImpact(request: Request, env: Env): Promise<Response> {
  const guard = await requireVerifiedSession(request, env);
  if (!guard.ok) return guard.resp;
  const ctx = guard.ctx;

  const businesses = ctx.role === "admin"
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const reqUrl = new URL(request.url);
  const slugParam = reqUrl.searchParams.get("slug");
  const biz = (slugParam ? businesses.find(b => b.slug === slugParam) : null) ?? businesses[0] ?? null;
  if (!biz) {
    return withCors(jsonErr(404, "No business found for this account"), request, { credentials: true });
  }

  const payload = await trafficImpactPayload(env, biz, reqUrl);
  return withCors(jsonOk(payload), request, { credentials: true });
}

// ── GET /api/client/traffic-impact/geography ──────────────────────────────

async function apiTrafficImpactGeography(request: Request, env: Env): Promise<Response> {
  const guard = await requireVerifiedSession(request, env);
  if (!guard.ok) return guard.resp;
  const ctx = guard.ctx;

  const businesses = ctx.role === "admin"
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const reqUrl    = new URL(request.url);
  const slugParam = reqUrl.searchParams.get("slug");
  const biz       = (slugParam ? businesses.find(b => b.slug === slugParam) : null) ?? businesses[0] ?? null;
  if (!biz) {
    return withCors(jsonErr(404, "No business found for this account"), request, { credentials: true });
  }

  const range    = reqUrl.searchParams.get("range");
  const startQs  = reqUrl.searchParams.get("start_date");
  const endQs    = reqUrl.searchParams.get("end_date");

  let dateFilterSql  = "";
  let dateFilterArgs: string[] = [];

  if (startQs && endQs) {
    dateFilterSql  = " AND date >= ? AND date <= ?";
    dateFilterArgs = [startQs, endQs];
  } else if (range && /^\d+d$/.test(range)) {
    const days   = parseInt(range, 10);
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    dateFilterSql  = " AND date >= ?";
    dateFilterArgs = [cutoff];
  }

  const result = await env.DB
    .prepare(
      `SELECT country, city,
              SUM(ai_sessions)    AS ai,
              SUM(human_sessions) AS human
         FROM traffic_geo_daily
        WHERE slug = ?${dateFilterSql}
        GROUP BY country, city`,
    )
    .bind(biz.slug, ...dateFilterArgs)
    .all<{ country: string | null; city: string | null; ai: number; human: number }>();

  const rows = result.results ?? [];

  // Sort server-side so the client only has to render — top 10 by each metric.
  const byAi    = [...rows].sort((a, b) => (b.ai    || 0) - (a.ai    || 0)).slice(0, 10);
  const byHuman = [...rows].sort((a, b) => (b.human || 0) - (a.human || 0)).slice(0, 10);

  const toEntry = (r: { country: string | null; city: string | null; ai: number; human: number }) => ({
    country:  r.country ?? null,
    city:     r.city    ?? null,
    sessions: 0,  // field overridden per-side below
  });

  // Each side's entry exposes sessions = the metric that side is sorted by.
  const aiEntries    = byAi.map(r    => ({ ...toEntry(r),    sessions: r.ai    || 0 }));
  const humanEntries = byHuman.map(r => ({ ...toEntry(r),    sessions: r.human || 0 }));

  return withCors(jsonOk({ ai: aiEntries, human: humanEntries }), request, { credentials: true });
}

// ── GET /api/client/traffic-impact/conversions ────────────────────────────
// Pro / Enterprise only — 402 for base-tier tenants.

async function apiTrafficImpactConversions(request: Request, env: Env): Promise<Response> {
  const guard = await requireVerifiedSession(request, env);
  if (!guard.ok) return guard.resp;
  const ctx = guard.ctx;

  const businesses = ctx.role === "admin"
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const reqUrl    = new URL(request.url);
  const slugParam = reqUrl.searchParams.get("slug");
  const biz       = (slugParam ? businesses.find(b => b.slug === slugParam) : null) ?? businesses[0] ?? null;
  if (!biz) return withCors(jsonErr(404, "No business"), request, { credentials: true });

  // Plan gate — Pro / Enterprise only. Mirror apiUpdateRevenueSettings.
  const planRow = await env.DB
    .prepare("SELECT plan FROM businesses WHERE slug = ?")
    .bind(biz.slug)
    .first<{ plan: string | null }>();
  const plan = planRow?.plan ?? "base";
  if (plan !== "pro" && plan !== "enterprise") {
    return withCors(jsonErr(402, "plan_required"), request, { credentials: true });
  }

  // Date filter mirrors apiTrafficImpact.
  const range    = reqUrl.searchParams.get("range");
  const startQs  = reqUrl.searchParams.get("start_date");
  const endQs    = reqUrl.searchParams.get("end_date");
  let dateFilterSql  = "";
  let dateFilterArgs: string[] = [];
  if (startQs && endQs) {
    dateFilterSql  = " AND date >= ? AND date <= ?";
    dateFilterArgs = [startQs, endQs];
  } else if (range && /^\d+d$/.test(range)) {
    const days   = parseInt(range, 10);
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    dateFilterSql  = " AND date >= ?";
    dateFilterArgs = [cutoff];
  }

  const result = await env.DB
    .prepare(
      `SELECT date, source_class, event_name, event_count, total_revenue, currency
         FROM conversion_daily
        WHERE slug = ?${dateFilterSql}
        ORDER BY date ASC`,
    )
    .bind(biz.slug, ...dateFilterArgs)
    .all<{ date: string; source_class: string; event_name: string; event_count: number; total_revenue: number | null; currency: string | null }>();

  const rows = result.results ?? [];

  // Roll-up: total revenue + count per side, plus per-event breakdown.
  // Currency: dominant by total_revenue.
  let aiRev = 0, humanRev = 0, aiCount = 0, humanCount = 0;
  const eventsByName: Record<string, { ai: number; human: number; revenue: number }> = {};
  const currencyTally: Record<string, number> = {};
  for (const r of rows) {
    if (r.source_class === "ai") {
      aiRev   += r.total_revenue ?? 0;
      aiCount += r.event_count;
    } else {
      humanRev   += r.total_revenue ?? 0;
      humanCount += r.event_count;
    }
    const ev = eventsByName[r.event_name] ?? { ai: 0, human: 0, revenue: 0 };
    if (r.source_class === "ai") ev.ai += r.event_count;
    else                          ev.human += r.event_count;
    ev.revenue += r.total_revenue ?? 0;
    eventsByName[r.event_name] = ev;
    if (r.currency && r.total_revenue) {
      currencyTally[r.currency] = (currencyTally[r.currency] ?? 0) + r.total_revenue;
    }
  }
  const dominantCurrency = Object.entries(currencyTally).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "USD";

  return withCors(
    jsonOk({
      slug:     biz.slug,
      currency: dominantCurrency,
      ai:    { event_count: aiCount,    revenue: aiRev },
      human: { event_count: humanCount, revenue: humanRev },
      events: Object.entries(eventsByName).map(([name, v]) => ({ event_name: name, ...v })),
      // True iff conversion_daily has any rows for this tenant in the
      // selected window. NOT a guarantee that key_events are configured
      // in GA4 — a tenant could have configured them but have zero
      // conversions in this window. The frontend treats false as
      // "no data yet" (could be either: not configured, or configured
      // but no conversions) and shows a configuration hint.
      has_conversion_data: rows.length > 0,
    }),
    request,
    { credentials: true },
  );
}

// ── GET /api/client/traffic-impact/gsc ────────────────────────────────────
// Pro / Enterprise only — 402 for base-tier tenants.
// Returns AI Overview presence stats from the gsc_daily table.

async function apiTrafficImpactGSC(request: Request, env: Env): Promise<Response> {
  const guard = await requireVerifiedSession(request, env);
  if (!guard.ok) return guard.resp;
  const ctx = guard.ctx;

  const businesses = ctx.role === "admin"
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const reqUrl = new URL(request.url);
  const slugParam = reqUrl.searchParams.get("slug");
  const biz = (slugParam ? businesses.find(b => b.slug === slugParam) : null) ?? businesses[0] ?? null;
  if (!biz) return withCors(jsonErr(404, "No business"), request, { credentials: true });

  // Pro plan gate.
  const planRow = await env.DB
    .prepare("SELECT plan FROM businesses WHERE slug = ?")
    .bind(biz.slug)
    .first<{ plan: string | null }>();
  const plan = planRow?.plan ?? "base";
  if (plan !== "pro" && plan !== "enterprise") {
    return withCors(jsonErr(402, "plan_required"), request, { credentials: true });
  }

  // Date filter same shape as apiTrafficImpact.
  const range = reqUrl.searchParams.get("range");
  const startQs = reqUrl.searchParams.get("start_date");
  const endQs   = reqUrl.searchParams.get("end_date");
  let dateFilterSql = "";
  let dateFilterArgs: string[] = [];
  if (startQs && endQs) {
    dateFilterSql = " AND date >= ? AND date <= ?";
    dateFilterArgs = [startQs, endQs];
  } else if (range && /^\d+d$/.test(range)) {
    const days = parseInt(range, 10);
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    dateFilterSql = " AND date >= ?";
    dateFilterArgs = [cutoff];
  }

  // Connection status check first — frontend wants to differentiate
  // not-connected from no-data-yet.
  const conn = await env.DB
    .prepare("SELECT site_url, status FROM gsc_connections WHERE slug = ? LIMIT 1")
    .bind(biz.slug)
    .first<{ site_url: string | null; status: string }>();

  if (!conn || !conn.site_url) {
    return withCors(jsonOk({
      gsc_connected: false,
      slug:          biz.slug,
      site_url:      null,
      total_impressions:       0,
      total_clicks:            0,
      ai_overview_impressions: 0,
      ai_overview_pct:         0,
      cite_rate:               0,
      daily: [],
      top_ai_overview_queries: [],
    }), request, { credentials: true });
  }

  // Per-day rollup: total impressions, AI Overview impressions
  const dailyResult = await env.DB
    .prepare(
      `SELECT date,
              SUM(impressions) AS impressions,
              SUM(clicks)      AS clicks,
              SUM(CASE WHEN ai_overview_shown = 1 THEN impressions ELSE 0 END) AS ai_overview_impressions
         FROM gsc_daily
        WHERE slug = ?${dateFilterSql}
        GROUP BY date
        ORDER BY date ASC`,
    )
    .bind(biz.slug, ...dateFilterArgs)
    .all<{ date: string; impressions: number; clicks: number; ai_overview_impressions: number }>();
  const daily = (dailyResult.results ?? []).map(d => ({
    date: d.date,
    impressions:             d.impressions             ?? 0,
    clicks:                  d.clicks                  ?? 0,
    ai_overview_impressions: d.ai_overview_impressions ?? 0,
  }));

  let totalImpressions = 0, totalClicks = 0, aiOverviewImpressions = 0;
  for (const d of daily) {
    totalImpressions      += d.impressions;
    totalClicks           += d.clicks;
    aiOverviewImpressions += d.ai_overview_impressions;
  }

  // Cite rate: of queries where AI Overview was shown, how many got
  // CLICKS for our customer. Proxy for "we were cited in the Overview"
  // since GSC reports clicks as "user clicked our link" — if the AI
  // Overview was shown AND we got clicks, plausibly we were cited.
  // (NOT 100% accurate — user could have clicked another result on the
  // same SERP — but it's the best signal GSC gives us.)
  const aiOverviewClicksResult = await env.DB
    .prepare(
      `SELECT SUM(clicks) AS clicks
         FROM gsc_daily
        WHERE slug = ? AND ai_overview_shown = 1${dateFilterSql}`,
    )
    .bind(biz.slug, ...dateFilterArgs)
    .first<{ clicks: number | null }>();
  const aiOverviewClicks = aiOverviewClicksResult?.clicks ?? 0;
  const citeRate = aiOverviewImpressions > 0 ? aiOverviewClicks / aiOverviewImpressions : 0;

  // Top AI Overview queries — for the table
  const topAiResult = await env.DB
    .prepare(
      `SELECT query, SUM(impressions) AS impressions, SUM(clicks) AS clicks
         FROM gsc_daily
        WHERE slug = ? AND ai_overview_shown = 1${dateFilterSql}
        GROUP BY query
        ORDER BY impressions DESC
        LIMIT 10`,
    )
    .bind(biz.slug, ...dateFilterArgs)
    .all<{ query: string; impressions: number; clicks: number }>();

  return withCors(
    jsonOk({
      gsc_connected:           true,
      slug:                    biz.slug,
      site_url:                conn.site_url,
      total_impressions:       totalImpressions,
      total_clicks:            totalClicks,
      ai_overview_impressions: aiOverviewImpressions,
      ai_overview_pct:         totalImpressions > 0 ? aiOverviewImpressions / totalImpressions : 0,
      cite_rate:               citeRate,
      daily,
      top_ai_overview_queries: topAiResult.results ?? [],
    }),
    request,
    { credentials: true },
  );
}

// ── GET /api/client/traffic-impact/verified-revenue ───────────────────────
// Pro / Enterprise only — 402 for base-tier tenants.
// Returns verified-revenue rollup with AI vs unknown attribution split.
// Phase 4 PR 1 — first-touch time-window attribution via click_events.

async function apiTrafficImpactVerifiedRevenue(request: Request, env: Env): Promise<Response> {
  const guard = await requireVerifiedSession(request, env);
  if (!guard.ok) return guard.resp;
  const ctx = guard.ctx;

  const businesses = ctx.role === "admin"
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const reqUrl    = new URL(request.url);
  const slugParam = reqUrl.searchParams.get("slug");
  const biz       = (slugParam ? businesses.find(b => b.slug === slugParam) : null) ?? businesses[0] ?? null;
  if (!biz) return withCors(jsonErr(404, "No business"), request, { credentials: true });

  // Pro plan gate — mirror apiTrafficImpactGSC.
  const planRow = await env.DB
    .prepare("SELECT plan FROM businesses WHERE slug = ?")
    .bind(biz.slug)
    .first<{ plan: string | null }>();
  const plan = planRow?.plan ?? "base";
  if (plan !== "pro" && plan !== "enterprise") {
    return withCors(jsonErr(402, "plan_required"), request, { credentials: true });
  }

  // Date filter same shape as apiTrafficImpact. revenue_events uses
  // occurred_at (ISO-8601 TEXT), not a date column, so we filter against it.
  const range    = reqUrl.searchParams.get("range");
  const startQs  = reqUrl.searchParams.get("start_date");
  const endQs    = reqUrl.searchParams.get("end_date");
  let dateFilterSql  = "";
  let dateFilterArgs: string[] = [];
  if (startQs && endQs) {
    dateFilterSql  = " AND occurred_at >= ? AND occurred_at <= ?";
    dateFilterArgs = [startQs, endQs];
  } else if (range && /^\d+d$/.test(range)) {
    const days   = parseInt(range, 10);
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    dateFilterSql  = " AND occurred_at >= ?";
    dateFilterArgs = [cutoff];
  }

  // Roll-up: total verified revenue, AI vs unknown split, event counts.
  const summary = await env.DB
    .prepare(
      `SELECT
         SUM(CASE WHEN referrer_classification = 'ai' THEN amount_cents ELSE 0 END) AS ai_cents,
         SUM(CASE WHEN referrer_classification IS NULL OR referrer_classification = 'unknown' THEN amount_cents ELSE 0 END) AS unknown_cents,
         COUNT(*) AS total_events,
         SUM(CASE WHEN referrer_classification = 'ai' THEN 1 ELSE 0 END) AS ai_events
       FROM revenue_events
      WHERE business_slug = ?${dateFilterSql}`,
    )
    .bind(biz.slug, ...dateFilterArgs)
    .first<{ ai_cents: number; unknown_cents: number; total_events: number; ai_events: number }>();

  // Recent events (last 10) for the table.
  const recent = await env.DB
    .prepare(
      `SELECT amount_cents, currency, occurred_at, referrer_classification, first_touch_source
         FROM revenue_events
        WHERE business_slug = ?${dateFilterSql}
        ORDER BY occurred_at DESC
        LIMIT 10`,
    )
    .bind(biz.slug, ...dateFilterArgs)
    .all<{ amount_cents: number; currency: string; occurred_at: string; referrer_classification: string | null; first_touch_source: string | null }>();

  // Webhook configuration status — presence of revenue_webhook_secret.
  // Never expose the secret itself.
  const config = await env.DB
    .prepare("SELECT revenue_webhook_secret IS NOT NULL AS has_secret, revenue_currency FROM businesses WHERE slug = ?")
    .bind(biz.slug)
    .first<{ has_secret: number; revenue_currency: string | null }>();

  return withCors(
    jsonOk({
      slug:               biz.slug,
      currency:           config?.revenue_currency ?? "USD",
      webhook_configured: !!(config?.has_secret),
      ai_cents:           summary?.ai_cents         ?? 0,
      unknown_cents:      summary?.unknown_cents     ?? 0,
      total_events:       summary?.total_events      ?? 0,
      ai_events:          summary?.ai_events         ?? 0,
      recent_events:      recent.results             ?? [],
    }),
    request,
    { credentials: true },
  );
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

// ═══════════════════════════════════════════════════════════════════════════════
// HubSpot CRM — Phase 5 PR 1 of the Traffic Impact data-depth roadmap.
//
// Passthrough architecture: we never persist contact data in D1. The LTV
// endpoint fetches contacts live on every request and returns an aggregate.
// ═══════════════════════════════════════════════════════════════════════════════

// ── GET /oauth/hubspot/start (protected wrapper) ───────────────────────────

async function handleHubspotStartProtected(request: Request, env: Env): Promise<Response> {
  const guard = await requireVerifiedSession(request, env);
  if (!guard.ok) return guard.resp;
  const ctx = guard.ctx;

  const reqUrl   = new URL(request.url);
  const querySlug = reqUrl.searchParams.get("slug");
  if (!querySlug) return withCors(jsonErr(400, "slug query param required"), request, { credentials: true });

  const businesses = ctx.role === "admin"
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const owns = businesses.some(b => b.slug === querySlug);
  if (!owns) return withCors(jsonErr(403, "no access to this business"), request, { credentials: true });

  // Pro plan gate — HubSpot CRM is a Pro feature.
  const planRow = await env.DB
    .prepare("SELECT plan FROM businesses WHERE slug = ?")
    .bind(querySlug)
    .first<{ plan: string | null }>();
  const plan = planRow?.plan ?? "base";
  if (plan !== "pro" && plan !== "enterprise") {
    return withCors(jsonErr(402, "plan_required"), request, { credentials: true });
  }

  return handleHubspotStart(request, env);
}

// ── GET /oauth/salesforce/start (protected wrapper) ───────────────────────────

async function handleSalesforceStartProtected(request: Request, env: Env): Promise<Response> {
  const guard = await requireVerifiedSession(request, env);
  if (!guard.ok) return guard.resp;
  const ctx = guard.ctx;

  const reqUrl    = new URL(request.url);
  const querySlug = reqUrl.searchParams.get("slug");
  if (!querySlug) return withCors(jsonErr(400, "slug query param required"), request, { credentials: true });

  const businesses = ctx.role === "admin"
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const owns = businesses.some(b => b.slug === querySlug);
  if (!owns) return withCors(jsonErr(403, "no access to this business"), request, { credentials: true });

  // Pro plan gate — Salesforce CRM is a Pro feature.
  const planRow = await env.DB
    .prepare("SELECT plan FROM businesses WHERE slug = ?")
    .bind(querySlug)
    .first<{ plan: string | null }>();
  const plan = planRow?.plan ?? "base";
  if (plan !== "pro" && plan !== "enterprise") {
    return withCors(jsonErr(402, "plan_required"), request, { credentials: true });
  }

  return handleSalesforceStart(request, env);
}

// ── POST /api/client/crm/start-link?provider=hubspot ─────────────────────────
//
// JSON-returning counterpart of /oauth/hubspot/start. Frontend calls this
// with bearer auth, receives { url }, then sets window.location.href = url.
// Mirrors apiGSCStartLink's pattern exactly.

async function apiCrmStartLink(request: Request, env: Env): Promise<Response> {
  const guard = await requireVerifiedSession(request, env);
  if (!guard.ok) return guard.resp;
  const ctx = guard.ctx;

  const reqUrl    = new URL(request.url);
  const querySlug = reqUrl.searchParams.get("slug");
  const provider  = reqUrl.searchParams.get("provider") ?? "hubspot";

  if (!querySlug) {
    return withCors(jsonErr(400, "slug query param required"), request, { credentials: true });
  }

  if (provider !== "hubspot" && provider !== "salesforce") {
    return withCors(jsonErr(400, "provider_not_supported_yet"), request, { credentials: true });
  }

  const businesses = ctx.role === "admin"
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const owns = businesses.some(b => b.slug === querySlug);
  if (!owns) {
    return withCors(jsonErr(403, "no access to this business"), request, { credentials: true });
  }

  // Pro plan gate
  const planRow = await env.DB
    .prepare("SELECT plan FROM businesses WHERE slug = ?")
    .bind(querySlug)
    .first<{ plan: string | null }>();
  const plan = planRow?.plan ?? "base";
  if (plan !== "pro" && plan !== "enterprise") {
    return withCors(jsonErr(402, "plan_required"), request, { credentials: true });
  }

  if (provider === "hubspot") {
    if (!env.TOKEN_SIGNING_KEY || !env.HUBSPOT_OAUTH_CLIENT_ID || !env.HUBSPOT_OAUTH_REDIRECT_URI) {
      return withCors(jsonErr(503, "HubSpot integration not configured"), request, { credentials: true });
    }

    const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
    const nonce = Array.from(nonceBytes).map((b) => b.toString(16).padStart(2, "0")).join("");
    const state = await signState(
      { slug: querySlug, nonce, ts: Math.floor(Date.now() / 1000) },
      env.TOKEN_SIGNING_KEY,
      "hubspot-state:v1:",
    );

    const params = new URLSearchParams({
      client_id:    env.HUBSPOT_OAUTH_CLIENT_ID,
      redirect_uri: env.HUBSPOT_OAUTH_REDIRECT_URI,
      scope:        "crm.objects.contacts.read crm.objects.deals.read",
      state,
    });
    const url = `https://app.hubspot.com/oauth/authorize?${params.toString()}`;

    return withCors(jsonOk({ url }), request, { credentials: true });
  } else {
    // provider === "salesforce"
    if (!env.TOKEN_SIGNING_KEY || !env.SALESFORCE_OAUTH_CLIENT_ID || !env.SALESFORCE_OAUTH_REDIRECT_URI) {
      return withCors(jsonErr(503, "Salesforce integration not configured"), request, { credentials: true });
    }

    const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
    const nonce = Array.from(nonceBytes).map((b) => b.toString(16).padStart(2, "0")).join("");
    const state = await signState(
      { slug: querySlug, nonce, ts: Math.floor(Date.now() / 1000) },
      env.TOKEN_SIGNING_KEY,
      "salesforce-state:v1:",
    );

    const params = new URLSearchParams({
      client_id:     env.SALESFORCE_OAUTH_CLIENT_ID,
      redirect_uri:  env.SALESFORCE_OAUTH_REDIRECT_URI,
      scope:         "api refresh_token offline_access",
      response_type: "code",
      state,
    });
    const url = `https://login.salesforce.com/services/oauth2/authorize?${params.toString()}`;

    return withCors(jsonOk({ url }), request, { credentials: true });
  }
}

// ── GET /api/client/crm/status?provider=hubspot ───────────────────────────────

async function apiCrmStatus(request: Request, env: Env): Promise<Response> {
  const guard = await requireVerifiedSession(request, env);
  if (!guard.ok) return guard.resp;
  const ctx = guard.ctx;

  const businesses = ctx.role === "admin"
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const reqUrl    = new URL(request.url);
  const slugParam = reqUrl.searchParams.get("slug");
  const provider  = reqUrl.searchParams.get("provider") ?? "hubspot";
  const biz = (slugParam ? businesses.find(b => b.slug === slugParam) : null) ?? businesses[0] ?? null;
  if (!biz) {
    return withCors(jsonOk({ connected: false }), request, { credentials: true });
  }

  const row = await env.DB
    .prepare("SELECT provider, status, last_used_at, last_error, connected_at FROM crm_connections WHERE slug = ? AND provider = ? LIMIT 1")
    .bind(biz.slug, provider)
    .first<{
      provider:    string;
      status:      string;
      last_used_at: string | null;
      last_error:  string | null;
      connected_at: string;
    }>();

  if (!row) {
    return withCors(jsonOk({ connected: false, slug: biz.slug, provider }), request, { credentials: true });
  }

  return withCors(
    jsonOk({
      connected:    true,
      slug:         biz.slug,
      provider:     row.provider,
      status:       row.status,
      last_used_at: row.last_used_at,
      last_error:   row.last_error,
      connected_at: row.connected_at,
    }),
    request,
    { credentials: true },
  );
}

// ── POST /api/client/crm/disconnect?provider=hubspot ─────────────────────────

async function apiCrmDisconnect(request: Request, env: Env): Promise<Response> {
  const guard = await requireVerifiedSession(request, env);
  if (!guard.ok) return guard.resp;
  const ctx = guard.ctx;

  const businesses = ctx.role === "admin"
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const reqUrl    = new URL(request.url);
  const slugParam = reqUrl.searchParams.get("slug");
  const provider  = reqUrl.searchParams.get("provider") ?? "hubspot";
  const biz = (slugParam ? businesses.find(b => b.slug === slugParam) : null) ?? businesses[0] ?? null;
  if (!biz) {
    return withCors(jsonErr(404, "No business"), request, { credentials: true });
  }

  await env.DB
    .prepare("DELETE FROM crm_connections WHERE slug = ? AND provider = ?")
    .bind(biz.slug, provider)
    .run();
  return withCors(jsonOk({ ok: true }), request, { credentials: true });
}

// ── GET /api/client/traffic-impact/ltv ───────────────────────────────────────
//
// Passthrough: fetches contacts live from HubSpot, cross-references with
// click_events, returns aggregate LTV split by AI vs unknown attribution.
// No contact data is persisted in D1 at any point.

async function apiTrafficImpactLtv(request: Request, env: Env): Promise<Response> {
  const guard = await requireVerifiedSession(request, env);
  if (!guard.ok) return guard.resp;
  const ctx = guard.ctx;

  const businesses = ctx.role === "admin"
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const reqUrl    = new URL(request.url);
  const slugParam = reqUrl.searchParams.get("slug");
  const biz = (slugParam ? businesses.find(b => b.slug === slugParam) : null) ?? businesses[0] ?? null;
  if (!biz) return withCors(jsonErr(404, "No business"), request, { credentials: true });

  // Pro plan gate — CRM LTV is a Pro feature per the data-depth roadmap.
  const planRow = await env.DB
    .prepare("SELECT plan FROM businesses WHERE slug = ?")
    .bind(biz.slug)
    .first<{ plan: string | null }>();
  const plan = planRow?.plan ?? "base";
  if (plan !== "pro" && plan !== "enterprise") {
    return withCors(jsonErr(402, "plan_required"), request, { credentials: true });
  }

  // Date filter — for LTV, 'since' is more useful than a window. Default 90 days.
  const range = reqUrl.searchParams.get("range");
  let cutoff: string;
  if (range && /^\d+d$/.test(range)) {
    const days = parseInt(range, 10);
    cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  } else {
    cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  }

  // Look up CRM connection — supports hubspot and salesforce.
  const conn = await env.DB
    .prepare("SELECT provider, refresh_token_enc, account_id FROM crm_connections WHERE slug = ? AND status = 'connected' LIMIT 1")
    .bind(biz.slug)
    .first<{ provider: string; refresh_token_enc: string; account_id: string | null }>();

  if (!conn) {
    return withCors(
      jsonOk({ crm_connected: false, slug: biz.slug, ai: emptyBucket(), unknown: emptyBucket(), since: cutoff }),
      request,
      { credentials: true },
    );
  }

  if (conn.provider === "hubspot") {
    if (!env.GA4_TOKEN_ENCRYPTION_KEY || !env.HUBSPOT_OAUTH_CLIENT_ID || !env.HUBSPOT_OAUTH_CLIENT_SECRET) {
      return withCors(jsonErr(503, "HubSpot integration not configured"), request, { credentials: true });
    }

    try {
      const refreshToken = await decryptToken(conn.refresh_token_enc, env.GA4_TOKEN_ENCRYPTION_KEY);
      const { accessToken } = await refreshHubspotAccessToken(
        refreshToken,
        env.HUBSPOT_OAUTH_CLIENT_ID,
        env.HUBSPOT_OAUTH_CLIENT_SECRET,
      );

      const contacts = await fetchContactsWithRevenue({ accessToken, createdAfter: cutoff, maxContacts: 1000 });

      const clickEventsResult = await env.DB
        .prepare("SELECT ref, timestamp FROM click_events WHERE business_slug = ? AND timestamp >= ? ORDER BY timestamp DESC LIMIT 5000")
        .bind(biz.slug, cutoff)
        .all<{ ref: string | null; timestamp: string }>();
      const clickEvents = clickEventsResult.results ?? [];

      const result = aggregateLtv(contacts, clickEvents);

      // Track last activity — useful for ops visibility into active connections.
      await env.DB
        .prepare("UPDATE crm_connections SET last_used_at = ?, last_error = NULL WHERE slug = ? AND provider = ?")
        .bind(new Date().toISOString(), biz.slug, "hubspot")
        .run();

      const trend = await fetchLtvTrend(env.DB, biz.slug, "hubspot");

      return withCors(
        jsonOk({
          crm_connected:  true,
          provider:       "hubspot",
          slug:           biz.slug,
          since:          cutoff,
          ai:             result.ai,
          unknown:        result.unknown,
          errored:        result.errored,
          total_contacts: result.ai.contact_count + result.unknown.contact_count + result.errored,
          trend,
        }),
        request,
        { credentials: true },
      );
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err).slice(0, 500);
      await env.DB
        .prepare("UPDATE crm_connections SET last_error = ? WHERE slug = ? AND provider = ?")
        .bind(msg, biz.slug, "hubspot")
        .run();
      return withCors(jsonErr(502, "Failed to fetch CRM data"), request, { credentials: true });
    }
  } else if (conn.provider === "salesforce") {
    // TODO(Phase 5 PR 3): extract cross-reference + aggregation into a shared
    // helper — the logic below is structurally identical to the HubSpot path
    // above; the only difference is the CRM client called. Deferred to keep
    // this PR scope tight.
    if (!env.SALESFORCE_OAUTH_CLIENT_ID || !env.SALESFORCE_OAUTH_CLIENT_SECRET) {
      return withCors(jsonErr(503, "Salesforce integration not configured"), request, { credentials: true });
    }

    if (!env.GA4_TOKEN_ENCRYPTION_KEY) {
      return withCors(jsonErr(503, "Token encryption not configured"), request, { credentials: true });
    }

    try {
      const refreshToken = await decryptToken(conn.refresh_token_enc, env.GA4_TOKEN_ENCRYPTION_KEY);
      const { accessToken, instanceUrl } = await refreshSalesforceAccessToken(
        refreshToken,
        env.SALESFORCE_OAUTH_CLIENT_ID,
        env.SALESFORCE_OAUTH_CLIENT_SECRET,
      );

      // Use instance_url from the fresh token response — it may differ from
      // the stored account_id if the org migrated since OAuth time.
      const contacts = await fetchSalesforceContactsWithRevenue({
        accessToken,
        instanceUrl,
        createdAfter: cutoff,
        maxContacts:  1000,
      });

      const clickEventsResult = await env.DB
        .prepare("SELECT ref, timestamp FROM click_events WHERE business_slug = ? AND timestamp >= ? ORDER BY timestamp DESC LIMIT 5000")
        .bind(biz.slug, cutoff)
        .all<{ ref: string | null; timestamp: string }>();
      const clickEvents = clickEventsResult.results ?? [];

      const result = aggregateLtv(contacts, clickEvents);

      // Track last activity and refresh account_id if instance_url changed.
      await env.DB
        .prepare("UPDATE crm_connections SET last_used_at = ?, last_error = NULL, account_id = ? WHERE slug = ? AND provider = ?")
        .bind(new Date().toISOString(), instanceUrl, biz.slug, "salesforce")
        .run();

      const trend = await fetchLtvTrend(env.DB, biz.slug, "salesforce");

      return withCors(
        jsonOk({
          crm_connected:  true,
          provider:       "salesforce",
          slug:           biz.slug,
          since:          cutoff,
          ai:             result.ai,
          unknown:        result.unknown,
          errored:        result.errored,
          total_contacts: result.ai.contact_count + result.unknown.contact_count + result.errored,
          trend,
        }),
        request,
        { credentials: true },
      );
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err).slice(0, 500);
      await env.DB
        .prepare("UPDATE crm_connections SET last_error = ? WHERE slug = ? AND provider = ?")
        .bind(msg, biz.slug, "salesforce")
        .run();
      return withCors(jsonErr(502, "Failed to fetch CRM data"), request, { credentials: true });
    }
  } else {
    // Unknown provider — guard against future schema drift.
    return withCors(
      jsonOk({ crm_connected: true, provider: conn.provider, slug: biz.slug, ai: emptyBucket(), unknown: emptyBucket(), since: cutoff, error: "provider_not_supported_yet" }),
      request,
      { credentials: true },
    );
  }
}

function emptyBucket() {
  return { contact_count: 0, customer_count: 0, total_revenue_cents: 0, avg_ltv_cents: 0 };
}

// ── fetchLtvTrend ─────────────────────────────────────────────────────────────
//
// Reads ltv_daily rows for the given slug + provider (last 90 days),
// collapses the ai and unknown source_class rows by date into a single
// trend entry per day. Returns [] when no snapshot rows exist yet.

interface LtvTrendEntry {
  date:    string;
  ai:      { contact_count: number; customer_count: number; total_revenue_cents: number; avg_ltv_cents: number };
  unknown: { contact_count: number; customer_count: number; total_revenue_cents: number; avg_ltv_cents: number };
}

async function fetchLtvTrend(
  db:       D1Database,
  slug:     string,
  provider: string,
): Promise<LtvTrendEntry[]> {
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const result = await db
    .prepare(
      `SELECT date, source_class, contact_count, customer_count, total_revenue_cents, avg_ltv_cents
         FROM ltv_daily
        WHERE slug = ? AND provider = ? AND date >= ?
        ORDER BY date ASC`,
    )
    .bind(slug, provider, cutoff)
    .all<{
      date:                string;
      source_class:        string;
      contact_count:       number;
      customer_count:      number;
      total_revenue_cents: number;
      avg_ltv_cents:       number;
    }>();

  const rows = result.results ?? [];
  if (rows.length === 0) return [];

  // Collapse ai + unknown rows by date into a single entry per date.
  const byDate = new Map<string, LtvTrendEntry>();
  for (const r of rows) {
    if (!byDate.has(r.date)) {
      byDate.set(r.date, {
        date:    r.date,
        ai:      { contact_count: 0, customer_count: 0, total_revenue_cents: 0, avg_ltv_cents: 0 },
        unknown: { contact_count: 0, customer_count: 0, total_revenue_cents: 0, avg_ltv_cents: 0 },
      });
    }
    const entry = byDate.get(r.date)!;
    if (r.source_class === "ai" || r.source_class === "unknown") {
      entry[r.source_class] = {
        contact_count:       r.contact_count,
        customer_count:      r.customer_count,
        total_revenue_cents: r.total_revenue_cents,
        avg_ltv_cents:       r.avg_ltv_cents,
      };
    }
  }

  return Array.from(byDate.values());
}

// ── GET /api/client/authority/status ─────────────────────────────────────────
// Pro-gated. Returns the tenant's authority_config row (if any) + a summary
// of the latest off_site_authority_daily rows (last 30 days, grouped by
// platform).

async function apiAuthorityStatus(request: Request, env: Env): Promise<Response> {
  const guard = await requireVerifiedSession(request, env);
  if (!guard.ok) return guard.resp;
  const ctx = guard.ctx;

  const businesses = ctx.role === "admin"
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const slug = new URL(request.url).searchParams.get("slug");
  const biz  = (slug ? businesses.find((b) => b.slug === slug) : null) ?? businesses[0] ?? null;
  if (!biz) return withCors(jsonErr(404, "No business found for this account"), request, { credentials: true });

  const planRow = await env.DB
    .prepare("SELECT plan FROM businesses WHERE slug = ?")
    .bind(biz.slug)
    .first<{ plan: string | null }>();
  const plan = planRow?.plan ?? "base";
  if (plan !== "pro" && plan !== "enterprise") {
    return withCors(jsonErr(402, "plan_required"), request, { credentials: true });
  }

  const config = await env.DB
    .prepare(
      `SELECT slug, brand_keyword, reddit_enabled, google_place_id,
              configured_at, last_synced_at, last_sync_error
         FROM authority_config
        WHERE slug = ?`,
    )
    .bind(biz.slug)
    .first<{
      slug:             string;
      brand_keyword:    string | null;
      reddit_enabled:   number;
      google_place_id:  string | null;
      configured_at:    string | null;
      last_synced_at:   string | null;
      last_sync_error:  string | null;
    }>();

  // Fetch last 30 days of aggregate summary per platform.
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const recentRows = await env.DB
    .prepare(
      `SELECT platform, SUM(mention_count) as total_mentions,
              SUM(positive_count) as total_positive,
              SUM(negative_count) as total_negative,
              AVG(avg_sentiment) as avg_sentiment,
              MAX(rating) as latest_rating,
              MAX(rating_count) as latest_rating_count
         FROM off_site_authority_daily
        WHERE slug = ? AND date >= ?
        GROUP BY platform`,
    )
    .bind(biz.slug, cutoff)
    .all<{
      platform:             string;
      total_mentions:       number;
      total_positive:       number;
      total_negative:       number;
      avg_sentiment:        number | null;
      latest_rating:        number | null;
      latest_rating_count:  number | null;
    }>();

  return withCors(
    jsonOk({
      configured: config !== null,
      config:     config ?? null,
      summary:    recentRows.results ?? [],
    }),
    request,
    { credentials: true },
  );
}

// ── POST /api/client/authority/configure ──────────────────────────────────────
// Pro-gated. Upserts authority_config row.
// Body: { brand_keyword?: string, google_place_id?: string }

const GOOGLE_PLACE_ID_RE = /^[A-Za-z0-9_]{20,200}$/;

async function apiAuthorityConfigure(request: Request, env: Env): Promise<Response> {
  const guard = await requireVerifiedSession(request, env);
  if (!guard.ok) return guard.resp;
  const ctx = guard.ctx;

  const businesses = ctx.role === "admin"
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const slug = new URL(request.url).searchParams.get("slug");
  const biz  = (slug ? businesses.find((b) => b.slug === slug) : null) ?? businesses[0] ?? null;
  if (!biz) return withCors(jsonErr(404, "No business found for this account"), request, { credentials: true });

  const planRow = await env.DB
    .prepare("SELECT plan FROM businesses WHERE slug = ?")
    .bind(biz.slug)
    .first<{ plan: string | null }>();
  const plan = planRow?.plan ?? "base";
  if (plan !== "pro" && plan !== "enterprise") {
    return withCors(jsonErr(402, "plan_required"), request, { credentials: true });
  }

  let body: { brand_keyword?: unknown; google_place_id?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return withCors(jsonErr(400, "Body must be JSON"), request, { credentials: true });
  }

  // Validate brand_keyword (optional — null clears it)
  let brandKeyword: string | null = null;
  if (body.brand_keyword !== undefined && body.brand_keyword !== null) {
    if (typeof body.brand_keyword !== "string") {
      return withCors(jsonErr(400, "brand_keyword must be a string"), request, { credentials: true });
    }
    const trimmed = body.brand_keyword.trim();
    if (trimmed.length < 1 || trimmed.length > 100) {
      return withCors(jsonErr(400, "brand_keyword must be 1–100 characters"), request, { credentials: true });
    }
    brandKeyword = trimmed;
  }

  // Validate google_place_id (optional — null clears it)
  let googlePlaceId: string | null = null;
  if (body.google_place_id !== undefined && body.google_place_id !== null) {
    if (typeof body.google_place_id !== "string") {
      return withCors(jsonErr(400, "google_place_id must be a string"), request, { credentials: true });
    }
    if (!GOOGLE_PLACE_ID_RE.test(body.google_place_id)) {
      return withCors(
        jsonErr(400, "google_place_id must be alphanumeric/underscores, 20–200 characters"),
        request,
        { credentials: true },
      );
    }
    googlePlaceId = body.google_place_id;
  }

  const configuredAt = new Date().toISOString();
  await env.DB
    .prepare(
      `INSERT OR REPLACE INTO authority_config
         (slug, brand_keyword, reddit_enabled, google_place_id, configured_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(
      biz.slug,
      brandKeyword,
      brandKeyword !== null ? 1 : 0,
      googlePlaceId,
      configuredAt,
    )
    .run();

  return withCors(
    jsonOk({ ok: true, slug: biz.slug, brand_keyword: brandKeyword, google_place_id: googlePlaceId }),
    request,
    { credentials: true },
  );
}

// ── GET /api/client/traffic-impact/authority ──────────────────────────────────
// Pro / Enterprise only — 402 for base-tier tenants.
// Returns aggregated off-site authority stats per platform plus a daily
// time-series and top mentions, so the dashboard can render the Authority Kit
// section without a second round-trip to /authority/status.

async function apiTrafficImpactAuthority(request: Request, env: Env): Promise<Response> {
  const guard = await requireVerifiedSession(request, env);
  if (!guard.ok) return guard.resp;
  const ctx = guard.ctx;

  const businesses = ctx.role === "admin"
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const reqUrl    = new URL(request.url);
  const slugParam = reqUrl.searchParams.get("slug");
  const biz = (slugParam ? businesses.find(b => b.slug === slugParam) : null) ?? businesses[0] ?? null;
  if (!biz) return withCors(jsonErr(404, "No business"), request, { credentials: true });

  // Pro plan gate — mirror apiTrafficImpactGSC.
  const planRow = await env.DB
    .prepare("SELECT plan FROM businesses WHERE slug = ?")
    .bind(biz.slug)
    .first<{ plan: string | null }>();
  const plan = planRow?.plan ?? "base";
  if (plan !== "pro" && plan !== "enterprise") {
    return withCors(jsonErr(402, "plan_required"), request, { credentials: true });
  }

  // Default range: last 30 days.
  const range = reqUrl.searchParams.get("range");
  let cutoff: string;
  if (range && /^\d+d$/.test(range)) {
    const days = parseInt(range, 10);
    cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  } else {
    cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }

  // Per-platform roll-up.
  const result = await env.DB
    .prepare(
      `SELECT platform,
              SUM(mention_count)   AS mentions,
              SUM(positive_count)  AS positive,
              SUM(neutral_count)   AS neutral,
              SUM(negative_count)  AS negative,
              AVG(avg_sentiment)   AS avg_sentiment,
              MAX(rating)          AS rating,
              MAX(rating_count)    AS rating_count,
              MAX(date)            AS last_date
         FROM off_site_authority_daily
        WHERE slug = ? AND date >= ?
        GROUP BY platform`,
    )
    .bind(biz.slug, cutoff)
    .all<{
      platform: string;
      mentions: number;
      positive: number;
      neutral: number;
      negative: number;
      avg_sentiment: number | null;
      rating: number | null;
      rating_count: number | null;
      last_date: string;
    }>();

  // Daily series for the line chart (mention counts per day per platform).
  const dailyResult = await env.DB
    .prepare(
      `SELECT date, platform, mention_count, avg_sentiment
         FROM off_site_authority_daily
        WHERE slug = ? AND date >= ?
        ORDER BY date ASC`,
    )
    .bind(biz.slug, cutoff)
    .all<{ date: string; platform: string; mention_count: number; avg_sentiment: number | null }>();

  // Recent top-3 mentions across the latest day with data.
  const topResult = await env.DB
    .prepare(
      `SELECT platform, top_mentions_json
         FROM off_site_authority_daily
        WHERE slug = ? AND top_mentions_json IS NOT NULL
        ORDER BY date DESC
        LIMIT 5`,
    )
    .bind(biz.slug)
    .all<{ platform: string; top_mentions_json: string }>();

  // Pull config so the frontend knows what's been wired.
  const config = await env.DB
    .prepare("SELECT brand_keyword, google_place_id, last_synced_at, last_sync_error FROM authority_config WHERE slug = ? LIMIT 1")
    .bind(biz.slug)
    .first<{ brand_keyword: string | null; google_place_id: string | null; last_synced_at: string | null; last_sync_error: string | null }>();

  return withCors(
    jsonOk({
      slug:            biz.slug,
      configured:      !!(config && (config.brand_keyword || config.google_place_id)),
      brand_keyword:   config?.brand_keyword ?? null,
      google_place_id: config?.google_place_id ?? null,
      last_synced_at:  config?.last_synced_at ?? null,
      last_sync_error: config?.last_sync_error ?? null,
      platforms:       result.results ?? [],
      daily:           dailyResult.results ?? [],
      top_mentions:    (topResult.results ?? []).map(r => ({
        platform: r.platform,
        mentions: (() => { try { return JSON.parse(r.top_mentions_json) as unknown[]; } catch { return []; } })(),
      })),
    }),
    request,
    { credentials: true },
  );
}

// ── POST /api/client/authority/disconnect ─────────────────────────────────────
// Pro-gated. Clears authority_config row (stops future syncing).
// Historical off_site_authority_daily rows are preserved by default.
// Body: { delete_history?: boolean }

async function apiAuthorityDisconnect(request: Request, env: Env): Promise<Response> {
  const guard = await requireVerifiedSession(request, env);
  if (!guard.ok) return guard.resp;
  const ctx = guard.ctx;

  const businesses = ctx.role === "admin"
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const slug = new URL(request.url).searchParams.get("slug");
  const biz  = (slug ? businesses.find((b) => b.slug === slug) : null) ?? businesses[0] ?? null;
  if (!biz) return withCors(jsonErr(404, "No business found for this account"), request, { credentials: true });

  const planRow = await env.DB
    .prepare("SELECT plan FROM businesses WHERE slug = ?")
    .bind(biz.slug)
    .first<{ plan: string | null }>();
  const plan = planRow?.plan ?? "base";
  if (plan !== "pro" && plan !== "enterprise") {
    return withCors(jsonErr(402, "plan_required"), request, { credentials: true });
  }

  let body: { delete_history?: unknown } = {};
  try {
    body = await request.json() as typeof body;
  } catch {
    // Missing body is fine — delete_history defaults to false.
  }

  const deleteHistory = body.delete_history === true;

  // Delete the config row — this stops future syncing.
  await env.DB
    .prepare("DELETE FROM authority_config WHERE slug = ?")
    .bind(biz.slug)
    .run();

  // Optionally purge historical aggregate rows.
  if (deleteHistory) {
    await env.DB
      .prepare("DELETE FROM off_site_authority_daily WHERE slug = ?")
      .bind(biz.slug)
      .run();
  }

  return withCors(
    jsonOk({ ok: true, slug: biz.slug, history_deleted: deleteHistory }),
    request,
    { credentials: true },
  );
}

