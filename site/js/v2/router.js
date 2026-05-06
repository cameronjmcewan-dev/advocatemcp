/* Client-side router for the v2 dashboard.
 *
 * What it replaces: full-page <a href> navigations between section
 * pages. Each of those reloads the HTML, re-parses and re-executes
 * all scripts, and re-mounts the entire chrome — ~300-500ms of
 * visible "Loading…" even with cached data.
 *
 * What it does: intercepts clicks on internal links that match a
 * known v2 route, loads the target page's module via a <script>
 * tag (cached after first load), then swaps only the main content
 * area via innerHTML. The chrome (sidebar, topbar, FAB) never
 * re-renders — so there's no white/black flash, no scroll jump,
 * no script re-parse.
 *
 * Data model: each module exports window.AMCP_<NAME> with at
 * minimum { fetch, render }. The router calls module.fetch()
 * (which hits AMCP.cachedFetch under the hood — instant on cache
 * hit), passes the result to module.render(), and swaps it into
 * #page-content. Optional module.afterMount(data) fires after the
 * swap so per-page listeners rewire against the fresh DOM.
 *
 * URL updates via history.pushState. popstate handler lets
 * back/forward Just Work. Cmd/Ctrl/Shift clicks + target=_blank
 * + cross-origin links + #anchors all pass through to native
 * browser behaviour.
 *
 * Impersonation: ?as=<slug> is preserved across navigations — if
 * the URL carries it, cached fetches are slug-scoped, and the
 * banner stays mounted. Navigating away (e.g. Exit → /admin)
 * drops the banner in updateImpersonationBanner().
 */
(function () {
  'use strict';

  // Route table. path = RegExp matching pathname; script = module URL;
  // module = window.AMCP_XXX global name; activeId matches sidebar
  // NAV items; crumb + title drive the topbar.
  const ROUTES = [
    { path: /^\/app(\.html)?\/?$/,                script: '/js/v2/overview.js',     module: 'AMCP_OVERVIEW',       activeId: 'overview',       crumb: 'Dashboard · Overview',         title: null /* dynamic via function */, titleFn: (d) => `Welcome back${window.AMCP_DATA && window.AMCP_DATA.full_name ? ', ' + window.AMCP_DATA.full_name.split(' ')[0] : ''}.` },
    { path: /^\/Mentions(\.html)?\/?$/,            script: '/js/v2/mentions.js',     module: 'AMCP_MENTIONS',       activeId: 'mentions',       crumb: 'Dashboard · Mentions',         title: 'Mentions' },
    { path: /^\/ClickThroughs(\.html)?\/?$/,       script: '/js/v2/clicks.js',       module: 'AMCP_CLICKS',         activeId: 'clicks',         crumb: 'Dashboard · Click-throughs',   title: 'Click-throughs' },
    { path: /^\/CompetitorRadar(\.html)?\/?$/,     script: '/js/v2/radar.js',        module: 'AMCP_RADAR',          activeId: 'radar',          crumb: 'Dashboard · Competitor Radar', title: 'Competitor Radar' },
    { path: /^\/A2APipeline(\.html)?\/?$/,         script: '/js/v2/a2a-pipeline.js', module: 'AMCP_A2A',            activeId: 'a2a',            crumb: 'Dashboard · AI bookings',     title: 'AI-attributed bookings' },
    { path: /^\/ActivityFeed(\.html)?\/?$/,        script: '/js/v2/activity.js',     module: 'AMCP_ACTIVITY',       activeId: 'activity',       crumb: 'Dashboard · Activity',         title: 'Activity feed' },
    { path: /^\/BusinessProfile(\.html)?\/?$/,     script: '/js/v2/profile.js',      module: 'AMCP_PROFILE',        activeId: 'profile',        crumb: 'Account · Business profile',   title: 'Business profile' },
    { path: /^\/Settings(\.html)?\/?$/,            script: '/js/v2/settings.js',     module: 'AMCP_SETTINGS',       activeId: 'settings',       crumb: 'Account · Settings',           title: 'Settings & API' },
    { path: /^\/Billing(\.html)?\/?$/,             script: '/js/v2/billing.js',      module: 'AMCP_BILLING',        activeId: 'billing',        crumb: 'Account · Billing',            title: 'Billing' },
    { path: /^\/admin\/?$/,                        script: '/js/v2/admin.js',        module: 'AMCP_ADMIN',          activeId: 'admin-overview', crumb: 'Internal · Mission Control',   title: 'Mission Control' },
    { path: /^\/admin\/tenants(\.html)?\/?$/,      script: '/js/v2/adminTenants.js', module: 'AMCP_ADMIN_TENANTS',  activeId: 'admin-tenants',  crumb: 'Internal · Tenants',           title: 'Every tenant' },
    { path: /^\/admin\/queries(\.html)?\/?$/,      script: '/js/v2/adminQueries.js', module: 'AMCP_ADMIN_QUERIES',  activeId: 'admin-queries',  crumb: 'Internal · Queries',           title: 'Cross-tenant queries' },
  ];

  function matchRoute(pathname) {
    return ROUTES.find(r => r.path.test(pathname));
  }

  /* Dynamically load a module's script tag. Returns the window global
     once it's defined. Cached after first load — subsequent calls are
     zero-cost and return the existing global. */
  function loadModule(route) {
    if (window[route.module]) return Promise.resolve(window[route.module]);
    if (document.querySelector(`script[data-amcp-module="${route.module}"]`)) {
      // Already loading from a prior concurrent navigate() call — wait
      // for the global to appear.
      return new Promise((resolve) => {
        const start = Date.now();
        (function poll() {
          if (window[route.module]) return resolve(window[route.module]);
          if (Date.now() - start > 5000) return resolve(null);
          setTimeout(poll, 25);
        })();
      });
    }
    return new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = route.script;
      s.dataset.amcpModule = route.module;
      s.onload = () => resolve(window[route.module] || null);
      s.onerror = () => resolve(null);
      document.head.appendChild(s);
    });
  }

  /* Update the sidebar's active pill without re-rendering the whole
     sidebar — just flips the .active class on the target link. If
     activeId can't be found (e.g. admin link that wasn't rendered for
     non-admins), no-op. */
  function updateActiveSidebar(activeId) {
    document.querySelectorAll('.sb-nav a.active').forEach(a => a.classList.remove('active'));
    const target = document.querySelector(`.sb-nav a[data-nav-id="${activeId}"]`);
    if (target) target.classList.add('active');
  }

  function updateTopbar(crumb, titleText) {
    const crumbEl = document.querySelector('.topbar-crumb');
    const titleEl = document.querySelector('.topbar-title');
    if (crumbEl && crumb) crumbEl.textContent = crumb;
    if (titleEl && titleText) titleEl.textContent = titleText;
  }

  /* The impersonation banner is a fixed-position element mounted
     lazily by shell.js on first boot. On SPA navigations, we keep it
     present if ?as= persists in the URL, remove it if not. This
     matches the user's expectation that hitting "Exit" on the banner
     (which links to /admin) clears impersonation. */
  function updateImpersonationBanner(url) {
    const asSlug = url.searchParams.get('as');
    const isAdmin = window.AMCP_DATA && window.AMCP_DATA.user_role === 'admin';
    const banner = document.getElementById('amcp-impersonation-banner');
    if (isAdmin && asSlug) {
      window.AMCP_DATA.impersonating = asSlug;
      if (!banner && typeof window.AMCP_SHELL_MOUNT_BANNER === 'function') {
        window.AMCP_SHELL_MOUNT_BANNER(asSlug, window.AMCP_DATA.business_name);
      }
    } else {
      window.AMCP_DATA.impersonating = null;
      if (banner) {
        banner.remove();
        // Undo the padding-top shift shell.js added on mount.
        document.querySelectorAll('.app, .sidebar, .main').forEach(el => {
          const p = parseFloat(getComputedStyle(el).paddingTop);
          if (p >= 32) el.style.paddingTop = (p - 32) + 'px';
        });
        // If a beta banner was sitting at top:32px (because the
        // impersonation banner used to be above it), slide it up to
        // top:0 now that nothing sits above it. Without this, the
        // beta banner would float with a 32px empty gap above it.
        // (Apr 28 2026 audit fix.)
        const beta = document.getElementById('amcp-beta-banner');
        if (beta && beta.style.top === '32px') {
          beta.style.top = '0px';
        }
      }
    }
  }

  let inFlight = 0;

  async function navigate(href, opts = {}) {
    const u = (typeof href === 'string') ? new URL(href, location.origin) : href;

    // Legacy redirect: /BotTraffic.html was merged into /Mentions.html.
    // Preserve query string + hash so ?as=<slug>&range=<w> survive.
    if (/^\/BotTraffic(\.html)?\/?$/.test(u.pathname)) {
      u.pathname = '/Mentions.html';
      if (opts.push !== false) {
        history.replaceState(null, '', u.pathname + u.search + u.hash);
      }
    }

    const route = matchRoute(u.pathname);
    if (!route) {
      // Not in our SPA — let the browser handle it (fallback nav).
      if (opts.allowFullNav !== false) window.location.href = u.href;
      return false;
    }

    // Preserve ?as=<slug> across navigations so admin impersonation
    // survives sidebar clicks. Without this, every nav strips the
    // query string and the next page reloads as the admin's own
    // (empty) tenant context — exactly what was happening on
    // /CompetitorRadar.html → empty radar, banner gone.
    //
    // Exception: clicking an admin sidebar item (Mission Control,
    // Tenants, Queries) is the canonical "exit impersonation" path,
    // so we explicitly drop ?as= there. The impersonation banner's
    // Exit link points to /admin and behaves the same way.
    const isAdminTarget = route.activeId.startsWith('admin-');
    const currentAs = new URL(location.href).searchParams.get('as');
    if (currentAs && !isAdminTarget && !u.searchParams.has('as')) {
      u.searchParams.set('as', currentAs);
    }

    inFlight++;
    const myFlight = inFlight;

    // Sync URL first so the back/forward stack reflects intent.
    if (opts.push !== false) {
      history.pushState(null, '', u.pathname + u.search + u.hash);
    }

    // Chrome updates first — instant feedback even before the module
    // script has loaded.
    updateActiveSidebar(route.activeId);
    const staticTitle = (typeof route.title === 'string') ? route.title : '';
    updateTopbar(route.crumb, staticTitle);
    updateImpersonationBanner(u);

    const mod = await loadModule(route);
    // Another nav fired after ours? Discard stale result.
    if (myFlight !== inFlight) return true;
    if (!mod || typeof mod.render !== 'function') return false;

    // Fetch data — cache-hit resolves synchronously-ish, no visible
    // spinner. If slow, render a tiny skeleton so the content area
    // doesn't appear frozen.
    const root = document.getElementById('page-content');
    if (root && !mod._hasSpinnerShown) {
      // Only show spinner if the fetch actually takes a bit — 50ms
      // grace period hides it for cache hits entirely.
      setTimeout(() => {
        if (root.dataset.pending === String(myFlight)) {
          root.innerHTML = renderInlineSpinner();
        }
      }, 50);
    }
    if (root) root.dataset.pending = String(myFlight);

    let data = {};
    try {
      data = await (typeof mod.fetch === 'function' ? mod.fetch() : Promise.resolve({}));
    } catch (err) {
      data = { __error: String(err && err.message || err) };
    }
    if (myFlight !== inFlight) return true;

    // Merge data into AMCP_DATA so sidebar biz-block, etc. stay fresh
    // when admin impersonates and the business_name flips.
    const m = (data && (data.metrics || data)) || {};
    Object.assign(window.AMCP_DATA || (window.AMCP_DATA = {}), m);

    // Dynamic title (function-shaped) — compute after data is in.
    if (typeof route.titleFn === 'function') {
      try { updateTopbar(route.crumb, route.titleFn(data)); } catch {}
    }

    if (root) {
      // If fetchReal rejected, show the same error UI shell.js renders
      // on first paint instead of silently rendering empty data. The
      // user gets a clear "we hit a snag" message + a refresh button
      // rather than a dashboard full of zeros. (Apr 28 2026 audit fix.)
      if (data && data.__error && typeof window.AMCP_SHELL_RENDER_ERROR === 'function') {
        root.innerHTML = window.AMCP_SHELL_RENDER_ERROR(data.__error);
      } else {
        root.innerHTML = mod.render(data);
      }
      delete root.dataset.pending;
    }
    if (typeof mod.afterMount === 'function') {
      try { mod.afterMount(data); } catch (err) { console.error('afterMount failed', err); }
    }

    // Scroll restore / reset on navigation.
    window.scrollTo({ top: 0, behavior: 'instant' });

    // Re-apply speculation rules so the new route prerenders siblings.
    if (window.AdvocateChrome && typeof window.AdvocateChrome._reapplySpeculationRules === 'function') {
      try { window.AdvocateChrome._reapplySpeculationRules(); } catch {}
    }

    return true;
  }

  function renderInlineSpinner() {
    return `
      <div class="row single" style="opacity:.72">
        <div class="card-dash" style="padding:32px;text-align:center">
          <div style="display:inline-block;width:18px;height:18px;border:2px solid var(--line);border-top-color:var(--maroon);border-radius:50%;animation:amcp-spin .8s linear infinite"></div>
        </div>
      </div>
      <style>@keyframes amcp-spin { to { transform: rotate(360deg); } }</style>
    `;
  }

  // Click interceptor — only internal same-origin links that match a
  // known v2 route. Everything else falls through to the browser.
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented) return;
    if (e.button !== 0) return;                               // only left-click
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;  // "open in new tab"
    const a = e.target.closest('a');
    if (!a) return;
    if (a.target === '_blank') return;
    const href = a.getAttribute('href');
    if (!href) return;
    if (href.startsWith('mailto:') || href.startsWith('tel:')) return;
    if (href.startsWith('#')) return;

    let url;
    try { url = new URL(href, location.origin); } catch { return; }
    if (url.origin !== location.origin) return;

    const route = matchRoute(url.pathname);
    if (!route) return; // not in our SPA — let browser navigate

    e.preventDefault();
    navigate(url);
  });

  window.addEventListener('popstate', () => {
    navigate(new URL(location.href), { push: false });
  });

  window.AMCP_ROUTER = { navigate, matchRoute };
})();
