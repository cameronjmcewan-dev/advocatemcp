/* DNS wizard, guided CNAME/TXT setup for custom-domain tenants.
 *
 * Opens the right-side drawer (AMCP_UI.openDrawer) and walks the user
 * through three stages:
 *
 *   1. Provider picker, pick DNS host (GoDaddy, Namecheap, Cloudflare).
 *      Selection cached in localStorage so return visits skip this stage.
 *   2. Instructions   , schematic SVG diagram + copyable CNAME/TXT
 *                         record values specific to the chosen provider.
 *   3. Verification   , four live status lights (DoH probe, CF hostname
 *                         active, SSL active, Worker Route present),
 *                         polling /api/client/domain-info every 10s until
 *                         all four go green, then marks
 *                         checklist.dns_configured complete.
 *
 * Public API (window.AMCP_DNS_WIZARD):
 *   open(initialProvider?), open the drawer at the appropriate stage.
 *                            Passes through to AMCP_UI.openDrawer.
 *   close()              , programmatic close (stops polling too).
 *
 * Depends on:
 *   window.AMCP.authedFetch (dashboard-auth.js)
 *   window.AMCP_UI.openDrawer / closeDrawer / toast (dashboard-ui.js)
 *   window.AMCP_DATA (slug, domain), metrics fetch in dashboard shell
 *   window.AMCP_ONBOARDING.markStep (dashboard-onboarding.js), to tick
 *                            checklist.dns_configured on first all-green.
 */
(function () {
  'use strict';

  /* ── Stage state ────────────────────────────────────────────────────────── */
  var STAGE_PICKER       = 'picker';
  var STAGE_INSTRUCTIONS = 'instructions';
  var STAGE_VERIFY       = 'verify';

  var _stage    = STAGE_PICKER;
  var _provider = null;   // one of 'godaddy' | 'namecheap' | 'cloudflare'
  var _pollTimer = null;  // interval id for /domain-info polling
  var _lastStatus = null; // last parsed status object

  var LOCAL_STORAGE_KEY = 'amcp-dns-provider';
  var POLL_INTERVAL_MS  = 10000;

  /* ── Small utils ────────────────────────────────────────────────────────── */
  function escHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function currentSlug() {
    return (window.AMCP_DATA && window.AMCP_DATA.slug) ||
      new URLSearchParams(window.location.search).get('slug') || '';
  }

  function currentDomain() {
    return (window.AMCP_DATA && window.AMCP_DATA.domain) || '';
  }

  function getSavedProvider() {
    try { return localStorage.getItem(LOCAL_STORAGE_KEY); }
    catch (_) { return null; }
  }

  function saveProvider(p) {
    try { if (p) localStorage.setItem(LOCAL_STORAGE_KEY, p); }
    catch (_) { /* no-op */ }
  }

  /* ── Public API ─────────────────────────────────────────────────────────── */
  function open(initialProvider) {
    _stopPolling();
    var saved = initialProvider || getSavedProvider();
    if (saved) {
      _provider = saved;
      _stage    = STAGE_INSTRUCTIONS;
    } else {
      _provider = null;
      _stage    = STAGE_PICKER;
    }
    _openDrawer();
  }

  function close() {
    _stopPolling();
    if (window.AMCP_UI && typeof window.AMCP_UI.closeDrawer === 'function') {
      window.AMCP_UI.closeDrawer();
    }
  }

  /* ── Drawer orchestration ───────────────────────────────────────────────── */
  function _openDrawer() {
    var title = 'DNS setup';
    var body  = _bodyForStage();
    if (window.AMCP_UI && typeof window.AMCP_UI.openDrawer === 'function') {
      window.AMCP_UI.openDrawer(title, body);
      _bindStageHandlers();
    }
  }

  function _bodyForStage() {
    if (_stage === STAGE_PICKER)       return _renderPicker();
    if (_stage === STAGE_INSTRUCTIONS) return _renderInstructions();
    if (_stage === STAGE_VERIFY)       return _renderVerify();
    return '';
  }

  function _bindStageHandlers() {
    if (_stage === STAGE_PICKER)       _bindPicker();
    if (_stage === STAGE_INSTRUCTIONS) _bindInstructions();
    if (_stage === STAGE_VERIFY)       _bindVerify();
  }

  function _transition(nextStage) {
    _stage = nextStage;
    var body = _bodyForStage();
    var drawerBody = document.getElementById('amcp-drawer-body');
    if (drawerBody) drawerBody.innerHTML = body;
    _bindStageHandlers();
  }

  /* ── Stage 1: provider picker ───────────────────────────────────────────── */
  /*
   * Four cards in a 2×2 grid. The known providers (GoDaddy, Namecheap,
   * Cloudflare) carry a "where to find it" hint so users don't waste
   * time hunting. "Other" routes to a generic-instructions path that
   * covers anyone not on the short-list.
   */
  var PROVIDERS = [
    {
      id:    'godaddy',
      name:  'GoDaddy',
      hint:  'My Products → Domain → DNS tab',
    },
    {
      id:    'namecheap',
      name:  'Namecheap',
      hint:  'Domain List → Manage → Advanced DNS',
    },
    {
      id:    'cloudflare',
      name:  'Cloudflare',
      hint:  'Dashboard → Domain → DNS → Records',
    },
    {
      id:    'other',
      name:  'Other / not sure',
      hint:  'Generic CNAME + TXT instructions',
    },
  ];

  function _renderPicker() {
    var domain = currentDomain() || '(your domain)';
    var cards = PROVIDERS.map(function (p) {
      return (
        '<button type="button" class="amcp-dns-provider" data-provider="' + escHtml(p.id) + '">' +
          '<div style="font-weight:600;font-size:var(--tx-base);margin-bottom:3px">' + escHtml(p.name) + '</div>' +
          '<div style="font-size:var(--tx-xs);color:var(--muted);line-height:1.4">' + escHtml(p.hint) + '</div>' +
        '</button>'
      );
    }).join('');
    return (
      '<div class="amcp-dns-step">' +
        '<div class="amcp-dns-step-title">Where is ' + escHtml(domain) + ' registered?</div>' +
        '<div class="amcp-dns-step-copy">' +
          'Pick your DNS provider and we\u2019ll show step-by-step instructions with copyable record values.' +
        '</div>' +
        '<div class="amcp-dns-providers" id="amcp-dns-picker-grid">' + cards + '</div>' +
        '<div style="margin-top:16px;font-size:var(--tx-xs);color:var(--muted)">' +
          'Your choice is remembered locally \u2014 next time you open this wizard, we\u2019ll jump straight to instructions.' +
        '</div>' +
      '</div>'
    );
  }

  function _bindPicker() {
    var grid = document.getElementById('amcp-dns-picker-grid');
    if (!grid) return;
    grid.addEventListener('click', function (ev) {
      var card = ev.target.closest('.amcp-dns-provider');
      if (!card) return;
      var id = card.dataset.provider;
      if (!id) return;
      _provider = id;
      saveProvider(id);
      _transition(STAGE_INSTRUCTIONS);
    });
  }

  /* ── Stage 2: instructions ──────────────────────────────────────────────── */
  var CNAME_TARGET = 'customers.advocatemcp.com';

  /* Per-provider navigation steps. Rendered as an ordered list above the
   * records. <strong> allowed (trusted template, no user data). */
  var PROVIDER_STEPS = {
    godaddy: [
      'Sign in and go to <strong>My Products</strong>.',
      'Find your domain, then click <strong>DNS</strong>.',
      'Scroll to <strong>Records</strong> and click <strong>Add New Record</strong>.',
      'Set Type to <strong>CNAME</strong> and paste the values below.',
    ],
    namecheap: [
      'Sign in and open the <strong>Domain List</strong>.',
      'Click <strong>Manage</strong> next to your domain.',
      'Select the <strong>Advanced DNS</strong> tab.',
      'Click <strong>Add New Record</strong>, choose CNAME, then paste the values below.',
    ],
    cloudflare: [
      'Open your domain in the Cloudflare dashboard.',
      'In the sidebar: <strong>DNS</strong> → <strong>Records</strong>.',
      'Click <strong>Add record</strong> and choose <strong>CNAME</strong>.',
      'Paste the values below. Set proxy status to <strong>DNS only</strong> (grey cloud).',
    ],
    other: [
      'Log in to your DNS provider.',
      'Find the <strong>DNS</strong> or <strong>Records</strong> settings for your domain.',
      'Add a <strong>CNAME</strong> record using the values below.',
    ],
  };

  function _providerName(id) {
    for (var i = 0; i < PROVIDERS.length; i++) {
      if (PROVIDERS[i].id === id) return PROVIDERS[i].name;
    }
    return id || '';
  }

  /* Generic DNS records table mock, shown above the real instructions as
   * a visual anchor ("this is what the UI you're looking for looks like").
   * Provider-agnostic on purpose: most DNS dashboards share this layout. */
  function _schematicSVG() {
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 180" style="width:100%;height:auto;max-width:360px;display:block;margin:0 auto 18px" aria-hidden="true">' +
        '<rect x="4" y="4" width="352" height="172" rx="8" style="fill:var(--surface);stroke:var(--border)" stroke-width="1.5"/>' +
        '<rect x="4" y="4" width="352" height="24" rx="8" style="fill:var(--bg)"/>' +
        '<circle cx="18" cy="16" r="3" style="fill:var(--muted)" opacity=".4"/>' +
        '<circle cx="28" cy="16" r="3" style="fill:var(--muted)" opacity=".4"/>' +
        '<circle cx="38" cy="16" r="3" style="fill:var(--muted)" opacity=".4"/>' +
        /* tabs */
        '<rect x="16" y="36" width="52" height="16" rx="3" style="fill:var(--accent)"/>' +
        '<text x="42" y="47" text-anchor="middle" font-size="9" fill="#fff" font-family="\'General Sans\',system-ui,sans-serif">DNS</text>' +
        '<rect x="74" y="36" width="52" height="16" rx="3" style="fill:var(--surface-2)" opacity=".65"/>' +
        '<rect x="132" y="36" width="52" height="16" rx="3" style="fill:var(--surface-2)" opacity=".65"/>' +
        /* add button */
        '<rect x="296" y="36" width="50" height="16" rx="3" style="fill:var(--accent-bright)"/>' +
        '<text x="321" y="47" text-anchor="middle" font-size="9" fill="#fff" font-family="\'General Sans\',system-ui,sans-serif">+ Add</text>' +
        /* table header */
        '<rect x="16" y="60" width="330" height="14" rx="2" style="fill:var(--surface-2)"/>' +
        '<text x="26" y="70" font-size="8" fill="var(--muted)" font-family="\'General Sans\',system-ui,sans-serif" font-weight="600" letter-spacing=".7">TYPE</text>' +
        '<text x="78" y="70" font-size="8" fill="var(--muted)" font-family="\'General Sans\',system-ui,sans-serif" font-weight="600" letter-spacing=".7">NAME</text>' +
        '<text x="186" y="70" font-size="8" fill="var(--muted)" font-family="\'General Sans\',system-ui,sans-serif" font-weight="600" letter-spacing=".7">VALUE</text>' +
        '<text x="316" y="70" font-size="8" fill="var(--muted)" font-family="\'General Sans\',system-ui,sans-serif" font-weight="600" letter-spacing=".7">TTL</text>' +
        /* highlighted CNAME row */
        '<rect x="16" y="82" width="330" height="22" rx="2" style="fill:var(--accent-dim);stroke:var(--accent-ring)" stroke-width="1.5"/>' +
        '<text x="26" y="97" font-size="10" fill="var(--accent-bright)" font-family="\'SF Mono\',monospace" font-weight="700">CNAME</text>' +
        '<text x="78" y="97" font-size="10" fill="var(--text)" font-family="\'SF Mono\',monospace">www</text>' +
        '<text x="186" y="97" font-size="10" fill="var(--text)" font-family="\'SF Mono\',monospace">' + CNAME_TARGET + '</text>' +
        '<text x="316" y="97" font-size="10" fill="var(--text)" font-family="\'SF Mono\',monospace">Auto</text>' +
        /* placeholder rows */
        '<line x1="26" y1="120" x2="68" y2="120" stroke="var(--border)" stroke-width="4" opacity=".7"/>' +
        '<line x1="78" y1="120" x2="150" y2="120" stroke="var(--border)" stroke-width="4" opacity=".7"/>' +
        '<line x1="186" y1="120" x2="268" y2="120" stroke="var(--border)" stroke-width="4" opacity=".7"/>' +
        '<line x1="316" y1="120" x2="340" y2="120" stroke="var(--border)" stroke-width="4" opacity=".7"/>' +
        '<line x1="26" y1="140" x2="58" y2="140" stroke="var(--border)" stroke-width="4" opacity=".4"/>' +
        '<line x1="78" y1="140" x2="130" y2="140" stroke="var(--border)" stroke-width="4" opacity=".4"/>' +
        '<line x1="186" y1="140" x2="250" y2="140" stroke="var(--border)" stroke-width="4" opacity=".4"/>' +
        '<line x1="316" y1="140" x2="340" y2="140" stroke="var(--border)" stroke-width="4" opacity=".4"/>' +
      '</svg>'
    );
  }

  function _recordHTML(type, name, value, copyValue) {
    return (
      '<div class="amcp-dns-record">' +
        '<div class="amcp-dns-record-kvs">' +
          '<div class="amcp-dns-record-kv">' +
            '<div class="amcp-dns-record-label">Type</div>' +
            '<div class="amcp-dns-record-val">' + escHtml(type) + '</div>' +
          '</div>' +
          '<div class="amcp-dns-record-kv" style="min-width:140px">' +
            '<div class="amcp-dns-record-label">Name</div>' +
            '<div class="amcp-dns-record-val" title="' + escHtml(name) + '">' + escHtml(name) + '</div>' +
          '</div>' +
          '<div class="amcp-dns-record-kv" style="min-width:180px;flex:1">' +
            '<div class="amcp-dns-record-label">Value</div>' +
            '<div class="amcp-dns-record-val" title="' + escHtml(value) + '">' + escHtml(value) + '</div>' +
          '</div>' +
        '</div>' +
        '<button type="button" class="amcp-dns-copy-btn" data-copy="' + escHtml(copyValue) + '">Copy</button>' +
      '</div>'
    );
  }

  function _renderInstructions() {
    var steps  = (PROVIDER_STEPS[_provider] || PROVIDER_STEPS.other).map(function (s) {
      return '<li>' + s + '</li>';
    }).join('');
    var domain = currentDomain();
    var cnameName = domain || 'www.yourdomain.com';

    return (
      '<div class="amcp-dns-step">' +
        '<div class="amcp-dns-step-title">Add a CNAME record in ' + escHtml(_providerName(_provider)) + '</div>' +
        '<div class="amcp-dns-step-copy">' +
          'This CNAME routes AI crawler traffic for <strong>' + escHtml(domain || 'your domain') + '</strong> through Advocate.' +
        '</div>' +
        _schematicSVG() +
        '<ol style="font-size:var(--tx-sm);color:var(--text);line-height:1.6;padding-left:20px;margin:0 0 18px">' + steps + '</ol>' +
        '<div id="amcp-dns-records">' +
          _recordHTML('CNAME', cnameName, CNAME_TARGET, CNAME_TARGET) +
          '<div id="amcp-dns-txt-slot" style="color:var(--muted);font-size:var(--tx-xs);padding:4px 2px">' +
            'Loading TXT record\u2026' +
          '</div>' +
        '</div>' +
        '<div style="margin-top:18px;display:flex;gap:10px;justify-content:flex-end">' +
          '<button id="amcp-dns-back" class="amcp-welcome-btn amcp-welcome-btn-ghost">Change provider</button>' +
          '<button id="amcp-dns-verify" class="amcp-welcome-btn amcp-welcome-btn-primary">Verify DNS</button>' +
        '</div>' +
      '</div>'
    );
  }

  function _bindInstructions() {
    var back = document.getElementById('amcp-dns-back');
    if (back) back.addEventListener('click', function () {
      try { localStorage.removeItem(LOCAL_STORAGE_KEY); } catch (_) { /* no-op */ }
      _provider = null;
      _transition(STAGE_PICKER);
    });
    var verify = document.getElementById('amcp-dns-verify');
    if (verify) verify.addEventListener('click', function () { _transition(STAGE_VERIFY); });

    var records = document.getElementById('amcp-dns-records');
    if (records) {
      records.addEventListener('click', function (ev) {
        var btn = ev.target.closest('.amcp-dns-copy-btn');
        if (!btn) return;
        var text = btn.dataset.copy || '';
        if (text) copyToClipboard(text, btn);
      });
    }

    _loadTxtRecord();
  }

  /* Fetch /api/client/domain-info and, if cf_hostname.ownership_verification
   * is present, swap the TXT placeholder for a real record card. Silent on
   * failure, the CNAME alone is enough to get started. */
  function _loadTxtRecord() {
    var slug = currentSlug();
    if (!slug || !window.AMCP || typeof window.AMCP.authedFetch !== 'function') return;
    window.AMCP.authedFetch('/api/client/domain-info?slug=' + encodeURIComponent(slug))
      .then(function (r) { return r.json(); })
      .then(function (info) {
        var slot = document.getElementById('amcp-dns-txt-slot');
        if (!slot) return;
        var ov = info && info.cf_hostname && info.cf_hostname.ownership_verification;
        if (ov && ov.name && ov.value) {
          slot.outerHTML = _recordHTML('TXT', ov.name, ov.value, ov.value);
        } else {
          slot.textContent = 'The TXT ownership record will appear here once the CNAME has propagated. You can skip this for now.';
        }
      })
      .catch(function () {
        var slot = document.getElementById('amcp-dns-txt-slot');
        if (slot) slot.textContent = 'Could not load TXT record. The CNAME alone will still work \u2014 you can re-check later.';
      });
  }

  /* ── Clipboard helper ───────────────────────────────────────────────────── */
  function copyToClipboard(text, btn) {
    var done = function () {
      if (!btn) return;
      var original = btn.dataset.orig || btn.textContent;
      btn.dataset.orig = original;
      btn.classList.add('copied');
      btn.textContent = 'Copied';
      setTimeout(function () {
        btn.classList.remove('copied');
        btn.textContent = original;
      }, 1600);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () {
        _fallbackCopy(text);
        done();
      });
      return;
    }
    _fallbackCopy(text);
    done();
  }

  function _fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    ta.style.pointerEvents = 'none';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (_) { /* no-op */ }
    document.body.removeChild(ta);
  }

  /* ── Stage 3: verification ──────────────────────────────────────────────── */
  /*
   * Four live status lights:
   *   1. DNS lookup       , DoH probe to cloudflare-dns.com/dns-query.
   *                           Fastest signal; confirms the CNAME resolves.
   *   2. Cloudflare hostname, cf_hostname.status === 'active'
   *   3. SSL certificate  , cf_hostname.ssl_status === 'active'
   *   4. Crawler route    , worker_route.present === true
   *
   * Poll /api/client/domain-info every 10s. First check fires immediately
   * on stage entry so the user sees progress without waiting.
   *
   * When all four go green, show the success block, mark
   * checklist.dns_configured, and stop polling.
   */
  var LIGHTS = [
    { id: 'dns_lookup', label: 'DNS record detected',        hint: 'We look up your CNAME via Cloudflare DNS.' },
    { id: 'cf_active',  label: 'Cloudflare hostname active', hint: 'Your domain has been registered with Cloudflare SaaS.' },
    { id: 'ssl_active', label: 'SSL certificate issued',     hint: 'Encryption is provisioned and ready.' },
    { id: 'route_ready', label: 'AI crawler route live',     hint: 'AdvocateMCP is intercepting crawler traffic.' },
  ];

  var _allGreen       = false;
  var _pollingStarted = false;

  function _renderVerify() {
    var lightsHTML = LIGHTS.map(function (l) {
      return (
        '<div class="amcp-dns-light waiting" data-check="' + escHtml(l.id) + '">' +
          '<span class="amcp-dns-light-dot"></span>' +
          '<span class="amcp-dns-light-label">' + escHtml(l.label) + '</span>' +
          '<span class="amcp-dns-light-hint">' + escHtml(l.hint) + '</span>' +
        '</div>'
      );
    }).join('');

    return (
      '<div class="amcp-dns-step">' +
        '<div class="amcp-dns-step-title">Verifying DNS</div>' +
        '<div class="amcp-dns-step-copy">' +
          'DNS changes usually propagate within a few minutes but can take up to an hour. This page polls every 10 seconds \u2014 feel free to leave it open.' +
        '</div>' +
        '<div id="amcp-dns-success-slot"></div>' +
        '<div class="amcp-dns-lights" id="amcp-dns-lights">' + lightsHTML + '</div>' +
        '<div style="margin-top:18px;display:flex;gap:10px;justify-content:flex-end">' +
          '<button id="amcp-dns-verify-back" class="amcp-welcome-btn amcp-welcome-btn-ghost">Back to instructions</button>' +
        '</div>' +
      '</div>'
    );
  }

  function _bindVerify() {
    var back = document.getElementById('amcp-dns-verify-back');
    if (back) back.addEventListener('click', function () {
      _stopPolling();
      _transition(STAGE_INSTRUCTIONS);
    });
    _startPolling();
  }

  /* ── Polling lifecycle ──────────────────────────────────────────────────── */
  function _startPolling() {
    _stopPolling();
    _allGreen = false;
    _pollingStarted = true;
    _doPoll();
    _pollTimer = setInterval(_doPoll, POLL_INTERVAL_MS);
  }

  function _stopPolling() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
    _pollingStarted = false;
  }

  function _doPoll() {
    var slug   = currentSlug();
    var domain = currentDomain();
    if (!slug) return;

    // Fire DoH + domain-info in parallel.
    var probe = _probeDoh(domain);
    var info  = window.AMCP && typeof window.AMCP.authedFetch === 'function'
      ? window.AMCP.authedFetch('/api/client/domain-info?slug=' + encodeURIComponent(slug))
          .then(function (r) { return r.ok ? r.json() : null; })
          .catch(function () { return null; })
      : Promise.resolve(null);

    Promise.all([probe, info]).then(function (results) {
      var dohOk = !!results[0];
      var data  = results[1] || {};
      _lastStatus = data;
      var statuses = _computeStatuses(dohOk, data);
      _updateLights(statuses);
      if (_allFour(statuses) && !_allGreen) {
        _allGreen = true;
        _onAllGreen();
      }
    });
  }

  /* Query cloudflare-dns.com/dns-query for a CNAME record on the host. Short
   * timeout; returns false on any error. Resolving to any Answer counts as
   * success, we don't check the target value because DoH sees the chain
   * before it follows it. */
  function _probeDoh(host) {
    if (!host) return Promise.resolve(false);
    var url = 'https://cloudflare-dns.com/dns-query?name=' + encodeURIComponent(host) + '&type=CNAME';
    var ctrl = ('AbortController' in window) ? new AbortController() : null;
    var t = ctrl ? setTimeout(function () { ctrl.abort(); }, 6000) : null;
    return fetch(url, {
      headers: { Accept: 'application/dns-json' },
      signal:  ctrl ? ctrl.signal : undefined,
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (body) {
        if (t) clearTimeout(t);
        if (!body) return false;
        return Array.isArray(body.Answer) && body.Answer.length > 0;
      })
      .catch(function () {
        if (t) clearTimeout(t);
        return false;
      });
  }

  function _computeStatuses(dohOk, data) {
    var cf = (data && data.cf_hostname) || {};
    var wr = (data && data.worker_route) || {};
    return {
      dns_lookup:  dohOk                            ? 'ok' : 'waiting',
      cf_active:   cf.status === 'active'           ? 'ok' : (cf.status === 'bad' ? 'err' : 'waiting'),
      ssl_active:  cf.ssl_status === 'active'       ? 'ok' : 'waiting',
      route_ready: wr.present === true              ? 'ok' : 'waiting',
    };
  }

  function _allFour(statuses) {
    return statuses.dns_lookup === 'ok' && statuses.cf_active === 'ok'
        && statuses.ssl_active === 'ok' && statuses.route_ready === 'ok';
  }

  function _updateLights(statuses) {
    Object.keys(statuses).forEach(function (key) {
      var el = document.querySelector('[data-check="' + key + '"]');
      if (!el) return;
      el.classList.remove('waiting', 'ok', 'err');
      el.classList.add(statuses[key]);
    });
  }

  function _onAllGreen() {
    _stopPolling();
    var slot = document.getElementById('amcp-dns-success-slot');
    if (slot) {
      slot.innerHTML =
        '<div class="amcp-dns-success" style="margin-bottom:18px">' +
          '<div class="amcp-dns-success-title">You\u2019re live</div>' +
          '<div class="amcp-dns-success-copy">' +
            'AI crawlers hitting <strong style="color:var(--text)">' + escHtml(currentDomain() || 'your domain') + '</strong> now reach your Advocate agent. ' +
            'Real bot traffic usually starts within 24 hours.' +
          '</div>' +
        '</div>';
    }
    if (window.AMCP_UI && window.AMCP_UI.toast) {
      window.AMCP_UI.toast('DNS verified \u2014 you\u2019re live!', 'success');
    }
    if (window.AMCP_ONBOARDING && typeof window.AMCP_ONBOARDING.markStep === 'function') {
      window.AMCP_ONBOARDING.markStep('checklist.dns_configured').then(function () {
        if (typeof window.AMCP_ONBOARDING.refreshChecklist === 'function') {
          window.AMCP_ONBOARDING.refreshChecklist();
        }
      });
    }
  }

  /* On drawer close (ESC or overlay click), stop any active polling. We
   * can't hook AMCP_UI.closeDrawer directly, so we listen for the drawer
   * overlay's aria-hidden flipping back to true. */
  (function wireDrawerCloseListener() {
    document.addEventListener('DOMContentLoaded', function () {
      var overlay = document.getElementById('amcp-drawer-overlay');
      if (!overlay) return;
      var obs = new MutationObserver(function () {
        if (overlay.getAttribute('aria-hidden') === 'true') _stopPolling();
      });
      obs.observe(overlay, { attributes: true, attributeFilter: ['aria-hidden'] });
    });
  })();

  /* ── Bootstrap ──────────────────────────────────────────────────────────── */
  window.AMCP_DNS_WIZARD = {
    open:  open,
    close: close,
  };
})();
