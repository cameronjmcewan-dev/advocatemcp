// Client portal: login, logout, dashboard, and protected JSON API.
// All HTML is server-rendered — no client-side framework required.

import type { Env } from "../types";
import {
  generateSalt, hashPassword, verifyPassword,
  getSessionToken, sessionCookieHeader, clearSessionCookieHeader,
} from "../auth";
import {
  getUserByEmail, createUser, updateUserPassword, createSession, getSessionByToken,
  deleteSession, getUserBusinesses, getBusinessBySlug, createBusiness,
  grantAccess, checkRateLimit, recordLoginAttempt,
} from "../portalDb";
import type { Business, User, SessionWithUser } from "../portalDb";

// ── Public route dispatcher ────────────────────────────────────────────────
// Returns a Response if this is a portal path, or null to fall through to
// the existing AI-crawler logic.

export async function handlePortal(request: Request, env: Env): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  const method = request.method;

  if (pathname === "/login"               && method === "GET")  return loginPage(request, env);
  if (pathname === "/auth/login"          && method === "POST") return authLogin(request, env);
  if (pathname === "/auth/logout"         && method === "POST") return authLogout(request, env);
  if (pathname === "/dashboard"           && method === "GET")  return dashboard(request, env);
  if (pathname === "/api/client/me"       && method === "GET")  return apiMe(request, env);
  if (pathname === "/api/client/metrics"  && method === "GET")  return apiMetrics(request, env);
  if (pathname === "/api/client/activity" && method === "GET")  return apiActivity(request, env);
  if (pathname === "/admin/create-client" && method === "POST") return adminCreateClient(request, env);
  if (pathname === "/status"              && method === "GET")  return statusPage(request, env);

  return null;
}

// ── Session helper ─────────────────────────────────────────────────────────

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
  const session = await requireSession(request, env);
  if (!session) return redirect("/login?error=expired");

  const businesses = await getUserBusinesses(env.DB, session.user_id);
  const slug = new URL(request.url).searchParams.get("slug");
  const selected = (slug ? businesses.find((b) => b.slug === slug) : null) ?? businesses[0] ?? null;

  const analytics = selected ? await fetchAnalytics(selected, env) : null;

  return html(dashboardHtml(session.user, businesses, selected, analytics));
}

// ── GET /api/client/me ─────────────────────────────────────────────────────

async function apiMe(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env);
  if (!session) return jsonErr(401, "Unauthorized");
  return jsonOk({ id: session.user.id, email: session.user.email, full_name: session.user.full_name, role: session.user.role });
}

// ── GET /api/client/metrics ────────────────────────────────────────────────

async function apiMetrics(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env);
  if (!session) return jsonErr(401, "Unauthorized");

  const businesses = await getUserBusinesses(env.DB, session.user_id);
  const slug = new URL(request.url).searchParams.get("slug");
  const biz  = (slug ? businesses.find((b) => b.slug === slug) : null) ?? businesses[0] ?? null;
  if (!biz) return jsonErr(404, "No business found for this account");

  const data = await fetchAnalytics(biz, env);
  return jsonOk(data ?? { message: "No data available yet", slug: biz.slug });
}

// ── GET /api/client/activity ───────────────────────────────────────────────

async function apiActivity(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env);
  if (!session) return jsonErr(401, "Unauthorized");

  const businesses = await getUserBusinesses(env.DB, session.user_id);
  const slug = new URL(request.url).searchParams.get("slug");
  const biz  = (slug ? businesses.find((b) => b.slug === slug) : null) ?? businesses[0] ?? null;
  if (!biz) return jsonErr(404, "No business found for this account");

  const data = await fetchAnalytics(biz, env);
  return jsonOk(data?.recent_queries ?? []);
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

  const { email, password, full_name, slug, business_name, api_key } = body as {
    email?: string; password?: string; full_name?: string;
    slug?: string; business_name?: string; api_key?: string;
  };

  const missing = ["email","password","slug","business_name","api_key"].filter(
    (k) => !body[k] || typeof body[k] !== "string"
  );
  if (missing.length > 0) {
    return jsonErr(400, `Missing or invalid fields: ${missing.join(", ")}`);
  }

  try {
    const salt         = generateSalt();
    const passwordHash = await hashPassword(password, salt);

    let user = await getUserByEmail(env.DB, email);
    if (!user) {
      user = await createUser(env.DB, email, passwordHash, salt, full_name);
    } else {
      await updateUserPassword(env.DB, user.id, passwordHash, salt);
    }

    let biz = await getBusinessBySlug(env.DB, slug);
    if (!biz) biz = await createBusiness(env.DB, slug, business_name, api_key);

    await grantAccess(env.DB, user.id, biz.id);

    return jsonOk({
      message:  "Client created. They can log in at /login.",
      user:     { id: user.id, email: user.email, full_name: user.full_name },
      business: { id: biz.id, slug: biz.slug, business_name: biz.business_name },
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
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--text:#111827;--sub:#6b7280;--muted:#9ca3af;--border:#e5e7eb;--page:#f9fafb;--card:#fff;--accent:#111827;--al:#f3f4f6}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;background:var(--page);color:var(--text);font-size:.875rem;line-height:1.5}
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

interface AnalyticsData {
  slug: string;
  total_queries: number;
  referral_clicks: number;
  queries_by_crawler: Record<string, number>;
  top_queries: string[];
  queries_last_7_days: Array<{ date: string; count: number }>;
  recent_queries: Array<{
    id: number; crawler_agent: string | null;
    query_text: string; response_text: string;
    referral_clicked: number; timestamp: string;
  }>;
}

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

function topBot(byCrawler: Record<string, number>): string {
  const entries = Object.entries(byCrawler).sort((a, b) => b[1] - a[1]);
  return entries[0]?.[0] ?? "—";
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
  } catch { return iso; }
}

function summary(a: AnalyticsData | null): string {
  if (!a || a.total_queries === 0) {
    return "Your business is set up and ready for AI traffic. Once AI search engines start visiting your site, referral data will appear here automatically.";
  }
  const week  = a.queries_last_7_days.reduce((s, d) => s + d.count, 0);
  const bot   = topBot(a.queries_by_crawler);
  const click = a.referral_clicks;
  return `This week, AI systems requested your business profile ${week} time${week !== 1 ? "s" : ""} — ${esc(bot)} was the most active crawler. You've received ${a.total_queries.toLocaleString()} total AI requests and ${click} tracked referral click${click !== 1 ? "s" : ""} to your website.`;
}

function trendBars(days: Array<{ date: string; count: number }>): string {
  if (!days.length) return `<p class="empty-sub">No trend data yet — activity will appear as AI bots visit.</p>`;
  const max = Math.max(...days.map((d) => d.count), 1);
  return `<div class="bars">${days.map((d) => {
    const pct = Math.max(Math.round((d.count / max) * 100), 4);
    const lbl = new Date(d.date + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short" });
    return `<div class="bar-col"><div class="bar" style="height:${pct}%" title="${esc(d.date)}: ${d.count}"></div><span class="bar-lbl">${esc(lbl)}</span></div>`;
  }).join("")}</div>`;
}

// ── Login page HTML ────────────────────────────────────────────────────────

function loginHtml(errorMsg: string | null): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in — AdvocateMCP</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
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

// ── Dashboard HTML ─────────────────────────────────────────────────────────

function dashboardHtml(
  user: User,
  businesses: Business[],
  selected: Business | null,
  analytics: AnalyticsData | null
): string {
  const displayName = user.full_name ?? user.email.split("@")[0];
  const total   = analytics?.total_queries ?? 0;
  const clicks  = analytics?.referral_clicks ?? 0;
  const bot     = analytics ? topBot(analytics.queries_by_crawler) : "—";
  const lastAt  = analytics?.recent_queries?.[0]?.timestamp
    ? fmtDate(analytics.recent_queries[0].timestamp)
    : "No activity yet";

  const bizSelector = businesses.length > 1
    ? `<form id="sf" method="GET" action="/dashboard" style="display:inline">
         <select name="slug" onchange="document.getElementById('sf').submit()" style="border:1px solid #e5e7eb;border-radius:6px;padding:.3rem .5rem;font-size:.8125rem;background:#fff;cursor:pointer">
           ${businesses.map((b) => `<option value="${esc(b.slug)}"${b.slug === selected?.slug ? " selected" : ""}>${esc(b.business_name)}</option>`).join("")}
         </select>
       </form>`
    : "";

  const actRows = (analytics?.recent_queries ?? []).slice(0, 25).map((q) =>
    `<tr>
      <td class="ts">${esc(fmtDate(q.timestamp))}</td>
      <td><span class="badge">${esc(q.crawler_agent ?? "Unknown")}</span></td>
      <td class="qt">${esc(q.query_text.length > 90 ? q.query_text.slice(0, 90) + "…" : q.query_text)}</td>
      <td class="${q.referral_clicked ? "yes" : "no"}">${q.referral_clicked ? "Clicked" : "—"}</td>
    </tr>`
  ).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${selected ? esc(selected.business_name) : "Dashboard"} — AdvocateMCP</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--text:#111827;--sub:#6b7280;--muted:#9ca3af;--border:#e5e7eb;--page:#f9fafb;--card:#fff;--accent:#111827;--al:#f3f4f6}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;background:var(--page);color:var(--text);font-size:.875rem;line-height:1.5}
a{color:inherit;text-decoration:none}
/* Layout */
.layout{display:flex;min-height:100vh}
.sidebar{width:216px;background:var(--accent);color:#fff;display:flex;flex-direction:column;position:fixed;inset:0 auto 0 0;overflow-y:auto}
.main{margin-left:216px;flex:1;display:flex;flex-direction:column}
/* Sidebar */
.sb-logo{display:flex;align-items:center;gap:.5rem;padding:1.25rem 1rem;border-bottom:1px solid rgba(255,255,255,.1)}
.sb-icon{width:26px;height:26px;background:rgba(255,255,255,.15);border-radius:5px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:.8125rem}
.sb-name{font-size:.875rem;font-weight:600}
.sb-nav{padding:.75rem 0;flex:1}
.nav-a{display:flex;align-items:center;gap:.5rem;padding:.4375rem 1rem;color:rgba(255,255,255,.65);font-size:.8125rem;border-left:3px solid transparent;transition:all .1s}
.nav-a:hover,.nav-a.on{background:rgba(255,255,255,.08);color:#fff;border-left-color:rgba(255,255,255,.4)}
.sb-foot{padding:1rem;border-top:1px solid rgba(255,255,255,.1)}
.sb-uname{font-size:.8125rem;font-weight:500;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sb-email{font-size:.75rem;color:rgba(255,255,255,.45);margin-bottom:.625rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.logout{display:block;width:100%;background:rgba(255,255,255,.07);border:none;border-radius:5px;color:rgba(255,255,255,.65);font-size:.75rem;padding:.375rem;cursor:pointer;transition:background .1s;text-align:center}
.logout:hover{background:rgba(255,255,255,.14);color:#fff}
/* Top bar */
.topbar{background:var(--card);border-bottom:1px solid var(--border);padding:.875rem 1.5rem;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:9}
.tb-title{font-size:.9375rem;font-weight:600}
/* Content */
.content{padding:1.5rem;flex:1}
/* Insight */
.insight{background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:.875rem 1.125rem;font-size:.8125rem;color:#1d4ed8;line-height:1.6;margin-bottom:1.25rem}
/* KPI grid */
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(185px,1fr));gap:1rem;margin-bottom:1.25rem}
.kpi{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:1.125rem}
.kpi-lbl{font-size:.6875rem;font-weight:600;color:var(--sub);text-transform:uppercase;letter-spacing:.06em;margin-bottom:.375rem}
.kpi-val{font-size:1.625rem;font-weight:700;color:var(--text);line-height:1}
.kpi-val.sm{font-size:1.125rem}
.kpi-hint{font-size:.6875rem;color:var(--muted);margin-top:.25rem}
/* Section card */
.sec{background:var(--card);border:1px solid var(--border);border-radius:10px;margin-bottom:1.25rem}
.sec-hd{padding:.875rem 1.125rem;border-bottom:1px solid var(--border);font-weight:600;font-size:.875rem}
.sec-bd{padding:1.125rem}
/* Trend */
.bars{display:flex;align-items:flex-end;gap:6px;height:72px}
.bar-col{display:flex;flex-direction:column;align-items:center;gap:3px;flex:1}
.bar{background:var(--accent);border-radius:3px 3px 0 0;width:100%;min-height:4px;opacity:.85;transition:opacity .1s}
.bar:hover{opacity:1}
.bar-lbl{font-size:.625rem;color:var(--muted)}
.empty-sub{font-size:.8125rem;color:var(--muted);text-align:center;padding:1.5rem}
/* Table */
.tw{overflow-x:auto}
table{width:100%;border-collapse:collapse}
th{text-align:left;font-size:.6875rem;font-weight:600;color:var(--sub);text-transform:uppercase;letter-spacing:.06em;padding:.5rem 1rem;border-bottom:1px solid var(--border)}
td{padding:.5625rem 1rem;border-bottom:1px solid #f3f4f6;vertical-align:top}
tr:last-child td{border-bottom:none}
.ts{color:var(--muted);white-space:nowrap;font-size:.8125rem}
.badge{background:var(--al);border-radius:4px;padding:.1rem .4rem;font-size:.75rem;font-weight:500;white-space:nowrap}
.qt{color:var(--sub);max-width:300px;font-size:.8125rem}
.yes{color:#059669;font-weight:500;font-size:.8125rem}
.no{color:var(--muted);font-size:.8125rem}
/* Empty */
.empty{text-align:center;padding:3rem 1rem;color:var(--sub)}
.empty h3{font-size:.9375rem;font-weight:600;color:var(--text);margin-bottom:.375rem}
.empty p{font-size:.8125rem;max-width:300px;margin:0 auto}
/* Responsive */
@media(max-width:720px){
  .sidebar{display:none}
  .main{margin-left:0}
  .kpis{grid-template-columns:1fr 1fr}
}
</style>
</head>
<body>
<div class="layout">
  <!-- Sidebar -->
  <nav class="sidebar">
    <div class="sb-logo">
      <div class="sb-icon">A</div>
      <div class="sb-name">AdvocateMCP</div>
    </div>
    <div class="sb-nav">
      <a href="/dashboard" class="nav-a on">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><rect x="1" y="1" width="6" height="6" rx="1"/><rect x="9" y="1" width="6" height="6" rx="1"/><rect x="1" y="9" width="6" height="6" rx="1"/><rect x="9" y="9" width="6" height="6" rx="1"/></svg>
        Dashboard
      </a>
    </div>
    <div class="sb-foot">
      <div class="sb-uname">${esc(displayName)}</div>
      <div class="sb-email">${esc(user.email)}</div>
      <form method="POST" action="/auth/logout">
        <button type="submit" class="logout">Sign out</button>
      </form>
    </div>
  </nav>

  <!-- Main -->
  <div class="main">
    <div class="topbar">
      <div class="tb-title">${selected ? esc(selected.business_name) : "Dashboard"}</div>
      ${bizSelector}
    </div>
    <div class="content">
      <!-- Insight -->
      <div class="insight">${summary(analytics)}</div>

      <!-- KPIs -->
      <div class="kpis">
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
          <div class="kpi-lbl">Top AI Bot</div>
          <div class="kpi-val sm">${esc(bot)}</div>
          <div class="kpi-hint">Most active crawler</div>
        </div>
        <div class="kpi">
          <div class="kpi-lbl">Last Activity</div>
          <div class="kpi-val sm">${esc(lastAt)}</div>
          <div class="kpi-hint">Most recent request</div>
        </div>
      </div>

      <!-- 7-Day Trend -->
      <div class="sec">
        <div class="sec-hd">7-Day AI Request Trend</div>
        <div class="sec-bd">${trendBars(analytics?.queries_last_7_days ?? [])}</div>
      </div>

      <!-- Activity Table -->
      <div class="sec">
        <div class="sec-hd">Recent Activity</div>
        ${total > 0 ? `
        <div class="tw">
          <table>
            <thead><tr><th>Time</th><th>Bot</th><th>Query</th><th>Referral</th></tr></thead>
            <tbody>${actRows}</tbody>
          </table>
        </div>` : `
        <div class="empty">
          <h3>No activity yet</h3>
          <p>AI search engines will appear here when they start indexing your business through AdvocateMCP.</p>
        </div>`}
      </div>
    </div>
  </div>
</div>
</body>
</html>`;
}
