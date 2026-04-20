/* Onboarding — welcome overlay, Get Started checklist, product tour.
 *
 * Public API (window.AMCP_ONBOARDING):
 *   loadState(snapshot)   — call from the dashboard boot handler after
 *                           AMCP_DATA is populated. Caches the snapshot
 *                           for subsequent getState() / isFirstLogin()
 *                           calls. Accepts null (admins, missing data).
 *   isFirstLogin()        — true iff state is present and the welcome
 *                           flow has not been completed yet. The boot
 *                           handler AND's this with user.role !== 'admin'
 *                           to decide whether to auto-open the overlay.
 *   openWelcome()         — show the 4-slide welcome overlay (also
 *                           callable from a "Restart welcome" link).
 *   openChecklistSection() — programmatically switch to the getting-
 *                           started section (used by welcome → finish).
 *   startTour()           — begin the 5-stop dashboard tour.
 *   restart()             — alias for startTour(); intended for a
 *                           "Restart tour" footer link.
 *   markStep(key, value?) — POST /api/client/onboarding/step. Used
 *                           internally but also exposed for integrations
 *                           that want to tick arbitrary keys.
 *   getState()            — returns the cached OnboardingState blob
 *                           or null.
 *
 * Registers:
 *   window.AMCP_SECTIONS['getting-started'] — renders the checklist
 *                           section when the sidebar nav item is clicked.
 *
 * Depends on:
 *   window.AMCP.authedFetch  (dashboard-auth.js)
 *   window.AMCP_UI.openDrawer / toast  (dashboard-ui.js)
 *   window.AMCP_DATA         — populated by metrics fetch in dashboard shell
 *   window.AMCP_SECTIONS     — section registry in dashboard.html
 *   window.AMCP_DNS_WIZARD   — optional; enables the dns_configured
 *                           checklist action (dashboard-dns-wizard.js)
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

  /* Is the welcome flow unfinished? Used by the boot handler to decide
   * whether to auto-open the overlay on first dashboard load.
   *
   * Returns false when:
   *   - state is null (admin impersonation, or server returned no snapshot)
   *   - state.welcome.completed_at is set (user already saw the intro)
   * Returns true otherwise.
   *
   * The boot handler must additionally gate on user.role !== 'admin' so
   * admins viewing an un-onboarded tenant don't trigger writes on the
   * tenant's behalf. (Server-side apiMarkOnboardingStep also no-ops for
   * admins, but skipping the UI is cleaner.)
   */
  function isFirstLogin() {
    if (!_state) return false;
    var w = _state.welcome;
    if (!w) return true;
    return !w.completed_at;
  }

  /* "Restart tour" alias — same as startTour(). Named so that a footer
   * link reads naturally ("Restart tour" → AMCP_ONBOARDING.restart()). */
  function restart() {
    startTour();
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
      markStep('welcome.completed_at', new Date().toISOString());
      markStep('checklist.watched_welcome').then(function () {
        _refreshChecklist();
      });
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

    // The overlay isn't in the document yet, so scope queries to `el`.
    el.querySelector('#amcp-wb-next').addEventListener('click', function () {
      _stopSlideTimer();
      if (_slideIdx < SLIDE_COUNT - 1) {
        _showSlide(_slideIdx + 1);
        _startSlideTimer();
      } else {
        _closeWelcome(true);
        openChecklistSection();
      }
    });
    el.querySelector('#amcp-wb-back').addEventListener('click', function () {
      _stopSlideTimer();
      _showSlide(_slideIdx - 1);
      _startSlideTimer();
    });
    el.querySelector('#amcp-wb-skip').addEventListener('click', function () {
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
    return _scene1() + _scene2() + _scene3() + _scene4();
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

  /* Scene 2: "AI assistants ask about your business."
   * Three abstract AI marks (ChatGPT swirl, Claude asterisk, Perplexity atom)
   * flow into a central Advocate shield via dashed animated arrows. */
  function _scene2() {
    return '<div class="amcp-welcome-scene">' +
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360" style="width:100%;height:100%;display:block" aria-hidden="true">' +
      '<defs><style>' +
        '@keyframes s2-flow{to{stroke-dashoffset:-20}}' +
        '@keyframes s2-in{from{opacity:0;transform:translateX(-10px)}to{opacity:1;transform:translateX(0)}}' +
        '@keyframes s2-pop{from{opacity:0;transform:scale(.7)}to{opacity:1;transform:scale(1)}}' +
        '.s2-m1{animation:s2-in .4s ease .1s both}' +
        '.s2-m2{animation:s2-in .4s ease .25s both}' +
        '.s2-m3{animation:s2-in .4s ease .4s both}' +
        '.s2-arrow{stroke-dasharray:6 4;animation:s2-flow 1.2s linear infinite}' +
        '.s2-a1{animation:s2-in .4s ease .55s both,s2-flow 1.2s linear .55s infinite}' +
        '.s2-a2{animation:s2-in .4s ease .7s both,s2-flow 1.2s linear .7s infinite}' +
        '.s2-a3{animation:s2-in .4s ease .85s both,s2-flow 1.2s linear .85s infinite}' +
        '.s2-shield{animation:s2-pop .45s ease 1.0s both;transform-origin:center}' +
      '</style></defs>' +

      '<rect width="640" height="360" style="fill:var(--surface-2,#140a0c)"/>' +

      /* Mark 1: ChatGPT-like swirl. Outer g positions, inner g animates
       * (CSS transform on an SVG element clobbers the `transform` attribute,
       * so we separate the two). */
      '<g transform="translate(100,90)">' +
        '<g class="s2-m1">' +
          '<circle r="30" style="fill:var(--surface,#0d0507);stroke:var(--accent-bright,#5c1532)" stroke-width="1.5"/>' +
          '<path d="M-14,-4 Q-4,-16 10,-8 Q18,4 4,14 Q-12,13 -13,1" fill="none" stroke="#a39a97" stroke-width="2" stroke-linecap="round"/>' +
          '<circle r="2.5" fill="#a39a97"/>' +
          '<text y="48" text-anchor="middle" font-size="10" fill="var(--muted,#8a7c78)" font-family="\'General Sans\',system-ui,sans-serif">ChatGPT</text>' +
        '</g>' +
      '</g>' +

      /* Mark 2: Claude asterisk */
      '<g transform="translate(100,180)">' +
        '<g class="s2-m2">' +
          '<circle r="30" style="fill:var(--surface,#0d0507);stroke:var(--accent-bright,#5c1532)" stroke-width="1.5"/>' +
          '<g stroke="#d97757" stroke-width="2.5" stroke-linecap="round">' +
            '<line x1="0" y1="-14" x2="0" y2="14"/>' +
            '<line x1="-14" y1="0" x2="14" y2="0"/>' +
            '<line x1="-10" y1="-10" x2="10" y2="10"/>' +
            '<line x1="-10" y1="10" x2="10" y2="-10"/>' +
          '</g>' +
          '<text y="48" text-anchor="middle" font-size="10" fill="var(--muted,#8a7c78)" font-family="\'General Sans\',system-ui,sans-serif">Claude</text>' +
        '</g>' +
      '</g>' +

      /* Mark 3: Perplexity atom */
      '<g transform="translate(100,270)">' +
        '<g class="s2-m3">' +
          '<circle r="30" style="fill:var(--surface,#0d0507);stroke:var(--accent-bright,#5c1532)" stroke-width="1.5"/>' +
          '<ellipse rx="18" ry="7" fill="none" stroke="#20b2ab" stroke-width="1.5"/>' +
          '<ellipse rx="18" ry="7" fill="none" stroke="#20b2ab" stroke-width="1.5" transform="rotate(60)"/>' +
          '<ellipse rx="18" ry="7" fill="none" stroke="#20b2ab" stroke-width="1.5" transform="rotate(120)"/>' +
          '<circle r="4" fill="#20b2ab"/>' +
          '<text y="48" text-anchor="middle" font-size="10" fill="var(--muted,#8a7c78)" font-family="\'General Sans\',system-ui,sans-serif">Perplexity</text>' +
        '</g>' +
      '</g>' +

      /* Flowing dashed arrows */
      '<path class="s2-arrow s2-a1" d="M135,90 Q300,90 468,160" fill="none" stroke="#5c1532" stroke-width="2"/>' +
      '<path class="s2-arrow s2-a2" d="M135,180 Q300,180 468,180" fill="none" stroke="#5c1532" stroke-width="2"/>' +
      '<path class="s2-arrow s2-a3" d="M135,270 Q300,270 468,200" fill="none" stroke="#5c1532" stroke-width="2"/>' +

      /* Central Advocate shield — same nesting pattern */
      '<g transform="translate(500,180)">' +
        '<g class="s2-shield">' +
          '<circle r="52" style="fill:var(--accent-glow,rgba(92,21,50,.35))" opacity=".4"/>' +
          '<path d="M-32,-34 L32,-34 L32,6 Q32,24 0,36 Q-32,24 -32,6 Z" style="fill:var(--accent,#3d0a22);stroke:var(--accent-bright,#5c1532)" stroke-width="1.5"/>' +
          '<text y="8" text-anchor="middle" font-size="30" font-weight="700" fill="#e8e3e0" font-family="\'General Sans\',system-ui,sans-serif">A</text>' +
          '<text y="58" text-anchor="middle" font-size="10" font-weight="600" fill="#5c1532" letter-spacing="1.2" font-family="\'General Sans\',system-ui,sans-serif">ADVOCATE</text>' +
        '</g>' +
      '</g>' +

      '</svg>' +
    '</div>';
  }

  /* Scene 3: "Three steps to go live."
   * Vertical stepper — three circles pop, checkmarks draw, connector line
   * draws in. Labels stagger in beside each step. */
  function _scene3() {
    return '<div class="amcp-welcome-scene">' +
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360" style="width:100%;height:100%;display:block" aria-hidden="true">' +
      '<defs><style>' +
        '@keyframes s3-pop{from{opacity:0;transform:scale(.4)}to{opacity:1;transform:scale(1)}}' +
        '@keyframes s3-draw{to{stroke-dashoffset:0}}' +
        '@keyframes s3-appear{from{opacity:0;transform:translateX(-6px)}to{opacity:1;transform:translateX(0)}}' +
        '.s3-c1{animation:s3-pop .4s ease .2s both;transform-origin:200px 90px}' +
        '.s3-c2{animation:s3-pop .4s ease 1.0s both;transform-origin:200px 180px}' +
        '.s3-c3{animation:s3-pop .4s ease 1.8s both;transform-origin:200px 270px}' +
        '.s3-k{stroke-dasharray:40;stroke-dashoffset:40}' +
        '.s3-k1{animation:s3-draw .35s ease .55s both}' +
        '.s3-k2{animation:s3-draw .35s ease 1.35s both}' +
        '.s3-k3{animation:s3-draw .35s ease 2.15s both}' +
        '.s3-l1{animation:s3-appear .35s ease .35s both}' +
        '.s3-l2{animation:s3-appear .35s ease 1.15s both}' +
        '.s3-l3{animation:s3-appear .35s ease 1.95s both}' +
        '.s3-line{stroke-dasharray:180;stroke-dashoffset:180;animation:s3-draw 1.5s ease .3s both}' +
      '</style></defs>' +

      '<rect width="640" height="360" style="fill:var(--surface-2,#140a0c)"/>' +

      /* Vertical connector line between circles */
      '<line class="s3-line" x1="200" y1="112" x2="200" y2="248" style="stroke:var(--accent-bright,#5c1532)" stroke-width="2" stroke-linecap="round"/>' +

      /* Step 1 */
      '<g class="s3-c1">' +
        '<circle cx="200" cy="90" r="22" style="fill:var(--accent,#3d0a22);stroke:var(--accent-bright,#5c1532)" stroke-width="2"/>' +
        '<path class="s3-k s3-k1" d="M189,90 L197,98 L212,83" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>' +
      '</g>' +
      '<g class="s3-l1">' +
        '<text x="240" y="86" font-size="17" font-weight="600" fill="var(--text,#e8e3e0)" font-family="\'General Sans\',system-ui,sans-serif">DNS wired up</text>' +
        '<text x="240" y="106" font-size="12" fill="var(--muted,#8a7c78)" font-family="\'General Sans\',system-ui,sans-serif">Your domain points to Advocate</text>' +
      '</g>' +

      /* Step 2 */
      '<g class="s3-c2">' +
        '<circle cx="200" cy="180" r="22" style="fill:var(--accent,#3d0a22);stroke:var(--accent-bright,#5c1532)" stroke-width="2"/>' +
        '<path class="s3-k s3-k2" d="M189,180 L197,188 L212,173" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>' +
      '</g>' +
      '<g class="s3-l2">' +
        '<text x="240" y="176" font-size="17" font-weight="600" fill="var(--text,#e8e3e0)" font-family="\'General Sans\',system-ui,sans-serif">Agent answers bots</text>' +
        '<text x="240" y="196" font-size="12" fill="var(--muted,#8a7c78)" font-family="\'General Sans\',system-ui,sans-serif">Crawlers get canonical answers from you</text>' +
      '</g>' +

      /* Step 3 */
      '<g class="s3-c3">' +
        '<circle cx="200" cy="270" r="22" style="fill:var(--accent,#3d0a22);stroke:var(--accent-bright,#5c1532)" stroke-width="2"/>' +
        '<path class="s3-k s3-k3" d="M189,270 L197,278 L212,263" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>' +
      '</g>' +
      '<g class="s3-l3">' +
        '<text x="240" y="266" font-size="17" font-weight="600" fill="var(--text,#e8e3e0)" font-family="\'General Sans\',system-ui,sans-serif">You see activity</text>' +
        '<text x="240" y="286" font-size="12" fill="var(--muted,#8a7c78)" font-family="\'General Sans\',system-ui,sans-serif">Bot hits, queries, and referrals in your dashboard</text>' +
      '</g>' +

      '</svg>' +
    '</div>';
  }

  /* Scene 4: "Your dashboard, explained."
   * Miniature wireframe — sidebar + topbar + KPI cards + chart — with three
   * dotted callouts pointing at Overview nav, KPI cards, and trend chart. */
  function _scene4() {
    return '<div class="amcp-welcome-scene">' +
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360" style="width:100%;height:100%;display:block" aria-hidden="true">' +
      '<defs><style>' +
        '@keyframes s4-in{from{opacity:0}to{opacity:1}}' +
        '.s4-mock{animation:s4-in .4s ease .1s both}' +
        '.s4-cb1{animation:s4-in .35s ease .7s both}' +
        '.s4-cb2{animation:s4-in .35s ease 1.3s both}' +
        '.s4-cb3{animation:s4-in .35s ease 1.9s both}' +
      '</style></defs>' +

      '<rect width="640" height="360" style="fill:var(--surface-2,#140a0c)"/>' +

      /* Dashboard mock */
      '<g class="s4-mock">' +
        /* outer frame */
        '<rect x="250" y="60" width="350" height="240" rx="6" style="fill:var(--surface,#0d0507);stroke:var(--border,#2a1418)" stroke-width="1.5"/>' +
        /* sidebar */
        '<rect x="250" y="60" width="80" height="240" style="fill:var(--bg,#050202);stroke:var(--border,#2a1418)" stroke-width="1"/>' +
        '<rect x="260" y="72" width="60" height="10" rx="2" style="fill:var(--accent-bright,#5c1532)"/>' +
        /* sidebar nav: first item highlighted */
        '<rect x="258" y="100" width="64" height="14" rx="3" style="fill:var(--accent,#3d0a22)"/>' +
        '<rect x="258" y="122" width="64" height="14" rx="3" style="fill:var(--border,#2a1418)" opacity=".5"/>' +
        '<rect x="258" y="144" width="64" height="14" rx="3" style="fill:var(--border,#2a1418)" opacity=".5"/>' +
        '<rect x="258" y="166" width="64" height="14" rx="3" style="fill:var(--border,#2a1418)" opacity=".5"/>' +
        '<rect x="258" y="188" width="64" height="14" rx="3" style="fill:var(--border,#2a1418)" opacity=".5"/>' +
        /* topbar */
        '<rect x="330" y="60" width="270" height="26" style="fill:var(--bg,#050202);stroke:var(--border,#2a1418)" stroke-width="1"/>' +
        '<rect x="342" y="69" width="50" height="8" rx="2" style="fill:var(--muted,#8a7c78)" opacity=".5"/>' +
        /* KPI cards */
        '<rect x="345" y="100" width="75" height="60" rx="4" style="fill:var(--surface-2,#140a0c);stroke:var(--border,#2a1418)" stroke-width="1"/>' +
        '<rect x="353" y="108" width="36" height="5" rx="2" style="fill:var(--muted,#8a7c78)" opacity=".6"/>' +
        '<rect x="353" y="124" width="40" height="16" rx="2" style="fill:var(--accent-bright,#5c1532)"/>' +
        '<rect x="430" y="100" width="75" height="60" rx="4" style="fill:var(--surface-2,#140a0c);stroke:var(--border,#2a1418)" stroke-width="1"/>' +
        '<rect x="438" y="108" width="36" height="5" rx="2" style="fill:var(--muted,#8a7c78)" opacity=".6"/>' +
        '<rect x="438" y="124" width="40" height="16" rx="2" style="fill:var(--accent-bright,#5c1532)"/>' +
        '<rect x="515" y="100" width="75" height="60" rx="4" style="fill:var(--surface-2,#140a0c);stroke:var(--border,#2a1418)" stroke-width="1"/>' +
        '<rect x="523" y="108" width="36" height="5" rx="2" style="fill:var(--muted,#8a7c78)" opacity=".6"/>' +
        '<rect x="523" y="124" width="40" height="16" rx="2" style="fill:var(--accent-bright,#5c1532)"/>' +
        /* chart placeholder */
        '<rect x="345" y="175" width="245" height="115" rx="4" style="fill:var(--surface-2,#140a0c);stroke:var(--border,#2a1418)" stroke-width="1"/>' +
        '<path d="M355,270 L390,248 L420,258 L450,228 L480,240 L515,208 L555,222 L585,192" fill="none" style="stroke:var(--accent-bright,#5c1532)" stroke-width="1.5"/>' +
      '</g>' +

      /* Callout 1: Overview nav item */
      '<g class="s4-cb1">' +
        '<line x1="246" y1="107" x2="210" y2="107" style="stroke:var(--muted,#8a7c78)" stroke-width="1" stroke-dasharray="3 3"/>' +
        '<text x="205" y="102" text-anchor="end" font-size="12" font-weight="600" fill="var(--text,#e8e3e0)" font-family="\'General Sans\',system-ui,sans-serif">Overview</text>' +
        '<text x="205" y="116" text-anchor="end" font-size="10" fill="var(--muted,#8a7c78)" font-family="\'General Sans\',system-ui,sans-serif">KPIs at a glance</text>' +
      '</g>' +

      /* Callout 2: KPI cards */
      '<g class="s4-cb2">' +
        '<line x1="430" y1="96" x2="430" y2="52" style="stroke:var(--muted,#8a7c78)" stroke-width="1" stroke-dasharray="3 3"/>' +
        '<text x="430" y="42" text-anchor="middle" font-size="12" font-weight="600" fill="var(--text,#e8e3e0)" font-family="\'General Sans\',system-ui,sans-serif">AI Requests</text>' +
        '<text x="430" y="28" text-anchor="middle" font-size="10" fill="var(--muted,#8a7c78)" font-family="\'General Sans\',system-ui,sans-serif">30-day trends</text>' +
      '</g>' +

      /* Callout 3: chart */
      '<g class="s4-cb3">' +
        '<line x1="465" y1="294" x2="465" y2="325" style="stroke:var(--muted,#8a7c78)" stroke-width="1" stroke-dasharray="3 3"/>' +
        '<text x="465" y="340" text-anchor="middle" font-size="12" font-weight="600" fill="var(--text,#e8e3e0)" font-family="\'General Sans\',system-ui,sans-serif">Bots + Referrals</text>' +
        '<text x="465" y="354" text-anchor="middle" font-size="10" fill="var(--muted,#8a7c78)" font-family="\'General Sans\',system-ui,sans-serif">Who asked, who clicked</text>' +
      '</g>' +

      '</svg>' +
    '</div>';
  }

  /* ── Checklist section ──────────────────────────────────────────────────── */
  var _checklistRendered = false;

  function escHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  var CHECKLIST_DEFS = {
    watched_welcome: {
      title: 'Watch the welcome',
      desc:  'A quick 4-slide intro to what Advocate does.',
    },
    dns_configured: {
      title: 'Wire up your DNS',
      desc:  'Point your domain at Advocate so AI crawlers reach your agent.',
    },
    previewed_voice: {
      title: 'Preview your agent\u2019s voice',
      desc:  'See how your agent might answer a real AI question.',
    },
    took_tour: {
      title: 'Take the dashboard tour',
      desc:  'A 5-stop walkthrough of every section.',
    },
    simulated_bot_hit: {
      title: 'Trigger a simulated bot hit',
      desc:  'We\u2019ll pretend to be PerplexityBot and ping your agent.',
    },
    first_real_bot_hit: {
      title: 'See your first real bot hit',
      desc:  'Once DNS is wired up, real AI crawlers will start arriving.',
    },
  };

  function openChecklistSection() {
    var item = document.querySelector('[data-section="getting-started"]');
    if (item) item.click();
  }

  function _renderChecklist() {
    var sec = document.getElementById('sec-getting-started');
    if (!sec) return;
    sec.innerHTML = _sectionShellHTML();
    var list = document.getElementById('amcp-onb-list');
    if (list) {
      list.addEventListener('click', function (ev) {
        var item = ev.target.closest('.amcp-onb-item');
        if (!item || item.classList.contains('done')) return;
        var key = item.dataset.key;
        if (key) _runChecklistAction(key);
      });
    }
    _refreshChecklist();
  }

  function _sectionShellHTML() {
    var name = (window.AMCP_DATA && window.AMCP_DATA.business_name) || 'your business';
    return (
      '<p class="db-sec-title">Get Started</p>' +
      '<p class="db-sec-sub">Finish these steps to go live with Advocate</p>' +
      '<div class="amcp-onb-intro">' +
        '<div class="amcp-onb-intro-mark"><i data-lucide="sparkles"></i></div>' +
        '<div>' +
          '<div class="amcp-onb-intro-title">Welcome, ' + escHtml(name) + '</div>' +
          '<div class="amcp-onb-intro-copy">Most customers are live in under 10 minutes. Pick up where you left off — progress saves automatically.</div>' +
        '</div>' +
      '</div>' +
      '<div class="amcp-onb-progress"><div class="amcp-onb-progress-fill" id="amcp-onb-progress-fill"></div></div>' +
      '<div class="amcp-onb-list" id="amcp-onb-list"></div>'
    );
  }

  function _refreshChecklist() {
    var list = document.getElementById('amcp-onb-list');
    if (!list) return;
    var keys  = checklistKeys();
    var done  = doneCount();
    var total = keys.length;
    var fill  = document.getElementById('amcp-onb-progress-fill');
    if (fill) fill.style.width = (total > 0 ? Math.round((done / total) * 100) : 0) + '%';
    list.innerHTML = keys.map(function (k) {
      var def    = CHECKLIST_DEFS[k] || { title: k, desc: '' };
      var isDone = isStepDone(k);
      return (
        '<div class="amcp-onb-item' + (isDone ? ' done' : '') + '" data-key="' + escHtml(k) + '">' +
          '<div class="amcp-onb-check"><i data-lucide="check"></i></div>' +
          '<div class="amcp-onb-text">' +
            '<div class="amcp-onb-title">' + escHtml(def.title) + '</div>' +
            '<div class="amcp-onb-desc">'  + escHtml(def.desc)  + '</div>' +
          '</div>' +
          '<div class="amcp-onb-chevron"><i data-lucide="chevron-right"></i></div>' +
        '</div>'
      );
    }).join('');
    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      window.lucide.createIcons();
    }
  }

  function _runChecklistAction(key) {
    switch (key) {
      case 'watched_welcome':
        openWelcome();
        break;
      case 'dns_configured':
        if (window.AMCP_DNS_WIZARD && typeof window.AMCP_DNS_WIZARD.open === 'function') {
          window.AMCP_DNS_WIZARD.open();
        } else {
          window.AMCP_UI && window.AMCP_UI.toast && window.AMCP_UI.toast('DNS wizard not available — reload the page.', 'error');
        }
        break;
      case 'previewed_voice':
        _openVoicePreview();
        break;
      case 'took_tour':
        startTour();
        break;
      case 'simulated_bot_hit':
        _triggerSimulatedHit();
        break;
      case 'first_real_bot_hit':
        _checkRealBotHit();
        break;
    }
  }

  /* Mock voice preview — pulls business_name out of AMCP_DATA and shows a
   * representative sample answer in the drawer. No API call; this is a tour
   * stop, not a live render. Marking it complete unblocks the checklist. */
  function _openVoicePreview() {
    var name   = (window.AMCP_DATA && window.AMCP_DATA.business_name) || 'your business';
    var sample =
      'Sure — ' + name + ' is a local business you can reach directly. ' +
      'They\u2019re open most weekdays and handle inquiries through their booking page. ' +
      'For pricing, hours, or to schedule, tap through to their site.';
    var html =
      '<div class="amcp-dns-step">' +
        '<p class="amcp-dns-step-copy">' +
          'Here\u2019s roughly what your agent returns when ChatGPT or Perplexity asks about your business. ' +
          'Your profile data (hours, services, pricing, credentials) shapes the tone — tune it in Settings.' +
        '</p>' +
        '<div style="padding:16px;background:var(--surface-2);border:1px solid var(--border);border-radius:10px;line-height:1.55;font-size:var(--tx-sm);color:var(--text)">' +
          '<span style="font-size:var(--tx-xs);font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--accent-bright)">Sample answer</span><br/><br/>' +
          escHtml(sample) +
        '</div>' +
        '<p style="margin-top:18px;font-size:var(--tx-xs);color:var(--muted)">' +
          'To see the live agent, open any AI assistant and ask about your business by name.' +
        '</p>' +
      '</div>';
    if (window.AMCP_UI && window.AMCP_UI.openDrawer) {
      window.AMCP_UI.openDrawer('Agent voice preview', html);
    }
    markStep('checklist.previewed_voice').then(function () {
      _refreshChecklist();
    });
  }

  function _triggerSimulatedHit() {
    var slug = currentSlug();
    if (!slug) return;
    if (window.AMCP_UI) window.AMCP_UI.toast('Simulating a bot hit\u2026', 'info');
    window.AMCP.authedFetch('/api/client/domain-test?slug=' + encodeURIComponent(slug))
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (res && (res.ok || res.status === 200)) {
          if (window.AMCP_UI) window.AMCP_UI.toast('Simulated hit successful', 'success');
          markStep('checklist.simulated_bot_hit').then(function () { _refreshChecklist(); });
        } else {
          if (window.AMCP_UI) window.AMCP_UI.toast('Simulation failed. Check domain setup.', 'error');
        }
      })
      .catch(function () {
        if (window.AMCP_UI) window.AMCP_UI.toast('Simulation failed.', 'error');
      });
  }

  function _checkRealBotHit() {
    var slug = currentSlug();
    if (!slug) return;
    window.AMCP.authedFetch('/api/client/domain-info?slug=' + encodeURIComponent(slug))
      .then(function (r) { return r.json(); })
      .then(function (info) {
        if (info && info.last_bot_hit) {
          markStep('checklist.first_real_bot_hit').then(function () { _refreshChecklist(); });
          if (window.AMCP_UI) window.AMCP_UI.toast('Bot hit detected!', 'success');
        } else {
          if (window.AMCP_UI) window.AMCP_UI.toast('No bot hits yet \u2014 real crawlers arrive within ~24h of DNS going live.', 'info');
        }
      })
      .catch(function () { /* non-fatal */ });
  }

  /* ── Product tour ───────────────────────────────────────────────────────── */
  /*
   * Five stops, each attached to a sidebar nav item. Highlights the target
   * with .amcp-tour-target and parks a floating card beside it with a short
   * pitch. Next/Skip controls + ESC exit.
   *
   * Radar is Pro-only; if the nav item is hidden we skip that stop rather
   * than dangle a card over empty space.
   */
  var TOUR_STOPS = [
    {
      selector: '[data-section="overview"]',
      section:  'overview',
      step:     'Step 1 of 5',
      title:    'Overview',
      copy:     'Your 30-day snapshot — AI requests, referral clicks, bot activity. This is the first thing to check each week.',
    },
    {
      selector: '[data-section="ai-requests"]',
      section:  'ai-requests',
      step:     'Step 2 of 5',
      title:    'AI Requests',
      copy:     'Every question an AI assistant asked about your business, grouped by crawler and intent. Great for discovering what customers are really asking.',
    },
    {
      selector: '[data-section="radar"]',
      section:  'radar',
      step:     'Step 3 of 5',
      title:    'Competitor Radar',
      copy:     'Weekly polls against Perplexity + OpenAI. See your Share of Model — when an AI recommends someone in your category, how often is it you?',
      skipIf: function () {
        var el = document.querySelector('[data-section="radar"]');
        return !el || el.offsetParent === null;
      },
    },
    {
      selector: '[data-section="getting-started"]',
      section:  'getting-started',
      step:     'Step 4 of 5',
      title:    'Get Started',
      copy:     'Come back here any time to finish setup. Progress saves automatically and the checklist adapts as you go.',
    },
    {
      selector: '[data-section="settings"]',
      section:  'settings',
      step:     'Step 5 of 5',
      title:    'Settings',
      copy:     'Your profile shapes every answer your agent returns. Update hours, services, pricing, and credentials here to tune the tone.',
    },
  ];

  var _tourIdx        = 0;
  var _tourBackdrop   = null;
  var _tourCard       = null;
  var _tourTargetEl   = null;
  var _tourKeyHandler = null;

  function startTour() {
    _tourIdx = 0;
    if (!_tourBackdrop) _tourBackdrop = _buildTourBackdrop();
    if (!_tourCard)     _tourCard     = _buildTourCard();
    if (!document.body.contains(_tourBackdrop)) document.body.appendChild(_tourBackdrop);
    if (!document.body.contains(_tourCard))     document.body.appendChild(_tourCard);
    _tourBackdrop.classList.add('show');
    _tourCard.classList.add('show');
    _tourKeyHandler = function (ev) {
      if (ev.key === 'Escape') { _endTour(false); ev.preventDefault(); }
    };
    document.addEventListener('keydown', _tourKeyHandler);
    _gotoTourStop(0);
  }

  function _buildTourBackdrop() {
    var b = document.createElement('div');
    b.className = 'amcp-tour-backdrop';
    b.addEventListener('click', function () { _endTour(false); });
    return b;
  }

  function _buildTourCard() {
    var c = document.createElement('div');
    c.className = 'amcp-tour-card';
    c.setAttribute('role', 'dialog');
    c.setAttribute('aria-label', 'Dashboard tour');
    c.innerHTML =
      '<div class="amcp-tour-step" id="amcp-tour-step">Step 1 of 5</div>' +
      '<div class="amcp-tour-title" id="amcp-tour-title">Overview</div>' +
      '<div class="amcp-tour-copy" id="amcp-tour-copy"></div>' +
      '<div class="amcp-tour-controls">' +
        '<button id="amcp-tour-skip" class="amcp-welcome-btn amcp-welcome-btn-ghost">Skip</button>' +
        '<button id="amcp-tour-next" class="amcp-welcome-btn amcp-welcome-btn-primary">Next</button>' +
      '</div>';
    c.querySelector('#amcp-tour-skip').addEventListener('click', function () { _endTour(false); });
    c.querySelector('#amcp-tour-next').addEventListener('click', function () {
      var next = _tourIdx + 1;
      while (next < TOUR_STOPS.length && TOUR_STOPS[next].skipIf && TOUR_STOPS[next].skipIf()) next++;
      if (next >= TOUR_STOPS.length) { _endTour(true); return; }
      _gotoTourStop(next);
    });
    return c;
  }

  function _gotoTourStop(idx) {
    // Clear previous target highlight
    if (_tourTargetEl) _tourTargetEl.classList.remove('amcp-tour-target');

    var stop = TOUR_STOPS[idx];
    if (!stop) return;

    // Skip hidden stops (e.g. Radar for non-Pro)
    if (stop.skipIf && stop.skipIf()) {
      var next = idx + 1;
      while (next < TOUR_STOPS.length && TOUR_STOPS[next].skipIf && TOUR_STOPS[next].skipIf()) next++;
      if (next >= TOUR_STOPS.length) { _endTour(true); return; }
      _gotoTourStop(next);
      return;
    }

    _tourIdx = idx;

    // Drive the section switch so the target content is rendered behind the card
    if (stop.section && window.AMCP_SECTIONS && window.AMCP_SECTIONS[stop.section]) {
      var navItem = document.querySelector('[data-section="' + stop.section + '"]');
      if (navItem) navItem.click();
    }

    // Highlight target
    var target = document.querySelector(stop.selector);
    _tourTargetEl = target;
    if (target) target.classList.add('amcp-tour-target');

    // Populate card copy
    var stepEl  = document.getElementById('amcp-tour-step');
    var titleEl = document.getElementById('amcp-tour-title');
    var copyEl  = document.getElementById('amcp-tour-copy');
    var nextBtn = document.getElementById('amcp-tour-next');
    if (stepEl)  stepEl.textContent  = stop.step;
    if (titleEl) titleEl.textContent = stop.title;
    if (copyEl)  copyEl.textContent  = stop.copy;
    if (nextBtn) nextBtn.textContent = idx === TOUR_STOPS.length - 1 ? 'Finish' : 'Next';

    _positionTourCard(target);
  }

  function _positionTourCard(target) {
    if (!_tourCard) return;
    if (!target) {
      // Fallback: center the card
      _tourCard.style.top  = '50%';
      _tourCard.style.left = '50%';
      _tourCard.style.transform = 'translate(-50%, -50%)';
      return;
    }
    _tourCard.style.transform = '';
    var rect = target.getBoundingClientRect();
    var cardWidth  = _tourCard.offsetWidth  || 320;
    var cardHeight = _tourCard.offsetHeight || 160;
    var gap = 14;

    // Prefer placing the card to the right of the sidebar item
    var left = rect.right + gap;
    var top  = rect.top + (rect.height / 2) - (cardHeight / 2);

    // If card would overflow right edge, place below instead
    if (left + cardWidth + 8 > window.innerWidth) {
      left = Math.max(8, rect.left);
      top  = rect.bottom + gap;
    }
    // Clamp vertically
    top  = Math.max(8, Math.min(top, window.innerHeight - cardHeight - 8));
    left = Math.max(8, Math.min(left, window.innerWidth - cardWidth - 8));

    _tourCard.style.top  = Math.round(top)  + 'px';
    _tourCard.style.left = Math.round(left) + 'px';
  }

  function _endTour(completed) {
    if (_tourTargetEl) _tourTargetEl.classList.remove('amcp-tour-target');
    _tourTargetEl = null;
    if (_tourBackdrop) _tourBackdrop.classList.remove('show');
    if (_tourCard)     _tourCard.classList.remove('show');
    if (_tourKeyHandler) {
      document.removeEventListener('keydown', _tourKeyHandler);
      _tourKeyHandler = null;
    }
    if (completed) {
      markStep('tour.completed_at', new Date().toISOString());
      markStep('checklist.took_tour').then(function () { _refreshChecklist(); });
    }
  }

  /* ── Section renderer (registered as AMCP_SECTIONS['getting-started']) ─── */
  function renderSection() {
    var sec = document.getElementById('sec-getting-started');
    if (!sec) return;
    if (_checklistRendered) { _refreshChecklist(); return; }
    _checklistRendered = true;
    _renderChecklist();
  }

  /* ── Bootstrap ─────────────────────────────────────────────────────────── */
  window.AMCP_SECTIONS = window.AMCP_SECTIONS || {};
  window.AMCP_SECTIONS['getting-started'] = renderSection;

  window.AMCP_ONBOARDING = {
    loadState:            loadState,
    isFirstLogin:         isFirstLogin,
    openWelcome:          openWelcome,
    openChecklistSection: openChecklistSection,
    startTour:            startTour,
    restart:              restart,
    markStep:             markStep,
    getState:             getState,
  };

})();
