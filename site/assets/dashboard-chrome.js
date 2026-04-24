/* ============================================================
   Advocate — Dashboard chrome renderer
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
    { id: 'a2a',         href: '/A2APipeline.html',      g: '⇄', label: 'A2A pipeline' },
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

  /* Reads the current tenant from window.AMCP_DATA (populated after /api/
     client/me + /api/client/metrics resolve) and falls back to generic
     placeholders if the boot code hasn't finished yet. Never returns the
     design-mockup florist persona — that would leak "Bloom & Stem" copy
     to real users. */
  function currentBiz() {
    const d = window.AMCP_DATA || {};
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
    const cls = item.id === activeId ? ' class="active"' : '';
    const badge = item.badge ? ` <span class="badge">${item.badge}</span>` : '';
    return `<li><a href="${item.href}"${cls}><span class="g">${item.g}</span> ${item.label}${badge}</a></li>`;
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
    return `
    <div class="topbar">
      <div class="tb-left">
        <div class="crumb">${crumb}</div>
        <h1>${title}</h1>
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
        if (typeof window.__startTour === 'function') {
          window.__startTour();
        } else {
          // On pages without a tour, land on Dashboard with replay trigger
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
  };

  window.AdvocateChrome.getContentRoot = () => document.getElementById('page-content');

  /* Speculation Rules — tell Chromium-based browsers to prerender the
     sidebar nav targets the moment a user hovers (moderate eagerness) so
     the next click lands near-instantly and the #boot-splash doesn't
     flash between sections. Firefox and Safari ignore the tag; the
     fallback there is the inline dark-mode splash bg we set on each
     page, which already prevents the black flash that was most jarring.

     Eagerness "moderate" means the browser only prefetches after a brief
     hover / touch — not every link on page load — which keeps bandwidth
     sane on low-end connections. */
  function injectSpeculationRules() {
    if (document.getElementById('amcp-speculation-rules')) return;
    // Feature-detect: browsers without SpeculationRules support just
    // ignore the <script> tag, but skip the DOM insert on the ones that
    // trip over "unexpected script type" errors in the console.
    try {
      if (!HTMLScriptElement.supports || !HTMLScriptElement.supports('speculationrules')) return;
    } catch { return; }

    const hrefs = [
      ...NAV_MAIN.map(i => i.href),
      ...NAV_ACCOUNT.map(i => i.href),
    ];
    const rules = {
      prerender: [
        {
          source: 'list',
          urls: hrefs,
          eagerness: 'moderate',
        },
      ],
    };
    const s = document.createElement('script');
    s.id = 'amcp-speculation-rules';
    s.type = 'speculationrules';
    s.textContent = JSON.stringify(rules);
    document.head.appendChild(s);
  }
})();
