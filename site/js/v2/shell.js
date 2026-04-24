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
      const authed = await window.AMCP.requireAuth();
      if (!authed) return;  // AMCP.requireAuth already redirected

      let me = null;
      try {
        const r = await window.AMCP.authedFetch('/api/client/me');
        if (r.ok) me = await r.json();
      } catch (_) { /* non-fatal */ }

      // Impersonation — admin-only. `?as=<slug>` on any dashboard URL
      // scopes the page to that tenant's data via slug-passing on
      // /api/client/* calls. Non-admin session ignores the param, so a
      // user can't switch tenants by URL-hacking. The visible banner
      // below prevents an admin from forgetting whose data they're in.
      const url = new URL(location.href);
      const asSlug  = url.searchParams.get('as');
      const isAdmin = !!(me && me.role === 'admin');
      const impersonating = isAdmin && asSlug ? asSlug : null;

      data = typeof opts.fetchReal === 'function' ? await opts.fetchReal() : {};

      const m = (data && (data.metrics || data)) || {};
      window.AMCP_DATA = Object.assign({}, m, {
        email:         (me && me.email) || null,
        user_role:     (me && me.role) || null,
        full_name:     (me && me.full_name) || null,
        impersonating: impersonating,
      });
    }

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
