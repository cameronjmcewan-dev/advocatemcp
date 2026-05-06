/* ============================================================
   Advocate, Dashboard chrome renderer
   Renders sidebar, topbar, FAB help button + menu on every page.
   ============================================================ */

(function () {
  // All internal hrefs are absolute so they resolve whether the page is
  // reached as /app.html, /app (CF Pages' auto-strip), or from any nested
  // route. Relative hrefs broke the ported marketing pages.
  //
  // The Overview entry is /app.html (not /Dashboard.html) because macOS'
  // case-insensitive filesystem aliases Dashboard.html with the existing
  // legacy dashboard.html, and we need the new UI on a distinct path.
  const NAV_MAIN = [
    { id: 'overview',    href: '/app.html',              g: '◈', label: 'Overview' },
    { id: 'bot-traffic', href: '/BotTraffic.html',       g: '♨', label: 'Bot traffic' },
    { id: 'mentions',    href: '/Mentions.html',         g: '✦', label: 'Mentions' },
    { id: 'clicks',      href: '/ClickThroughs.html',    g: '→', label: 'Click-throughs' },
    { id: 'radar',       href: '/CompetitorRadar.html',  g: '△', label: 'Competitor Radar' },
    { id: 'a2a',         href: '/A2APipeline.html',      g: '⇄', label: 'AI bookings' },
    { id: 'activity',    href: '/ActivityFeed.html',     g: '☰', label: 'Activity feed' },
  ];
  const NAV_ACCOUNT = [
    { id: 'profile',     href: '/BusinessProfile.html',  g: '⚙', label: 'Business profile' },
    { id: 'settings',    href: '/Settings.html',         g: '⌸', label: 'Settings & API' },
    { id: 'billing',     href: '/Billing.html',          g: '◑', label: 'Billing' },
  ];
  const NAV_FOOT = [
    { id: 'back',        href: '/',                      g: '↩', label: 'Back to site' },
    { id: 'contact',     href: '/Contact.html',          g: '?', label: 'Contact Us' },
    { id: 'faqs',        href: '/FAQs.html',             g: '?', label: 'FAQs' },
  ];

  // Admin-only nav, rendered only when window.AMCP_DATA.user_role === 'admin'.
  // Order follows the "operator console" pattern: Mission Control first (single-
  // page overview), then drill-downs (tenant list, cross-tenant queries). Paths
  // are /admin/* so they feel like one surface, not scattered files.
  const NAV_ADMIN = [
    { id: 'admin-overview',     href: '/admin',                     g: '◎', label: 'Mission Control' },
    { id: 'admin-tenants',      href: '/admin/tenants.html',        g: '◉', label: 'Tenants' },
    { id: 'admin-queries',      href: '/admin/queries.html',        g: '◔', label: 'Queries' },
    { id: 'admin-experiments',  href: '/admin/experiments.html',    g: '⚗', label: 'Experiments' },
  ];

  /* Reads the current tenant from window.AMCP_DATA (populated after /api/
     client/me + /api/client/metrics resolve) and falls back to generic
     placeholders if the boot code hasn't finished yet. Never returns the
     design-mockup florist persona, that would leak "Bloom & Stem" copy
     to real users.

     Admin flavouring: when the session role is admin AND we aren't
     currently impersonating a specific tenant, the sidebar block
     renders as "Admin · All tenants" so it's obvious this isn't a
     single-business session. When admin IS impersonating, we show the
     impersonated tenant's name + slug (driven by AMCP_DATA.impersonating). */
  function currentBiz() {
    const d = window.AMCP_DATA || {};
    const isAdmin       = d.user_role === 'admin';
    const impersonating = d.impersonating;
    if (isAdmin && !impersonating) {
      return { name: 'Admin', location: 'All tenants', plan: 'Operator', letter: 'A' };
    }
    const name     = d.business_name || d.name || 'Your business';
    const location = d.location || '';
    const planRaw  = (d.plan || '').toLowerCase();
    const plan     = planRaw === 'pro' ? 'Pro plan'
                    : planRaw === 'base' ? 'Base plan'
                    : planRaw === 'admin' ? 'Admin'
                    : 'Free plan';
    const letter   = (name.trim()[0] || 'A').toUpperCase();
    return { name, location, plan, letter };
  }

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function navItem(item, activeId) {
    // data-nav-id is the hook the SPA router uses to update the active
    // pill without re-rendering the whole sidebar on every navigation.
    const cls = item.id === activeId ? ' class="active"' : '';
    const badge = item.badge ? ` <span class="badge">${item.badge}</span>` : '';
    return `<li><a href="${item.href}" data-nav-id="${item.id}"${cls}><span class="g">${item.g}</span> ${item.label}${badge}</a></li>`;
  }

  /* Admin-only section. Rendered ONLY when the current session is an
     admin, gated on window.AMCP_DATA.user_role (populated by shell.js
     from the /api/client/me response). For regular users / preview mode
     this returns an empty string so the Main / Account sections stay
     flush against the business block. */
  function renderAdminSection(activeId) {
    const d = window.AMCP_DATA || {};
    if (d.user_role !== 'admin') return '';
    return `
      <div>
        <div class="sb-section" style="color:var(--maroon);font-weight:600">Admin</div>
        <ul class="sb-nav">${NAV_ADMIN.map(i => navItem(i, activeId)).join('')}</ul>
      </div>
    `;
  }

  // Multi-dashboard sidebar removed Apr 29 2026 — single Overview only.
  // The dashboards CRUD endpoints (/api/client/dashboards/*) stay live
  // on the worker for any future use, but the static-site UI no longer
  // surfaces them. The user's directive: "don't do a create your own
  // dashboard. have the new statistics and graphs on the existing data
  // with the new options and features for time".
  function renderDashboardsSection() { return ''; }

  function renderSidebar(activeId) {
    const biz = currentBiz();
    const bizSub = biz.location ? `${escHtml(biz.location)} · ${escHtml(biz.plan)}` : escHtml(biz.plan);
    return `
    <aside class="sidebar" id="amcp-sidebar">
      <a class="sb-brand" href="/" aria-label="Advocate — back to homepage">
        <span class="brand-mark" aria-hidden="true">A</span>
        <span class="name">Advocate</span>
      </a>
      <div class="sb-biz" title="Switch business">
        <div class="sq">${escHtml(biz.letter)}</div>
        <div class="info">
          <strong>${escHtml(biz.name)}</strong>
          <span>${bizSub}</span>
        </div>
        <span class="caret">⌄</span>
      </div>
      ${renderAdminSection(activeId)}
      ${renderDashboardsSection(activeId)}
      <div>
        <div class="sb-section">Main</div>
        <ul class="sb-nav">${NAV_MAIN.map(i => navItem(i, activeId)).join('')}</ul>
      </div>
      <div>
        <div class="sb-section">Account</div>
        <ul class="sb-nav">${NAV_ACCOUNT.map(i => navItem(i, activeId)).join('')}</ul>
      </div>
      <div class="sb-foot">
        <ul class="sb-nav">${NAV_FOOT.map(i => navItem(i, activeId)).join('')}</ul>
      </div>
    </aside>`;
  }

  function renderTopbar({ crumb, title, showDateRange = true, showShare = true, showInvite = true }) {
    const dateBtn = showDateRange ? `<button class="date-range" id="date-range-btn" type="button">
      <span class="date-range-label">Last 30 days</span><span style="opacity:.6;margin-left:4px">⌄</span>
    </button>` : '';
    const shareBtn = showShare ? `<button class="btn btn-ghost btn-sm">Share</button>` : '';
    const inviteBtn = showInvite ? `<button class="btn btn-primary btn-sm">Invite teammate</button>` : '';
    // Location selector — visible only for tenants with > 1 location.
    // Hidden by default in the markup; wireLocationSelector() below
    // unhides + populates after fetching /api/client/locations.
    const locBtn = `<button class="loc-selector" id="loc-selector" type="button" hidden>
      <span style="opacity:.6;margin-right:4px">📍</span><span class="loc-selector-label">All locations</span><span style="opacity:.6;margin-left:4px">⌄</span>
    </button>`;
    // Extra classes (topbar-crumb / topbar-title) are selectors the
    // SPA router uses to update text content on navigation without
    // re-rendering the whole topbar.
    // Hamburger only renders meaningfully on mobile via CSS; on desktop
    // it stays display:none. Lives inside .tb-left so it sits before
    // the breadcrumb on small screens. aria-controls points at the
    // sidebar so screen readers announce the toggle correctly.
    return `
    <div class="topbar">
      <div class="tb-left">
        <button type="button" class="topbar-hamburger" id="topbar-hamburger"
                aria-label="Open navigation" aria-controls="amcp-sidebar"
                aria-expanded="false">☰</button>
        <div class="crumb topbar-crumb">${crumb}</div>
        <h1 class="topbar-title">${title}</h1>
      </div>
      <div class="tb-right">${locBtn}${dateBtn}${shareBtn}${inviteBtn}</div>
    </div>`;
  }

  function renderFab() {
    // The first item is wired to /js/support-chat.js via the
    // data-support-chat-open attribute — clicking it opens the
    // floating Claude-powered support drawer instead of navigating.
    // support-chat.js's MutationObserver detects this FAB on the page
    // and suppresses its own redundant floating "?" so we only show one
    // help button bottom-right.
    return `
    <button class="fab" id="fab-btn" aria-label="Help">?</button>
    <div class="fab-menu" id="fab-menu" role="menu">
      <a href="#" data-support-chat-open><span class="g">◑</span> Chat with Advocate</a>
      <a id="fab-replay"><span class="g">▶</span> Replay tutorial</a>
      <a href="/FAQs.html"><span class="g">☰</span> What does each number mean?</a>
      <a href="/intro.html" target="_blank" rel="noopener"><span class="g">▷</span> Watch 2-minute video intro</a>
      <div class="fab-menu-sep"></div>
      <a href="/FAQs.html"><span class="g">◐</span> Browse help articles</a>
      <a href="mailto:max@advocate-mcp.com"><span class="g">✉</span> Email support</a>
      <a href="/Contact.html"><span class="g">☎</span> Book a support call</a>
    </div>`;
  }

  // Hamburger ↔ sidebar drawer toggle for mobile (≤900px). The CSS handles
  // the slide-in transform; this just flips body.sidebar-open. Outside-tap
  // on the overlay (body::after, also bound via a delegated click on body)
  // closes it. Escape key also closes.
  /* Brand logo click handler — bulletproof "back to homepage" wiring.
   *
   * The anchor's `href="/"` should work natively because the SPA router
   * doesn't match `/` and lets the browser navigate. But: if Pages
   * serves a stale dashboard-chrome.js (browser cache), if the SPA
   * router gets a future route added that accidentally matches `/`,
   * or if any other interceptor in this module preventDefault's, the
   * logo silently breaks.
   *
   * This explicit handler short-circuits all of that by navigating via
   * window.location.assign — same behavior as a top-level GET, ignores
   * the SPA. The href stays so middle-click + cmd-click "open in new
   * tab" still work natively. (Apr 28 2026 user-reported fix.)
   */
  function wireBrandLogo() {
    const brand = document.querySelector('a.sb-brand');
    if (!brand) return;
    brand.addEventListener('click', (e) => {
      // Respect modifier keys: cmd/ctrl/shift/alt = open in new tab,
      // middle-click = open in new tab. Native browser handles those.
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      window.location.assign('/');
    });
  }

  function wireMobileSidebar() {
    const ham = document.getElementById('topbar-hamburger');
    const sidebar = document.getElementById('amcp-sidebar');
    if (!ham || !sidebar) return;
    function setOpen(open) {
      document.body.classList.toggle('sidebar-open', open);
      ham.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    ham.addEventListener('click', (e) => {
      e.stopPropagation();
      setOpen(!document.body.classList.contains('sidebar-open'));
    });
    // Close on tap anywhere outside the sidebar.
    document.addEventListener('click', (e) => {
      if (!document.body.classList.contains('sidebar-open')) return;
      if (sidebar.contains(e.target)) return;
      if (ham.contains(e.target)) return;
      setOpen(false);
    });
    // Close on Escape.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && document.body.classList.contains('sidebar-open')) {
        setOpen(false);
      }
    });
    // Auto-close after a sidebar nav click on mobile (so the drawer
    // doesn't stay open over the freshly-routed page).
    sidebar.addEventListener('click', (e) => {
      const link = e.target.closest('a[href]');
      if (link && window.matchMedia('(max-width: 900px)').matches) {
        setOpen(false);
      }
    });
  }

  function wireFab() {
    const btn = document.getElementById('fab-btn');
    const menu = document.getElementById('fab-menu');
    if (!btn || !menu) return;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.classList.toggle('open');
    });
    document.addEventListener('click', () => menu.classList.remove('open'));
    menu.addEventListener('click', (e) => e.stopPropagation());

    const replay = document.getElementById('fab-replay');
    if (replay) {
      replay.addEventListener('click', () => {
        menu.classList.remove('open');
        // v2 tour bridge is the canonical tour on /app.html. Fall back
        // to the legacy spotlight if it's loaded, then to a full-page
        // hand-off if neither is present.
        if (window.AMCP_TOUR && typeof window.AMCP_TOUR.start === 'function') {
          window.AMCP_TOUR.start();
        } else if (typeof window.__startTour === 'function') {
          window.__startTour();
        } else {
          localStorage.removeItem('advocate-tour-seen');
          window.location.href = '/app.html?replay=1';
        }
      });
    }
  }

  window.AdvocateChrome = window.AdvocateChrome || {};
  window.AdvocateChrome.mount = function mount(opts) {
    const {
      activeId,
      crumb = 'Dashboard',
      title = 'Dashboard',
      mainClass = '',
      mainContent = '',
      showDateRange = true,
      showShare = true,
      showInvite = true,
    } = opts || {};

    const body = document.body;
    const app = document.createElement('div');
    app.className = 'app';
    app.innerHTML = `
      ${renderSidebar(activeId)}
      <main class="main ${mainClass}">
        ${renderTopbar({ crumb, title, showDateRange, showShare, showInvite })}
        <div id="page-content">${mainContent}</div>
      </main>
    `;
    body.appendChild(app);

    // FAB is outside the .app grid
    const fabHolder = document.createElement('div');
    fabHolder.innerHTML = renderFab();
    while (fabHolder.firstChild) body.appendChild(fabHolder.firstChild);

    wireMobileSidebar();
    wireFab();
    wireLocationSelector();
    wireDateRange();
    wireBrandLogo();
    injectSpeculationRules();
    loadCommandPaletteIfAdmin();
    loadRouter();
  };

  // ── Location selector (Apr 27 2026 Section 2) ───────────────────────
  //
  // Topbar dropdown that filters every dashboard KPI / chart / activity
  // feed by location. Selection persists in localStorage across page
  // navigation. When changed, dispatches an `amcp:location-changed`
  // event on window so module-specific renderers (overview.js,
  // activity.js, etc.) can refetch their data with the new filter.
  //
  // Hidden when the tenant has 0 or 1 location — single-location tenants
  // don't need a selector. Populated via /api/client/locations after
  // mount so it doesn't block the initial render.
  function wireLocationSelector() {
    const btn = document.getElementById('loc-selector');
    if (!btn) return;

    // Expose the selected location as a window-global so any module
    // can read the current filter without subscribing to the event.
    // localStorage backs it for cross-page persistence.
    const KEY = 'amcp_selected_location_id';
    window.AMCP_LOCATION = window.AMCP_LOCATION || {
      get: () => localStorage.getItem(KEY) || null,
      set: (id) => {
        if (id) localStorage.setItem(KEY, id);
        else    localStorage.removeItem(KEY);
        window.dispatchEvent(new CustomEvent('amcp:location-changed', { detail: { id: id || null } }));
      },
    };

    // Inject styles for the menu (one-time).
    if (!document.getElementById('amcp-loc-style')) {
      const style = document.createElement('style');
      style.id = 'amcp-loc-style';
      style.textContent = [
        '.loc-selector{display:inline-flex;align-items:center;background:var(--paper-2);border:1px solid var(--line);border-radius:999px;padding:6px 12px;font-size:13px;color:var(--ink);cursor:pointer;font:inherit}',
        '.loc-selector:hover{background:var(--paper)}',
        '.loc-menu{position:fixed;background:var(--paper);border:1px solid var(--line);border-radius:8px;box-shadow:0 12px 36px rgba(0,0,0,.12);padding:6px;z-index:9999;min-width:240px}',
        '.loc-menu-item{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;font-size:13.5px;color:var(--ink);cursor:pointer;border-radius:6px}',
        '.loc-menu-item:hover{background:var(--paper-2)}',
        '.loc-menu-item.active{font-weight:500;color:var(--maroon)}',
      ].join('');
      document.head.appendChild(style);
    }

    // Fetch locations and populate.
    const af = window.AMCP && window.AMCP.authedFetch;
    if (!af) return;
    af('/api/client/locations')
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (!data || !Array.isArray(data.locations) || data.locations.length < 2) return;
        const locations = data.locations;
        btn.removeAttribute('hidden');

        // Stale-id cleanup. If localStorage still has a location id that
        // was removed (deleted, renamed, etc.), drop it now so labelFor()
        // doesn't fall back to "All locations" while the underlying state
        // still points at a ghost. Without this, refreshLabel() shows the
        // wrong text and the menu can render checkmarks against a row
        // that no longer exists.
        const storedId = window.AMCP_LOCATION.get();
        if (storedId && !locations.find((l) => l.id === storedId)) {
          window.AMCP_LOCATION.set(null);
        }

        function labelFor(id) {
          if (!id) return 'All locations';
          const m = locations.find((l) => l.id === id);
          return m ? m.name : 'All locations';
        }
        function refreshLabel() {
          const lbl = btn.querySelector('.loc-selector-label');
          if (lbl) lbl.textContent = labelFor(window.AMCP_LOCATION.get());
        }
        refreshLabel();

        let menu = null;
        function closeMenu() { if (menu) { menu.remove(); menu = null; } }
        function openMenu() {
          closeMenu();
          const rect = btn.getBoundingClientRect();
          menu = document.createElement('div');
          menu.className = 'loc-menu';
          menu.style.top = (rect.bottom + 6) + 'px';
          // Anchor the menu's right edge to the button's right edge while
          // clamping to the viewport so we don't render off-screen on
          // narrow widths. On mobile the button sits far left, so the
          // pre-clamp left could go negative — `Math.max(8, ...)` keeps
          // an 8px gutter from the left edge of the screen, which the
          // 240px-wide menu fits within on every mobile viewport ≥256px.
          const MENU_WIDTH = 240;
          const GUTTER = 8;
          const desiredLeft = rect.right - MENU_WIDTH;
          const maxLeft = Math.max(GUTTER, window.innerWidth - MENU_WIDTH - GUTTER);
          menu.style.left = Math.min(maxLeft, Math.max(GUTTER, desiredLeft)) + 'px';
          const current = window.AMCP_LOCATION.get();
          const items = [{ id: null, name: 'All locations' }].concat(locations);
          menu.innerHTML = items.map((l) => {
            const active = (current === l.id) || (!current && l.id === null);
            const sub = l.city ? `<span style="opacity:.6;font-size:12px;margin-left:8px">${l.city}, ${l.state}</span>` : '';
            return `<div class="loc-menu-item ${active ? 'active' : ''}" data-loc-id="${l.id || ''}">
              <span>${(l.name || '').replace(/[<>&]/g, '')}</span>${sub}
              ${active ? '<span style="color:var(--maroon)">✓</span>' : ''}
            </div>`;
          }).join('');
          document.body.appendChild(menu);
          menu.addEventListener('click', (e) => {
            const item = e.target.closest('.loc-menu-item');
            if (!item) return;
            const id = item.getAttribute('data-loc-id') || null;
            window.AMCP_LOCATION.set(id);
            refreshLabel();
            closeMenu();
          });
        }
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (menu) closeMenu(); else openMenu();
        });
        document.addEventListener('click', () => closeMenu());
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
      })
      .catch(() => { /* network blip — leave selector hidden */ });
  }

  // ── Date-range selector (May 5 2026) ────────────────────────────────
  //
  // Topbar dropdown that controls the time window every dashboard
  // metrics-driven page reads from. Selection persists in localStorage
  // and the URL (?range=) so deep-links + reloads keep the choice.
  // When changed, dispatches `amcp:date-range-changed` on window so
  // module-specific renderers (bots.js, mentions.js, etc.) can refetch
  // their data with the new window.
  //
  // Backend already accepts `range=7d|30d|90d|365d` on /api/client/metrics
  // and echoes back `date_range.days` in the response so callers can
  // derive labels + chart bucket counts dynamically.
  //
  // Replaces the previous non-functional `Last 7 days ⌄` button that
  // looked clickable but did nothing.
  function wireDateRange() {
    const btn = document.getElementById('date-range-btn');
    if (!btn) return;

    const KEY = 'amcp_selected_date_range';
    const PRESETS = [
      { value: '7d',   label: 'Last 7 days' },
      { value: '30d',  label: 'Last 30 days' },
      { value: '90d',  label: 'Last 90 days' },
      { value: '365d', label: 'Last 365 days' },
    ];
    function labelFor(value) {
      const m = PRESETS.find((p) => p.value === value);
      return m ? m.label : 'Last 30 days';
    }

    // Initial selection: URL ?range= wins, then localStorage, then 30d.
    function readInitial() {
      const url = new URL(window.location.href);
      const fromUrl = url.searchParams.get('range');
      if (fromUrl && PRESETS.find((p) => p.value === fromUrl)) return fromUrl;
      const stored = localStorage.getItem(KEY);
      if (stored && PRESETS.find((p) => p.value === stored)) return stored;
      return '30d';
    }

    // Expose the selected range as a window-global so any module can
    // read the current filter without subscribing to the event.
    window.AMCP_DATE_RANGE = window.AMCP_DATE_RANGE || {
      get: () => localStorage.getItem(KEY) || '30d',
      set: (value) => {
        if (!PRESETS.find((p) => p.value === value)) return;
        localStorage.setItem(KEY, value);
        // Sync URL so deep-links and reloads preserve the choice.
        const u = new URL(window.location.href);
        u.searchParams.set('range', value);
        window.history.replaceState({}, '', u.toString());
        window.dispatchEvent(new CustomEvent('amcp:date-range-changed', {
          detail: { range: value, label: labelFor(value) },
        }));
      },
    };

    // Inject styles for the menu (one-time, mirrors the location-selector pattern).
    if (!document.getElementById('amcp-date-style')) {
      const style = document.createElement('style');
      style.id = 'amcp-date-style';
      style.textContent = [
        '.date-range{display:inline-flex;align-items:center;background:var(--paper-2);border:1px solid var(--line);border-radius:999px;padding:6px 12px;font-size:13px;color:var(--ink);cursor:pointer;font:inherit}',
        '.date-range:hover{background:var(--paper)}',
        '.date-menu{position:fixed;background:var(--paper);border:1px solid var(--line);border-radius:8px;box-shadow:0 12px 36px rgba(0,0,0,.12);padding:6px;z-index:9999;min-width:180px}',
        '.date-menu-item{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;font-size:13.5px;color:var(--ink);cursor:pointer;border-radius:6px}',
        '.date-menu-item:hover{background:var(--paper-2)}',
        '.date-menu-item.active{font-weight:500;color:var(--maroon)}',
      ].join('');
      document.head.appendChild(style);
    }

    // Apply the initial label without broadcasting (the page's first
    // render reads window.AMCP_DATE_RANGE.get() directly, so a wakeup
    // event would just trigger a duplicate fetch).
    const initial = readInitial();
    localStorage.setItem(KEY, initial);
    {
      const u = new URL(window.location.href);
      if (u.searchParams.get('range') !== initial) {
        u.searchParams.set('range', initial);
        window.history.replaceState({}, '', u.toString());
      }
    }
    function refreshLabel() {
      const lbl = btn.querySelector('.date-range-label');
      if (lbl) lbl.textContent = labelFor(window.AMCP_DATE_RANGE.get());
    }
    refreshLabel();

    let menu = null;
    function closeMenu() { if (menu) { menu.remove(); menu = null; } }
    function openMenu() {
      closeMenu();
      const rect = btn.getBoundingClientRect();
      menu = document.createElement('div');
      menu.className = 'date-menu';
      menu.style.top = (rect.bottom + 6) + 'px';
      const MENU_WIDTH = 180;
      const GUTTER = 8;
      const desiredLeft = rect.right - MENU_WIDTH;
      const maxLeft = Math.max(GUTTER, window.innerWidth - MENU_WIDTH - GUTTER);
      menu.style.left = Math.min(maxLeft, Math.max(GUTTER, desiredLeft)) + 'px';
      const current = window.AMCP_DATE_RANGE.get();
      menu.innerHTML = PRESETS.map((p) => {
        const active = current === p.value;
        return `<div class="date-menu-item ${active ? 'active' : ''}" data-range-value="${p.value}">
          <span>${p.label}</span>
          ${active ? '<span style="color:var(--maroon)">✓</span>' : ''}
        </div>`;
      }).join('');
      document.body.appendChild(menu);
      menu.addEventListener('click', (e) => {
        const item = e.target.closest('.date-menu-item');
        if (!item) return;
        const value = item.getAttribute('data-range-value');
        window.AMCP_DATE_RANGE.set(value);
        refreshLabel();
        closeMenu();
      });
    }
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (menu) closeMenu(); else openMenu();
    });
    document.addEventListener('click', () => closeMenu());
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
  }

  /* Auto-load the client-side SPA router on every v2 page so sidebar
     clicks swap main content in-place instead of full-reloading. Not
     gated on admin, every logged-in user gets seamless nav. */
  function loadRouter() {
    if (window.AMCP_ROUTER) return;
    if (document.getElementById('amcp-router-script')) return;
    const s = document.createElement('script');
    s.id = 'amcp-router-script';
    s.src = '/js/v2/router.js';
    s.async = true;
    document.head.appendChild(s);
  }

  /* Let the SPA router re-run speculation rules after a client-side
     navigation so the browser prerenders the siblings of the new
     page. Replaces the current <script type=speculationrules> block
     wholesale, browsers treat re-inserted rules idempotently. */
  window.AdvocateChrome._reapplySpeculationRules = function () {
    const existing = document.getElementById('amcp-speculation-rules');
    if (existing) existing.remove();
    injectSpeculationRules();
  };

  /* Load /js/v2/commandPalette.js on-demand when the current session is
     an admin. Avoids making every section page list the script tag
     individually, admins get ⌘K everywhere, regular users don't fetch
     the script at all.
     The palette module is self-contained (IIFE + global Cmd+K listener)
     so once it lands, it just works. Guard against double-load via the
     script id check. */
  function loadCommandPaletteIfAdmin() {
    const d = window.AMCP_DATA || {};
    if (d.user_role !== 'admin') return;
    if (document.getElementById('amcp-cmdk-script')) return;
    const s = document.createElement('script');
    s.id = 'amcp-cmdk-script';
    s.src = '/js/v2/commandPalette.js';
    s.async = true;
    document.head.appendChild(s);
  }

  window.AdvocateChrome.getContentRoot = () => document.getElementById('page-content');

  /* Speculation Rules, tell Chromium-based browsers to prerender the
     sidebar nav targets the moment a user hovers (moderate eagerness) so
     the next click lands near-instantly and the #boot-splash doesn't
     flash between sections. Firefox and Safari ignore the tag; the
     fallback there is the inline dark-mode splash bg we set on each
     page, which already prevents the black flash that was most jarring.

     Eagerness "moderate" means the browser only prefetches after a brief
     hover / touch, not every link on page load, which keeps bandwidth
     sane on low-end connections. */
  function injectSpeculationRules() {
    if (document.getElementById('amcp-speculation-rules')) return;
    // Feature-detect: browsers without SpeculationRules support just
    // ignore the <script> tag, but skip the DOM insert on the ones that
    // trip over "unexpected script type" errors in the console.
    try {
      if (!HTMLScriptElement.supports || !HTMLScriptElement.supports('speculationrules')) return;
    } catch { return; }

    const isAdmin = (window.AMCP_DATA || {}).user_role === 'admin';
    // Regular tenant pages: moderate eagerness (hover-triggered), 7+ pages,
    // prerendering them all on page load would waste bandwidth.
    // Admin pages: only 3 URLs, and admins almost certainly click between
    // them repeatedly, so use eager eagerness to prerender on page load.
    const tenantHrefs = [
      ...NAV_MAIN.map(i => i.href),
      ...NAV_ACCOUNT.map(i => i.href),
    ];
    const adminHrefs = isAdmin ? NAV_ADMIN.map(i => i.href) : [];

    const prerender = [
      { source: 'list', urls: tenantHrefs, eagerness: 'moderate' },
    ];
    if (adminHrefs.length > 0) {
      prerender.push({ source: 'list', urls: adminHrefs, eagerness: 'eager' });
    }
    const rules = { prerender };
    const s = document.createElement('script');
    s.id = 'amcp-speculation-rules';
    s.type = 'speculationrules';
    s.textContent = JSON.stringify(rules);
    document.head.appendChild(s);
  }
})();
