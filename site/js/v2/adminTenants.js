/* v2 Admin · Tenants list — dedicated drill-down surface.
 *
 * Same /api/client/all-metrics source as admin.js's Mission Control,
 * but this page surfaces a focused view: filterable + sortable list
 * plus per-tenant quick actions (impersonate, rotate key, open MCP
 * record). Mission Control is the summary; this is the detail.
 *
 * Why a separate page: the 5-column tenant table on Mission Control
 * competes with the KPI strip + activity feed for attention. A
 * dedicated list makes heavy operator workflows (scanning, triage,
 * bulk ops) first-class. */
(function () {
  'use strict';

  const DEMO = {
    businesses: [
      { slug: 'dmre',                 name: 'DMRE',                 domain: 'dmre.com',                 plan: 'pro',  analytics: { total_queries: 412, referral_clicks: 89,  referral_clicks_last_30_days: 47 } },
      { slug: 'workman-copy-co',      name: 'Workman Copy Co',      domain: 'www.workmancopyco.com',    plan: 'base', analytics: { total_queries: 128, referral_clicks: 31,  referral_clicks_last_30_days: 18 } },
      { slug: 'bamboo-brace',         name: 'Bamboo Brace',         domain: 'bamboobrace.com',          plan: 'pro',  analytics: { total_queries: 247, referral_clicks: 52,  referral_clicks_last_30_days: 34 } },
      { slug: 'hill-country-land-co', name: 'Hill Country Land Co', domain: null,                       plan: 'base', analytics: { total_queries: 63,  referral_clicks: 14,  referral_clicks_last_30_days: 9  } },
      { slug: 'preview-demo',         name: 'Preview Tenant',       domain: 'preview.test',             plan: 'free', analytics: { total_queries: 0,   referral_clicks: 0,   referral_clicks_last_30_days: 0  } },
    ],
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
        This page lists every tenant and is restricted to accounts with the <code>admin</code> role.
      </div>
    `;
  }

  function render(data) {
    if (!window.__ADVOCATE_PREVIEW && !isAdmin()) return renderForbidden();
    if (data && data.__forbidden) return renderForbidden();
    if (data && data.__error) {
      return `<div class="row single"><div class="card-dash" style="padding:32px;color:var(--red)">Failed to load: ${esc(data.__error)}</div></div>`;
    }

    const all = (data?.businesses || []).slice();

    return `
      <div class="row single">
        <div class="card-dash">
          <div class="card-head" style="flex-wrap:wrap;gap:12px">
            <div>
              <h3>Tenants (<span id="tenant-count">${all.length}</span>)</h3>
              <div class="sub">Filter, sort, and drill into any tenant's dashboard.</div>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
              <input id="filter" type="search" placeholder="Filter by name, slug, domain…" autocomplete="off"
                     style="padding:7px 10px;border:1px solid var(--line);border-radius:8px;font-size:13.5px;background:var(--paper);color:var(--ink);min-width:220px">
              <select id="plan-filter" style="padding:7px 10px;border:1px solid var(--line);border-radius:8px;font-size:13.5px;background:var(--paper);color:var(--ink)">
                <option value="">All plans</option>
                <option value="pro">Pro</option>
                <option value="base">Base</option>
                <option value="free">Free</option>
              </select>
              <select id="sort-by" style="padding:7px 10px;border:1px solid var(--line);border-radius:8px;font-size:13.5px;background:var(--paper);color:var(--ink)">
                <option value="queries">Sort: Mentions desc</option>
                <option value="clicks">Sort: 30d clicks desc</option>
                <option value="name">Sort: Name A–Z</option>
                <option value="plan">Sort: Plan</option>
              </select>
            </div>
          </div>
          <table class="tbl" id="tenants-tbl">
            <thead><tr>
              <th>Business</th>
              <th>Domain</th>
              <th>Plan</th>
              <th class="t">Mentions</th>
              <th class="t">30d clicks</th>
              <th></th>
            </tr></thead>
            <tbody id="tenants-tbody"></tbody>
          </table>
        </div>
      </div>

      <style>
        .row-action { display: inline-flex; gap: 6px; }
        .row-action a { font-size: 12.5px; color: var(--maroon); font-weight: 500; }
      </style>
    `;
  }

  function afterMount(data) {
    const all = (data?.businesses || []).slice();
    const filterEl = document.getElementById('filter');
    const planEl   = document.getElementById('plan-filter');
    const sortEl   = document.getElementById('sort-by');
    const tbody    = document.getElementById('tenants-tbody');
    const countEl  = document.getElementById('tenant-count');
    if (!filterEl || !tbody) return;

    function compare(a, b, key) {
      if (key === 'queries') return (b.analytics?.total_queries || 0) - (a.analytics?.total_queries || 0);
      if (key === 'clicks')  return (b.analytics?.referral_clicks_last_30_days || 0) - (a.analytics?.referral_clicks_last_30_days || 0);
      if (key === 'name')    return (a.name || a.slug).localeCompare(b.name || b.slug);
      if (key === 'plan')    return (a.plan || 'z').localeCompare(b.plan || 'z');
      return 0;
    }

    function rowsFor(list) {
      if (list.length === 0) {
        return `<tr><td colspan="6" style="padding:20px;color:var(--muted);font-size:13.5px;text-align:center">No tenants match the filter.</td></tr>`;
      }
      return list.map((b) => `
        <tr>
          <td>
            <strong>${esc(b.name || b.slug)}</strong>
            <div style="font-size:11.5px;color:var(--muted);font-family:var(--mono);margin-top:2px">${esc(b.slug)}</div>
          </td>
          <td>${b.domain ? `<span style="font-size:12.5px;font-family:var(--mono)">${esc(b.domain)}</span>` : '<span style="color:var(--muted);font-size:13px">—</span>'}</td>
          <td>${tierChip(b.plan)}</td>
          <td class="t">${fmtCount(b.analytics?.total_queries)}</td>
          <td class="t">${fmtCount(b.analytics?.referral_clicks_last_30_days)}</td>
          <td style="text-align:right" class="row-action">
            <a href="/app.html?as=${encodeURIComponent(b.slug)}" target="_blank" rel="noopener">Impersonate →</a>
          </td>
        </tr>
      `).join('');
    }

    function refresh() {
      const q = (filterEl.value || '').toLowerCase().trim();
      const plan = planEl.value;
      const sort = sortEl.value;
      let list = all.slice();
      if (plan) list = list.filter((b) => (b.plan || '').toLowerCase() === plan);
      if (q) list = list.filter((b) =>
        (b.name || '').toLowerCase().includes(q) ||
        (b.slug || '').toLowerCase().includes(q) ||
        (b.domain || '').toLowerCase().includes(q),
      );
      list.sort((a, b) => compare(a, b, sort));
      tbody.innerHTML = rowsFor(list);
      countEl.textContent = String(list.length);
    }

    filterEl.addEventListener('input', refresh);
    planEl.addEventListener('change', refresh);
    sortEl.addEventListener('change', refresh);
    refresh();
  }

  window.AMCP_ADMIN_TENANTS = {
    demo:       () => DEMO,
    fetch:      fetchReal,
    render,
    afterMount,
  };
})();
