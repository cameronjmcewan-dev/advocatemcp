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

  function renderSidebar(activeId) {
    const biz = currentBiz();
    const bizSub = biz.location ? `${escHtml(biz.location)} · ${escHtml(biz.plan)}` : escHtml(biz.plan);
    return `
    <aside class="sidebar">
      <div class="sb-brand">
        <span class="brand-mark" aria-hidden="true">A</span>
        <span class="name">Advocate</span>
      </div>
      <div class="sb-biz" title="Switch business">
        <div class="sq">${escHtml(biz.letter)}</div>
        <div class="info">
          <strong>${escHtml(biz.name)}</strong>
          <span>${bizSub}</span>
        </div>
        <span class="caret">⌄</span>
      </div>
      ${renderAdminSection(activeId)}
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
    const dateBtn = showDateRange ? `<button class="date-range">Last 7 days ⌄</button>` : '';
    const shareBtn = showShare ? `<button class="btn btn-ghost btn-sm">Share</button>` : '';
    const inviteBtn = showInvite ? `<button class="btn btn-primary btn-sm">Invite teammate</button>` : '';
    // Extra classes (topbar-crumb / topbar-title) are selectors the
    // SPA router uses to update text content on navigation without
    // re-rendering the whole topbar.
    return `
    <div class="topbar">
      <div class="tb-left">
        <div class="crumb topbar-crumb">${crumb}</div>
        <h1 class="topbar-title">${title}</h1>
      </div>
      <div class="tb-right">${dateBtn}${shareBtn}${inviteBtn}</div>
    </div>`;
  }

  function renderFab() {
    return `
    <button class="fab" id="fab-btn" aria-label="Help">?</button>
    <div class="fab-menu" id="fab-menu" role="menu">
      <a id="fab-replay"><span class="g">▶</span> Replay tutorial</a>
      <a href="/FAQs.html"><span class="g">☰</span> What does each number mean?</a>
      <a href="/intro.html" target="_blank" rel="noopener"><span class="g">▷</span> Watch 2-minute video intro</a>
      <div class="fab-menu-sep"></div>
      <a href="/FAQs.html"><span class="g">◐</span> Browse help articles</a>
      <a href="mailto:hello@advocatemcp.com"><span class="g">✉</span> Email support</a>
      <a href="/Contact.html"><span class="g">☎</span> Book a support call</a>
    </div>`;
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

    wireFab();
    injectSpeculationRules();
    loadCommandPaletteIfAdmin();
    loadRouter();
  };

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
