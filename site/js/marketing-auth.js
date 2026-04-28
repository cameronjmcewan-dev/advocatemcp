/**
 * marketing-auth.js — cross-subdomain logged-in state for advocatemcp.com.
 *
 * Auto-loaded on every marketing page (Pricing, Features, FAQs, etc.).
 * On DOMContentLoaded, checks whether the visitor is signed in to the
 * dashboard at customers.advocatemcp.com. If yes, swaps the nav's
 * "Sign in / Get started" cluster for an avatar dropdown linking to
 * Dashboard / Settings / Billing / Sign out.
 *
 * The session cookie is scoped to .advocatemcp.com (parent domain), so
 * the fetch from advocatemcp.com → customers.advocatemcp.com sends the
 * cookie automatically. CORS is preconfigured to allow advocatemcp.com
 * with credentials.
 *
 * Failure modes are silent: if the dashboard origin is unreachable,
 * the marketing nav stays in its logged-out state — no error UI on a
 * marketing page just because we couldn't determine auth status.
 *
 * The script is idempotent: re-running it (e.g. via SPA navigation) is
 * a no-op if the avatar is already mounted.
 */

(function () {
  'use strict';

  if (window.__amcpMarketingAuthMounted) return;
  window.__amcpMarketingAuthMounted = true;

  // The /api/* + /auth/* endpoints live on the worker
  // (customers.advocatemcp.com); HTML pages (app, settings, billing)
  // live on Pages (advocatemcp.com). Keeping them split because the
  // worker's catch-all bot-detection path returns a JSON error for any
  // unmatched HTML URL on customers.advocatemcp.com — clicking
  // /app.html on the worker domain shows that JSON to a real human
  // user. Linking to advocatemcp.com directly avoids the trap and the
  // session cookie travels via the Domain=.advocatemcp.com scope.
  var API_ORIGIN     = 'https://customers.advocatemcp.com';     // /api + /auth
  var SITE_ORIGIN    = 'https://advocatemcp.com';                // HTML pages
  var ME_URL         = API_ORIGIN + '/api/client/me';
  var LOGOUT_URL     = API_ORIGIN + '/auth/logout';

  function checkAuth() {
    fetch(ME_URL, {
      method:      'GET',
      credentials: 'include',
      headers:     { 'Accept': 'application/json' },
    })
      .then(function (r) {
        if (!r.ok) return null;
        return r.json();
      })
      .then(function (me) {
        if (me && me.id) renderLoggedIn(me);
      })
      .catch(function () { /* network blip — leave nav as-is */ });
  }

  /** Find the marketing nav's CTA cluster (the "Sign in" / "Get started"
   * pair). The marketing site uses a few different markup patterns
   * across its pages, so we look for the most specific selectors first
   * and fall back to common ones.
   *
   * Hardening (Apr 28 2026): a page can opt in explicitly by tagging
   * its CTA container with `data-cta-cluster`. That short-circuits the
   * heuristic so future template changes can't silently break the
   * avatar dropdown — if the data attribute is present, we trust it. */
  function findCtaCluster() {
    var explicit = document.querySelector('[data-cta-cluster]');
    if (explicit) return explicit;
    // Most pages: a div with both buttons in a flex/grid container.
    // Look for the "Get started" CTA by text since it's the most
    // unambiguous anchor. Selectors are intentionally broad — every
    // header/nav/navbar variant we've shipped is covered.
    var anchors = document.querySelectorAll('header a, nav a, .nav a, .navbar a, .nav-cta a, .header a, .top-nav a, [data-nav] a');
    for (var i = 0; i < anchors.length; i++) {
      var a = anchors[i];
      var text = (a.textContent || '').trim().toLowerCase();
      if (text === 'get started' || text === 'start free trial' ||
          text === 'sign in' || text === 'log in' || text === 'login') {
        return a.parentNode;
      }
    }
    return null;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function initial(me) {
    var src = me.full_name || me.email || '?';
    return String(src).trim().charAt(0).toUpperCase() || '?';
  }

  function renderLoggedIn(me) {
    var cluster = findCtaCluster();
    if (!cluster) return;     // no nav on this page (e.g. 404)

    // Build the avatar + dropdown.
    var wrap = document.createElement('div');
    wrap.className = 'amcp-auth';
    wrap.style.cssText = 'position:relative;display:inline-flex;align-items:center';
    wrap.innerHTML = [
      '<button type="button" class="amcp-auth-trigger" aria-haspopup="menu" aria-expanded="false" ',
      '  style="display:inline-flex;align-items:center;gap:6px;background:transparent;border:1px solid var(--line, #d4ccbf);',
      '  border-radius:999px;padding:4px 10px 4px 4px;cursor:pointer;font:inherit;color:inherit">',
      '  <span class="amcp-auth-avatar" style="width:28px;height:28px;border-radius:50%;background:var(--maroon, #7d2550);',
      '    color:#fff;display:grid;place-items:center;font-size:12px;font-weight:600">',
      escapeHtml(initial(me)),
      '  </span>',
      '  <span class="amcp-auth-caret" style="font-size:10px;opacity:.7">▾</span>',
      '</button>',
      '<div class="amcp-auth-menu" role="menu" hidden ',
      '  style="position:absolute;top:calc(100% + 8px);right:0;min-width:200px;',
      '  background:var(--paper, #fbf9f5);border:1px solid var(--line, #d4ccbf);border-radius:10px;',
      '  box-shadow:0 12px 36px rgba(0,0,0,.12);padding:6px;z-index:9999">',
      '  <div style="padding:8px 10px 6px;font-size:12px;color:var(--muted, #766f63);border-bottom:1px solid var(--line, #d4ccbf);margin-bottom:4px">',
      escapeHtml(me.email || ''),
      '  </div>',
      '  <a href="' + SITE_ORIGIN + '/app.html" role="menuitem" class="amcp-auth-link">Dashboard</a>',
      // /app.html#settings is a dead anchor — the SPA router matches on
      // pathname, not hash, so it lands on Overview and the hash is
      // never read by anything. Link to /Settings.html so the router
      // routes to the actual Settings page. (Apr 28 2026 audit fix.)
      '  <a href="' + SITE_ORIGIN + '/Settings.html" role="menuitem" class="amcp-auth-link">Settings</a>',
      '  <a href="' + SITE_ORIGIN + '/Billing.html" role="menuitem" class="amcp-auth-link">Billing</a>',
      '  <hr style="border:none;border-top:1px solid var(--line, #d4ccbf);margin:4px 0">',
      '  <button type="button" class="amcp-auth-link amcp-auth-logout" role="menuitem" ',
      '    style="background:transparent;border:none;width:100%;text-align:left;cursor:pointer;font:inherit">Sign out</button>',
      '</div>',
    ].join('');

    // Style the menu links uniformly.
    var style = document.createElement('style');
    style.textContent = [
      '.amcp-auth-link{display:block;padding:8px 10px;font-size:13.5px;color:var(--ink, #1a1815);text-decoration:none;border-radius:6px}',
      '.amcp-auth-link:hover{background:var(--paper-2, #f4f0e8);color:var(--ink, #1a1815);text-decoration:none}',
    ].join('');
    document.head.appendChild(style);

    // Nuke the existing CTAs and mount the avatar in their place.
    cluster.innerHTML = '';
    cluster.appendChild(wrap);

    // Wire toggle + outside-click + sign-out.
    var trigger = wrap.querySelector('.amcp-auth-trigger');
    var menu    = wrap.querySelector('.amcp-auth-menu');
    var logout  = wrap.querySelector('.amcp-auth-logout');

    function setOpen(open) {
      if (open) menu.removeAttribute('hidden');
      else      menu.setAttribute('hidden', '');
      trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    trigger.addEventListener('click', function (e) {
      e.stopPropagation();
      setOpen(menu.hasAttribute('hidden'));
    });
    document.addEventListener('click', function () { setOpen(false); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') setOpen(false);
    });

    logout.addEventListener('click', function (e) {
      e.preventDefault();
      logout.disabled = true;
      logout.textContent = 'Signing out…';
      fetch(LOGOUT_URL, { method: 'POST', credentials: 'include' })
        .catch(function () { /* swallow — we'll reload anyway */ })
        .then(function () { window.location.reload(); });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', checkAuth);
  } else {
    checkAuth();
  }
})();
