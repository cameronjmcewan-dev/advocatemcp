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

  var SLIDES = [
    {
      eyebrow: 'Welcome to Advocate',
      title:   'You built an agent.',
      copy:    'Every AI assistant that asks about your business gets a direct, accurate answer — straight from you.',
    },
    {
      eyebrow: 'What Advocate does',
      title:   'AI assistants ask about your business.',
      copy:    'ChatGPT, Claude, Perplexity — they crawl the web for answers. Advocate intercepts them before they guess.',
    },
    {
      eyebrow: 'The setup',
      title:   'Three steps to go live.',
      copy:    'Wire up DNS, preview your agent\'s answer, then watch real bot traffic appear in your dashboard.',
    },
    {
      eyebrow: 'You\'re almost set',
      title:   'Explore your dashboard.',
      copy:    'Overview, AI Requests, Competitor Radar — your Get Started checklist walks you through each one.',
    },
  ];

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
    _overlayEl.querySelectorAll('.amcp-welcome-dot').forEach(function (d, i) {
      d.classList.toggle('active', i === _slideIdx);
    });
    var btnBack = document.getElementById('amcp-wb-back');
    var btnNext = document.getElementById('amcp-wb-next');
    if (btnBack) btnBack.disabled = _slideIdx === 0;
    if (btnNext) btnNext.textContent = _slideIdx === SLIDE_COUNT - 1 ? "Let's go →" : 'Next →';
    var slide = SLIDES[_slideIdx];
    if (slide) {
      var eyebrow = _overlayEl.querySelector('.amcp-welcome-eyebrow');
      var title   = _overlayEl.querySelector('.amcp-welcome-title');
      var copy    = _overlayEl.querySelector('.amcp-welcome-copy');
      if (eyebrow) eyebrow.textContent = slide.eyebrow;
      if (title)   title.textContent   = slide.title;
      if (copy)    copy.textContent    = slide.copy;
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

    document.getElementById('amcp-wb-next').addEventListener('click', function () {
      _stopSlideTimer();
      if (_slideIdx < SLIDE_COUNT - 1) {
        _showSlide(_slideIdx + 1);
        _startSlideTimer();
      } else {
        _closeWelcome(true);
        openChecklistSection();
      }
    });
    document.getElementById('amcp-wb-back').addEventListener('click', function () {
      _stopSlideTimer();
      _showSlide(_slideIdx - 1);
      _startSlideTimer();
    });
    document.getElementById('amcp-wb-skip').addEventListener('click', function () {
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

  function _overlayInnerHTML() {
    var s = SLIDES[0];
    var dots = [0,1,2,3].map(function (i) {
      return '<span class="amcp-welcome-dot' + (i === 0 ? ' active' : '') + '"></span>';
    }).join('');
    return (
      '<div class="amcp-welcome-card">' +
        '<div class="amcp-welcome-stage">' +
          _scenesHTML() +
        '</div>' +
        '<div class="amcp-welcome-body">' +
          '<div class="amcp-welcome-eyebrow">' + s.eyebrow + '</div>' +
          '<div class="amcp-welcome-title">'   + s.title   + '</div>' +
          '<div class="amcp-welcome-copy">'    + s.copy    + '</div>' +
        '</div>' +
        '<div class="amcp-welcome-controls">' +
          '<button id="amcp-wb-skip" class="amcp-welcome-btn amcp-welcome-btn-ghost">Skip</button>' +
          '<div class="amcp-welcome-dots">' + dots + '</div>' +
          '<div class="amcp-welcome-btns">' +
            '<button id="amcp-wb-back" class="amcp-welcome-btn" disabled>← Back</button>' +
            '<button id="amcp-wb-next" class="amcp-welcome-btn amcp-welcome-btn-primary">Next →</button>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }

  function _scenesHTML() {
    return _scene1() +
      '<div class="amcp-welcome-scene"><div class="amcp-scene-placeholder">Scene 2 — coming next</div></div>' +
      '<div class="amcp-welcome-scene"><div class="amcp-scene-placeholder">Scene 3 — coming next</div></div>' +
      '<div class="amcp-welcome-scene"><div class="amcp-scene-placeholder">Scene 4 — coming next</div></div>';
  }

  /* Scene 1: "You built an agent."
   * Storefront silhouette + pulsing Advocate speech bubble.
   * All colors via CSS vars with hex fallbacks for SVG attribute context. */
  function _scene1() {
    return '<div class="amcp-welcome-scene active">' +
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360" style="width:100%;height:100%;display:block" aria-hidden="true">' +
      '<defs><style>' +
        '@keyframes s1-pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.07)}}' +
        '@keyframes s1-appear{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}' +
        '.s1-bubble{animation:s1-appear .5s ease .1s both}' +
        '.s1-shield{animation:s1-pulse 2.2s ease-in-out infinite;transform-origin:488px 114px}' +
      '</style></defs>' +

      /* bg */
      '<rect width="640" height="360" style="fill:var(--surface-2,#140a0c)"/>' +
      /* subtle grid */
      '<line x1="0" y1="180" x2="640" y2="180" stroke="#2a1418" stroke-width=".5"/>' +
      '<line x1="320" y1="0" x2="320" y2="360" stroke="#2a1418" stroke-width=".5"/>' +

      /* storefront body */
      '<rect x="150" y="196" width="240" height="140" rx="3" style="fill:var(--surface,#0d0507);stroke:var(--border,#2a1418)" stroke-width="1.5"/>' +
      /* roof */
      '<polygon points="133,198 270,118 407,198" style="fill:var(--accent,#3d0a22)"/>' +
      '<line x1="133" y1="198" x2="407" y2="198" stroke="#5c1532" stroke-width="2"/>' +
      /* left window */
      '<rect x="165" y="216" width="68" height="46" rx="3" style="fill:var(--accent-dim,rgba(61,10,34,.18));stroke:var(--border,#2a1418)" stroke-width="1"/>' +
      '<rect x="168" y="219" width="22" height="10" rx="1" fill="#5c1532" opacity=".3"/>' +
      /* right window */
      '<rect x="307" y="216" width="68" height="46" rx="3" style="fill:var(--accent-dim,rgba(61,10,34,.18));stroke:var(--border,#2a1418)" stroke-width="1"/>' +
      '<rect x="310" y="219" width="22" height="10" rx="1" fill="#5c1532" opacity=".3"/>' +
      /* door */
      '<rect x="237" y="264" width="66" height="72" rx="3" style="fill:var(--accent,#3d0a22);stroke:var(--accent-bright,#5c1532)" stroke-width="1"/>' +
      '<circle cx="296" cy="302" r="3" fill="#e8e3e0" opacity=".55"/>' +
      /* steps */
      '<rect x="226" y="335" width="88" height="5" rx="2" style="fill:var(--border,#2a1418)"/>' +
      '<rect x="215" y="338" width="110" height="3" rx="2" style="fill:var(--border,#2a1418)" opacity=".5"/>' +

      /* speech bubble group */
      '<g class="s1-bubble">' +
        /* shadow */
        '<rect x="415" y="85" width="158" height="94" rx="14" fill="#000" opacity=".22" transform="translate(2,3)"/>' +
        /* body */
        '<rect x="415" y="85" width="158" height="94" rx="14" style="fill:var(--surface,#0d0507);stroke:var(--accent-bright,#5c1532)" stroke-width="1.5"/>' +
        /* tail: a down-left pointing triangle */
        '<path d="M436,179 L420,200 L458,179" style="fill:var(--surface,#0d0507);stroke:var(--accent-bright,#5c1532)" stroke-width="1.5" stroke-linejoin="round"/>' +
        /* cover the bubble bottom border in the tail gap */
        '<rect x="421" y="175" width="46" height="8" style="fill:var(--surface,#0d0507)"/>' +
        /* shield */
        '<g class="s1-shield">' +
          '<path d="M466,94 L510,94 L510,121 Q510,133 488,139 Q466,133 466,121 Z" style="fill:var(--accent,#3d0a22);stroke:var(--accent-bright,#5c1532)" stroke-width="1.5"/>' +
          '<text x="488" y="121" text-anchor="middle" dominant-baseline="middle" font-size="21" font-weight="700" fill="#e8e3e0" font-family="\'General Sans\',system-ui,sans-serif">A</text>' +
        '</g>' +
        /* "ADVOCATE" label */
        '<text x="488" y="155" text-anchor="middle" font-size="9.5" font-weight="600" fill="#5c1532" font-family="\'General Sans\',system-ui,sans-serif" letter-spacing="1.2">ADVOCATE</text>' +
      '</g>' +

      /* dashed connector line bubble-tail → roof */
      '<line x1="420" y1="196" x2="370" y2="190" stroke="#5c1532" stroke-width="1" stroke-dasharray="3 3" opacity=".4"/>' +

      '</svg>' +
    '</div>';
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
