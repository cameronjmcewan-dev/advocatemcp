// /onboard-dns — full-screen DNS setup gate.
//
// Shown when a customer logs in before their DNS is configured. They cannot
// reach the analytics dashboard until DNS verifies. Once all lights go green
// (window.AMCP_DNS_STATUS fires the onAllGreen callback), this page marks
// the checklist step and redirects to /dashboard.html.
//
// Design system: follows worker/CLAUDE.md rules — sharedLayout import,
// no hardcoded hex, CSS vars only.

import type { Env } from "../types";
import {
  BASE_TOKENS_CSS,
  BASE_LAYOUT_CSS,
  renderHeader,
  renderFooter,
  themeToggleScript,
} from "./sharedLayout";

export async function serveOnboardDnsPage(_request: Request, _env: Env): Promise<Response> {
  return new Response(PAGE_HTML, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

const PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Set up your domain — Advocate</title>
${BASE_TOKENS_CSS}
${BASE_LAYOUT_CSS}
<style>
/* Hero section */
.dns-gate-wrap{max-width:640px;margin:0 auto;padding:3rem 1.5rem;flex:1;width:100%;display:flex;flex-direction:column;align-items:center;text-align:center}
.dns-gate-icon{font-size:3rem;margin-bottom:1.25rem;line-height:1}
.dns-gate-title{font-size:1.625rem;font-weight:700;letter-spacing:-.025em;margin-bottom:.625rem}
.dns-gate-sub{color:var(--sub);font-size:.9375rem;line-height:1.65;max-width:480px;margin-bottom:2rem}

/* Wizard container — DNS status lights render here */
.dns-gate-container{width:100%;max-width:520px}

/* Sign-out escape hatch — corner link */
.dns-gate-signout{position:fixed;top:1rem;right:1.25rem;font-size:.75rem;color:var(--sub);cursor:pointer;background:none;border:none;font-family:var(--font);padding:0}
.dns-gate-signout:hover{color:var(--text)}
</style>
</head>
<body>

${renderHeader({ subtitle: "Domain Setup", showCta: false, activeNav: null })}

<div class="dns-gate-wrap">
  <div class="dns-gate-icon" aria-hidden="true">&#x1F310;</div>
  <h1 class="dns-gate-title">Connect your domain to Advocate</h1>
  <p class="dns-gate-sub">
    Before you can start receiving AI bot traffic, point your domain at Advocate.
    Add the DNS records below — verification usually takes 10&ndash;30 minutes, but can take up to 48 hours globally.
  </p>

  <div class="dns-gate-container" id="onboard-dns-container"></div>
</div>

<!-- Escape hatch: sign out without being trapped -->
<button class="dns-gate-signout" id="dns-gate-signout-btn" onclick="handleSignOut()">Sign out</button>

${renderFooter()}

<script src="/js/dashboard-dns-status.js"></script>

<script>
(function () {
  'use strict';

  /* ── Auth helpers (minimal — no full AMCP bundle on this page) ─────── */
  function getToken() {
    // Mirror the AMCP.authedFetch convention: bearer from cookie or
    // localStorage depending on how the auth layer persists it. The
    // portal session cookie is HttpOnly, so fetch() automatically
    // sends it — we just need to set credentials:'include'.
    return null; // session cookie is the credential, not a bearer token
  }

  function authedFetch(path, opts) {
    opts = opts || {};
    opts.credentials = 'include';
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    return fetch(path, opts);
  }

  /* ── Sign out ────────────────────────────────────────────────────────── */
  window.handleSignOut = function () {
    authedFetch('/auth/logout', { method: 'POST' })
      .catch(function () { /* ignore */ })
      .finally(function () {
        window.location.replace('/login.html');
      });
  };

  /* ── Callback: all DNS lights green ─────────────────────────────────── */
  function onAllGreen() {
    // 1. Mark the checklist step so the dashboard doesn't re-gate.
    authedFetch('/api/client/onboarding/step', {
      method: 'POST',
      body: JSON.stringify({ step: 'checklist.dns_configured' }),
    })
    .catch(function () { /* non-fatal — redirect anyway */ })
    .finally(function () {
      window.location.replace('/dashboard.html');
    });
  }

  /* ── Boot: fetch /api/client/me to get slug, then start polling ─────── */
  authedFetch('/api/client/me')
    .then(function (r) {
      if (r.status === 401 || r.status === 403) {
        // Not logged in — bounce to login.
        window.location.replace('/login.html');
        return null;
      }
      return r.json();
    })
    .then(function (me) {
      if (!me) return;

      // If DNS is already configured (e.g. race condition or manual
      // admin action), skip straight to the dashboard.
      if (me.dns_configured === true) {
        window.location.replace('/dashboard.html');
        return;
      }

      // Fetch the business metrics to get the slug (apiMe doesn't
      // include it — it's on the metrics/domain info endpoint).
      authedFetch('/api/client/domain-info')
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (info) {
          var slug = info && info.slug;
          var container = document.getElementById('onboard-dns-container');
          if (!container) return;

          if (window.AMCP_DNS_STATUS && typeof window.AMCP_DNS_STATUS.startPolling === 'function') {
            // 10-second polling interval; onAllGreen fires when all 5 lights pass.
            window.AMCP_DNS_STATUS.startPolling(container, slug, 10000, onAllGreen);
          } else {
            // Fallback: DNS status module not loaded — show a simple message
            // so the user isn't stranded on a blank page.
            container.innerHTML =
              '<p style="color:var(--sub);font-size:.875rem;padding:1rem 0">' +
              'Loading DNS status… If this persists, refresh the page.' +
              '</p>';
          }
        })
        .catch(function (err) {
          console.error('[onboard-dns] domain-info fetch failed:', err);
        });
    })
    .catch(function (err) {
      console.error('[onboard-dns] /api/client/me fetch failed:', err);
    });

})();
</script>
${themeToggleScript()}
</body>
</html>`;
