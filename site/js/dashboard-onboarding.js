/* Onboarding — welcome overlay, Get Started checklist, product tour.
 *
 * Registers:
 *   window.AMCP_ONBOARDING  — openWelcome(), openChecklistSection(),
 *                             startTour(), markStep(), getState()
 *   window.AMCP_SECTIONS['getting-started'] — renders the checklist section
 *
 * Depends on:
 *   window.AMCP.authedFetch  (dashboard-auth.js)
 *   window.AMCP_UI.openDrawer / toast  (dashboard-ui.js)
 *   window.AMCP_DATA         — populated by metrics fetch in dashboard shell
 *   window.AMCP_SECTIONS     — section registry in dashboard.html
 */
(function () {
  'use strict';

  /* ── State cache ────────────────────────────────────────────────────────── */
  var _state = null;   // OnboardingState blob (welcome / checklist / tour)
  var _slug  = null;   // resolved from AMCP_DATA or ?slug param

  function currentSlug() {
    return _slug ||
      (window.AMCP_DATA && window.AMCP_DATA.slug) ||
      new URLSearchParams(window.location.search).get('slug') || '';
  }

  /* Called once by the dashboard boot handler after AMCP_DATA is set. */
  function loadState(onboardingSnapshot) {
    if (!onboardingSnapshot) return;
    _state = onboardingSnapshot.state || null;
    _slug  = (window.AMCP_DATA && window.AMCP_DATA.slug) || '';
  }

  function getState() {
    return _state;
  }

  /* ── API helpers ────────────────────────────────────────────────────────── */
  function markStep(key, value) {
    var body = { step: key };
    if (value !== undefined) body.value = value;
    return window.AMCP.authedFetch('/api/client/onboarding/step', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (data && data.state) _state = data.state;
      return data;
    })
    .catch(function () { /* non-fatal */ });
  }

  /* ── Checklist helpers ──────────────────────────────────────────────────── */
  var HOSTED_KEYS = [
    'watched_welcome',
    'previewed_voice',
    'took_tour',
    'simulated_bot_hit',
  ];
  var CUSTOM_KEYS = [
    'watched_welcome',
    'dns_configured',
    'previewed_voice',
    'took_tour',
    'first_real_bot_hit',
  ];

  function checklistKeys() {
    var isHosted = !!(window.AMCP_DATA && window.AMCP_DATA.is_hosted);
    return isHosted ? HOSTED_KEYS : CUSTOM_KEYS;
  }

  function isStepDone(key) {
    if (!_state || !_state.checklist) return false;
    return !!(_state.checklist[key] && _state.checklist[key].completed_at);
  }

  function doneCount() {
    return checklistKeys().filter(isStepDone).length;
  }

  /* ── Welcome overlay ────────────────────────────────────────────────────── */
  var _overlayEl = null;   // lazily created DOM node
  var _slideIdx  = 0;
  var _slideTimer = null;
  var SLIDE_DURATION = 6000;
  var SLIDE_COUNT    = 4;

  function openWelcome() {
    _slideIdx = (_state && _state.welcome && _state.welcome.current_slide) || 0;
    if (!_overlayEl) _overlayEl = _buildOverlay();
    if (!document.body.contains(_overlayEl)) document.body.appendChild(_overlayEl);
    _showSlide(_slideIdx);
    requestAnimationFrame(function () {
      _overlayEl.classList.add('show');
    });
    _startSlideTimer();
    _overlayEl.focus();
  }

  function _closeWelcome(markComplete) {
    if (_overlayEl) _overlayEl.classList.remove('show');
    _stopSlideTimer();
    if (markComplete || _slideIdx >= SLIDE_COUNT - 1) {
      markStep('welcome.completed');
    } else {
      markStep('welcome.current_slide', _slideIdx);
    }
  }

  function _showSlide(idx) {
    _slideIdx = Math.max(0, Math.min(idx, SLIDE_COUNT - 1));
    if (!_overlayEl) return;
    _overlayEl.querySelectorAll('.amcp-welcome-scene').forEach(function (el, i) {
      el.classList.toggle('active', i === _slideIdx);
    });
    var dots = _overlayEl.querySelectorAll('.amcp-welcome-dot');
    dots.forEach(function (d, i) { d.classList.toggle('active', i === _slideIdx); });
    var btnBack = _overlayEl.querySelector('.amcp-welcome-btn-back');
    var btnNext = _overlayEl.querySelector('.amcp-welcome-btn-next');
    if (btnBack) btnBack.disabled = _slideIdx === 0;
    if (btnNext) {
      btnNext.textContent = _slideIdx === SLIDE_COUNT - 1 ? "Let's go" : 'Next →';
    }
  }

  function _startSlideTimer() {
    _stopSlideTimer();
    _slideTimer = setInterval(function () {
      if (_slideIdx < SLIDE_COUNT - 1) {
        _showSlide(_slideIdx + 1);
      } else {
        _stopSlideTimer();
      }
    }, SLIDE_DURATION);
  }

  function _stopSlideTimer() {
    if (_slideTimer) { clearInterval(_slideTimer); _slideTimer = null; }
  }

  function _buildOverlay() {
    var el = document.createElement('div');
    el.className = 'amcp-welcome-overlay';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', 'Welcome to Advocate');
    el.setAttribute('tabindex', '-1');

    el.innerHTML = _overlayInnerHTML();

    el.querySelector('.amcp-welcome-btn-next').addEventListener('click', function () {
      _stopSlideTimer();
      if (_slideIdx < SLIDE_COUNT - 1) {
        _showSlide(_slideIdx + 1);
        _startSlideTimer();
      } else {
        _closeWelcome(true);
        openChecklistSection();
      }
    });
    el.querySelector('.amcp-welcome-btn-back').addEventListener('click', function () {
      _stopSlideTimer();
      _showSlide(_slideIdx - 1);
      _startSlideTimer();
    });
    el.querySelector('.amcp-welcome-btn-skip').addEventListener('click', function () {
      _closeWelcome(false);
    });

    document.addEventListener('keydown', function (ev) {
      if (!_overlayEl || !_overlayEl.classList.contains('show')) return;
      if (ev.key === 'Escape') { _closeWelcome(false); ev.preventDefault(); }
      if (ev.key === 'ArrowRight') { _stopSlideTimer(); _showSlide(_slideIdx + 1); _startSlideTimer(); }
      if (ev.key === 'ArrowLeft')  { _stopSlideTimer(); _showSlide(_slideIdx - 1); _startSlideTimer(); }
    });

    return el;
  }

  /* Returns the overlay's inner HTML — scenes injected here in step 2. */
  function _overlayInnerHTML() {
    return (
      '<div class="amcp-welcome-card">' +
        '<div class="amcp-welcome-stage">' +
          _scenesHTML() +
        '</div>' +
        '<div class="amcp-welcome-footer">' +
          '<button class="amcp-welcome-btn-back" disabled>← Back</button>' +
          '<div class="amcp-welcome-dots">' +
            [0,1,2,3].map(function (i) {
              return '<span class="amcp-welcome-dot' + (i === 0 ? ' active' : '') + '"></span>';
            }).join('') +
          '</div>' +
          '<button class="amcp-welcome-btn-next">Next →</button>' +
        '</div>' +
        '<button class="amcp-welcome-btn-skip" aria-label="Skip intro">Skip</button>' +
      '</div>'
    );
  }

  /* Placeholder — replaced in step 2. */
  function _scenesHTML() {
    return (
      '<div class="amcp-welcome-scene active"><div class="amcp-scene-placeholder">Scene 1</div></div>' +
      '<div class="amcp-welcome-scene"><div class="amcp-scene-placeholder">Scene 2</div></div>' +
      '<div class="amcp-welcome-scene"><div class="amcp-scene-placeholder">Scene 3</div></div>' +
      '<div class="amcp-welcome-scene"><div class="amcp-scene-placeholder">Scene 4</div></div>'
    );
  }

  /* ── Checklist section ──────────────────────────────────────────────────── */
  var _checklistRendered = false;

  function openChecklistSection() {
    // Drive nav to the getting-started section
    var item = document.querySelector('[data-section="getting-started"]');
    if (item) item.click();
  }

  function _renderChecklist() {
    // Will be filled in step 4
  }

  /* ── Product tour ───────────────────────────────────────────────────────── */
  function startTour() {
    // Will be filled in step 5
  }

  /* ── Section renderer (registered as AMCP_SECTIONS['getting-started']) ─── */
  function renderSection() {
    var sec = document.getElementById('sec-getting-started');
    if (!sec) return;
    if (_checklistRendered) { _refreshChecklist(); return; }
    _checklistRendered = true;
    _renderChecklist();
  }

  function _refreshChecklist() {
    // Re-render just the item states without rebuilding the full section
  }

  /* ── Bootstrap ─────────────────────────────────────────────────────────── */
  window.AMCP_SECTIONS = window.AMCP_SECTIONS || {};
  window.AMCP_SECTIONS['getting-started'] = renderSection;

  window.AMCP_ONBOARDING = {
    loadState:            loadState,
    openWelcome:          openWelcome,
    openChecklistSection: openChecklistSection,
    startTour:            startTour,
    markStep:             markStep,
    getState:             getState,
  };

})();
