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

  /* Polling state — Phase B real-time DNS status. After a successful
   * /api/activate, we poll /api/activate/status every POLL_INTERVAL_MS
   * to flip per-variant pills (⏳ Pending DNS → ✓ Active) and auto-
   * redirect to /dashboard when all variants land active. Stops after
   * POLL_MAX_MS so a customer who walked away doesn't hammer us. */
  var POLL_INTERVAL_MS = 10000;     // 10 s — same as dashboard-dns-wizard.js
  var POLL_MAX_MS      = 30 * 60_000; // 30 min ceiling
  var pollTimer  = null;
  var pollStart  = 0;
  var allActive  = false;

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

    var pillStyleBase = 'margin-left:8px;font-size:.6875rem;font-weight:500;padding:2px 8px;border-radius:999px;display:inline-block;min-width:88px;text-align:center;';
    var pillContent;
    var pillColor;
    var pillBg;
    if (variant.verification_status === 'active' && variant.ssl_status === 'active') {
      pillContent = '✓ Active';
      pillColor = 'var(--sage)';
      pillBg = 'var(--sage-tint)';
    } else {
      pillContent = '⏳ Pending DNS';
      pillColor = 'var(--amber)';
      pillBg = 'var(--amber-tint)';
    }
    var statusPill = '<span data-status-pill style="' + pillStyleBase +
      'color:' + pillColor + ';background:' + pillBg + '">' + esc(pillContent) + '</span>';

    var recordsHtml = routingCard(variant, cnameTarget);
    if (variant.records && variant.records.length > 0) {
      for (var i = 0; i < variant.records.length; i++) {
        recordsHtml += dnsCard(variant.records[i]);
      }
    }

    return '<div data-variant-host="' + esc(variant.hostname) + '" style="margin-bottom:24px">' +
      '<div style="font-size:.875rem;font-weight:600;color:var(--ink);margin-bottom:10px">' + heading + statusPill + '</div>' +
      recordsHtml +
    '</div>';
  }

  /* ── Phase C: provider-specific guidance ─────────────────────────────────
   * After the activate page renders generic per-variant records, fetch
   * the customer's DNS provider and prepend a tailored set of steps so
   * they don't have to translate generic copy to GoDaddy-speak. The
   * fetch is best-effort — if the worker times out or returns "other",
   * we silently skip the prepend and the customer just sees the generic
   * cards we already rendered. */

  async function loadProviderGuide(data) {
    if (!token) return;
    if (!window.AMCP_DNS_GUIDES) return; // dns-provider-guides.js not loaded
    if (data && data.skip_dns) return;   // hosted tenants don't need guides
    try {
      var res = await fetch(API_BASE + '/api/activate/dns-provider?t=' + encodeURIComponent(token), {
        method: 'GET',
        credentials: 'include',
        headers: { 'Accept': 'application/json' },
      });
      if (!res.ok) return;
      var detection = await res.json();
      var providerId = (detection && detection.provider) || 'other';
      var guide = window.AMCP_DNS_GUIDES[providerId] || window.AMCP_DNS_GUIDES.other;
      if (!guide) return;
      renderProviderGuide(providerId, guide, data);
    } catch (_) {
      // Silently skip — generic cards are still on screen.
    }
  }

  /* Render the auto-DNS section. Provider-specific because the form
   * shape differs (Cloudflare = single token, GoDaddy = key+secret).
   * Each provider has its own validate + apply endpoints. Other
   * providers fall through to the manual guide. */
  function renderAutoDnsSection(providerId, activateData) {
    if (providerId === 'cloudflare') return renderCloudflareAutoDns();
    if (providerId === 'godaddy')    return renderGoDaddyAutoDns();
    return '';
  }

  function renderCloudflareAutoDns() {
    return '' +
      '<div id="auto-dns-block" data-provider="cloudflare" style="margin-top:18px;padding:14px 16px;background:var(--paper);border:1px dashed var(--maroon-tint);border-radius:var(--r-md)">' +
        '<div style="font-size:.6875rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--maroon);margin-bottom:6px">⚡ Or do it automatically</div>' +
        '<p style="margin:0 0 12px 0;font-size:.8125rem;color:var(--ink-2);line-height:1.55">' +
          "Paste a scoped Cloudflare API token and we'll add the records for you. " +
          'Token is used once, never stored. Need to make one? ' +
          '<a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noopener" style="color:var(--maroon)">Create a Cloudflare API token →</a>' +
        '</p>' +
        '<p style="margin:0 0 10px 0;font-size:.75rem;color:var(--muted);line-height:1.5">' +
          'When creating the token: pick "Edit zone DNS" template, scope to your zone only. ' +
          'We never receive any other permissions or zones.' +
        '</p>' +
        '<input type="password" id="auto-dns-token" placeholder="paste your CF API token here" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" style="width:100%;padding:9px 12px;background:var(--paper);border:1px solid var(--line);border-radius:var(--r-md);color:var(--ink);font-family:var(--mono);font-size:.75rem;margin-bottom:10px">' +
        '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">' +
          '<button type="button" id="btn-auto-dns-validate" class="btn-submit" style="width:auto;padding:9px 16px;font-size:.8125rem">Validate token</button>' +
          '<button type="button" id="btn-auto-dns-apply" class="btn-submit" style="width:auto;padding:9px 16px;font-size:.8125rem;display:none">Add records to my Cloudflare zone</button>' +
          '<span id="auto-dns-status" style="font-size:.75rem;color:var(--muted)"></span>' +
        '</div>' +
      '</div>';
  }

  function renderGoDaddyAutoDns() {
    return '' +
      '<div id="auto-dns-block" data-provider="godaddy" style="margin-top:18px;padding:14px 16px;background:var(--paper);border:1px dashed var(--maroon-tint);border-radius:var(--r-md)">' +
        '<div style="font-size:.6875rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--maroon);margin-bottom:6px">⚡ Or do it automatically</div>' +
        '<p style="margin:0 0 10px 0;font-size:.8125rem;color:var(--ink-2);line-height:1.55">' +
          "Paste your GoDaddy API key + secret and we'll add the DNS records and set up apex forwarding for you. " +
          'Credentials used once, never stored. Need them? ' +
          '<a href="https://developer.godaddy.com/keys" target="_blank" rel="noopener" style="color:var(--maroon)">Create a GoDaddy API key →</a>' +
        '</p>' +
        '<p style="margin:0 0 10px 0;font-size:.75rem;color:var(--muted);line-height:1.5">' +
          'Pick "Production" environment when creating the key. We use it once to write your records, then drop the credential.' +
        '</p>' +
        '<input type="text"     id="auto-dns-key"    placeholder="API Key"    autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" style="width:100%;padding:9px 12px;background:var(--paper);border:1px solid var(--line);border-radius:var(--r-md);color:var(--ink);font-family:var(--mono);font-size:.75rem;margin-bottom:8px">' +
        '<input type="password" id="auto-dns-secret" placeholder="API Secret" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" style="width:100%;padding:9px 12px;background:var(--paper);border:1px solid var(--line);border-radius:var(--r-md);color:var(--ink);font-family:var(--mono);font-size:.75rem;margin-bottom:10px">' +
        '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">' +
          '<button type="button" id="btn-auto-dns-validate" class="btn-submit" style="width:auto;padding:9px 16px;font-size:.8125rem">Validate key</button>' +
          '<button type="button" id="btn-auto-dns-apply" class="btn-submit" style="width:auto;padding:9px 16px;font-size:.8125rem;display:none">Add records + set up apex forwarding</button>' +
          '<span id="auto-dns-status" style="font-size:.75rem;color:var(--muted)"></span>' +
        '</div>' +
      '</div>';
  }

  /* Wire up the auto-DNS form. Provider-specific paths because the
   * credential shape differs (CF = single token, GoDaddy = key+secret).
   * Idempotent — re-running is OK. */
  function wireAutoDnsHandlers() {
    var block = document.getElementById('auto-dns-block');
    if (!block) return;
    var provider = block.getAttribute('data-provider') || 'cloudflare';
    var validateBtn = document.getElementById('btn-auto-dns-validate');
    var applyBtn = document.getElementById('btn-auto-dns-apply');
    var statusEl = document.getElementById('auto-dns-status');
    if (!validateBtn || !statusEl) return;

    function setStatus(text, kind) {
      statusEl.textContent = text;
      if (kind === 'ok')   statusEl.style.color = 'var(--sage)';
      else if (kind === 'err') statusEl.style.color = 'var(--maroon)';
      else statusEl.style.color = 'var(--muted)';
    }

    /* Per-provider credential reader. Returns null + sets status on
     * missing input, otherwise returns the request body shape the
     * worker expects. */
    function readCreds() {
      if (provider === 'godaddy') {
        var keyEl = document.getElementById('auto-dns-key');
        var secEl = document.getElementById('auto-dns-secret');
        var k = keyEl ? keyEl.value.trim() : '';
        var s = secEl ? secEl.value.trim() : '';
        if (!k || !s) { setStatus('Paste your API key and secret first.', 'err'); return null; }
        return { key: k, secret: s };
      }
      // Cloudflare default
      var tEl = document.getElementById('auto-dns-token');
      var t = tEl ? tEl.value.trim() : '';
      if (!t) { setStatus('Paste a token first.', 'err'); return null; }
      return { token: t };
    }

    function clearCreds() {
      var ids = ['auto-dns-token', 'auto-dns-key', 'auto-dns-secret'];
      for (var i = 0; i < ids.length; i++) {
        var el = document.getElementById(ids[i]);
        if (el) el.value = '';
      }
    }

    function endpointFor(action) {
      return API_BASE + '/api/dns-auto/' + provider + '/' + action + '?t=' + encodeURIComponent(token);
    }

    validateBtn.addEventListener('click', async function () {
      var creds = readCreds();
      if (!creds) return;
      validateBtn.disabled = true;
      setStatus('Checking…', 'muted');
      try {
        var res = await fetch(endpointFor('validate'), {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(creds),
        });
        var data = await res.json();
        if (!res.ok || !data.ok) {
          setStatus(prettyAutoDnsReason(data.reason || 'credential_validation_failed'), 'err');
          return;
        }
        var domainLabel = data.zone_name || data.domain || 'your domain';
        setStatus('✓ Valid for ' + domainLabel + '.', 'ok');
        if (applyBtn) applyBtn.style.display = '';
      } catch (_) {
        setStatus("Couldn't reach our server. Try again.", 'err');
      } finally {
        validateBtn.disabled = false;
      }
    });

    if (applyBtn) {
      applyBtn.addEventListener('click', async function () {
        var creds = readCreds();
        if (!creds) return;
        applyBtn.disabled = true;
        validateBtn.disabled = true;
        setStatus('Adding records…', 'muted');
        try {
          var res = await fetch(endpointFor('apply'), {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(creds),
          });
          var data = await res.json();
          if (!res.ok || !data.ok) {
            var firstFail = (data.results || []).find(function (r) { return !r.ok; });
            var why = firstFail
              ? prettyAutoDnsReason(firstFail.reason)
              : (data.forwarding && !data.forwarding.ok
                ? prettyAutoDnsReason(data.forwarding.reason)
                : prettyAutoDnsReason(data.reason || 'apply_failed'));
            setStatus('Some steps failed: ' + why, 'err');
            applyBtn.disabled = false;
            validateBtn.disabled = false;
            return;
          }
          var msg = provider === 'godaddy'
            ? '✓ Records added and apex forwarding set up. AI bots crawling either variant will land on your Advocate intercept once DNS propagates (usually under 5 minutes).'
            : '✓ Records added. Cloudflare is now validating SSL — usually under a minute.';
          setStatus(msg, 'ok');
          clearCreds();
          // Polling (Phase B) is already running — it will flip the
          // per-variant pills as records propagate.
        } catch (_) {
          setStatus("Couldn't reach our server. Try again.", 'err');
          applyBtn.disabled = false;
          validateBtn.disabled = false;
        }
      });
    }
  }

  function prettyAutoDnsReason(reason) {
    // Map worker-side reason codes to human-friendly copy.
    var MAP = {
      // Cloudflare-specific
      token_format_invalid:           "That doesn't look like a valid Cloudflare API token. Double-check what you pasted.",
      token_invalid_or_revoked:       "Cloudflare doesn't recognize this token, or it was revoked. Create a fresh one.",
      token_inactive:                 "This token isn't active in Cloudflare. Make a new one.",
      zone_not_found_for_token:       "This token doesn't have access to your domain's zone. Check that the token's zone scope matches.",
      zone_not_active:                "Your Cloudflare zone isn't active yet. Activate it in Cloudflare first, then retry.",
      // GoDaddy-specific
      credential_format_invalid:      "Your API key or secret looks malformed. Check that you copied each one fully.",
      credential_invalid_or_revoked:  "GoDaddy doesn't recognize this key/secret pair. Create a fresh one in the GoDaddy developer console.",
      domain_not_found_for_credential:"This credential can't manage the domain we have on file. Make sure the API key has access to it.",
      domain_not_active:              "Your domain isn't active in GoDaddy yet (still pending transfer or registration). Try again once it's active.",
      forwarding_not_available:       "GoDaddy domain forwarding isn't available for this domain (sometimes happens when DNS is delegated elsewhere). Records were still added — apex traffic needs manual A records or a redirect.",
      forwarding_setup_failed:        "Couldn't set up apex forwarding. Records were added — set up a 301 redirect from apex to www manually.",
      // Shared
      permission_denied:              "The credential isn't allowed to edit DNS in this zone. Re-create it with the 'Edit DNS' permission.",
      record_create_failed:           "Your DNS provider rejected one of the record creations. Open the DNS UI and check for conflicts.",
      hosted_tenant_no_dns_needed:    "Your account is hosted on our subdomain — no DNS records needed. You're already live.",
      missing_provider_token:         "Token field was empty.",
      missing_provider_credentials:   "API key or secret was empty.",
      no_records_to_add:              "Nothing to add — your records may already be in place.",
    };
    if (typeof reason === 'string' && /^record_conflict_/.test(reason)) {
      return "A different DNS record already exists at one of the spots we'd write to. Resolve the conflict in your DNS panel, then retry.";
    }
    return MAP[reason] || ('Something went wrong (' + (reason || 'unknown') + '). Try again or fall back to manual records.');
  }

  /* Render the provider-specific section above the generic record
   * cards. Steps reference {{placeholders}} that interpolate from the
   * activate response data. */
  function renderProviderGuide(providerId, guide, activateData) {
    var dnsEl = document.getElementById('dns-records');
    if (!dnsEl) return;

    var apex = '';
    var www = '';
    if (activateData && Array.isArray(activateData.variants)) {
      for (var i = 0; i < activateData.variants.length; i++) {
        var v = activateData.variants[i];
        if (v.is_apex) apex = v.hostname; else www = v.hostname;
      }
    }
    if (!apex && activateData) apex = activateData.domain || '';
    if (!www && apex) www = 'www.' + apex.replace(/^www\./, '');

    var cnameTarget = (activateData.cname_record && activateData.cname_record.target) || 'customers.advocatemcp.com';

    // First DCV TXT record across variants — the apex's, ideally.
    var txtHost = '';
    var txtValue = '';
    if (activateData.variants) {
      for (var j = 0; j < activateData.variants.length; j++) {
        var vv = activateData.variants[j];
        if (vv.records) {
          for (var k = 0; k < vv.records.length; k++) {
            if (vv.records[k].type === 'TXT' && vv.records[k].value) {
              if (!txtHost) {
                txtHost = vv.records[k].host;
                txtValue = vv.records[k].value;
              }
            }
          }
        }
      }
    }

    function interp(s) {
      return String(s || '')
        .replace(/\{\{apex\}\}/g, esc(apex))
        .replace(/\{\{www\}\}/g, esc(www))
        .replace(/\{\{cname_target\}\}/g, esc(cnameTarget))
        .replace(/\{\{txt_host_name\}\}/g, esc(txtHost))
        .replace(/\{\{txt_value\}\}/g, esc(txtValue));
    }

    function renderStep(s) {
      var color, badge;
      if (s.type === 'tip')      { color = 'var(--maroon)'; badge = '💡'; }
      else if (s.type === 'warning') { color = 'var(--amber)'; badge = '⚠️'; }
      else                       { color = 'var(--ink)'; badge = '→'; }
      return '<li style="display:flex;gap:10px;align-items:flex-start;padding:8px 0;font-size:.875rem;line-height:1.55;color:var(--ink-2)">' +
        '<span style="flex-shrink:0;width:18px;color:' + color + ';font-weight:600">' + badge + '</span>' +
        '<span>' + interp(s.text) + '</span>' +
      '</li>';
    }

    function renderSection(title, steps) {
      if (!Array.isArray(steps) || steps.length === 0) return '';
      var stepsHtml = '';
      for (var i = 0; i < steps.length; i++) stepsHtml += renderStep(steps[i]);
      return '<div style="margin-top:18px">' +
        '<div style="font-size:.6875rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--maroon);margin-bottom:6px">' + esc(title) + '</div>' +
        '<ol style="list-style:none;padding:0;margin:0">' + stepsHtml + '</ol>' +
      '</div>';
    }

    var heading = providerId === 'other'
      ? 'Generic DNS instructions'
      : 'Setup steps for ' + esc(guide.name);

    var loginLine = guide.login_url
      ? '<div style="font-size:.8125rem;color:var(--muted);margin-top:4px">Sign in at <a href="' + esc(guide.login_url) + '" target="_blank" rel="noopener" style="color:var(--maroon)">' + esc(guide.login_url) + '</a></div>'
      : '';

    var gotchasHtml = '';
    if (Array.isArray(guide.gotchas) && guide.gotchas.length > 0) {
      var gItems = '';
      for (var g = 0; g < guide.gotchas.length; g++) {
        gItems += '<li style="font-size:.8125rem;color:var(--muted);line-height:1.5;margin-bottom:6px">' + interp(guide.gotchas[g]) + '</li>';
      }
      gotchasHtml = '<div style="margin-top:18px;padding:12px 14px;background:var(--paper-2);border:1px solid var(--line);border-radius:var(--r-md)">' +
        '<div style="font-size:.6875rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-bottom:8px">Provider-specific gotchas</div>' +
        '<ul style="margin:0;padding-left:18px">' + gItems + '</ul>' +
      '</div>';
    }

    var guideEl = document.createElement('div');
    guideEl.id = 'provider-guide';
    guideEl.style.cssText = 'background:var(--maroon-wash);border:1px solid var(--maroon-tint);border-radius:var(--r-lg);padding:18px 18px 14px;margin-bottom:24px';
    guideEl.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px">' +
        '<div>' +
          '<div style="font-size:1.0625rem;font-weight:600;color:var(--ink)">' + heading + '</div>' +
          loginLine +
        '</div>' +
        '<button type="button" class="btn-link" id="hide-provider-guide" style="background:none;border:0;color:var(--maroon);font-size:.75rem;cursor:pointer;text-decoration:underline">Hide</button>' +
      '</div>' +
      // Auto-DNS section (Phase D) — only renders for providers we
      // support programmatically. Lets the customer skip the manual
      // steps below by pasting a scoped API token.
      renderAutoDnsSection(providerId, activateData) +
      renderSection('Step 1: add the www CNAME record', guide.www_steps) +
      renderSection('Step 2: route apex traffic to us', guide.apex_steps) +
      renderSection('Step 3: add the SSL verification TXT record', guide.txt_steps) +
      gotchasHtml;

    // Drop any existing guide before re-rendering.
    var existing = document.getElementById('provider-guide');
    if (existing) existing.remove();
    dnsEl.parentNode.insertBefore(guideEl, dnsEl);

    var hideBtn = document.getElementById('hide-provider-guide');
    if (hideBtn) {
      hideBtn.addEventListener('click', function () {
        var el = document.getElementById('provider-guide');
        if (el) el.style.display = 'none';
      });
    }

    // Auto-DNS form (Phase D) — wire the validate / apply handlers if
    // the section was rendered for this provider.
    wireAutoDnsHandlers();
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

    // Kick off polling so the live status pills update without the
    // customer refreshing the page. The first poll fires immediately
    // so the pills reflect the as-of-now state instead of the snapshot
    // from the activate response.
    startPolling();

    // Phase C: load and render the provider-specific guide above the
    // generic record cards. Best-effort — silent skip on failure.
    loadProviderGuide(data);
  }

  /* ── Phase B: real-time DNS polling ─────────────────────────────────────── */

  function startPolling() {
    stopPolling();
    pollStart = Date.now();
    allActive = false;
    pollOnce();
    pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  async function pollOnce() {
    if (!token) return stopPolling();
    if (Date.now() - pollStart > POLL_MAX_MS) {
      stopPolling();
      return;
    }
    try {
      var res = await fetch(API_BASE + '/api/activate/status?t=' + encodeURIComponent(token), {
        method: 'GET',
        credentials: 'include',
        headers: { 'Accept': 'application/json' },
      });
      if (!res.ok) return; // transient; next tick will retry
      var data = await res.json();
      updatePillsFromStatus(data);
      if (data && data.all_active === true && !allActive) {
        allActive = true;
        stopPolling();
        // Brief celebratory pause so the customer sees the green
        // pills land before we redirect.
        var msgEl = document.getElementById('success-message');
        if (msgEl) msgEl.textContent = 'All set. Redirecting you to your dashboard…';
        setTimeout(function () {
          window.location.href = 'https://customers.advocatemcp.com/dashboard';
        }, 1800);
      }
    } catch (_) {
      // Ignore. Polling continues; transient blips are fine.
    }
  }

  /* Update each variant's status pill in-place based on the latest
   * /api/activate/status response. We rely on a `data-variant-host`
   * attribute set during initial render to find the right group. */
  function updatePillsFromStatus(data) {
    if (!data || !Array.isArray(data.variants)) return;
    for (var i = 0; i < data.variants.length; i++) {
      var v = data.variants[i];
      var pill = document.querySelector('[data-variant-host="' + cssEscape(v.hostname) + '"] [data-status-pill]');
      if (!pill) continue;
      if (v.active) {
        pill.style.color = 'var(--sage)';
        pill.style.background = 'var(--sage-tint)';
        pill.textContent = '✓ Active';
      } else if (v.verification_status === 'pending' || v.ssl_status === 'pending' || v.ssl_status === 'initializing') {
        pill.style.color = 'var(--amber)';
        pill.style.background = 'var(--amber-tint)';
        pill.textContent = '⏳ Pending DNS';
      } else {
        // unknown / transitional state — surface the literal status
        pill.textContent = (v.verification_status || '?') + ' / ' + (v.ssl_status || '?');
      }
    }
  }

  function cssEscape(s) {
    // Minimal CSS-attr escape for hostnames. Fine because hostnames
    // can only contain a-z 0-9 . - per RFC.
    return String(s).replace(/[^a-zA-Z0-9.-]/g, '');
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
