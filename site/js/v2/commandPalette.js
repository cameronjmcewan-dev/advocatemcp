/* Cmd+K / Ctrl+K command palette for admin dashboards.
 *
 * Keeps its own DOM root (appended to body on first use) and listens
 * globally for the shortcut. Mounts only when window.AMCP_DATA.user_role
 * === 'admin' — regular users see the native Cmd+K browser behavior.
 *
 * Data sources:
 *   - /api/client/all-metrics (cached 30s) for tenant names + slugs
 *   - Static list of admin pages + common actions (search, open)
 *
 * Navigation model: picking a tenant opens /app.html?as=<slug>
 * (impersonation). Picking an admin page navigates directly.
 * Actions like "Impersonate <slug>" and "Open Queries" are one-shot.
 */
(function () {
  'use strict';

  const PALETTE_ID = 'amcp-cmd-palette';
  let tenantsCache = null;
  let tenantsFetchedAt = 0;
  const TENANT_CACHE_TTL_MS = 30 * 1000;

  const STATIC_ACTIONS = [
    { kind: 'admin-page', label: 'Mission Control',     hint: '/admin',                href: '/admin' },
    { kind: 'admin-page', label: 'All Tenants',         hint: '/admin/tenants.html',   href: '/admin/tenants.html' },
    { kind: 'admin-page', label: 'Cross-tenant Queries',hint: '/admin/queries.html',   href: '/admin/queries.html' },
    { kind: 'admin-page', label: 'My Dashboard',        hint: '/app.html',             href: '/app.html' },
    { kind: 'admin-page', label: 'My Settings',         hint: '/Settings.html',        href: '/Settings.html' },
    { kind: 'admin-page', label: 'Back to marketing',   hint: '/',                     href: '/' },
  ];

  async function loadTenants() {
    if (tenantsCache && Date.now() - tenantsFetchedAt < TENANT_CACHE_TTL_MS) return tenantsCache;
    try {
      // Cache-share with Mission Control / Tenants / Queries pages so
      // opening the palette right after viewing any of them is instant.
      const cf = (window.AMCP && window.AMCP.cachedFetch) || window.AMCP.authedFetch;
      const r = await cf('/api/client/all-metrics');
      if (!r.ok) return [];
      const j = await r.json();
      tenantsCache = (j.businesses || []).map((b) => ({
        kind:  'tenant',
        label: b.name || b.slug,
        hint:  b.domain || b.slug,
        slug:  b.slug,
        href:  `/app.html?as=${encodeURIComponent(b.slug)}`,
      }));
      tenantsFetchedAt = Date.now();
      return tenantsCache;
    } catch {
      return [];
    }
  }

  function palette() {
    let el = document.getElementById(PALETTE_ID);
    if (el) return el;
    el = document.createElement('div');
    el.id = PALETTE_ID;
    el.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:9999',
      'display:none', 'align-items:flex-start', 'justify-content:center',
      'padding-top:12vh',
      'background:rgba(20,18,16,.45)',
      'backdrop-filter:blur(4px)', '-webkit-backdrop-filter:blur(4px)',
    ].join(';');
    el.innerHTML = `
      <div id="amcp-cmd-box" style="width:min(560px,92vw);background:#fbf9f5;border:1px solid #d8d1c3;border-radius:12px;overflow:hidden;box-shadow:0 20px 60px -20px rgba(20,18,16,.35);font-family:'General Sans',system-ui,sans-serif">
        <input id="amcp-cmd-input" type="text" autocomplete="off" placeholder="Jump to a tenant or page…"
               style="width:100%;padding:16px 20px;border:0;outline:none;font-size:15px;background:#fbf9f5;color:#141210;border-bottom:1px solid #d8d1c3"/>
        <ul id="amcp-cmd-list" style="list-style:none;margin:0;padding:6px 0;max-height:50vh;overflow-y:auto"></ul>
        <div style="padding:10px 16px;border-top:1px solid #d8d1c3;font-size:12px;color:#766f63;display:flex;gap:14px;justify-content:space-between">
          <span>↑↓ navigate · ⏎ open · Esc close</span>
          <span>Admin palette</span>
        </div>
      </div>
      <style>
        @media (prefers-color-scheme: dark) {
          #amcp-cmd-box { background:#1c1a17 !important; border-color:#3a342c !important; }
          #amcp-cmd-input { background:#1c1a17 !important; color:#e8e3e0 !important; border-color:#3a342c !important; }
          #amcp-cmd-box > div { border-color:#3a342c !important; color:#a39b8f !important; }
        }
        #amcp-cmd-list li.active { background:rgba(92,26,60,.1); }
        #amcp-cmd-list li:hover { background:rgba(92,26,60,.08); cursor:pointer; }
      </style>
    `;
    document.body.appendChild(el);
    return el;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function renderList(items, activeIdx) {
    if (items.length === 0) {
      return '<li style="padding:16px 20px;color:#766f63;font-size:14px">No matches.</li>';
    }
    return items.map((it, i) => {
      const active = i === activeIdx ? 'active' : '';
      const badge = it.kind === 'tenant' ? 'Tenant' : 'Page';
      const badgeBg = it.kind === 'tenant' ? '#5c1a3c' : '#766f63';
      return `
        <li class="${active}" data-idx="${i}" style="padding:10px 20px;display:flex;align-items:center;gap:12px;font-size:14px;color:#141210">
          <span style="font-size:10px;padding:2px 8px;border-radius:999px;background:${badgeBg};color:#fff;font-weight:500;letter-spacing:.04em">${badge}</span>
          <span style="flex:1">${esc(it.label)}</span>
          <span style="color:#766f63;font-size:12px">${esc(it.hint)}</span>
        </li>
      `;
    }).join('');
  }

  function filterItems(items, q) {
    if (!q) return items;
    const qq = q.toLowerCase();
    return items.filter((it) =>
      String(it.label).toLowerCase().includes(qq) ||
      String(it.hint).toLowerCase().includes(qq),
    );
  }

  async function open() {
    const el = palette();
    const input = el.querySelector('#amcp-cmd-input');
    const list  = el.querySelector('#amcp-cmd-list');

    el.style.display = 'flex';
    input.value = '';
    input.focus();

    // Immediately render static pages, then merge tenants when they arrive.
    let items = STATIC_ACTIONS.slice();
    let activeIdx = 0;
    list.innerHTML = renderList(filterItems(items, ''), activeIdx);

    const tenants = await loadTenants();
    items = [...tenants, ...STATIC_ACTIONS];
    list.innerHTML = renderList(filterItems(items, input.value), activeIdx);

    function refresh() {
      const filtered = filterItems(items, input.value);
      if (activeIdx >= filtered.length) activeIdx = Math.max(0, filtered.length - 1);
      list.innerHTML = renderList(filtered, activeIdx);
    }

    function close() {
      el.style.display = 'none';
      input.onkeydown = null;
      list.onclick = null;
      el.onclick = null;
    }

    function pick(idx) {
      const filtered = filterItems(items, input.value);
      const it = filtered[idx];
      if (!it) return;
      close();
      if (it.href) {
        window.location.href = it.href;
      }
    }

    input.oninput = refresh;
    input.onkeydown = (e) => {
      const filtered = filterItems(items, input.value);
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key === 'Enter')  { e.preventDefault(); pick(activeIdx); return; }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        activeIdx = (activeIdx + 1) % Math.max(1, filtered.length);
        list.innerHTML = renderList(filtered, activeIdx);
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        activeIdx = (activeIdx - 1 + filtered.length) % Math.max(1, filtered.length);
        list.innerHTML = renderList(filtered, activeIdx);
      }
    };
    list.onclick = (e) => {
      const li = e.target.closest('li[data-idx]');
      if (!li) return;
      pick(parseInt(li.dataset.idx, 10));
    };
    el.onclick = (e) => { if (e.target === el) close(); };
  }

  /* Global listener — Cmd+K / Ctrl+K. Scoped to admin role so regular
     users get the browser-native behavior (Chrome's address-bar focus,
     etc). Ignore inside contenteditable or password inputs. */
  document.addEventListener('keydown', (e) => {
    const isShortcut = (e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K');
    if (!isShortcut) return;
    const d = window.AMCP_DATA || {};
    if (d.user_role !== 'admin') return;
    const target = e.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') &&
        target.id !== 'amcp-cmd-input') {
      // allow shortcut from within most inputs
    }
    e.preventDefault();
    open();
  });

  window.AMCP_CMDK = { open };
})();
