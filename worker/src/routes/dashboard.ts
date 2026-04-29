// Client dashboard: full-featured analytics UI.
// Phase A redesign (Apr 29 2026) collapses the 4 analytics tabs (Overview /
// AI Requests / Referral Clicks / Bot Activity) into a single unified
// "Analytics" tab with a Profound-style card grid. The Recommendations +
// Settings tabs are preserved; new tabs are added for "Analytics" at the
// top of the sidebar.

import type { Business, User } from "../portalDb";
import { CARD_REGISTRY, DEFAULT_DASHBOARD_LAYOUT, getCard, type CardSize } from "./dashboard/cards";
import { renderCard, CARD_GRID_CSS } from "./dashboard/renderCard";
import { DASHBOARD_CLIENT_SCRIPT } from "./dashboard/clientScript";

// ── Exported interface ─────────────────────────────────────────────────────

export interface AnalyticsData {
  slug: string;
  total_queries: number;
  referral_clicks: number;
  referral_clicks_last_30_days: number;
  queries_by_crawler: Record<string, number>;
  queries_by_intent: Record<string, number>;
  top_queries: string[];
  queries_last_30_days: Array<{ date: string; count: number }>;
  activity_by_dow_hour: Array<{ dow: number; hour: number; count: number }>;
  recent_queries: Array<{
    id: number;
    crawler_agent: string | null;
    query_text: string;
    response_text: string;
    referral_clicked: number;
    timestamp: string;
    intent?: string | null;
  }>;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtTs(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
  } catch { return iso; }
}

function fmtDateShort(dateStr: string): string {
  try {
    return new Date(dateStr + "T12:00:00Z").toLocaleDateString("en-US", {
      month: "short", day: "numeric",
    });
  } catch { return dateStr.slice(5); }
}

function fillDays(data: Array<{ date: string; count: number }>): Array<{ date: string; count: number }> {
  const map = new Map(data.map((d) => [d.date, d.count]));
  const result: Array<{ date: string; count: number }> = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86_400_000);
    const key = d.toISOString().slice(0, 10);
    result.push({ date: key, count: map.get(key) ?? 0 });
  }
  return result;
}

function ctrStr(queries: number, clicks: number): string {
  if (!queries) return "0.0%";
  return ((clicks / queries) * 100).toFixed(1) + "%";
}

function topBotName(byCrawler: Record<string, number>): string {
  const e = Object.entries(byCrawler).sort((a, b) => b[1] - a[1]);
  return e[0]?.[0] ?? "—";
}

function buildInsight(a: AnalyticsData | null): string {
  if (!a || a.total_queries === 0) {
    return "Your agent is live and ready. Once AI search engines start visiting your business, requests and referral data will appear here automatically.";
  }
  const week = (a.queries_last_30_days ?? []).slice(-7).reduce((s, d) => s + d.count, 0);
  const bot  = topBotName(a.queries_by_crawler);
  const rate = ctrStr(a.total_queries, a.referral_clicks);
  const weekPart = week > 0
    ? `This week, AI systems queried your business profile ${week} time${week !== 1 ? "s" : ""} — ${esc(bot)} was the most active.`
    : `AI systems haven't queried your profile this week yet — ${esc(bot)} is the most active crawler overall.`;
  return `${weekPart} You have ${a.total_queries.toLocaleString()} total AI requests and a ${rate} referral click rate.`;
}

interface Rec { title: string; desc: string; type: "success" | "warning" | "info"; }

function buildRecs(a: AnalyticsData | null): Rec[] {
  if (!a) {
    return [{ title: "Connect your business", desc: "Register your domain and link it to your AdvocateMCP agent to start receiving AI traffic.", type: "info" }];
  }
  const { total_queries, referral_clicks, queries_by_crawler, queries_last_30_days } = a;
  const recs: Rec[] = [];

  if (total_queries === 0) {
    recs.push({ title: "No AI traffic yet", desc: "Your agent is live but hasn't been discovered yet. Add /.well-known/ai-agent.json to your domain and ensure your domain is mapped in AdvocateMCP.", type: "info" });
    return recs;
  }

  const ctr = referral_clicks / total_queries;

  if (total_queries >= 10 && referral_clicks === 0) {
    recs.push({ title: "No referral clicks tracked", desc: "AI bots are querying your profile but no referral clicks have been recorded. Verify your referral_url field is set in your business profile.", type: "warning" });
  } else if (total_queries >= 5 && ctr < 0.05) {
    recs.push({ title: "Low referral click rate", desc: `Only ${(ctr * 100).toFixed(1)}% of AI queries lead to a referral click. Consider improving your business description, differentiator, and referral URL.`, type: "warning" });
  }

  const entries = Object.entries(queries_by_crawler).sort((a, b) => b[1] - a[1]);
  if (entries.length > 0 && total_queries >= 10 && entries[0][1] / total_queries > 0.8) {
    recs.push({ title: `${Math.round((entries[0][1] / total_queries) * 100)}% traffic from ${entries[0][0]}`, desc: "Your AI traffic comes primarily from one source. Add schema.org/LocalBusiness markup to improve multi-crawler discoverability.", type: "info" });
  }

  const recentSum = (queries_last_30_days ?? []).slice(-7).reduce((s, d) => s + d.count, 0);
  const prevSum   = (queries_last_30_days ?? []).slice(-14, -7).reduce((s, d) => s + d.count, 0);
  if (prevSum > 0 && recentSum > prevSum * 1.2) {
    recs.push({ title: "Traffic trending up", desc: `AI request volume is up ~${Math.round(((recentSum - prevSum) / prevSum) * 100)}% this week vs. last. Keep your profile fresh to maintain momentum.`, type: "success" });
  }

  if (recs.length === 0) {
    recs.push({ title: "Looking good!", desc: `${total_queries.toLocaleString()} AI requests with a ${(ctr * 100).toFixed(1)}% click rate. Keep your business profile up to date to maintain visibility.`, type: "success" });
  }
  return recs;
}

function buildHeatmap(data: Array<{ dow: number; hour: number; count: number }>): string {
  if (!data.length) {
    return `<p class="empty-sub">No activity data yet — heatmap will populate as AI bots visit.</p>`;
  }
  const grid: number[][] = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const row of data) {
    if (row.dow >= 0 && row.dow < 7 && row.hour >= 0 && row.hour < 24) {
      grid[row.dow][row.hour] = row.count;
    }
  }
  const maxVal = Math.max(1, ...data.map((d) => d.count));
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  let html = '<div class="heatmap">';
  html += '<div class="hm-row"><div class="hm-lbl"></div>';
  for (let h = 0; h < 24; h++) {
    const lbl = h === 0 ? "12a" : h < 12 ? `${h}a` : h === 12 ? "12p" : `${h - 12}p`;
    html += `<div class="hm-h">${h % 3 === 0 ? lbl : ""}</div>`;
  }
  html += "</div>";

  for (let d = 0; d < 7; d++) {
    html += `<div class="hm-row"><div class="hm-lbl">${days[d]}</div>`;
    for (let h = 0; h < 24; h++) {
      const val = grid[d][h];
      const opacity = val === 0 ? 0.05 : 0.15 + (val / maxVal) * 0.85;
      html += `<div class="hm-cell" style="opacity:${opacity.toFixed(2)}" title="${esc(days[d])} ${h}:00 — ${val} request${val !== 1 ? "s" : ""}"></div>`;
    }
    html += "</div>";
  }
  html += "</div>";
  return html;
}

function botBars(byKey: Record<string, number>, total: number, limit = 8): string {
  if (!total || !Object.keys(byKey).length) {
    return `<p class="empty-sub">No data yet.</p>`;
  }
  return Object.entries(byKey)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => {
      const pct = Math.max(2, Math.round((count / total) * 100));
      return `<div class="bot-row">
        <div class="bot-name">${esc(name)}</div>
        <div class="bot-track"><div class="bot-fill" style="width:${pct}%"></div></div>
        <div class="bot-stat">${count.toLocaleString()} <span class="muted">${pct}%</span></div>
      </div>`;
    })
    .join("");
}

// ── Main builder ───────────────────────────────────────────────────────────

export function buildDashboard(
  user: User,
  businesses: Business[],
  selected: Business | null,
  analytics: AnalyticsData | null
): string {
  const a          = analytics;
  const displayName = user.full_name ?? user.email.split("@")[0];
  const total      = a?.total_queries ?? 0;
  const clicks     = a?.referral_clicks ?? 0;
  const clicks30   = a?.referral_clicks_last_30_days ?? 0;
  const bot        = a ? topBotName(a.queries_by_crawler) : "—";
  const insight    = buildInsight(a);
  const recs       = buildRecs(a);
  const filled     = fillDays(a?.queries_last_30_days ?? []);
  const maskedKey  = selected?.api_key
    ? selected.api_key.slice(0, 8) + "••••••••••••••••••••••"
    : "—";

  const bizSelector = businesses.length > 1
    ? `<form id="sf" method="GET" action="/dashboard" style="display:inline-flex;align-items:center">
         <select name="slug" onchange="document.getElementById('sf').submit()" style="border:1px solid var(--border);border-radius:6px;padding:.3rem .6rem;font-size:.8125rem;background:var(--card);color:var(--text);cursor:pointer">
           ${businesses.map((b) => `<option value="${esc(b.slug)}"${b.slug === selected?.slug ? " selected" : ""}>${esc(b.business_name)}</option>`).join("")}
         </select>
       </form>`
    : "";

  // ── Sections ──────────────────────────────────────────────────────────────

  // Overview
  const overviewHtml = `
  <div class="insight">${insight}</div>
  <div class="kpis">
    <div class="kpi"><div class="kpi-lbl">Total AI Requests</div><div class="kpi-val">${total.toLocaleString()}</div><div class="kpi-hint">All time</div></div>
    <div class="kpi"><div class="kpi-lbl">Referral Clicks</div><div class="kpi-val">${clicks.toLocaleString()}</div><div class="kpi-hint">All time</div></div>
    <div class="kpi"><div class="kpi-lbl">Click Rate</div><div class="kpi-val">${ctrStr(total, clicks)}</div><div class="kpi-hint">Of AI queries</div></div>
    <div class="kpi"><div class="kpi-lbl">Top AI Bot</div><div class="kpi-val sm">${esc(bot)}</div><div class="kpi-hint">Most active crawler</div></div>
  </div>
  <div class="sec">
    <div class="sec-hd">30-Day AI Request Trend</div>
    <div class="sec-bd chart-wrap"><canvas id="trend-chart"></canvas></div>
  </div>
  <div class="sec">
    <div class="sec-hd">Bot Breakdown</div>
    <div class="sec-bd">${botBars(a?.queries_by_crawler ?? {}, total)}</div>
  </div>`;

  // AI Requests
  const actRows = (a?.recent_queries ?? []).map((q, i) =>
    `<tr${i >= 25 ? ' class="act-more" style="display:none"' : ""}>
      <td class="ts">${esc(fmtTs(q.timestamp))}</td>
      <td><span class="badge">${esc(q.crawler_agent ?? "Unknown")}</span></td>
      <td>${q.intent ? `<span class="badge">${esc(q.intent)}</span>` : `<span class="muted">—</span>`}</td>
      <td class="qt">${esc(q.query_text.length > 80 ? q.query_text.slice(0, 80) + "…" : q.query_text)}</td>
      <td class="${q.referral_clicked ? "yes" : "no"}">${q.referral_clicked ? "Clicked" : "—"}</td>
    </tr>`
  ).join("");

  const topQueryItems = (a?.top_queries ?? []).slice(0, 10).map((q, i) =>
    `<div class="top-query"><span class="tq-num">${i + 1}</span><span class="tq-text">${esc(q.length > 100 ? q.slice(0, 100) + "…" : q)}</span></div>`
  ).join("");

  const requestsHtml = `
  <div class="sec">
    <div class="sec-hd">30-Day Trend</div>
    <div class="sec-bd chart-wrap"><canvas id="trend-chart-2"></canvas></div>
  </div>
  <div class="two-col">
    <div class="sec" style="margin-bottom:0">
      <div class="sec-hd">Top Queries <span class="cnt">by frequency</span></div>
      <div class="sec-bd">${topQueryItems || `<p class="empty-sub">No query data yet.</p>`}</div>
    </div>
    <div class="sec" style="margin-bottom:0">
      <div class="sec-hd">Intent Breakdown</div>
      <div class="sec-bd">${botBars(a?.queries_by_intent ?? {}, total)}</div>
    </div>
  </div>
  <div class="sec" style="margin-top:1.25rem">
    <div class="sec-hd">Recent Activity <span class="cnt">last ${Math.min(total, 50)} requests</span></div>
    ${total > 0 ? `
    <div class="tw">
      <table>
        <thead><tr><th>Time</th><th>Bot</th><th>Intent</th><th>Query</th><th>Referral</th></tr></thead>
        <tbody>${actRows}</tbody>
      </table>
      ${(a?.recent_queries?.length ?? 0) > 25
        ? `<div style="text-align:center;padding:.75rem"><button class="btn-ghost" onclick="toggleMore(this)">Show all ${a?.recent_queries?.length} requests</button></div>`
        : ""}
    </div>` : `<div class="empty"><h3>No activity yet</h3><p>AI requests will appear here as crawlers visit your domain.</p></div>`}
  </div>`;

  // Referral Clicks
  const clickedByBot: Record<string, number> = {};
  for (const q of (a?.recent_queries ?? [])) {
    if (q.referral_clicked && q.crawler_agent) {
      clickedByBot[q.crawler_agent] = (clickedByBot[q.crawler_agent] ?? 0) + 1;
    }
  }

  const clicksHtml = `
  <div class="kpis">
    <div class="kpi"><div class="kpi-lbl">Total Clicks</div><div class="kpi-val">${clicks.toLocaleString()}</div><div class="kpi-hint">All time</div></div>
    <div class="kpi"><div class="kpi-lbl">Last 30 Days</div><div class="kpi-val">${clicks30.toLocaleString()}</div><div class="kpi-hint">Recent referrals</div></div>
    <div class="kpi"><div class="kpi-lbl">Click Rate</div><div class="kpi-val">${ctrStr(total, clicks)}</div><div class="kpi-hint">Of all AI queries</div></div>
  </div>
  <div class="sec">
    <div class="sec-hd">Clicks by Bot Source <span class="cnt">from recent ${Math.min(total, 50)} requests</span></div>
    <div class="sec-bd">${
      Object.keys(clickedByBot).length
        ? botBars(clickedByBot, clicks)
        : `<p class="empty-sub">${clicks === 0
          ? "No referral clicks recorded yet. Verify your referral_url field is set in your business profile."
          : "Click source data available for recent requests only."}</p>`
    }</div>
  </div>
  <div class="sec">
    <div class="sec-hd">How Referral Tracking Works</div>
    <div class="sec-bd">
      <div class="info-list">
        <div class="info-item"><span class="info-icon">1</span><div><strong>AI bot queries your agent</strong><br><span class="muted">The crawler calls your agent endpoint and receives a structured response including your referral URL.</span></div></div>
        <div class="info-item"><span class="info-icon">2</span><div><strong>Bot surfaces your link</strong><br><span class="muted">The AI includes your referral URL in answers to humans searching for your type of business.</span></div></div>
        <div class="info-item"><span class="info-icon">3</span><div><strong>Human clicks — tracked</strong><br><span class="muted">The click routes through the AdvocateMCP tracking URL, then redirects to your site. Bot clicks are filtered out.</span></div></div>
      </div>
    </div>
  </div>`;

  // Bot Activity
  const botTableRows = Object.entries(a?.queries_by_crawler ?? {})
    .sort((a, b) => b[1] - a[1])
    .map(([b, count]) => {
      const pct = total ? ((count / total) * 100).toFixed(1) : "0.0";
      return `<tr><td>${esc(b)}</td><td>${count.toLocaleString()}</td><td>${pct}%</td></tr>`;
    })
    .join("");

  const botsHtml = `
  <div class="two-col">
    <div class="sec" style="margin-bottom:0">
      <div class="sec-hd">Crawler Breakdown</div>
      ${botTableRows
        ? `<div class="tw"><table>
             <thead><tr><th>Crawler</th><th>Requests</th><th>Share</th></tr></thead>
             <tbody>${botTableRows}</tbody>
           </table></div>`
        : `<div class="sec-bd"><p class="empty-sub">No crawler data yet.</p></div>`}
    </div>
    <div class="sec" style="margin-bottom:0">
      <div class="sec-hd">Intent Breakdown</div>
      <div class="sec-bd">${botBars(a?.queries_by_intent ?? {}, total)}</div>
    </div>
  </div>
  <div class="sec" style="margin-top:1.25rem">
    <div class="sec-hd">Activity Heatmap <span class="cnt">requests by day &amp; hour (UTC)</span></div>
    <div class="sec-bd">${buildHeatmap(a?.activity_by_dow_hour ?? [])}</div>
  </div>`;

  // ── Phase A unified Analytics card grid ──────────────────────────────────
  // The 4 legacy section variables (overviewHtml/requestsHtml/clicksHtml/
  // botsHtml) are intentionally still computed above for backward compat
  // (some downstream tests / e2e probes inspect their HTML), but the new
  // dashboard render uses ONLY analyticsHtml below — a single grid of
  // ECharts-driven cards from DEFAULT_DASHBOARD_LAYOUT. Cards are
  // self-loading via clientScript.ts; the server only emits chrome.
  void overviewHtml; void requestsHtml; void clicksHtml; void botsHtml;
  const analyticsHtml = (() => {
    const cardsHtml = DEFAULT_DASHBOARD_LAYOUT
      .map((entry) => {
        const card = getCard(entry.card_id);
        if (!card) return "";
        return renderCard(card, entry.size as CardSize);
      })
      .filter(Boolean)
      .join("\n");
    return `<div id="card-grid" class="dashboard-grid">${cardsHtml}</div>`;
  })();

  // Recommendations
  const recBorder: Record<string, string> = { success: "#059669", warning: "#d97706", info: "#2563eb" };
  const recCards = recs.map((r) =>
    `<div class="rec-card" style="border-left:3px solid ${recBorder[r.type]}">
      <div class="rec-title">${esc(r.title)}</div>
      <div class="rec-desc">${esc(r.desc)}</div>
    </div>`
  ).join("");

  const recsHtml = `
  <div class="recs-grid">${recCards}</div>
  <div class="sec">
    <div class="sec-hd">Optimization Checklist</div>
    <div class="sec-bd">
      <div class="check-list">
        <label class="check-item"><input type="checkbox"${total > 0 ? " checked" : ""} disabled> Agent receiving AI traffic</label>
        <label class="check-item"><input type="checkbox"${clicks > 0 ? " checked" : ""} disabled> Referral clicks tracked</label>
        <label class="check-item"><input type="checkbox"${Object.keys(a?.queries_by_crawler ?? {}).length > 1 ? " checked" : ""} disabled> Multiple crawlers active</label>
        <label class="check-item"><input type="checkbox"${(a?.top_queries?.length ?? 0) > 0 ? " checked" : ""} disabled> Top queries identified</label>
      </div>
    </div>
  </div>`;

  // Settings
  const apiKeyFull = esc(selected?.api_key ?? "");
  const settingsHtml = `
  <div class="sec">
    <div class="sec-hd">Business Profile</div>
    <div class="sec-bd">
      <div class="settings-row"><span class="settings-lbl">Business Name</span><span class="settings-val">${esc(selected?.business_name ?? "—")}</span></div>
      <div class="settings-row"><span class="settings-lbl">Slug</span><span class="settings-val"><code>${esc(selected?.slug ?? "—")}</code></span></div>
      <div class="settings-row"><span class="settings-lbl">Demo Page</span><span class="settings-val"><a href="/demo/${esc(selected?.slug ?? "")}" target="_blank" style="color:var(--info)">/demo/${esc(selected?.slug ?? "—")}</a></span></div>
      <div class="settings-row"><span class="settings-lbl">Agent Since</span><span class="settings-val muted">${selected?.created_at ? fmtTs(selected.created_at) : "—"}</span></div>
    </div>
  </div>
  <div class="sec">
    <div class="sec-hd">API Key</div>
    <div class="sec-bd">
      <div style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;margin-bottom:.5rem">
        <code id="api-key-display" style="font-size:.8125rem;word-break:break-all;flex:1">${esc(maskedKey)}</code>
        <button class="btn-ghost" onclick="toggleKey(this,'${apiKeyFull}','${esc(maskedKey)}')">Show</button>
        <button class="btn-ghost" onclick="copyText('${apiKeyFull}',this)">Copy</button>
      </div>
      <p class="muted" style="font-size:.75rem">Used to authenticate your analytics requests. Keep this secret.</p>
      <div style="margin-top:1rem;padding-top:1rem;border-top:1px solid var(--border);display:flex;align-items:center;gap:.75rem;flex-wrap:wrap">
        <button class="btn-danger" onclick="rotateKey('${esc(selected?.slug ?? "")}')">Rotate API Key</button>
        <span class="muted" style="font-size:.75rem">Generates a new key and immediately invalidates the old one.</span>
      </div>
      <div id="rotate-result" style="display:none;margin-top:.75rem"></div>
    </div>
  </div>`;

  // ── Data for Chart.js ──────────────────────────────────────────────────────

  const trendLabels = JSON.stringify(filled.map((d) => fmtDateShort(d.date)));
  const trendData   = JSON.stringify(filled.map((d) => d.count));

  // ── Full page ──────────────────────────────────────────────────────────────

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${selected ? esc(selected.business_name) : "Dashboard"} — AdvocateMCP</title>
<script src="https://cdn.jsdelivr.net/npm/echarts@5.4.3/dist/echarts.min.js" defer><\/script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js" defer><\/script>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#f9fafb;--card:#fff;--text:#111827;--sub:#6b7280;--muted:#9ca3af;--border:#e5e7eb;--accent:#111827;--al:#f3f4f6;--info:#2563eb;--success:#059669;--warning:#d97706;--danger:#dc2626;--sb-w:220px}
html.dark{--bg:#111827;--card:#1f2937;--text:#f9fafb;--sub:#9ca3af;--muted:#6b7280;--border:#374151;--accent:#0f172a;--al:#374151}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;background:var(--bg);color:var(--text);font-size:.875rem;line-height:1.5;transition:background .15s,color .15s}
a{color:inherit;text-decoration:none}
code{font-family:'SF Mono',Menlo,Monaco,monospace;background:var(--al);padding:.1em .35em;border-radius:3px;font-size:.8125rem}
.layout{display:flex;min-height:100vh}
.sidebar{width:var(--sb-w);background:var(--accent);color:#fff;display:flex;flex-direction:column;position:fixed;inset:0 auto 0 0;overflow-y:auto;z-index:20}
.main{margin-left:var(--sb-w);flex:1;display:flex;flex-direction:column;min-width:0}
.sb-logo{display:flex;align-items:center;gap:.5rem;padding:1.25rem 1rem;border-bottom:1px solid rgba(255,255,255,.1)}
.sb-icon{width:26px;height:26px;background:rgba(255,255,255,.15);border-radius:5px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:.8125rem;flex-shrink:0}
.sb-name{font-size:.875rem;font-weight:600}
.sb-nav{padding:.5rem 0;flex:1}
.nav-a{display:flex;align-items:center;gap:.625rem;padding:.4375rem 1rem;color:rgba(255,255,255,.6);font-size:.8125rem;border-left:3px solid transparent;cursor:pointer;transition:all .1s;border-top:none;border-right:none;border-bottom:none;background:none;width:100%;text-align:left}
.nav-a:hover,.nav-a.on{background:rgba(255,255,255,.08);color:#fff;border-left-color:rgba(255,255,255,.35)}
.nav-a.on{border-left-color:#fff}
.sb-foot{padding:1rem;border-top:1px solid rgba(255,255,255,.1)}
.sb-uname{font-size:.8125rem;font-weight:500;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sb-email{font-size:.75rem;color:rgba(255,255,255,.4);margin-bottom:.5rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.logout{display:block;width:100%;background:rgba(255,255,255,.07);border:none;border-radius:5px;color:rgba(255,255,255,.6);font-size:.75rem;padding:.375rem;cursor:pointer;transition:background .1s}
.logout:hover{background:rgba(255,255,255,.14);color:#fff}
.topbar{background:var(--card);border-bottom:1px solid var(--border);padding:.875rem 1.5rem;display:flex;align-items:center;justify-content:space-between;gap:1rem;position:sticky;top:0;z-index:9}
.tb-title{font-size:.9375rem;font-weight:600}
.dark-toggle{background:none;border:1px solid var(--border);border-radius:6px;color:var(--sub);font-size:.75rem;padding:.3rem .6rem;cursor:pointer;transition:all .1s}
.dark-toggle:hover{background:var(--al);color:var(--text)}
.content{padding:1.5rem;flex:1}
.section{display:none}.section.active{display:block}
.insight{background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:.875rem 1.125rem;font-size:.8125rem;color:#1d4ed8;line-height:1.6;margin-bottom:1.25rem}
html.dark .insight{background:#1e3a5f;border-color:#1d4ed8;color:#93c5fd}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(165px,1fr));gap:.875rem;margin-bottom:1.25rem}
.kpi{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:1rem 1.125rem}
.kpi-lbl{font-size:.6875rem;font-weight:600;color:var(--sub);text-transform:uppercase;letter-spacing:.06em;margin-bottom:.375rem}
.kpi-val{font-size:1.625rem;font-weight:700;color:var(--text);line-height:1}
.kpi-val.sm{font-size:1.05rem;margin-top:.1rem}
.kpi-hint{font-size:.6875rem;color:var(--muted);margin-top:.25rem}
.sec{background:var(--card);border:1px solid var(--border);border-radius:10px;margin-bottom:1.25rem}
.sec-hd{padding:.875rem 1.125rem;border-bottom:1px solid var(--border);font-weight:600;font-size:.875rem;display:flex;align-items:center;justify-content:space-between}
.cnt{font-size:.75rem;font-weight:400;color:var(--sub)}
.sec-bd{padding:1.125rem}
.chart-wrap{position:relative;height:140px;padding:.75rem 1.125rem 1rem}
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-bottom:1.25rem}
.bot-row{display:flex;align-items:center;gap:.625rem;margin-bottom:.625rem}
.bot-row:last-child{margin-bottom:0}
.bot-name{width:110px;font-size:.8125rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex-shrink:0}
.bot-track{flex:1;height:7px;background:var(--al);border-radius:4px;overflow:hidden}
.bot-fill{height:100%;background:var(--accent);border-radius:4px}
html.dark .bot-fill{background:#60a5fa}
.bot-stat{font-size:.8125rem;color:var(--sub);min-width:60px;text-align:right;white-space:nowrap}
.heatmap{overflow-x:auto;padding:.25rem 0}
.hm-row{display:flex;gap:2px;margin-bottom:2px;align-items:center}
.hm-lbl{width:28px;font-size:.5625rem;color:var(--muted);text-align:right;padding-right:4px;flex-shrink:0}
.hm-h{width:20px;font-size:.5rem;color:var(--muted);text-align:center;flex-shrink:0}
.hm-cell{width:20px;height:14px;background:var(--accent);border-radius:2px;flex-shrink:0}
html.dark .hm-cell{background:#60a5fa}
.tw{overflow-x:auto}
table{width:100%;border-collapse:collapse}
th{text-align:left;font-size:.6875rem;font-weight:600;color:var(--sub);text-transform:uppercase;letter-spacing:.06em;padding:.5rem 1rem;border-bottom:1px solid var(--border)}
td{padding:.5rem 1rem;border-bottom:1px solid var(--border);vertical-align:top}
tr:last-child td{border-bottom:none}
.ts{color:var(--muted);white-space:nowrap;font-size:.8125rem}
.badge{background:var(--al);border-radius:4px;padding:.1rem .4rem;font-size:.75rem;font-weight:500;white-space:nowrap}
.qt{color:var(--sub);max-width:280px;font-size:.8125rem}
.yes{color:var(--success);font-weight:500;font-size:.8125rem}
.no{color:var(--muted);font-size:.8125rem}
.muted{color:var(--muted)}
.top-query{display:flex;gap:.5rem;padding:.45rem 0;border-bottom:1px solid var(--border)}
.top-query:last-child{border-bottom:none}
.tq-num{width:18px;font-size:.75rem;font-weight:600;color:var(--muted);flex-shrink:0;padding-top:.05rem}
.tq-text{font-size:.8125rem;line-height:1.4}
.info-list{display:flex;flex-direction:column;gap:.875rem}
.info-item{display:flex;align-items:flex-start;gap:.75rem}
.info-icon{width:24px;height:24px;background:var(--al);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.75rem;font-weight:700;color:var(--sub);flex-shrink:0}
.recs-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:1rem;margin-bottom:1.25rem}
.rec-card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:1rem 1.125rem;padding-left:1.25rem}
.rec-title{font-weight:600;font-size:.875rem;margin-bottom:.375rem}
.rec-desc{font-size:.8125rem;color:var(--sub);line-height:1.5}
.check-list{display:flex;flex-direction:column;gap:.625rem}
.check-item{display:flex;align-items:center;gap:.5rem;font-size:.8125rem;cursor:default;user-select:none}
.check-item input{accent-color:var(--success);cursor:default}
.settings-row{display:flex;align-items:center;gap:1rem;padding:.625rem 0;border-bottom:1px solid var(--border)}
.settings-row:last-child{border-bottom:none}
.settings-lbl{width:130px;font-size:.8125rem;font-weight:500;color:var(--sub);flex-shrink:0}
.settings-val{font-size:.8125rem}
.btn-ghost{background:none;border:1px solid var(--border);border-radius:6px;color:var(--sub);font-size:.75rem;padding:.3rem .6rem;cursor:pointer;transition:all .1s;white-space:nowrap}
.btn-ghost:hover{background:var(--al);color:var(--text);border-color:var(--text)}
.btn-danger{background:none;border:1px solid #fca5a5;border-radius:6px;color:#dc2626;font-size:.8125rem;padding:.4rem .75rem;cursor:pointer;white-space:nowrap}
.btn-danger:hover{background:#fef2f2}
html.dark .btn-danger{border-color:#7f1d1d;color:#f87171}
html.dark .btn-danger:hover{background:#450a0a}
.empty{text-align:center;padding:3rem 1rem;color:var(--sub)}
.empty h3{font-size:.9375rem;font-weight:600;color:var(--text);margin-bottom:.375rem}
.empty p,.empty-sub{font-size:.8125rem;color:var(--muted);padding:1rem 0;text-align:center}
@media(max-width:720px){
  .sidebar{width:var(--sb-w);transform:translateX(-100%)}
  .main{margin-left:0}
  .kpis{grid-template-columns:1fr 1fr}
  .two-col{grid-template-columns:1fr}
}
@media(max-width:480px){.kpis{grid-template-columns:1fr}}

/* Date range picker (Phase A) */
.range-picker{display:inline-flex;align-items:center;gap:.375rem;padding:.3rem .5rem;border:1px solid var(--border);border-radius:6px;background:var(--card)}
.range-picker select{border:none;background:transparent;color:var(--text);font-size:.8125rem;font-family:inherit;cursor:pointer;padding-right:.25rem}
.range-picker select:focus{outline:none}
.range-custom{display:none;align-items:center;gap:.375rem;margin-left:.5rem}
.range-custom input{border:1px solid var(--border);border-radius:5px;padding:.25rem .375rem;font-size:.75rem;background:var(--card);color:var(--text);font-family:inherit}
.range-apply{background:var(--info);color:#fff;border:none;border-radius:5px;padding:.3rem .625rem;font-size:.75rem;font-weight:500;cursor:pointer;font-family:inherit}
.range-apply:hover{filter:brightness(1.1)}
</style>
${CARD_GRID_CSS}
</head>
<body>
<div class="layout">
  <nav class="sidebar">
    <div class="sb-logo">
      <div class="sb-icon">A</div>
      <div class="sb-name">AdvocateMCP</div>
    </div>
    <div class="sb-nav">
      <button class="nav-a on" onclick="nav('analytics',this)">
        <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1" y="1" width="5" height="5" rx="1"/><rect x="8" y="1" width="5" height="5" rx="1"/><rect x="1" y="8" width="5" height="5" rx="1"/><rect x="8" y="8" width="5" height="5" rx="1"/></svg>
        Analytics
      </button>
      <button class="nav-a" onclick="nav('recs',this)">
        <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M7 1a4 4 0 00-2.5 7.1V10h5V8.1A4 4 0 007 1z"/><line x1="5" y1="12" x2="9" y2="12"/></svg>
        Recommendations
      </button>
      <button class="nav-a" onclick="nav('settings',this)">
        <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="2"/><path d="M7 1v1.5m0 9V13M1 7h1.5m9 0H13M3.05 3.05l1.06 1.06m5.78 5.78l1.06 1.06M3.05 10.95l1.06-1.06m5.78-5.78l1.06-1.06"/></svg>
        Settings
      </button>
    </div>
    <div class="sb-foot">
      <div class="sb-uname">${esc(displayName)}</div>
      <div class="sb-email">${esc(user.email)}</div>
      <form method="POST" action="/auth/logout">
        <button type="submit" class="logout">Sign out</button>
      </form>
    </div>
  </nav>

  <div class="main">
    <div class="topbar">
      <div style="display:flex;align-items:center;gap:.75rem;flex-wrap:wrap">
        <div class="tb-title" id="tb-title">Analytics</div>
        ${bizSelector}
        <div class="range-picker">
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="10" height="9" rx="1.5"/><line x1="2" y1="6" x2="12" y2="6"/><line x1="5" y1="1.5" x2="5" y2="3.5"/><line x1="9" y1="1.5" x2="9" y2="3.5"/></svg>
          <select id="range-picker">
            <option value="7d">Last 7 days</option>
            <option value="30d" selected>Last 30 days</option>
            <option value="90d">Last 90 days</option>
            <option value="365d">Last year</option>
            <option value="custom">Custom…</option>
          </select>
        </div>
        <div class="range-custom" id="range-custom">
          <input type="date" id="range-start">
          <span style="color:var(--muted);font-size:.75rem">to</span>
          <input type="date" id="range-end">
          <button class="range-apply" id="range-apply" type="button">Apply</button>
        </div>
      </div>
      <button class="dark-toggle" onclick="toggleDark()" id="dark-btn">Dark</button>
    </div>
    <div class="content">
      <div id="sec-analytics" class="section active">${analyticsHtml}</div>
      <div id="sec-recs"      class="section">${recsHtml}</div>
      <div id="sec-settings"  class="section">${settingsHtml}</div>
    </div>
  </div>
</div>

<script>
var TREND_LABELS = ${trendLabels};
var TREND_DATA = ${trendData};
var chartsDone = false;
var chart1, chart2;
var curSection = 'overview';

function nav(name, btn) {
  document.querySelectorAll('.section').forEach(function(el) { el.classList.remove('active'); });
  var el = document.getElementById('sec-' + name);
  if (el) el.classList.add('active');
  document.querySelectorAll('.nav-a').forEach(function(a) { a.classList.remove('on'); });
  if (btn) btn.classList.add('on');
  var titles = {analytics:'Analytics',recs:'Recommendations',settings:'Settings'};
  document.getElementById('tb-title').textContent = titles[name] || name;
  curSection = name;
  if ((name === 'overview' || name === 'requests') && !chartsDone) setTimeout(initCharts, 50);
}

function mkChart(ctx, barColor, gridColor, textColor) {
  return new Chart(ctx, {
    type: 'bar',
    data: { labels: TREND_LABELS, datasets: [{ data: TREND_DATA, backgroundColor: barColor, borderRadius: 3, borderSkipped: false }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { title: function(items) { return items[0].label; } } } },
      scales: {
        x: { grid: { display: false }, ticks: { color: textColor, font: { size: 9 }, maxTicksLimit: 8 } },
        y: { beginAtZero: true, grid: { color: gridColor }, ticks: { color: textColor, font: { size: 9 }, precision: 0 } }
      }
    }
  });
}

function initCharts() {
  if (typeof Chart === 'undefined' || chartsDone) return;
  chartsDone = true;
  var dark = document.documentElement.classList.contains('dark');
  var barColor  = dark ? 'rgba(96,165,250,0.75)' : 'rgba(17,24,39,0.75)';
  var gridColor = dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)';
  var textColor = dark ? '#6b7280' : '#9ca3af';
  var c1 = document.getElementById('trend-chart');
  var c2 = document.getElementById('trend-chart-2');
  if (c1) chart1 = mkChart(c1, barColor, gridColor, textColor);
  if (c2) chart2 = mkChart(c2, barColor, gridColor, textColor);
}

function toggleDark() {
  var dark = document.documentElement.classList.toggle('dark');
  document.getElementById('dark-btn').textContent = dark ? 'Light' : 'Dark';
  try { localStorage.setItem('adv-dark', dark ? '1' : '0'); } catch(e) {}
  chartsDone = false;
  if (chart1) { chart1.destroy(); chart1 = null; }
  if (chart2) { chart2.destroy(); chart2 = null; }
  if (curSection === 'overview' || curSection === 'requests') setTimeout(initCharts, 50);
}

function toggleMore(btn) {
  var rows = document.querySelectorAll('.act-more');
  var show = rows[0] && rows[0].style.display === 'none';
  rows.forEach(function(r) { r.style.display = show ? '' : 'none'; });
  btn.textContent = show ? 'Show less' : ('Show all ' + rows.length + ' more requests');
}

function toggleKey(btn, full, masked) {
  var el = document.getElementById('api-key-display');
  var showing = btn.textContent === 'Hide';
  el.textContent = showing ? masked : full;
  btn.textContent = showing ? 'Show' : 'Hide';
}

function copyText(text, btn) {
  navigator.clipboard.writeText(text).then(function() {
    var orig = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(function() { btn.textContent = orig; }, 1800);
  }).catch(function() {
    btn.textContent = 'Failed';
    setTimeout(function() { btn.textContent = 'Copy'; }, 1800);
  });
}

function rotateKey(slug) {
  if (!slug) return;
  if (!confirm('Rotate API key for "' + slug + '"?\\n\\nThis will immediately invalidate your current key. Any services using it must be updated.')) return;
  var result = document.getElementById('rotate-result');
  result.innerHTML = '<span style="color:var(--muted);font-size:.8125rem">Rotating key...</span>';
  result.style.display = 'block';
  fetch('/api/client/rotate-key?slug=' + encodeURIComponent(slug), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.ok && data.new_api_key) {
        result.innerHTML = '<div style="background:#f0fdf4;border:1px solid #86efac;border-radius:6px;padding:.875rem;font-size:.8125rem">' +
          '<strong>New API key generated:</strong><br><code style="word-break:break-all;display:block;margin:.5rem 0">' + data.new_api_key + '</code>' +
          '<span style="color:var(--sub)">Save this key and update it anywhere the old key was used. The old key is now invalid.</span></div>';
      } else {
        result.innerHTML = '<div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:6px;padding:.75rem;font-size:.8125rem;color:#dc2626">Error: ' + (data.error || 'Unknown error') + '</div>';
      }
    })
    .catch(function() {
      result.innerHTML = '<div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:6px;padding:.75rem;font-size:.8125rem;color:#dc2626">Network error. Please try again.</div>';
    });
}

// Dark mode init
try {
  if (localStorage.getItem('adv-dark') === '1') {
    document.documentElement.classList.add('dark');
    var db = document.getElementById('dark-btn');
    if (db) db.textContent = 'Light';
  }
} catch(e) {}

// Chart init on load (legacy Chart.js trend — left in place for the
// Recommendations/Settings sections that still reference TREND_DATA).
window.addEventListener('load', function() {
  if (TREND_DATA.some(function(v) { return v > 0; })) setTimeout(initCharts, 100);
});
<\/script>

<!-- Phase A: dashboard config + ECharts client script -->
<script id="dashboard-config" type="application/json">${JSON.stringify({
  slug:        selected?.slug ?? null,
  apiBase:     "",
  rangeQS:     "range=30d",
  businessName: selected?.business_name ?? null,
})}<\/script>
${DASHBOARD_CLIENT_SCRIPT}
</body>
</html>`;
}
