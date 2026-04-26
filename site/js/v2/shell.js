/* Shared boot scaffolding for every v2 dashboard page.
 *
 * Every page in the new dashboard follows the same loading flow:
 *   1. Detect preview vs real-auth host
 *   2. On preview: skip auth, use a demo() dataset, show a banner
 *   3. On real: requireAuth, fetch /api/client/me, then call the page's
 *      own fetchReal()
 *   4. Mount the shared chrome and inject the page's render(data) into
 *      the main area
 *
 * Each page passes a small options object to AMCP_SHELL.boot({...}):
 *   activeId   — which sidebar nav item to highlight
 *   crumb      — topbar breadcrumb string
 *   title      — topbar title (can be a function(data) for dynamic copy)
 *   showDateRange, showShare, showInvite — chrome topbar flags
 *   demo()     — returns mock dataset used on preview URLs
 *   fetchReal() → Promise<data> — does the /api/client/* calls
 *   render(data) → HTML string for mainContent
 *   previewPlan — 'pro' | 'base' | 'free' | 'admin' — overrides the
 *                 default 'base' plan in preview so pages like Competitor
 *                 Radar can show their Pro view for design review.
 *
 * Keeps per-page modules focused on data shape + rendering. */
(function () {
  'use strict';

  function isPreviewHost() {
    const h = location.hostname;
    return h.endsWith('.pages.dev') || h === 'localhost' || h === '127.0.0.1';
  }

  /* Inject the shared right-side drawer DOM if it isn't already in the
   * page. Required by AMCP_UI.openDrawer() (used by the DNS wizard,
   * activity feed, query detail view, etc.). The legacy dashboard.html
   * shipped with this DOM inline; the v2 surface (app.html and the
   * per-section pages) doesn't, so calls like AMCP_DNS_WIZARD.open()
   * silently no-op without this. We inject once per page, idempotent. */
  function ensureDrawerDom() {
    if (document.getElementById('amcp-drawer-overlay')) return;

    const overlay = document.createElement('div');
    overlay.className = 'amcp-drawer-overlay';
    overlay.id = 'amcp-drawer-overlay';
    overlay.setAttribute('aria-hidden', 'true');
    document.body.appendChild(overlay);

    const panel = document.createElement('aside');
    panel.className = 'amcp-drawer-panel';
    panel.id = 'amcp-drawer-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-hidden', 'true');
    panel.setAttribute('aria-labelledby', 'amcp-drawer-title');
    panel.innerHTML = [
      '<div class="amcp-drawer-header">',
      '  <h2 class="amcp-drawer-title" id="amcp-drawer-title">Details</h2>',
      '  <button type="button" class="amcp-drawer-close" id="amcp-drawer-close" aria-label="Close drawer">×</button>',
      '</div>',
      '<div class="amcp-drawer-body" id="amcp-drawer-body"></div>',
    ].join('');
    document.body.appendChild(panel);

    // Inject minimal styles so the drawer renders correctly even on
    // pages that don't import dashboard.html's stylesheet. Mirrors the
    // styles in dashboard.html lines ~501-514.
    if (!document.getElementById('amcp-drawer-styles')) {
      const s = document.createElement('style');
      s.id = 'amcp-drawer-styles';
      s.textContent = `
        .amcp-drawer-overlay {
          position: fixed; inset: 0; background: rgba(0,0,0,0.45);
          opacity: 0; pointer-events: none; transition: opacity .2s ease;
          z-index: 90;
        }
        .amcp-drawer-overlay.open { opacity: 1; pointer-events: auto; }
        .amcp-drawer-panel {
          position: fixed; top: 0; right: 0; bottom: 0;
          width: min(640px, 100vw); background: var(--paper, #fbf9f5);
          color: var(--ink, #141210); border-left: 1px solid var(--line, #e6e1d8);
          transform: translateX(100%); transition: transform .25s ease;
          z-index: 100; display: flex; flex-direction: column;
          box-shadow: -4px 0 24px rgba(0,0,0,0.18);
        }
        .amcp-drawer-panel.open { transform: translateX(0); }
        .amcp-drawer-header {
          display: flex; align-items: center; justify-content: space-between;
          padding: 18px 24px; border-bottom: 1px solid var(--line, #e6e1d8);
          flex-shrink: 0;
        }
        .amcp-drawer-title {
          font-family: var(--serif, "Instrument Serif", serif);
          font-weight: 400; font-size: 22px; margin: 0; color: var(--ink, #141210);
        }
        .amcp-drawer-close {
          background: none; border: none; cursor: pointer;
          font-size: 28px; line-height: 1; color: var(--muted, #8a7c78);
          padding: 4px 10px; border-radius: 6px;
          transition: background-color .15s, color .15s;
        }
        .amcp-drawer-close:hover { background: var(--paper-2, #f4efe6); color: var(--ink, #141210); }
        .amcp-drawer-body {
          padding: 22px 24px 32px; overflow-y: auto; flex: 1;
          font-size: 14px; line-height: 1.55; color: var(--ink-2, #4a4540);
        }
        @media (prefers-color-scheme: dark) {
          .amcp-drawer-panel { background: var(--paper, #1a1714); border-left-color: var(--line, #2c2622); }
          .amcp-drawer-header { border-bottom-color: var(--line, #2c2622); }
        }
      `;
      document.head.appendChild(s);
    }
  }

  function mountPreviewBanner() {
    // Guard against double-mount if AMCP_SHELL.boot is called more than
    // once (e.g. during hot reload in dev).
    if (document.getElementById('amcp-preview-banner')) return;
    const b = document.createElement('div');
    b.id = 'amcp-preview-banner';
    b.setAttribute('role', 'status');
    b.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:100',
      'background:var(--maroon)', 'color:#fff', 'font-size:13px',
      'font-weight:500', 'letter-spacing:.02em', 'text-align:center',
      'padding:8px 16px',
      'box-shadow:0 1px 0 rgba(0,0,0,.15)',
    ].join(';');
    b.innerHTML = 'Preview mode &nbsp;·&nbsp; demo data only &nbsp;·&nbsp; log in on <a href="https://advocatemcp.com/dashboard.html" style="color:#fff;text-decoration:underline">advocatemcp.com</a> for real data';
    document.body.appendChild(b);
    document.querySelectorAll('.app, .sidebar, .main').forEach(el => {
      el.style.paddingTop = (parseFloat(getComputedStyle(el).paddingTop) + 32) + 'px';
    });
  }

  async function boot(opts) {
    if (!opts || typeof opts.render !== 'function') {
      throw new Error('AMCP_SHELL.boot: opts.render(data) is required');
    }
    // Inject the right-side drawer DOM up front so AMCP_UI.openDrawer
    // calls (DNS wizard, activity feed, query detail) work on every v2
    // page. Idempotent — safe to call repeatedly across hot reloads.
    ensureDrawerDom();

    const preview = isPreviewHost();

    let data;
    if (preview) {
      window.__ADVOCATE_PREVIEW = true;
      data = typeof opts.demo === 'function' ? opts.demo() : {};
      // Populate AMCP_DATA with whatever the page's demo provides so the
      // sidebar business block renders sensible placeholders.
      const m = (data && (data.metrics || data)) || {};
      // previewPlan="admin" upgrades the preview identity so admin-only
      // surfaces (sidebar Admin section, Cmd+K palette, impersonation
      // banner, /admin/* pages) render as they would for a real admin
      // on production. Any other previewPlan keeps user_role=owner.
      // Either previewPlan='admin' (admin pages pass this explicitly)
      // OR ?as=<slug> on the URL (lets operators flip any preview page
      // into admin mode to visually verify impersonation + the admin
      // sidebar without touching each page's boot options).
      const previewUrl0 = new URL(location.href);
      const previewAsSlug0 = previewUrl0.searchParams.get('as');
      const isPreviewAdmin = opts.previewPlan === 'admin' || !!previewAsSlug0;
      window.AMCP_DATA = Object.assign({
        slug:      'preview-demo',
        plan:      opts.previewPlan || 'base',
        location:  'Austin, TX',
        email:     'you@advocatemcp.com',
        full_name: 'Preview User',
        user_role: isPreviewAdmin ? 'admin' : 'owner',
      }, m);
      // If the page asked for a specific preview plan, let it win over
      // whatever the demo payload carries so the right view renders.
      if (opts.previewPlan) window.AMCP_DATA.plan = opts.previewPlan;
      // Mirror the real-auth impersonation flow in preview: admin
      // previews on /app.html?as=<slug> should see the banner too so
      // the UX can be visually verified without signing in on prod.
      if (isPreviewAdmin && previewAsSlug0) {
        window.AMCP_DATA.impersonating = previewAsSlug0;
      }
    } else {
      // ── Progressive-mount flow ─────────────────────────────────────
      // 1. requireAuth runs first (fast, just a JWT verify)
      // 2. /api/client/me + opts.fetchReal() fire in parallel (not
      //    sequential) — halves the round-trip latency on cold nav.
      // 3. Chrome mounts as soon as /me resolves, with a loading card
      //    in the main area. This eliminates the "full-screen black
      //    Loading…" that used to cover the whole viewport until all
      //    data was in.
      // 4. When opts.fetchReal() resolves, we swap the loading card
      //    for the real opts.render(data) output and fire afterMount.
      const authed = await window.AMCP.requireAuth();
      if (!authed) return;  // AMCP.requireAuth already redirected

      // Fire both in parallel. Catch per-promise so one slow/failed
      // request doesn't stall the other.
      const mePromise = window.AMCP.authedFetch('/api/client/me')
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      const dataPromise = typeof opts.fetchReal === 'function'
        ? opts.fetchReal().catch((err) => ({ __error: String(err && err.message || err) }))
        : Promise.resolve({});

      const me = await mePromise;

      // Populate AMCP_DATA with IDENTITY-only info now so chrome
      // renders correctly (admin sidebar section + palette gating).
      const url = new URL(location.href);
      const asSlug  = url.searchParams.get('as');
      const isAdmin = !!(me && me.role === 'admin');
      const impersonating = isAdmin && asSlug ? asSlug : null;

      window.AMCP_DATA = {
        email:         (me && me.email) || null,
        user_role:     (me && me.role) || null,
        full_name:     (me && me.full_name) || null,
        impersonating: impersonating,
      };

      // Mount chrome with a loading card BEFORE data arrives. The
      // sidebar + topbar are visible instantly; only the main content
      // area shows the spinner.
      const splashEarly = document.getElementById('boot-splash');
      if (splashEarly) splashEarly.remove();

      const earlyTitle = typeof opts.title === 'function' ? opts.title({}) : (opts.title || 'Dashboard');
      window.AdvocateChrome.mount({
        activeId:      opts.activeId,
        crumb:         opts.crumb || 'Dashboard',
        title:         earlyTitle,
        showDateRange: opts.showDateRange === true,
        showShare:     opts.showShare === true,
        showInvite:    opts.showInvite === true,
        mainContent:   renderLoadingCard(),
      });
      if (impersonating) {
        mountImpersonationBanner(impersonating, null);
      }

      // Wait for data, then merge into AMCP_DATA and swap main content.
      data = await dataPromise;
      const m = (data && (data.metrics || data)) || {};
      Object.assign(window.AMCP_DATA, m);

      // Derive is_hosted from the domain hostname so the legacy
      // AMCP_ONBOARDING state machine (and the v2 Get Started panel)
      // can pick the right checklist (hosted has no DNS step). Worker
      // doesn't return is_hosted explicitly today; suffix-match is the
      // single source of truth.
      const host = (window.AMCP_DATA.domain && window.AMCP_DATA.domain.hostname) || '';
      window.AMCP_DATA.is_hosted = /\.hosted\.advocatemcp\.com$/i.test(host);

      // Hand the onboarding snapshot (if the page returned it) to the
      // legacy state machine so isFirstLogin() and the inline Get
      // Started panel both see the same state without re-fetching.
      if (data && data.onboarding && window.AMCP_ONBOARDING && typeof window.AMCP_ONBOARDING.loadState === 'function') {
        window.AMCP_ONBOARDING.loadState(data.onboarding);
      }

      // Re-render title if it depends on data
      if (typeof opts.title === 'function') {
        const topTitle = document.querySelector('.topbar-title');
        if (topTitle) topTitle.textContent = opts.title(data);
      }

      // Swap main content
      const root = document.getElementById('page-content');
      if (root) root.innerHTML = opts.render(data);

      // If the banner wasn't mountable earlier because we didn't know
      // the business name yet, try again now that metrics are in.
      if (window.AMCP_DATA.impersonating && !document.getElementById('amcp-impersonation-banner')) {
        mountImpersonationBanner(window.AMCP_DATA.impersonating, window.AMCP_DATA.business_name);
      }

      if (typeof opts.afterMount === 'function') opts.afterMount(data);
      return;
    }

    // ── Preview-mode flow (unchanged) — preview demo data is sync
    //    so the old "mount once with full data" path is fine here.
    const splash = document.getElementById('boot-splash');
    if (splash) splash.remove();

    const title = typeof opts.title === 'function' ? opts.title(data) : opts.title;

    window.AdvocateChrome.mount({
      activeId:      opts.activeId,
      crumb:         opts.crumb || 'Dashboard',
      title:         title || 'Dashboard',
      showDateRange: opts.showDateRange === true,
      showShare:     opts.showShare === true,
      showInvite:    opts.showInvite === true,
      mainContent:   opts.render(data),
    });

    if (window.__ADVOCATE_PREVIEW) mountPreviewBanner();
    if (window.AMCP_DATA && window.AMCP_DATA.impersonating) {
      mountImpersonationBanner(window.AMCP_DATA.impersonating, window.AMCP_DATA.business_name);
    }
    if (typeof opts.afterMount === 'function') opts.afterMount(data);
  }

  /* Skeleton card shown in the main content area while fetchReal() is
     in flight. Uses paper/ink tokens so it matches the rest of the
     chrome — no black flash, no jarring "Loading…" centered on void.
     Pure CSS spinner so we don't need to add an external animation. */
  function renderLoadingCard() {
    return `
      <div class="row single">
        <div class="card-dash" style="padding:48px;text-align:center">
          <div style="display:inline-block;width:22px;height:22px;border:2px solid var(--line);border-top-color:var(--maroon);border-radius:50%;animation:amcp-spin .8s linear infinite;margin-bottom:12px"></div>
          <div style="font-size:13.5px;color:var(--muted)">Loading your data&hellip;</div>
        </div>
      </div>
      <style>
        @keyframes amcp-spin { to { transform: rotate(360deg); } }
      </style>
    `;
  }

  // Re-exported on window so the SPA router can mount the banner
  // without re-importing shell.js internals. Same signature.
  window.AMCP_SHELL_MOUNT_BANNER = function (slug, name) {
    mountImpersonationBanner(slug, name);
  };

  /* Admin impersonation banner — only mounts when shell.js has decided
   * the current session is an admin viewing ?as=<slug>. Exit returns to
   * /admin (which lists every tenant and clears the ?as= param). Not
   * stylable from outside — the inline styles match Max's maroon
   * palette so the banner is visually distinct from the paper/ink base. */
  function mountImpersonationBanner(slug, name) {
    if (document.getElementById('amcp-impersonation-banner')) return;
    const b = document.createElement('div');
    b.id = 'amcp-impersonation-banner';
    b.setAttribute('role', 'status');
    b.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:100',
      'background:#5c1a3c', 'color:#fff',
      'font-size:13px', 'font-weight:500', 'letter-spacing:.02em',
      'padding:8px 16px', 'text-align:center',
      'box-shadow:0 1px 0 rgba(0,0,0,.18)',
    ].join(';');
    const shown = name ? `${name} (${slug})` : slug;
    b.innerHTML = `Impersonating <strong>${escapeHtml(shown)}</strong> &nbsp;·&nbsp; <a href="/admin" style="color:#fff;text-decoration:underline;font-weight:500">Exit</a>`;
    document.body.appendChild(b);
    document.querySelectorAll('.app, .sidebar, .main').forEach(el => {
      el.style.paddingTop = (parseFloat(getComputedStyle(el).paddingTop) + 32) + 'px';
    });
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  window.AMCP_SHELL = { boot, isPreviewHost };
})();
