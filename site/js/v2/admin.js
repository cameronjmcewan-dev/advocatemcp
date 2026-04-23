/* v2 Admin page — role-gated aggregate view across every tenant.
 *
 * Backend: GET /api/client/all-metrics (admin only) returns:
 *   { businesses: [{slug, name, domain, plan, analytics}], totals: {...} }
 *
 * Non-admin role returns 403 — render() surfaces that as "You don't have
 * access" instead of a broken page. */
(function () {
  'use strict';

  const DEMO = {
    businesses: [
      { slug: 'dmre',               name: 'DMRE',               domain: 'dmre.com',                  plan: 'pro',  analytics: { total_queries: 412, referral_clicks: 89,  referral_clicks_last_30_days: 47 } },
      { slug: 'workman-copy-co',    name: 'Workman Copy Co',    domain: 'www.workmancopyco.com',     plan: 'base', analytics: { total_queries: 128, referral_clicks: 31,  referral_clicks_last_30_days: 18 } },
      { slug: 'bamboo-brace',       name: 'Bamboo Brace',       domain: 'bamboobrace.com',           plan: 'pro',  analytics: { total_queries: 247, referral_clicks: 52,  referral_clicks_last_30_days: 34 } },
      { slug: 'hill-country-land-co', name: 'Hill Country Land Co', domain: null,                    plan: 'base', analytics: { total_queries: 63,  referral_clicks: 14,  referral_clicks_last_30_days: 9  } },
      { slug: 'preview-demo',       name: 'Preview Tenant',     domain: 'preview.test',              plan: 'free', analytics: { total_queries: 0,   referral_clicks: 0,   referral_clicks_last_30_days: 0  } },
    ],
    totals: {
      business_count: 5,
      total_queries: 850,
      total_clicks: 186,
      total_clicks_30d: 108,
      queries_by_crawler: { Perplexity: 312, ChatGPT: 284, Claude: 171, Gemini: 55, Copilot: 28 },
    },
  };

  async function fetchReal() {
    const af = window.AMCP && window.AMCP.authedFetch;
    const r = await af('/api/client/all-metrics');
    if (r.status === 403) return { __forbidden: true };
    if (!r.ok) return { __error: `HTTP ${r.status}` };
    return await r.json();
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtCount(v) { return v == null || isNaN(v) ? '—' : Number(v).toLocaleString(); }

  function tierChip(plan) {
    const p = (plan || 'free').toLowerCase();
    const cls = p === 'pro' ? 'maroon' : p === 'base' ? 'sage' : p === 'admin' ? 'amber' : '';
    return `<span class="chip ${cls}">${esc(p.toUpperCase())}</span>`;
  }

  function isAdmin() {
    const d = window.AMCP_DATA || {};
    return d.user_role === 'admin';
  }

  function renderForbidden() {
    return `
      <div class="plain-banner" style="background:var(--maroon-wash);border-color:var(--maroon-tint)">
        <strong>Admin only.</strong>
        This page shows aggregate data across every tenant and is restricted to accounts with the <code>admin</code> role.
      </div>
      <div class="row single">
        <div class="card-dash" style="padding:40px;text-align:center">
          <h3 style="font-family:var(--serif);font-weight:400;font-size:28px;margin-bottom:8px">Not your page</h3>
          <p style="color:var(--ink-2);font-size:14.5px;max-width:480px;margin:0 auto">Head back to your <a href="/app.html" style="color:var(--maroon);font-weight:500">own dashboard</a>. If you think you should have admin access, email <a href="mailto:hello@advocatemcp.com" style="color:var(--maroon);font-weight:500">hello@advocatemcp.com</a>.</p>
        </div>
      </div>
    `;
  }

  function render(data) {
    if (!window.__ADVOCATE_PREVIEW && !isAdmin()) return renderForbidden();
    if (data && data.__forbidden) return renderForbidden();
    if (data && data.__error) {
      return `<div class="row single"><div class="card-dash" style="padding:32px;color:var(--red)">Failed to load: ${esc(data.__error)}</div></div>`;
    }

    const d = data || {};
    const totals = d.totals || {};
    const businesses = (d.businesses || []).slice().sort((a, b) =>
      (b.analytics?.total_queries || 0) - (a.analytics?.total_queries || 0)
    );

    const proCount = businesses.filter(b => (b.plan || '').toLowerCase() === 'pro').length;
    const baseCount = businesses.filter(b => (b.plan || '').toLowerCase() === 'base').length;

    const crawlerEntries = Object.entries(totals.queries_by_crawler || {}).sort((a, b) => b[1] - a[1]);
    const crawlerTotal   = crawlerEntries.reduce((s, [, n]) => s + n, 0);
    const crawlerBars = crawlerEntries.length === 0
      ? `<div style="padding:16px 0;color:var(--muted);font-size:13.5px">No aggregate crawler data yet.</div>`
      : crawlerEntries.map(([name, n]) => {
          const pct = crawlerTotal ? Math.round((n / crawlerTotal) * 100) : 0;
          return `<div class="bot-row">
            <span class="name">${esc(name)}</span>
            <div class="track"><div class="fill" style="width:${pct}%"></div></div>
            <span class="n">${fmtCount(n)}</span>
          </div>`;
        }).join('');

    const rows = businesses.length === 0
      ? `<tr><td colspan="6" style="padding:20px;color:var(--muted);font-size:13.5px;text-align:center">No tenants yet.</td></tr>`
      : businesses.map(b => `<tr>
          <td><strong>${esc(b.name || b.slug)}</strong><div style="font-size:11.5px;color:var(--muted);font-family:var(--mono);margin-top:2px">${esc(b.slug)}</div></td>
          <td>${b.domain ? `<span style="font-size:12.5px;font-family:var(--mono)">${esc(b.domain)}</span>` : '<span style="color:var(--muted);font-size:13px">—</span>'}</td>
          <td>${tierChip(b.plan)}</td>
          <td class="t">${fmtCount(b.analytics?.total_queries)}</td>
          <td class="t">${fmtCount(b.analytics?.referral_clicks_last_30_days)}</td>
          <td style="text-align:right">
            <a class="btn btn-ghost btn-sm" href="/app.html?slug=${encodeURIComponent(b.slug)}" target="_blank" rel="noopener">Impersonate →</a>
          </td>
        </tr>`).join('');

    return `
      <div class="plain-banner">
        <strong>Admin view.</strong>
        Aggregate across every active tenant. Impersonate to see a specific business's dashboard (your session stays intact — it's a read-through view).
      </div>

      <div class="kpis">
        <div class="kpi"><div class="head"><div class="k">Businesses</div></div><div class="v tabular">${fmtCount(totals.business_count)}</div><div class="d">Active tenants</div></div>
        <div class="kpi"><div class="head"><div class="k">Pro / Base</div></div><div class="v tabular" style="font-size:28px">${fmtCount(proCount)} / ${fmtCount(baseCount)}</div><div class="d">By plan tier</div></div>
        <div class="kpi"><div class="head"><div class="k">Total mentions</div></div><div class="v tabular">${fmtCount(totals.total_queries)}</div><div class="d">All tenants, all time</div></div>
        <div class="kpi"><div class="head"><div class="k">30-day clicks</div></div><div class="v tabular">${fmtCount(totals.total_clicks_30d)}</div><div class="d">Aggregated</div></div>
      </div>

      <div class="row">
        <div class="card-dash">
          <div class="card-head"><div><h3>By AI tool</h3><div class="sub">Every tenant's mentions combined</div></div></div>
          ${crawlerBars}
        </div>
        <div class="card-dash">
          <div class="card-head"><div><h3>Quick ops links</h3><div class="sub">Internal admin surfaces</div></div></div>
          <ul class="admin-links">
            <li><a href="https://dash.cloudflare.com" target="_blank" rel="noopener">Cloudflare dashboard</a> <span class="hint">Pages, Workers, D1</span></li>
            <li><a href="https://railway.app" target="_blank" rel="noopener">Railway</a> <span class="hint">Server logs + redeploys</span></li>
            <li><a href="https://api.stripe.com" target="_blank" rel="noopener">Stripe</a> <span class="hint">Checkout + subscriptions</span></li>
            <li><a href="https://api.advocatemcp.com/.well-known/mcp.json" target="_blank" rel="noopener">/.well-known/mcp.json</a> <span class="hint">Live manifest</span></li>
            <li><a href="/dashboard.html?ui=legacy" target="_blank" rel="noopener">Legacy dashboard</a> <span class="hint">Full admin tools (/admin endpoints)</span></li>
          </ul>
        </div>
      </div>

      <div class="row single">
        <div class="card-dash">
          <div class="card-head"><div><h3>Every tenant</h3><div class="sub">Sorted by mentions, descending</div></div></div>
          <table class="tbl">
            <thead><tr><th>Business</th><th>Domain</th><th>Plan</th><th>Mentions</th><th>Clicks 30d</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>

      <style>
        .admin-links { list-style: none; padding: 0; margin: 12px 0 0; display: flex; flex-direction: column; gap: 10px; }
        .admin-links li { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; padding: 8px 0; border-bottom: 1px dashed var(--line); }
        .admin-links li:last-child { border-bottom: 0; }
        .admin-links a { color: var(--maroon); font-weight: 500; font-size: 14px; }
        .admin-links .hint { font-size: 12px; color: var(--muted); }
      </style>
    `;
  }

  window.AMCP_ADMIN = { demo: () => DEMO, fetch: fetchReal, render };
})();
