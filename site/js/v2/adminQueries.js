/* v2 Admin · Cross-tenant queries.
 *
 * This is Concept C's hero — the internal preview of the Tier 1
 * external data product. Shows top semantic clusters across every
 * tenant in the panel, plus coverage health + industry trend strip.
 *
 * Data comes from the Worker's /api/admin/insights-proxy/* routes,
 * which forward to Railway's /admin/insights/* endpoints (Bearer-
 * auth'd with ADMIN_API_KEY, never exposed to the browser). If the
 * Worker doesn't have ADMIN_API_KEY set, we show a config-needed
 * state with the exact wrangler command to run.
 */
(function () {
  'use strict';

  const DEMO = {
    health: {
      coverage_last_7d_pct:  0.94,
      coverage_last_30d_pct: 0.83,
      total_clusters_active: 47,
      total_clusters_archived: 3,
      avg_cluster_size: 18.2,
      last_cluster_update_at: new Date(Date.now() - 4 * 3600 * 1000).toISOString(),
      backfill_remaining: 120,
    },
    clusters: [
      { cluster_id: 1, label: 'pediatric dental cleaning pricing', count: 87, unique_tenants: 4, representative_queries: ['how much for a cleaning', 'what\'s a kids cleaning cost', 'dental prices for a 5 year old'] },
      { cluster_id: 2, label: 'emergency plumber nights weekends', count: 62, unique_tenants: 3, representative_queries: ['24 hour plumber near me', 'emergency leak weekend', 'plumber tonight'] },
      { cluster_id: 3, label: 'real estate lawyer austin closing', count: 49, unique_tenants: 2, representative_queries: ['closing attorney fee', 'title lawyer downtown', 'real estate closing cost austin'] },
      { cluster_id: 4, label: 'florist same day delivery', count: 41, unique_tenants: 3, representative_queries: ['can you deliver today', 'same-day flower austin', 'flowers in 2 hours'] },
      { cluster_id: 5, label: 'electrician panel upgrade quote', count: 34, unique_tenants: 2, representative_queries: ['200 amp panel price', 'electrical panel upgrade cost', 'service upgrade quote'] },
    ],
    trends: [
      { industry_code: 'healthcare',    day: todayMinus(0), query_count: 58, unique_tenants: 6, avg_cost_cents: 2 },
      { industry_code: 'home_services', day: todayMinus(0), query_count: 44, unique_tenants: 4, avg_cost_cents: 2 },
      { industry_code: 'food_beverage', day: todayMinus(0), query_count: 31, unique_tenants: 3, avg_cost_cents: 2 },
      { industry_code: 'events',        day: todayMinus(0), query_count: 22, unique_tenants: 3, avg_cost_cents: 2 },
      { industry_code: 'professional_svc', day: todayMinus(0), query_count: 17, unique_tenants: 2, avg_cost_cents: 2 },
    ],
  };

  function todayMinus(n) {
    const d = new Date(Date.now() - n * 86400000);
    return d.toISOString().slice(0, 10);
  }

  async function fetchReal() {
    const af = window.AMCP && window.AMCP.authedFetch;
    const base = '/api/admin/insights-proxy';
    const [health, clusters, trends] = await Promise.all([
      af(`${base}/embeddings-health`).catch(() => null),
      af(`${base}/top-clusters?limit=25&days=30`).catch(() => null),
      af(`${base}/trends?days=14`).catch(() => null),
    ]);
    // 403 from any of them = non-admin; 503 = ADMIN_API_KEY not set.
    if (health && health.status === 403) return { __forbidden: true };
    if (health && health.status === 503) return { __not_configured: true };
    const data = {};
    try { if (health   && health.ok)   data.health   = await health.json();   } catch {}
    try { if (clusters && clusters.ok) data.clusters = await clusters.json(); } catch {}
    try { if (trends   && trends.ok)   data.trends   = await trends.json();   } catch {}
    if (!data.health && !data.clusters && !data.trends) {
      return { __error: 'Insights endpoints returned nothing — check Worker logs for `admin_insights_proxy_error`.' };
    }
    return data;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtCount(v) { return v == null || isNaN(v) ? '—' : Number(v).toLocaleString(); }
  function fmtPct(v)   { return v == null || isNaN(v) ? '—' : Math.round(v * 100) + '%'; }

  function isAdmin() {
    const d = window.AMCP_DATA || {};
    return d.user_role === 'admin';
  }

  function renderForbidden() {
    return `
      <div class="plain-banner" style="background:var(--maroon-wash);border-color:var(--maroon-tint)">
        <strong>Admin only.</strong>
        Cross-tenant query data is restricted to accounts with the <code>admin</code> role.
      </div>
    `;
  }

  function renderNotConfigured() {
    return `
      <div class="plain-banner" style="background:var(--maroon-wash);border-color:var(--maroon-tint)">
        <strong>ADMIN_API_KEY not configured on the Worker.</strong>
        The insights proxy is deployed but can't reach the Railway
        admin endpoints until the shared bearer token is installed.
      </div>
      <div class="row single">
        <div class="card-dash" style="padding:28px">
          <h3 style="font-family:var(--serif);font-weight:400;font-size:22px;margin-bottom:8px">One-time setup</h3>
          <p style="color:var(--ink-2);font-size:14px;line-height:1.55">
            Set the Worker secret with the same value as Railway's
            <code>ADMIN_API_KEY</code> env var (the one used to auth Railway's
            <code>/admin/insights/*</code> routes). Then reload this page.
          </p>
          <pre style="background:var(--paper-2);border:1px solid var(--line);border-radius:8px;padding:14px;font-family:var(--mono);font-size:13px;overflow:auto;margin-top:12px">cd worker
npx wrangler secret put ADMIN_API_KEY</pre>
        </div>
      </div>
    `;
  }

  function render(data) {
    if (!window.__ADVOCATE_PREVIEW && !isAdmin()) return renderForbidden();
    if (data && data.__forbidden)        return renderForbidden();
    if (data && data.__not_configured)   return renderNotConfigured();
    if (data && data.__error) {
      return `<div class="row single"><div class="card-dash" style="padding:32px;color:var(--red)">Failed to load: ${esc(data.__error)}</div></div>`;
    }

    const health  = data?.health   || {};
    const clusters = Array.isArray(data?.clusters) ? data.clusters : [];
    const trends  = Array.isArray(data?.trends)    ? data.trends    : [];

    const lastUpdate = health.last_cluster_update_at
      ? new Date(health.last_cluster_update_at).toLocaleString()
      : '—';

    const clusterRows = clusters.length === 0
      ? `<tr><td colspan="4" style="padding:20px;color:var(--muted);font-size:13.5px;text-align:center">No clusters yet. Coverage = ${fmtPct(health.coverage_last_30d_pct)} of last-30d queries embedded. Clusters build as backfill completes.</td></tr>`
      : clusters.map((c, i) => `
          <tr>
            <td class="t">${i + 1}</td>
            <td>
              <strong>${esc(c.label)}</strong>
              <div style="font-size:11.5px;color:var(--muted);margin-top:3px">
                ${(c.representative_queries || []).slice(0, 3).map((q) => {
                  const t = q && q.length > 80 ? q.slice(0, 77) + '…' : q;
                  return esc(t);
                }).join(' · ')}
              </div>
            </td>
            <td class="t">${fmtCount(c.count)}</td>
            <td class="t">${fmtCount(c.unique_tenants)}</td>
          </tr>
        `).join('');

    // Trends: top-5 industries by volume, last 7 days, horizontal bars.
    const industryTotals = new Map();
    for (const t of trends) {
      industryTotals.set(t.industry_code, (industryTotals.get(t.industry_code) || 0) + (t.query_count || 0));
    }
    const top5 = [...industryTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    const maxN = top5[0]?.[1] || 0;
    const trendBars = top5.length === 0
      ? `<div style="padding:14px 0;color:var(--muted);font-size:13.5px">No industry trend data yet.</div>`
      : top5.map(([industry, n]) => {
          const pct = maxN ? Math.round((n / maxN) * 100) : 0;
          return `<div class="bot-row">
            <span class="name">${esc(industry)}</span>
            <div class="track"><div class="fill" style="width:${pct}%"></div></div>
            <span class="n">${fmtCount(n)}</span>
          </div>`;
        }).join('');

    return `
      <div class="plain-banner">
        <strong>Cross-tenant query clusters.</strong>
        Semantic topics aggregated across every tenant in the panel.
        This is the operational preview of the external data product —
        if we shipped this view to marketing agencies or hedge funds
        tomorrow, these are the rows they'd see. PII is stripped from
        labels at the Haiku prompt layer.
      </div>

      <div class="kpis">
        <div class="kpi"><div class="head"><div class="k">7d coverage</div></div><div class="v tabular">${fmtPct(health.coverage_last_7d_pct)}</div><div class="d">Embedded / total queries</div></div>
        <div class="kpi"><div class="head"><div class="k">30d coverage</div></div><div class="v tabular">${fmtPct(health.coverage_last_30d_pct)}</div><div class="d">Of last-30d queries</div></div>
        <div class="kpi"><div class="head"><div class="k">Active clusters</div></div><div class="v tabular">${fmtCount(health.total_clusters_active)}</div><div class="d">${fmtCount(health.total_clusters_archived)} archived</div></div>
        <div class="kpi"><div class="head"><div class="k">Avg size</div></div><div class="v tabular">${(health.avg_cluster_size || 0).toFixed(1)}</div><div class="d">Queries per cluster</div></div>
      </div>

      <div class="row">
        <div class="card-dash">
          <div class="card-head"><div><h3>Industry activity · 14d</h3><div class="sub">Top 5 industries by query volume</div></div></div>
          ${trendBars}
        </div>
        <div class="card-dash">
          <div class="card-head"><div><h3>Pipeline</h3><div class="sub">Cluster refresh status</div></div></div>
          <div class="set-row"><div class="l">Last cluster update</div><div class="r">${esc(lastUpdate)}</div></div>
          <div class="set-row"><div class="l">Backfill remaining</div><div class="r">${fmtCount(health.backfill_remaining)} rows</div></div>
          <div class="set-row"><div class="l">Next full re-cluster</div><div class="r">Sunday 04:30 UTC</div></div>
          <div class="set-row" style="border-bottom:0"><div class="l">Nightly incremental</div><div class="r">Daily 04:15 UTC</div></div>
        </div>
      </div>

      <div class="row single">
        <div class="card-dash">
          <div class="card-head"><div><h3>Top topics (last 30 days)</h3><div class="sub">Aggregated across every tenant; each row is one semantic cluster.</div></div></div>
          <table class="tbl">
            <thead><tr><th style="width:40px">#</th><th>Topic · representative queries</th><th class="t">Mentions</th><th class="t">Tenants</th></tr></thead>
            <tbody>${clusterRows}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  window.AMCP_ADMIN_QUERIES = { demo: () => DEMO, fetch: fetchReal, render };
})();
