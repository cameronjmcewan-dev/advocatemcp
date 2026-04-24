/**
 * /admin/insights — internal data dashboard.
 *
 * Phase 2 of advocate-data-layer-vision.md. Ugly but functional, for us
 * not customers. Consumes the Layer 1 columns added in migration 020.
 *
 * Auth: accepts either `Authorization: Bearer $ADMIN_API_KEY` (scripts,
 * cURL) or HTTP Basic with password = ADMIN_API_KEY (browsers). Browsers
 * won't send a Bearer header natively; Basic gets the 401 challenge flow
 * and a password prompt so a plain URL works in the wild.
 *
 * No JavaScript framework. One HTML string, inline CSS, monospace tables.
 * Matches the vision doc's "internal before external" principle — we're
 * optimising for readability over aesthetics here.
 *
 * Endpoints:
 *   GET /admin/insights               — HTML dashboard
 *   GET /admin/insights/overview      — JSON KPIs
 *   GET /admin/insights/top-queries   — JSON top queries
 *   GET /admin/insights/profile-gaps  — JSON gap analysis
 *   GET /admin/insights/trends        — JSON industry time series
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import { getDb } from "../../db.js";
import {
  overviewStats,
  topQueries,
  profileGaps,
  trendsByIndustry,
  topClusters,
  embeddingsHealth,
  type OverviewStats,
  type TopCluster,
  type ProfileGap,
  type IndustryTrend,
  type EmbeddingsHealth,
} from "../../jobs/insights.js";

export const adminInsightsRouter = Router();

/* ── Auth ──────────────────────────────────────────────────────────────
 *
 * Accept Bearer OR Basic. Both paths check the same ADMIN_API_KEY secret.
 * 401 with WWW-Authenticate: Basic forces a browser to prompt for creds
 * when the URL is hit directly. */
function requireAdminBasicOrBearer(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const expected = process.env.ADMIN_API_KEY;
  if (!expected) {
    res.status(503).json({ error: "ADMIN_API_KEY not configured" });
    return;
  }
  const h = req.headers.authorization ?? "";
  let provided: string | null = null;

  if (h.startsWith("Bearer ")) {
    provided = h.slice(7).trim();
  } else if (h.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(h.slice(6).trim(), "base64").toString("utf-8");
      // format: "user:password" — we don't care about user, password must match.
      const idx = decoded.indexOf(":");
      provided = idx >= 0 ? decoded.slice(idx + 1) : decoded;
    } catch {
      provided = null;
    }
  }

  if (provided === expected) {
    next();
    return;
  }

  res.setHeader("WWW-Authenticate", 'Basic realm="Advocate admin", charset="UTF-8"');
  res.status(401).json({ error: "Unauthorized" });
}

// ── JSON endpoints ────────────────────────────────────────────────────────
//
// Kept separate so a future CLI or monitoring probe can hit machine-
// readable data without parsing HTML.

adminInsightsRouter.get(
  "/admin/insights/overview",
  requireAdminBasicOrBearer,
  (_req, res) => { res.json(overviewStats(getDb())); },
);

adminInsightsRouter.get(
  "/admin/insights/top-queries",
  requireAdminBasicOrBearer,
  (req, res) => {
    const days  = parseInt(String(req.query.days  ?? "30"), 10);
    const limit = parseInt(String(req.query.limit ?? "25"), 10);
    res.json(topQueries(getDb(), { days, limit }));
  },
);

adminInsightsRouter.get(
  "/admin/insights/profile-gaps",
  requireAdminBasicOrBearer,
  (req, res) => {
    const limit = parseInt(String(req.query.limit ?? "20"), 10);
    res.json(profileGaps(getDb(), { limit }));
  },
);

adminInsightsRouter.get(
  "/admin/insights/trends",
  requireAdminBasicOrBearer,
  (req, res) => {
    const days = parseInt(String(req.query.days ?? "30"), 10);
    res.json(trendsByIndustry(getDb(), { days }));
  },
);

adminInsightsRouter.get(
  "/admin/insights/embeddings-health",
  requireAdminBasicOrBearer,
  (_req, res) => {
    res.json(embeddingsHealth(getDb()));
  },
);

adminInsightsRouter.get(
  "/admin/insights/top-clusters",
  requireAdminBasicOrBearer,
  (req, res) => {
    const days  = parseInt(String(req.query.days  ?? "30"), 10);
    const limit = parseInt(String(req.query.limit ?? "25"), 10);
    res.json(topClusters(getDb(), { days, limit }));
  },
);

// ── HTML dashboard ────────────────────────────────────────────────────────

adminInsightsRouter.get(
  "/admin/insights",
  requireAdminBasicOrBearer,
  (_req, res) => {
    const db = getDb();
    const overview = overviewStats(db);
    const clusters = topClusters(db, { limit: 25, days: 30 });
    const health   = embeddingsHealth(db);
    const gaps     = profileGaps(db, { limit: 20 });
    const trends   = trendsByIndustry(db, { days: 14 });

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(renderInsightsHtml({ overview, clusters, health, gaps, trends }));
  },
);

// ── Rendering ─────────────────────────────────────────────────────────────

function esc(v: unknown): string {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtCents(c: number | null | undefined): string {
  if (c == null || isNaN(c)) return "—";
  return "$" + (c / 100).toFixed(2);
}

function fmtPct(num: number, den: number): string {
  if (!den) return "—";
  return Math.round((num / den) * 100) + "%";
}

interface RenderInput {
  overview: OverviewStats;
  clusters: TopCluster[];
  health:   EmbeddingsHealth;
  gaps:     ProfileGap[];
  trends:   IndustryTrend[];
}

function renderInsightsHtml(data: RenderInput): string {
  const { overview: o, clusters, health, gaps, trends } = data;

  const clusterRows = clusters.length === 0
    ? `<tr><td colspan="5" class="empty">No clusters yet. Coverage = ${Math.round(health.coverage_last_30d_pct * 100)}% of last-30d queries have embeddings. Clusters build as backfill completes.</td></tr>`
    : clusters.map((c, i) => `<tr>
        <td class="num">${i + 1}</td>
        <td><strong>${esc(c.label)}</strong><br><span class="sub">${
          c.representative_queries.map((q) => esc(q.length > 80 ? q.slice(0, 77) + "…" : q)).join(" · ")
        }</span></td>
        <td class="num">${c.count.toLocaleString()}</td>
        <td class="num">${c.unique_tenants.toLocaleString()}</td>
        <td class="num">${new Date(c.last_seen).toISOString().slice(0, 10)}</td>
      </tr>`).join("");

  const gapRows = gaps.length === 0
    ? `<tr><td colspan="6" class="empty">No gaps surfaced (either no Phase-1-classified queries yet, or every tenant's profile covers what they're being asked).</td></tr>`
    : gaps.map((g) => `<tr>
        <td><strong>${esc(g.name)}</strong><br><span class="sub">${esc(g.slug)}</span></td>
        <td>${esc(g.industry_code ?? "—")}</td>
        <td class="num">${g.total_queries_30d.toLocaleString()}</td>
        <td>${esc(g.top_missing_intent)}</td>
        <td class="num">${g.missing_count.toLocaleString()}</td>
        <td><code>${esc(g.missing_field)}</code></td>
      </tr>`).join("");

  // Trends: pivot (industry × day) for the 14-day view. Limit to top 8
  // industries to keep the table readable.
  const industries: string[] = [];
  const daySet = new Set<string>();
  const byKey = new Map<string, IndustryTrend>();
  for (const t of trends) {
    byKey.set(`${t.industry_code}|${t.day}`, t);
    if (!industries.includes(t.industry_code)) industries.push(t.industry_code);
    daySet.add(t.day);
  }
  const days = Array.from(daySet).sort().reverse();
  // Rank industries by total volume and keep the top 8 for readability.
  const industryTotals = new Map<string, number>();
  for (const t of trends) {
    industryTotals.set(t.industry_code, (industryTotals.get(t.industry_code) ?? 0) + t.query_count);
  }
  const topIndustries = Array.from(industryTotals.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([code]) => code);

  const trendRows = days.length === 0
    ? `<tr><td colspan="${topIndustries.length + 1}" class="empty">No queries in the last 14 days.</td></tr>`
    : days.map((d) => {
        const cells = topIndustries.map((ind) => {
          const entry = byKey.get(`${ind}|${d}`);
          return `<td class="num">${entry ? entry.query_count : 0}</td>`;
        }).join("");
        return `<tr><td class="date">${esc(d)}</td>${cells}</tr>`;
      }).join("");

  const trendHeader = topIndustries.length === 0
    ? ""
    : `<thead><tr><th>Day (UTC)</th>${topIndustries.map((i) => `<th>${esc(i)}</th>`).join("")}</tr></thead>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Advocate · internal insights</title>
<style>
  :root {
    --bg: #f7f5ef; --card: #fff; --ink: #161412; --ink-2: #3b3631;
    --muted: #766f63; --line: #d8d1c3; --maroon: #5c1a3c; --maroon-2: #3d0f26;
    --pos: #2f5c3d; --warn: #8b5b19;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--ink); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13.5px; line-height: 1.45; }
  body { padding: 28px 32px 96px; max-width: 1280px; margin: 0 auto; }
  h1 { font-family: 'Georgia', serif; font-weight: 400; font-size: 30px; letter-spacing: -0.01em; margin: 0 0 6px; color: var(--maroon); }
  h2 { font-family: 'Georgia', serif; font-weight: 400; font-size: 20px; margin: 40px 0 12px; color: var(--ink); }
  .tagline { color: var(--muted); font-size: 12.5px; }
  .warn { background: #fff6e3; border: 1px solid #e9d9ac; color: var(--warn); padding: 10px 14px; margin: 14px 0 0; border-radius: 6px; font-size: 12.5px; }
  .kpi-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-top: 20px; }
  @media (max-width: 800px) { .kpi-grid { grid-template-columns: 1fr 1fr; } }
  .kpi { background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: 14px 16px; }
  .kpi .k { color: var(--muted); font-size: 11px; letter-spacing: .08em; text-transform: uppercase; }
  .kpi .v { font-size: 24px; font-family: 'Georgia', serif; font-weight: 400; color: var(--maroon); margin-top: 4px; line-height: 1.1; }
  .kpi .sub { color: var(--muted); font-size: 11.5px; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; background: var(--card); border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
  th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--line); vertical-align: top; }
  tr:last-child td { border-bottom: 0; }
  th { background: #efece4; color: var(--ink-2); font-weight: 600; font-size: 11.5px; letter-spacing: .06em; text-transform: uppercase; }
  td.num { font-variant-numeric: tabular-nums; text-align: right; }
  td.date { color: var(--muted); white-space: nowrap; }
  td.empty { color: var(--muted); text-align: center; font-style: italic; padding: 18px; }
  td code { background: #efece4; padding: 1px 5px; border-radius: 3px; font-size: 11.5px; color: var(--maroon-2); }
  .sub { color: var(--muted); font-size: 11.5px; }
  .footer { margin-top: 48px; color: var(--muted); font-size: 11.5px; border-top: 1px dashed var(--line); padding-top: 14px; }
</style>
</head>
<body>

<h1>Advocate · internal insights</h1>
<p class="tagline">Phase 2 dashboard. Layer 1 columns from migration 020. Nothing here is customer-facing.</p>

${o.total_queries === 0 ? `<div class="warn">No queries in the database yet. This dashboard lights up once Phase 1 instrumentation has logged real traffic.</div>` : ""}

<h2>Overview (last 30 days)</h2>

<div class="kpi-grid">
  <div class="kpi">
    <div class="k">Queries (30d)</div>
    <div class="v">${o.queries_last_30d.toLocaleString()}</div>
    <div class="sub">${o.queries_last_7d.toLocaleString()} in the last 7 days</div>
  </div>
  <div class="kpi">
    <div class="k">Active tenants (30d)</div>
    <div class="v">${o.unique_tenants_active_30d.toLocaleString()}</div>
    <div class="sub">logging ≥ 1 query</div>
  </div>
  <div class="kpi">
    <div class="k">Claude spend (30d)</div>
    <div class="v">${fmtCents(o.total_cost_cents_30d)}</div>
    <div class="sub">across all tenants</div>
  </div>
  <div class="kpi">
    <div class="k">Total queries (all time)</div>
    <div class="v">${o.total_queries.toLocaleString()}</div>
    <div class="sub">${fmtPct(o.queries_with_intent_v2, o.total_queries)} have intent_v2</div>
  </div>

  <div class="kpi">
    <div class="k">Intent_v2 coverage</div>
    <div class="v">${fmtPct(o.queries_with_intent_v2, o.total_queries)}</div>
    <div class="sub">${o.queries_with_intent_v2.toLocaleString()} / ${o.total_queries.toLocaleString()} classified</div>
  </div>
  <div class="kpi">
    <div class="k">Geo coverage</div>
    <div class="v">${fmtPct(o.queries_with_geo, o.total_queries)}</div>
    <div class="sub">${o.queries_with_geo.toLocaleString()} rows with country</div>
  </div>
  <div class="kpi">
    <div class="k">Industry coverage</div>
    <div class="v">${fmtPct(o.queries_with_industry, o.total_queries)}</div>
    <div class="sub">${o.queries_with_industry.toLocaleString()} rows tagged</div>
  </div>
  <div class="kpi">
    <div class="k">Top crawler (30d)</div>
    <div class="v" style="font-size:18px">${esc(o.top_crawler?.name ?? "—")}</div>
    <div class="sub">${o.top_crawler ? o.top_crawler.count.toLocaleString() + " hits · " + (o.top_model?.name ?? "—") + " top model" : "no crawler traffic yet"}</div>
  </div>
</div>

<h2>Top 25 topics (last 30 days)</h2>
<p class="tagline">Clusters of semantically similar queries. Label generated by Haiku with explicit PII stripping. Coverage: ${Math.round(health.coverage_last_30d_pct * 100)}% of 30d queries are embedded; ${health.total_clusters_active.toLocaleString()} active clusters; avg size ${health.avg_cluster_size.toFixed(1)}.</p>
<table>
  <thead><tr><th style="width:40px">#</th><th>Topic · representative queries</th><th style="width:80px">Count</th><th style="width:100px">Tenants</th><th style="width:120px">Last seen</th></tr></thead>
  <tbody>${clusterRows}</tbody>
</table>

<h2>Profile gaps (last 30 days)</h2>
<p class="tagline">Tenants whose top-asked intent maps to an empty profile field. These are the "47 pricing questions, your profile doesn't mention pricing" suggestions that power Phase 3 customer enrichment.</p>
<table>
  <thead><tr><th>Tenant</th><th style="width:140px">Industry</th><th style="width:90px">30d queries</th><th style="width:110px">Gap intent</th><th style="width:90px">Gap count</th><th style="width:240px">Missing field</th></tr></thead>
  <tbody>${gapRows}</tbody>
</table>

<h2>Industry trends (last 14 days)</h2>
<p class="tagline">Top 8 industries by volume, day-by-day. Sparse days read as 0. Use this to eyeball whether a category is trending before committing to a Phase 4 aggregate view.</p>
<table>
  ${trendHeader}
  <tbody>${trendRows}</tbody>
</table>

<div class="footer">
  Served by <code>/admin/insights</code> · ADMIN_API_KEY required via Bearer header or HTTP Basic · rendered ${new Date().toISOString()} · source: <code>server/src/routes/admin/insights.ts</code>
</div>

</body>
</html>`;
}
