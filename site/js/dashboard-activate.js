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
  function dnsCard(record, opts) {
    if (!record) return '';
    opts = opts || {};
    // Apex hostnames can't be CNAMEd — surface ANAME/ALIAS guidance
    // when the record represents an apex CNAME from the legacy single-
    // record path. The new variants path supplies an explicit type
    // (TXT for DCV; we render a separate apex-routing block below).
    var typeLabel = opts.apexCname ? 'ANAME / ALIAS (apex — see below)' : record.type;
    return '<div class="dns-block">' +
      '<div class="dns-type-tag">' + esc(typeLabel) + '</div>' +
      '<div class="dns-row-item"><span class="dns-k">Host</span><span class="dns-v">' + esc(record.host) + '</span></div>' +
      (record.target ? '<div class="dns-row-item"><span class="dns-k">Target</span><span class="dns-v">' + esc(record.target) + '</span></div>' : '') +
      (record.value  ? '<div class="dns-row-item"><span class="dns-k">Value</span><span class="dns-v">'  + esc(record.value)  + '</span></div>' : '') +
      (record.purpose ? '<div class="dns-row-item"><span class="dns-k" style="color:var(--muted-2)">Purpose</span><span class="dns-v" style="font-style:italic;color:var(--muted)">' + esc(record.purpose) + '</span></div>' : '') +
      '</div>';
  }

  /* Render a routing record for one variant (apex needs ANAME/ALIAS;
   * www needs CNAME). Apex copy includes the three-options note that
   * matches buildDnsInstructions on the worker. */
  function routingCard(variant, cnameTarget) {
    if (variant.is_apex) {
      return '<div class="dns-block">' +
        '<div class="dns-type-tag">ANAME / ALIAS / CNAME-flatten</div>' +
        '<div class="dns-row-item"><span class="dns-k">Host</span><span class="dns-v">' + esc(variant.hostname) + '</span></div>' +
        '<div class="dns-row-item"><span class="dns-k">Target</span><span class="dns-v">' + esc(cnameTarget) + '</span></div>' +
        '<p style="margin:10px 0 0 0;font-size:.75rem;color:var(--muted);line-height:1.5">' +
          "Apex domains can't be CNAMEd by DNS spec. If your provider doesn't support ANAME / ALIAS / CNAME flattening, " +
          "you can either move the apex to Cloudflare nameservers (free, supports flattening), or use Domain Forwarding (301 redirect to www), " +
          "or contact us for static A-record values." +
        '</p>' +
      '</div>';
    }
    return '<div class="dns-block">' +
      '<div class="dns-type-tag">CNAME</div>' +
      '<div class="dns-row-item"><span class="dns-k">Host</span><span class="dns-v">' + esc(variant.hostname) + '</span></div>' +
      '<div class="dns-row-item"><span class="dns-k">Target</span><span class="dns-v">' + esc(cnameTarget) + '</span></div>' +
    '</div>';
  }

  /* Render a per-variant card group: apex group + www group. Each group
   * has the routing record (apex ANAME / www CNAME) followed by every
   * DCV TXT record CF needs for that variant. */
  function variantGroup(variant, cnameTarget) {
    var heading = variant.is_apex
      ? 'Records for ' + esc(variant.hostname) + ' <span style="font-weight:400;color:var(--muted-2)">(apex)</span>'
      : 'Records for ' + esc(variant.hostname);

    var statusPill = '';
    if (variant.verification_status === 'active' && variant.ssl_status === 'active') {
      statusPill = '<span style="margin-left:8px;font-size:.6875rem;font-weight:500;color:var(--sage);background:var(--sage-tint);padding:2px 8px;border-radius:999px">Active</span>';
    } else if (variant.verification_status === 'pending' || variant.ssl_status === 'pending' || variant.ssl_status === 'initializing') {
      statusPill = '<span style="margin-left:8px;font-size:.6875rem;font-weight:500;color:var(--amber);background:var(--amber-tint);padding:2px 8px;border-radius:999px">Pending DNS</span>';
    }

    var recordsHtml = routingCard(variant, cnameTarget);
    if (variant.records && variant.records.length > 0) {
      for (var i = 0; i < variant.records.length; i++) {
        recordsHtml += dnsCard(variant.records[i]);
      }
    }

    return '<div style="margin-bottom:24px">' +
      '<div style="font-size:.875rem;font-weight:600;color:var(--ink);margin-bottom:10px">' + heading + statusPill + '</div>' +
      recordsHtml +
    '</div>';
  }

  function renderSuccess(data) {
    var msgEl   = document.getElementById('success-message');
    var dnsEl   = document.getElementById('dns-records');
    var domainEl = document.getElementById('success-domain');

    if (domainEl) domainEl.textContent = data.domain || '';
    if (msgEl)   msgEl.textContent = data.customer_message || '';

    if (dnsEl) {
      // New per-variant rendering when the worker exposes variants[]
      // (post-Apr-26-2026 tenants). Falls back to the legacy single-
      // record cards when variants is absent.
      var cnameTarget = (data.cname_record && data.cname_record.target) || 'customers.advocatemcp.com';
      var html = '';
      if (data.variants && data.variants.length > 0) {
        for (var i = 0; i < data.variants.length; i++) {
          html += variantGroup(data.variants[i], cnameTarget);
        }
        // If the customer's domain has both apex + www, add a single-
        // line summary up top so they don't miss that BOTH need DNS.
        if (data.variants.length > 1) {
          html = '<p style="font-size:.875rem;color:var(--ink-2);margin-bottom:18px;line-height:1.5">' +
            'Add the records below to your domain registrar. AI bots crawl both your apex (' + esc(data.variants[0].hostname) + ') ' +
            'and www variants — adding records for both means whichever URL an AI engine picks, the optimized response wins.' +
          '</p>' + html;
        }
      } else {
        // Legacy fallback: pre-Apr-26 tenants with single cname_record
        // + txt_record fields. Same rendering as before.
        html = dnsCard(data.cname_record) + dnsCard(data.txt_record);
      }
      dnsEl.innerHTML = html ||
        '<p style="font-size:.875rem;color:var(--muted)">DNS setup complete, no additional records needed.</p>';
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

  /* Preview the token before showing UI. For skipDns / hosted-tenant
   * signups, the customer doesn't own a custom domain — they're at
   * `{slug}.hosted.advocatemcp.com`. Pre-Apr-26-2026 these customers
   * landed on the manual "enter your domain" form, which is wrong.
   * Now we call /api/activate/preview, detect skipDns, and route them
   * directly to /dashboard with a one-time success state. */
  async function preflight() {
    setState('loading');
    try {
      var res = await fetch(API_BASE + '/api/activate/preview?t=' + encodeURIComponent(token), {
        method: 'GET',
        credentials: 'include',
        headers: { 'Accept': 'application/json' },
      });
      if (!res.ok) {
        // Token invalid / expired / platform error — fall back to
        // showing the manual form so the customer sees a familiar UI
        // before any specific failure mode renders later.
        setState('enter');
        return;
      }
      var data = await res.json();
      if (data && data.skip_dns === true) {
        // Hosted tenant. They have nothing to configure. Show a brief
        // success state and redirect to the dashboard. The hosted
        // domain is already provisioned and active in CF SaaS.
        renderHostedSuccess(data);
        // Auto-redirect after a moment so the customer sees the
        // confirmation before the dashboard loads.
        setTimeout(function () {
          window.location.href = 'https://customers.advocatemcp.com/dashboard';
        }, 2200);
        return;
      }
      // Custom-domain tenant — show the manual domain entry form.
      setState('enter');
    } catch (_) {
      setState('enter');
    }
  }

  function renderHostedSuccess(data) {
    var domainEl = document.getElementById('success-domain');
    var msgEl = document.getElementById('success-message');
    var dnsEl = document.getElementById('dns-records');
    if (domainEl) domainEl.textContent = data.hosted_domain || '';
    if (msgEl) {
      msgEl.textContent = "You're live. We'll redirect you to your dashboard in a moment.";
    }
    if (dnsEl) {
      dnsEl.innerHTML =
        '<div class="dns-block" style="text-align:center">' +
          '<p style="margin:0;font-size:.875rem;color:var(--ink-2);line-height:1.6">' +
            'Your business is hosted at <strong>' + esc(data.hosted_domain || '') + '</strong>. ' +
            'No DNS setup needed — AI bots that visit your subdomain already get the optimized response.' +
          '</p>' +
        '</div>';
    }
    setState('success');
  }

  function init() {
    var params = new URLSearchParams(window.location.search);
    token = params.get('t');

    if (!token) {
      setState('no-token');
      return;
    }

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

    // Preflight: auto-skip domain form for hosted tenants.
    preflight();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
