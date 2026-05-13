/* DNS wizard, guided CNAME/TXT setup for custom-domain tenants.
 *
 * Opens the right-side drawer (AMCP_UI.openDrawer) and walks the user
 * through three stages:
 *
 *   1. Provider picker, pick DNS host (GoDaddy, Namecheap, Cloudflare).
 *      Selection cached in localStorage so return visits skip this stage.
 *   2. Instructions   , schematic SVG diagram + copyable CNAME/TXT
 *                         record values specific to the chosen provider.
 *   3. Verification   , delegates to window.AMCP_DNS_STATUS.startPolling
 *                         which renders all signals; wizard handles the
 *                         on-all-green hook (toast + checklist mark).
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
 *   window.AMCP_DNS_STATUS.startPolling (dashboard-dns-status.js)
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
    // window.AMCP_DATA.domain landed as a STRING in v0 of the shell
    // boot, but v2 (Apr 2026 onward) populates it as an object
    // { hostname, status, ... } since callers needed the status
    // signals. The DNS wizard predates that shape change — without
    // this unwrap, escHtml(domain) renders "[object Object]" inside
    // the instructions panel. Handle both shapes for back-compat.
    var d = window.AMCP_DATA && window.AMCP_DATA.domain;
    if (!d) return '';
    if (typeof d === 'string') return d;
    return d.hostname || '';
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
  /* Opens the drawer with a brief loading state, then consults the
   * canonical /api/client/domain-info probe to decide which branch to
   * render. Previously this used AMCP_DATA.is_hosted — a brittle local
   * heuristic computed from a D1 column suffix that could disagree with
   * the Connection card's live status (the card uses the same probe
   * called here). Reading the same signal keeps the two views coherent
   * and removes a class of bugs where the wizard told a tenant "no DNS
   * setup needed" while the card next to it said "Inactive". */
  function open(initialProvider) {
    _stopPolling();
    _openLoadingDrawer();
    _resolveCanonicalState().then(function (state) {
      var host = state && (typeof state.domain === 'string'
        ? state.domain
        : ((state.domain && state.domain.hostname) || ''));
      if (state && state.is_hosted && state.all_green && host) {
        _renderHostedNotice(host);
        return;
      }
      var saved = initialProvider || getSavedProvider();
      if (saved) {
        _provider = saved;
        _stage    = STAGE_INSTRUCTIONS;
      } else {
        _provider = null;
        _stage    = STAGE_PICKER;
      }
      _swapDrawerBody(_bodyForStage());
      _bindStageHandlers();
    });
  }

  /* Render the "you're all set" panel into the already-open drawer.
   * Caller (open()) is responsible for confirming the tenant is on the
   * hosted tier AND has a verified-green domain probe before invoking
   * this. If displayHost is missing we refuse to render and fall through
   * to the actionable wizard rather than claim "no setup needed" with
   * a placeholder — historically this is exactly how the
   * "your subdomain" literal leaked into bold tags. */
  function _renderHostedNotice(displayHost) {
    if (!displayHost) {
      _provider = null;
      _stage    = STAGE_PICKER;
      _swapDrawerBody(_bodyForStage());
      _bindStageHandlers();
      return;
    }
    var body = (
      '<div class="amcp-dns-step">' +
        '<div class="amcp-dns-step-title">No DNS setup needed</div>' +
        '<div class="amcp-dns-step-copy" style="margin-bottom:18px">' +
          'Your subdomain <strong>' + escHtml(displayHost) + '</strong> is hosted by Advocate ' +
          'and routed automatically through our Cloudflare edge. There’s nothing for ' +
          'you to configure at a domain registrar — bots already reach your agent.' +
        '</div>' +
        '<div class="amcp-dns-step-copy" style="font-size:13px;color:var(--muted)">' +
          'Want to use your own domain (e.g. <code>advocate.com</code>) instead? ' +
          'Reach out to support and we’ll move you to the custom-domain tier.' +
        '</div>' +
        '<div style="margin-top:24px;display:flex;justify-content:flex-end">' +
          '<button id="amcp-dns-close" class="amcp-welcome-btn amcp-welcome-btn-primary" type="button">Got it</button>' +
        '</div>' +
      '</div>'
    );
    _swapDrawerBody(body);
    var btn = document.getElementById('amcp-dns-close');
    if (btn) btn.addEventListener('click', close);
  }

  function _openLoadingDrawer() {
    var body = (
      '<div class="amcp-dns-step">' +
        '<div class="amcp-dns-step-copy" style="color:var(--muted)">Loading DNS setup…</div>' +
      '</div>'
    );
    if (window.AMCP_UI && typeof window.AMCP_UI.openDrawer === 'function') {
      window.AMCP_UI.openDrawer('DNS setup', body);
    }
  }

  function _swapDrawerBody(body) {
    var drawerBody = document.getElementById('amcp-drawer-body');
    if (drawerBody) drawerBody.innerHTML = body;
  }

  function _resolveCanonicalState() {
    // Same /api/client/domain-info signal the Connection card reads,
    // so wizard copy and card status can't disagree. Returns null on
    // any failure; caller falls through to the actionable wizard.
    var slug = currentSlug();
    if (!window.AMCP || typeof window.AMCP.authedFetch !== 'function') {
      return Promise.resolve(null);
    }
    var path = '/api/client/domain-info' + (slug ? '?slug=' + encodeURIComponent(slug) : '');
    return window.AMCP.authedFetch(path)
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
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
          'Pick your DNS provider and we’ll show step-by-step instructions with copyable record values.' +
        '</div>' +
        '<div class="amcp-dns-providers" id="amcp-dns-picker-grid">' + cards + '</div>' +
        '<div style="margin-top:16px;font-size:var(--tx-xs);color:var(--muted)">' +
          'Your choice is remembered locally — next time you open this wizard, we’ll jump straight to instructions.' +
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
      'Set <strong>TTL</strong> to <strong>1/2 Hour</strong> from the dropdown (don\'t pick Custom or 1 Hour).',
    ],
    namecheap: [
      'Sign in and open the <strong>Domain List</strong>.',
      'Click <strong>Manage</strong> next to your domain.',
      'Select the <strong>Advanced DNS</strong> tab.',
      'Click <strong>Add New Record</strong>, choose CNAME, then paste the values below.',
      'Set <strong>TTL</strong> to <strong>30 min</strong> from the dropdown.',
    ],
    cloudflare: [
      'Open your domain in the Cloudflare dashboard.',
      'In the sidebar: <strong>DNS</strong> → <strong>Records</strong>.',
      'Click <strong>Add record</strong> and choose <strong>CNAME</strong>.',
      'Paste the values below. Set proxy status to <strong>DNS only</strong> (grey cloud).',
      'Leave <strong>TTL</strong> on <strong>Auto</strong>.',
    ],
    other: [
      'Log in to your DNS provider.',
      'Find the <strong>DNS</strong> or <strong>Records</strong> settings for your domain.',
      'Add a <strong>CNAME</strong> record using the values below.',
      'Set <strong>TTL</strong> to <strong>30 minutes</strong> (1800 seconds).',
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
   * Provider-agnostic on purpose: most DNS dashboards share this layout.
   *
   * Brand-token mapping (Apr 29 2026 fix): the original implementation
   * referenced --surface, --bg, --accent, --surface-2, --accent-bright,
   * --accent-dim, --accent-ring, --border, --text — none of which exist
   * in styles.css. The SVG was rendering as a black rectangle with only
   * the maroon-fill regions (DNS tab, + Add button) visible. Mapped
   * onto the real palette: --paper / --ink / --muted / --line / --maroon
   * / --maroon-tint / --maroon-wash. */
  function _schematicSVG() {
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 180" style="width:100%;height:auto;max-width:360px;display:block;margin:0 auto 18px;border-radius:8px" aria-hidden="true">' +
        /* outer card frame */
        '<rect x="4" y="4" width="352" height="172" rx="8" style="fill:var(--paper);stroke:var(--line)" stroke-width="1.5"/>' +
        /* faux window chrome */
        '<rect x="4" y="4" width="352" height="24" rx="8" style="fill:var(--maroon-wash)"/>' +
        '<circle cx="18" cy="16" r="3" style="fill:var(--muted)" opacity=".5"/>' +
        '<circle cx="28" cy="16" r="3" style="fill:var(--muted)" opacity=".5"/>' +
        '<circle cx="38" cy="16" r="3" style="fill:var(--muted)" opacity=".5"/>' +
        /* tabs row */
        '<rect x="16" y="36" width="52" height="16" rx="3" style="fill:var(--maroon)"/>' +
        '<text x="42" y="47" text-anchor="middle" font-size="9" fill="#fff" font-family="\'General Sans\',system-ui,sans-serif">DNS</text>' +
        '<rect x="74" y="36" width="52" height="16" rx="3" style="fill:var(--maroon-wash)"/>' +
        '<rect x="132" y="36" width="52" height="16" rx="3" style="fill:var(--maroon-wash)"/>' +
        /* add button */
        '<rect x="296" y="36" width="50" height="16" rx="3" style="fill:var(--maroon)"/>' +
        '<text x="321" y="47" text-anchor="middle" font-size="9" fill="#fff" font-family="\'General Sans\',system-ui,sans-serif">+ Add</text>' +
        /* table header */
        '<rect x="16" y="60" width="330" height="14" rx="2" style="fill:var(--maroon-wash)"/>' +
        '<text x="26" y="70" font-size="8" fill="var(--muted)" font-family="\'General Sans\',system-ui,sans-serif" font-weight="600" letter-spacing=".7">TYPE</text>' +
        '<text x="78" y="70" font-size="8" fill="var(--muted)" font-family="\'General Sans\',system-ui,sans-serif" font-weight="600" letter-spacing=".7">NAME</text>' +
        '<text x="186" y="70" font-size="8" fill="var(--muted)" font-family="\'General Sans\',system-ui,sans-serif" font-weight="600" letter-spacing=".7">VALUE</text>' +
        '<text x="316" y="70" font-size="8" fill="var(--muted)" font-family="\'General Sans\',system-ui,sans-serif" font-weight="600" letter-spacing=".7">TTL</text>' +
        /* highlighted CNAME row — what the user is about to add */
        '<rect x="16" y="82" width="330" height="22" rx="2" style="fill:var(--maroon-tint);stroke:var(--maroon)" stroke-width="1.5"/>' +
        '<text x="26" y="97" font-size="10" fill="var(--maroon)" font-family="\'SF Mono\',ui-monospace,monospace" font-weight="700">CNAME</text>' +
        '<text x="78" y="97" font-size="10" fill="var(--ink)" font-family="\'SF Mono\',ui-monospace,monospace">www</text>' +
        '<text x="186" y="97" font-size="10" fill="var(--ink)" font-family="\'SF Mono\',ui-monospace,monospace">' + CNAME_TARGET + '</text>' +
        '<text x="316" y="97" font-size="10" fill="var(--ink)" font-family="\'SF Mono\',ui-monospace,monospace">Auto</text>' +
        /* placeholder skeleton rows below */
        '<line x1="26" y1="120" x2="68" y2="120" stroke="var(--line)" stroke-width="4" opacity=".8"/>' +
        '<line x1="78" y1="120" x2="150" y2="120" stroke="var(--line)" stroke-width="4" opacity=".8"/>' +
        '<line x1="186" y1="120" x2="268" y2="120" stroke="var(--line)" stroke-width="4" opacity=".8"/>' +
        '<line x1="316" y1="120" x2="340" y2="120" stroke="var(--line)" stroke-width="4" opacity=".8"/>' +
        '<line x1="26" y1="140" x2="58" y2="140" stroke="var(--line)" stroke-width="4" opacity=".5"/>' +
        '<line x1="78" y1="140" x2="130" y2="140" stroke="var(--line)" stroke-width="4" opacity=".5"/>' +
        '<line x1="186" y1="140" x2="250" y2="140" stroke="var(--line)" stroke-width="4" opacity=".5"/>' +
        '<line x1="316" y1="140" x2="340" y2="140" stroke="var(--line)" stroke-width="4" opacity=".5"/>' +
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

  function _ttlCallout(provider) {
    var msg = '';
    if (provider === 'godaddy')  msg = '⏱️ Set <strong>TTL</strong> to <strong>1/2 Hour</strong> for every record. (GoDaddy default is 1 Hour — change it.)';
    else if (provider === 'namecheap') msg = '⏱️ Set <strong>TTL</strong> to <strong>30 min</strong> for every record.';
    else if (provider === 'cloudflare') msg = '⏱️ Leave <strong>TTL</strong> on <strong>Auto</strong> (Cloudflare default).';
    else msg = '⏱️ Use <strong>30 minutes</strong> (1800 seconds) as the TTL for every record.';
    return '<div class="amcp-dns-ttl-callout">' + msg + '</div>';
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
        _ttlCallout(_provider) +
        '<ol style="font-size:var(--tx-sm);color:var(--text);line-height:1.6;padding-left:20px;margin:0 0 18px">' + steps + '</ol>' +
        '<div id="amcp-dns-records">' +
          _recordHTML('CNAME', cnameName, CNAME_TARGET, CNAME_TARGET) +
          '<div id="amcp-dns-txt-slot" style="color:var(--muted);font-size:var(--tx-xs);padding:4px 2px">' +
            'Loading TXT record…' +
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
        if (slot) slot.textContent = 'Could not load TXT record. The CNAME alone will still work — you can re-check later.';
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
   * Stage 3 is now a thin host. The actual rendering + polling lives in
   * dashboard-dns-status.js (window.AMCP_DNS_STATUS). The wizard provides
   * the container and the on-all-green hook (toast + checklist mark).
   */
  var _statusHandle = null;
  var _allGreen = false;

  function _renderVerify() {
    return (
      '<div class="amcp-dns-step">' +
        '<div class="amcp-dns-step-title">Verifying DNS</div>' +
        '<div class="amcp-dns-step-copy">' +
          'DNS changes usually propagate in 10-30 minutes, but can take up to 48 hours globally. ' +
          'This page polls every 10 seconds — feel free to leave it open and check back later.' +
        '</div>' +
        '<div id="amcp-dns-success-slot"></div>' +
        '<div id="amcp-dns-status-container"></div>' +
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

  function _startPolling() {
    _stopPolling();
    _allGreen = false;
    var container = document.getElementById('amcp-dns-status-container');
    var slug = currentSlug();
    if (!container || !slug || !window.AMCP_DNS_STATUS) return;
    _statusHandle = window.AMCP_DNS_STATUS.startPolling(container, slug, POLL_INTERVAL_MS, function (status) {
      _onAllGreen(status);
    });
  }

  function _stopPolling() {
    if (_statusHandle && typeof _statusHandle.stop === 'function') {
      _statusHandle.stop();
    }
    _statusHandle = null;
  }

  function _onAllGreen(status) {
    _allGreen = true;
    _stopPolling();
    var slot = document.getElementById('amcp-dns-success-slot');
    if (slot) {
      slot.innerHTML =
        '<div class="amcp-dns-success" style="margin-bottom:18px">' +
          '<div class="amcp-dns-success-title">You’re live</div>' +
          '<div class="amcp-dns-success-copy">' +
            'AI crawlers hitting <strong style="color:var(--text)">' + escHtml(currentDomain() || 'your domain') + '</strong> now reach your Advocate agent. ' +
            'Real bot traffic usually starts within 24 hours.' +
          '</div>' +
        '</div>';
    }
    if (window.AMCP_UI && window.AMCP_UI.toast) {
      window.AMCP_UI.toast('DNS verified — you’re live!', 'success');
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
