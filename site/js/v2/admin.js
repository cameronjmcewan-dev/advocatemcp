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
    // Kick off both requests in parallel — the aggregate activity feed
    // (scope=all) is admin-only on the worker side. If either fails we
    // surface the partial result instead of going 100% blank.
    const [metricsRes, feedRes] = await Promise.all([
      af('/api/client/all-metrics').catch(() => null),
      af('/api/client/activity-detail?scope=all').catch(() => null),
    ]);
    if (metricsRes && metricsRes.status === 403) return { __forbidden: true };
    if (!metricsRes || !metricsRes.ok) return { __error: `HTTP ${metricsRes?.status ?? 'network'}` };
    const body = await metricsRes.json();
    if (feedRes && feedRes.ok) {
      try { body.__feed = await feedRes.json(); } catch { /* ignore */ }
    }
    return body;
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
            <a class="btn btn-ghost btn-sm" href="/app.html?as=${encodeURIComponent(b.slug)}" target="_blank" rel="noopener">Impersonate →</a>
          </td>
        </tr>`).join('');

    // ── Cross-tenant activity feed (scope=all) ──────────────────────
    const feed = data?.__feed?.feed || [];
    const feedRows = feed.length === 0
      ? `<div style="padding:14px 0;color:var(--muted);font-size:13.5px">No recent cross-tenant events.</div>`
      : feed.slice(0, 12).map((ev) => {
          const t  = ev.timestamp ? new Date(ev.timestamp).toLocaleString() : '';
          const ts = t.length > 18 ? t.slice(0, 18) : t;
          const biz = ev.business_name || ev.business_slug || '';
          let line = '';
          if (ev.type === 'reservation') {
            line = `<strong>${esc(biz)}</strong> reservation <code>${esc(ev.status)}</code>`;
          } else if (ev.type === 'handoff') {
            line = `<strong>${esc(biz)}</strong> handoff <code>${esc(ev.mode)}</code>${ev.delivered_via ? ` via ${esc(ev.delivered_via)}` : ''}`;
          } else if (ev.type === 'agent_call') {
            line = `<strong>${esc(biz)}</strong> <code>${esc(ev.tool_called)}</code> · ${esc(ev.agent_id || 'anon')} · ${esc(ev.outcome_signal || '–')}`;
          } else {
            line = `<strong>${esc(biz)}</strong> ${esc(ev.type || '')}`;
          }
          return `<div class="feed-row"><span class="t">${esc(ts)}</span><span class="m">${line}</span></div>`;
        }).join('');

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
          <div class="card-head"><div><h3>Live activity · all tenants</h3><div class="sub">Reservations, handoffs, agent calls — most recent first</div></div></div>
          <div class="feed-list">${feedRows}</div>
        </div>
      </div>

      <div class="row">
        <div class="card-dash">
          <div class="card-head"><div><h3>Admin shortcuts</h3><div class="sub">Go deeper</div></div></div>
          <ul class="admin-links">
            <li><a href="/admin/tenants.html">Tenant list + filter</a> <span class="hint">All tenants, sortable, drill through to impersonate</span></li>
            <li><a href="/admin/queries.html">Cross-tenant query clusters</a> <span class="hint">Top topics across every tenant (data-product preview)</span></li>
            <li><a href="#" onclick="event.preventDefault(); window.AMCP_CMDK && window.AMCP_CMDK.open();">Command palette (⌘K)</a> <span class="hint">Jump to any tenant by name</span></li>
          </ul>
        </div>
        <div class="card-dash">
          <div class="card-head"><div><h3>External ops</h3><div class="sub">Services we depend on</div></div></div>
          <ul class="admin-links">
            <li><a href="https://dash.cloudflare.com" target="_blank" rel="noopener">Cloudflare</a> <span class="hint">Pages, Workers, D1</span></li>
            <li><a href="https://railway.app" target="_blank" rel="noopener">Railway</a> <span class="hint">Server logs + redeploys</span></li>
            <li><a href="https://dashboard.stripe.com" target="_blank" rel="noopener">Stripe</a> <span class="hint">Checkout + subscriptions</span></li>
            <li><a href="https://resend.com/emails" target="_blank" rel="noopener">Resend</a> <span class="hint">Email deliverability</span></li>
            <li><a href="https://api.advocatemcp.com/.well-known/mcp.json" target="_blank" rel="noopener">/.well-known/mcp.json</a> <span class="hint">Live MCP manifest</span></li>
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
        .feed-list { display: flex; flex-direction: column; }
        .feed-row { display: grid; grid-template-columns: 120px 1fr; gap: 10px; padding: 8px 0; border-bottom: 1px dashed var(--line); font-size: 13px; }
        .feed-row:last-child { border-bottom: 0; }
        .feed-row .t { color: var(--muted); font-family: var(--mono); font-size: 11.5px; white-space: nowrap; }
        .feed-row .m code { background: var(--paper-2); padding: 1px 5px; border-radius: 3px; font-size: 11.5px; }
      </style>
    `;
  }

  window.AMCP_ADMIN = { demo: () => DEMO, fetch: fetchReal, render };
})();
