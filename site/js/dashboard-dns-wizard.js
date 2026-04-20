/* DNS wizard — guided CNAME/TXT setup for custom-domain tenants.
 *
 * Opens the right-side drawer (AMCP_UI.openDrawer) and walks the user
 * through three stages:
 *
 *   1. Provider picker  — pick DNS host (GoDaddy, Namecheap, Cloudflare).
 *      Selection cached in localStorage so return visits skip this stage.
 *   2. Instructions     — schematic SVG diagram + copyable CNAME/TXT
 *                         record values specific to the chosen provider.
 *   3. Verification     — four live status lights (DoH probe, CF hostname
 *                         active, SSL active, Worker Route present),
 *                         polling /api/client/domain-info every 10s until
 *                         all four go green, then marks
 *                         checklist.dns_configured complete.
 *
 * Public API (window.AMCP_DNS_WIZARD):
 *   open(initialProvider?) — open the drawer at the appropriate stage.
 *                            Passes through to AMCP_UI.openDrawer.
 *   close()                — programmatic close (stops polling too).
 *
 * Depends on:
 *   window.AMCP.authedFetch (dashboard-auth.js)
 *   window.AMCP_UI.openDrawer / closeDrawer / toast (dashboard-ui.js)
 *   window.AMCP_DATA (slug, domain) — metrics fetch in dashboard shell
 *   window.AMCP_ONBOARDING.markStep (dashboard-onboarding.js) — to tick
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

  /* ── Stage 1: provider picker (filled in step 2) ────────────────────────── */
  function _renderPicker() {
    return (
      '<div class="amcp-dns-step">' +
        '<div class="amcp-dns-step-title">Pick your DNS provider</div>' +
        '<div class="amcp-dns-step-copy">' +
          'We\u2019ll show provider-specific instructions and live status while the records propagate.' +
        '</div>' +
        '<div class="amcp-dns-providers" id="amcp-dns-picker-grid">' +
          '<em style="color:var(--muted);font-size:var(--tx-sm)">Provider cards rendered in step 2.</em>' +
        '</div>' +
      '</div>'
    );
  }

  function _bindPicker() {
    // Click delegation for provider cards — filled in step 2.
  }

  /* ── Stage 2: instructions (filled in step 3) ───────────────────────────── */
  function _renderInstructions() {
    return (
      '<div class="amcp-dns-step">' +
        '<div class="amcp-dns-step-title">Instructions for <span style="text-transform:capitalize">' + escHtml(_provider || '') + '</span></div>' +
        '<div class="amcp-dns-step-copy">' +
          'Provider diagram + copyable records rendered in step 3.' +
        '</div>' +
        '<div style="margin-top:18px;display:flex;gap:10px">' +
          '<button id="amcp-dns-back" class="amcp-welcome-btn amcp-welcome-btn-ghost">Change provider</button>' +
          '<button id="amcp-dns-verify" class="amcp-welcome-btn amcp-welcome-btn-primary">Verify DNS</button>' +
        '</div>' +
      '</div>'
    );
  }

  function _bindInstructions() {
    var back = document.getElementById('amcp-dns-back');
    if (back) back.addEventListener('click', function () { _transition(STAGE_PICKER); });
    var verify = document.getElementById('amcp-dns-verify');
    if (verify) verify.addEventListener('click', function () { _transition(STAGE_VERIFY); });
  }

  /* ── Stage 3: verification (filled in step 4) ───────────────────────────── */
  function _renderVerify() {
    return (
      '<div class="amcp-dns-step">' +
        '<div class="amcp-dns-step-title">Verifying DNS\u2026</div>' +
        '<div class="amcp-dns-step-copy">' +
          'Live status lights and polling rendered in step 4.' +
        '</div>' +
        '<div id="amcp-dns-lights" style="margin-top:16px;color:var(--muted);font-size:var(--tx-sm)">' +
          'Waiting to start polling\u2026' +
        '</div>' +
      '</div>'
    );
  }

  function _bindVerify() {
    _startPolling();
  }

  /* ── Polling lifecycle (wired in step 4) ────────────────────────────────── */
  function _startPolling() {
    // Placeholder — step 4 wires this to /api/client/domain-info.
  }

  function _stopPolling() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
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
