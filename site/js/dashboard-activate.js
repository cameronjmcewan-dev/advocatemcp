/* Activation page logic.
 * Reads ?t= from the URL (signed activation token minted by Stripe webhook).
 * Collects the customer's domain, submits to POST /api/activate, then
 * renders the DNS records they need to add. */
(function () {
  'use strict';

  var API_BASE = 'https://customers.advocatemcp.com';

  /* ── State machine ─────────────────────────────────────────────────────────
   * no-token  → show "check your email" state
   * enter     → show domain entry form
   * loading   → spinner while POST /api/activate is in flight
   * success   → show DNS records
   * error     → show customer_message from API
   * ─────────────────────────────────────────────────────────────────────── */

  var token = null;
  var submitting = false;

  function setState(name) {
    ['no-token', 'enter', 'loading', 'success', 'error'].forEach(function (s) {
      var el = document.getElementById('state-' + s);
      if (el) el.style.display = s === name ? '' : 'none';
    });
  }

  function esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* Render a single DNS record card */
  function dnsCard(record) {
    if (!record) return '';
    return '<div class="dns-block">' +
      '<div class="dns-type-tag">' + esc(record.type) + '</div>' +
      '<div class="dns-row-item"><span class="dns-k">Host</span><span class="dns-v">' + esc(record.host) + '</span></div>' +
      (record.target ? '<div class="dns-row-item"><span class="dns-k">Target</span><span class="dns-v">' + esc(record.target) + '</span></div>' : '') +
      (record.value  ? '<div class="dns-row-item"><span class="dns-k">Value</span><span class="dns-v">'  + esc(record.value)  + '</span></div>' : '') +
      '</div>';
  }

  function renderSuccess(data) {
    var msgEl   = document.getElementById('success-message');
    var dnsEl   = document.getElementById('dns-records');
    var domainEl = document.getElementById('success-domain');

    if (domainEl) domainEl.textContent = data.domain || '';
    if (msgEl)   msgEl.textContent = data.customer_message || '';

    if (dnsEl) {
      var cards = dnsCard(data.cname_record) + dnsCard(data.txt_record);
      dnsEl.innerHTML = cards ||
        '<p style="font-size:var(--tx-sm);color:var(--muted)">DNS setup complete, no additional records needed.</p>';
    }

    setState('success');
  }

  function renderError(msg) {
    var el = document.getElementById('error-message');
    if (el) el.textContent = msg || 'Something went wrong. Please try again.';
    setState('error');
  }

  async function submit(domain) {
    if (submitting) return;
    submitting = true;
    setState('loading');

    try {
      var res = await fetch(API_BASE + '/api/activate', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token, domain: domain }),
      });
      var data = await res.json();

      if (!res.ok) {
        renderError(data.customer_message || 'Activation failed. Please try again.');
        return;
      }
      renderSuccess(data);
    } catch (_) {
      renderError('We could not reach our servers. Please check your internet connection and try again.');
    } finally {
      submitting = false;
    }
  }

  function init() {
    var params = new URLSearchParams(window.location.search);
    token = params.get('t');

    if (!token) {
      setState('no-token');
      return;
    }

    setState('enter');

    var form = document.getElementById('activate-form');
    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var domainInput = document.getElementById('domain-input');
        var domain = domainInput ? domainInput.value.trim() : '';
        if (!domain) return;
        submit(domain);
      });
    }

    /* "Try a different token" link on the error state */
    var retryBtn = document.getElementById('btn-retry');
    if (retryBtn) {
      retryBtn.addEventListener('click', function () {
        setState('enter');
        submitting = false;
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
