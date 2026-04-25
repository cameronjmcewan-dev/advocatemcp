/* Onboarding, welcome overlay, Get Started checklist, product tour.
 *
 * Public API (window.AMCP_ONBOARDING):
 *   loadState(snapshot) , call from the dashboard boot handler after
 *                           AMCP_DATA is populated. Caches the snapshot
 *                           for subsequent getState() / isFirstLogin()
 *                           calls. Accepts null (admins, missing data).
 *   isFirstLogin()      , true iff state is present and the welcome
 *                           flow has not been completed yet. The boot
 *                           handler AND's this with user.role !== 'admin'
 *                           to decide whether to auto-open the overlay.
 *   openWelcome()       , show the 4-slide welcome overlay (also
 *                           callable from a "Restart welcome" link).
 *   openChecklistSection(), programmatically switch to the getting-
 *                           started section (used by welcome → finish).
 *   startTour()         , begin the 5-stop dashboard tour.
 *   restart()           , alias for startTour(); intended for a
 *                           "Restart tour" footer link.
 *   markStep(key, value?), POST /api/client/onboarding/step. Used
 *                           internally but also exposed for integrations
 *                           that want to tick arbitrary keys.
 *   getState()          , returns the cached OnboardingState blob
 *                           or null.
 *
 * Registers:
 *   window.AMCP_SECTIONS['getting-started'], renders the checklist
 *                           section when the sidebar nav item is clicked.
 *
 * Depends on:
 *   window.AMCP.authedFetch  (dashboard-auth.js)
 *   window.AMCP_UI.openDrawer / toast  (dashboard-ui.js)
 *   window.AMCP_DATA       , populated by metrics fetch in dashboard shell
 *   window.AMCP_SECTIONS   , section registry in dashboard.html
 *   window.AMCP_DNS_WIZARD , optional; enables the dns_configured
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

  /* "Restart tour" alias, same as startTour(). Named so that a footer
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
      copy:    'Every AI assistant that asks about your business gets a direct, accurate answer, straight from you.',
    },
    {
      eyebrow: 'What Advocate does',
      title:   'AI assistants ask about your business.',
      copy:    'ChatGPT, Claude, Perplexity, they crawl the web for answers. Advocate intercepts them before they guess.',
    },
    {
      eyebrow: 'The setup',
      title:   'Three steps to go live.',
      copy:    'Wire up DNS, preview your agent\'s answer, then watch real bot traffic appear in your dashboard.',
    },
    {
      eyebrow: 'You\'re almost set',
      title:   'Explore your dashboard.',
      copy:    'Overview, AI Requests, Competitor Radar, your Get Started checklist walks you through each one.',
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
      // Chain, don't parallelise. markOnboardingStep on the server does a
      // read-modify-write that isn't atomic across Worker invocations,
      // firing these in parallel means the later write overwrites the
      // earlier one, so welcome.completed_at gets wiped by
      // checklist.watched_welcome and the welcome re-opens on next login.
      markStep('welcome.completed_at', new Date().toISOString())
        .then(function () { return markStep('checklist.watched_welcome'); })
        .then(function () { _refreshChecklist(); });
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
      _closeWelcome(true);
    });

    document.addEventListener('keydown', function (ev) {
      if (!_overlayEl || !_overlayEl.classList.contains('show')) return;
      if (ev.key === 'Escape') { _closeWelcome(true); ev.preventDefault(); }
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

  /* Scene 1, "You built an agent."
   *
   * A single hero composition: the Advocate mark, large and centered, with
   * concentric ripple circles expanding outward. No cartoon storefront.
   * Subtle radial glow behind the mark. Feels like a product launch still.
   *
   * Shared design language across scenes:
   *   - One accent color (burgundy). No oranges, teals, greys.
   *   - Radial gradient background: glow at center, fading to surface.
   *   - Cubic-bezier(0.22, 1, 0.36, 1) for entries (out-quint, smooth
   *     deceleration, no bounce).
   *   - Drop shadows via feGaussianBlur + feOffset instead of fake offset
   *     rectangles.
   */
  function _scene1() {
    return '<div class="amcp-welcome-scene active">' +
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360" style="width:100%;height:100%;display:block" aria-hidden="true">' +
      '<defs>' +
        '<radialGradient id="s1-bg" cx="50%" cy="50%" r="55%">' +
          '<stop offset="0%"  stop-color="#3d0a22" stop-opacity=".55"/>' +
          '<stop offset="60%" stop-color="#140a0c" stop-opacity=".3"/>' +
          '<stop offset="100%" stop-color="#050202" stop-opacity="0"/>' +
        '</radialGradient>' +
        '<linearGradient id="s1-shield" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0%"  stop-color="#5c1532"/>' +
          '<stop offset="100%" stop-color="#3d0a22"/>' +
        '</linearGradient>' +
        '<filter id="s1-shadow" x="-30%" y="-30%" width="160%" height="160%">' +
          '<feGaussianBlur in="SourceAlpha" stdDeviation="6"/>' +
          '<feOffset dx="0" dy="8" result="o"/>' +
          '<feComponentTransfer><feFuncA type="linear" slope=".45"/></feComponentTransfer>' +
          '<feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>' +
        '</filter>' +
        '<style>' +
          '@keyframes s1-rise{from{opacity:0;transform:translateY(12px) scale(.96)}to{opacity:1;transform:translateY(0) scale(1)}}' +
          '@keyframes s1-ripple{0%{opacity:.7;transform:scale(.4)}100%{opacity:0;transform:scale(2.4)}}' +
          '@keyframes s1-line{from{stroke-dashoffset:160}to{stroke-dashoffset:0}}' +
          '@keyframes s1-fade{from{opacity:0}to{opacity:1}}' +
          '.s1-mark{animation:s1-rise .9s cubic-bezier(.22,1,.36,1) .15s both;transform-origin:center;transform-box:fill-box}' +
          '.s1-r1{animation:s1-ripple 2.6s cubic-bezier(.4,0,.2,1) .4s infinite;transform-origin:center;transform-box:fill-box}' +
          '.s1-r2{animation:s1-ripple 2.6s cubic-bezier(.4,0,.2,1) 1.25s infinite;transform-origin:center;transform-box:fill-box}' +
          '.s1-lbl{animation:s1-rise .7s cubic-bezier(.22,1,.36,1) .55s both;transform-origin:center;transform-box:fill-box}' +
          '.s1-rule{stroke-dasharray:160;stroke-dashoffset:160;animation:s1-line 1s cubic-bezier(.22,1,.36,1) .75s both}' +
          '.s1-caption{animation:s1-fade .6s ease .95s both}' +
        '</style>' +
      '</defs>' +

      '<rect width="640" height="360" fill="#050202"/>' +
      '<rect width="640" height="360" fill="url(#s1-bg)"/>' +

      /* Ripples */
      '<circle class="s1-r1" cx="320" cy="180" r="54" fill="none" stroke="#5c1532" stroke-width="1" stroke-opacity=".35"/>' +
      '<circle class="s1-r2" cx="320" cy="180" r="54" fill="none" stroke="#5c1532" stroke-width="1" stroke-opacity=".35"/>' +

      /* Hero mark */
      '<g class="s1-mark" filter="url(#s1-shadow)">' +
        /* shield silhouette */
        '<path d="M260,120 L380,120 L380,204 Q380,230 320,256 Q260,230 260,204 Z" fill="url(#s1-shield)"/>' +
        '<path d="M260,120 L380,120 L380,204 Q380,230 320,256 Q260,230 260,204 Z" fill="none" stroke="#7a1c40" stroke-width="1"/>' +
        /* serif A */
        '<text x="320" y="200" text-anchor="middle" font-size="74" font-weight="400" fill="#f5ebed" font-family="\'Instrument Serif\',Georgia,serif">A</text>' +
      '</g>' +

      /* Horizontal rule under mark */
      '<line class="s1-rule" x1="240" y1="286" x2="400" y2="286" stroke="#5c1532" stroke-width="1" stroke-opacity=".7"/>' +

      /* Caption */
      '<g class="s1-caption">' +
        '<text x="320" y="308" text-anchor="middle" font-size="11" font-weight="600" fill="#5c1532" letter-spacing="3" font-family="\'General Sans\',system-ui,sans-serif">ADVOCATE</text>' +
        '<text x="320" y="330" text-anchor="middle" font-size="12" fill="#8a7c78" font-family="\'General Sans\',system-ui,sans-serif">Your AI-facing agent, live.</text>' +
      '</g>' +

      '</svg>' +
    '</div>';
  }

  /* Scene 2, "AI assistants ask about your business."
   *
   * Left column: three name pills (just a coloured dot + service name). The
   * hand-drawn swirl/asterisk/atom marks are gone, the pills read instantly
   * as "AI platforms" without pretending to be real brand logos.
   *
   * Right: the Advocate shield again (same lockup as scene 1, smaller).
   *
   * Between them: three soft, solid-stroke Bézier curves with a gradient
   * that fades darker → brighter toward the shield. No dashed animation.
   * Each curve draws in with stroke-dashoffset after its pill settles.
   */
  function _scene2() {
    return '<div class="amcp-welcome-scene">' +
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360" style="width:100%;height:100%;display:block" aria-hidden="true">' +
      '<defs>' +
        '<radialGradient id="s2-bg" cx="75%" cy="50%" r="55%">' +
          '<stop offset="0%"  stop-color="#3d0a22" stop-opacity=".45"/>' +
          '<stop offset="70%" stop-color="#140a0c" stop-opacity=".2"/>' +
          '<stop offset="100%" stop-color="#050202" stop-opacity="0"/>' +
        '</radialGradient>' +
        '<linearGradient id="s2-wire" x1="0" y1="0" x2="1" y2="0">' +
          '<stop offset="0%"  stop-color="#2a0811" stop-opacity=".2"/>' +
          '<stop offset="100%" stop-color="#7a1c40" stop-opacity=".9"/>' +
        '</linearGradient>' +
        '<linearGradient id="s2-shield" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0%"  stop-color="#5c1532"/>' +
          '<stop offset="100%" stop-color="#3d0a22"/>' +
        '</linearGradient>' +
        '<filter id="s2-shadow" x="-30%" y="-30%" width="160%" height="160%">' +
          '<feGaussianBlur in="SourceAlpha" stdDeviation="5"/>' +
          '<feOffset dx="0" dy="6"/>' +
          '<feComponentTransfer><feFuncA type="linear" slope=".4"/></feComponentTransfer>' +
          '<feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>' +
        '</filter>' +
        '<style>' +
          '@keyframes s2-pill{from{opacity:0;transform:translateX(-18px)}to{opacity:1;transform:translateX(0)}}' +
          '@keyframes s2-draw{to{stroke-dashoffset:0}}' +
          '@keyframes s2-shield-in{from{opacity:0;transform:scale(.92)}to{opacity:1;transform:scale(1)}}' +
          '.s2-p{animation:s2-pill .65s cubic-bezier(.22,1,.36,1) both}' +
          '.s2-p1{animation-delay:.1s}' +
          '.s2-p2{animation-delay:.22s}' +
          '.s2-p3{animation-delay:.34s}' +
          '.s2-wire{stroke-dasharray:320;stroke-dashoffset:320;animation:s2-draw .8s cubic-bezier(.22,1,.36,1) both}' +
          '.s2-w1{animation-delay:.5s}' +
          '.s2-w2{animation-delay:.62s}' +
          '.s2-w3{animation-delay:.74s}' +
          '.s2-shield-grp{animation:s2-shield-in .7s cubic-bezier(.22,1,.36,1) .9s both;transform-origin:center;transform-box:fill-box}' +
        '</style>' +
      '</defs>' +

      '<rect width="640" height="360" fill="#050202"/>' +
      '<rect width="640" height="360" fill="url(#s2-bg)"/>' +

      /* Three name pills, dot + label */
      '<g transform="translate(60,96)">' +
        '<g class="s2-p s2-p1">' +
          '<rect x="0" y="0" width="178" height="42" rx="21" fill="#140a0c" stroke="#2a1418" stroke-width="1"/>' +
          '<circle cx="22" cy="21" r="5" fill="#5c1532"/>' +
          '<text x="40" y="26" font-size="14" font-weight="500" fill="#e8e3e0" font-family="\'General Sans\',system-ui,sans-serif">ChatGPT</text>' +
        '</g>' +
      '</g>' +
      '<g transform="translate(60,158)">' +
        '<g class="s2-p s2-p2">' +
          '<rect x="0" y="0" width="178" height="42" rx="21" fill="#140a0c" stroke="#2a1418" stroke-width="1"/>' +
          '<circle cx="22" cy="21" r="5" fill="#5c1532"/>' +
          '<text x="40" y="26" font-size="14" font-weight="500" fill="#e8e3e0" font-family="\'General Sans\',system-ui,sans-serif">Claude</text>' +
        '</g>' +
      '</g>' +
      '<g transform="translate(60,220)">' +
        '<g class="s2-p s2-p3">' +
          '<rect x="0" y="0" width="178" height="42" rx="21" fill="#140a0c" stroke="#2a1418" stroke-width="1"/>' +
          '<circle cx="22" cy="21" r="5" fill="#5c1532"/>' +
          '<text x="40" y="26" font-size="14" font-weight="500" fill="#e8e3e0" font-family="\'General Sans\',system-ui,sans-serif">Perplexity</text>' +
        '</g>' +
      '</g>' +

      /* Connecting curves, solid stroke with gradient */
      '<path class="s2-wire s2-w1" d="M238,117 C 340,117 380,168 478,180" fill="none" stroke="url(#s2-wire)" stroke-width="1.5"/>' +
      '<path class="s2-wire s2-w2" d="M238,179 C 340,179 380,180 478,180" fill="none" stroke="url(#s2-wire)" stroke-width="1.5"/>' +
      '<path class="s2-wire s2-w3" d="M238,241 C 340,241 380,192 478,180" fill="none" stroke="url(#s2-wire)" stroke-width="1.5"/>' +

      /* Advocate mark */
      '<g class="s2-shield-grp" transform="translate(478,120)">' +
        '<g filter="url(#s2-shadow)">' +
          '<path d="M0,0 L120,0 L120,86 Q120,114 60,138 Q0,114 0,86 Z" fill="url(#s2-shield)"/>' +
          '<path d="M0,0 L120,0 L120,86 Q120,114 60,138 Q0,114 0,86 Z" fill="none" stroke="#7a1c40" stroke-width="1"/>' +
          '<text x="60" y="82" text-anchor="middle" font-size="54" font-weight="400" fill="#f5ebed" font-family="\'Instrument Serif\',Georgia,serif">A</text>' +
        '</g>' +
        '<text x="60" y="168" text-anchor="middle" font-size="10" font-weight="600" fill="#5c1532" letter-spacing="3" font-family="\'General Sans\',system-ui,sans-serif">ADVOCATE</text>' +
      '</g>' +

      '</svg>' +
    '</div>';
  }

  /* Scene 3, "Three steps to go live."
   *
   * Three horizontal cards, side by side. Each card: a large serif number
   * (01 / 02 / 03), a thin divider, a bold title, a short description.
   * Cards cascade in from below with a smooth deceleration; no pop, no
   * bounce. Checkmarks were too juvenile, the numbers carry the order.
   */
  function _scene3() {
    return '<div class="amcp-welcome-scene">' +
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360" style="width:100%;height:100%;display:block" aria-hidden="true">' +
      '<defs>' +
        '<radialGradient id="s3-bg" cx="50%" cy="50%" r="60%">' +
          '<stop offset="0%"  stop-color="#3d0a22" stop-opacity=".35"/>' +
          '<stop offset="80%" stop-color="#140a0c" stop-opacity=".15"/>' +
          '<stop offset="100%" stop-color="#050202" stop-opacity="0"/>' +
        '</radialGradient>' +
        '<linearGradient id="s3-card" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0%"  stop-color="#170c10"/>' +
          '<stop offset="100%" stop-color="#0d0507"/>' +
        '</linearGradient>' +
        '<filter id="s3-shadow" x="-20%" y="-20%" width="140%" height="140%">' +
          '<feGaussianBlur in="SourceAlpha" stdDeviation="4"/>' +
          '<feOffset dx="0" dy="4"/>' +
          '<feComponentTransfer><feFuncA type="linear" slope=".35"/></feComponentTransfer>' +
          '<feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>' +
        '</filter>' +
        '<style>' +
          '@keyframes s3-rise{from{opacity:0;transform:translateY(22px)}to{opacity:1;transform:translateY(0)}}' +
          '.s3-card{animation:s3-rise .8s cubic-bezier(.22,1,.36,1) both;transform-origin:center;transform-box:fill-box}' +
          '.s3-c1{animation-delay:.12s}' +
          '.s3-c2{animation-delay:.28s}' +
          '.s3-c3{animation-delay:.44s}' +
        '</style>' +
      '</defs>' +

      '<rect width="640" height="360" fill="#050202"/>' +
      '<rect width="640" height="360" fill="url(#s3-bg)"/>' +

      /* Card 1 */
      '<g class="s3-card s3-c1" transform="translate(52,76)" filter="url(#s3-shadow)">' +
        '<rect x="0" y="0" width="168" height="208" rx="10" fill="url(#s3-card)" stroke="#2a1418" stroke-width="1"/>' +
        '<text x="20" y="70" font-size="44" font-weight="400" fill="#5c1532" font-family="\'Instrument Serif\',Georgia,serif">01</text>' +
        '<line x1="20" y1="92" x2="60" y2="92" stroke="#5c1532" stroke-width="1"/>' +
        '<text x="20" y="128" font-size="16" font-weight="600" fill="#e8e3e0" font-family="\'General Sans\',system-ui,sans-serif">Wire up DNS</text>' +
        '<text x="20" y="158" font-size="12" fill="#8a7c78" font-family="\'General Sans\',system-ui,sans-serif"><tspan x="20" dy="0">Point your domain at</tspan><tspan x="20" dy="16">Advocate. One CNAME.</tspan></text>' +
      '</g>' +

      /* Card 2 */
      '<g class="s3-card s3-c2" transform="translate(236,76)" filter="url(#s3-shadow)">' +
        '<rect x="0" y="0" width="168" height="208" rx="10" fill="url(#s3-card)" stroke="#2a1418" stroke-width="1"/>' +
        '<text x="20" y="70" font-size="44" font-weight="400" fill="#5c1532" font-family="\'Instrument Serif\',Georgia,serif">02</text>' +
        '<line x1="20" y1="92" x2="60" y2="92" stroke="#5c1532" stroke-width="1"/>' +
        '<text x="20" y="128" font-size="16" font-weight="600" fill="#e8e3e0" font-family="\'General Sans\',system-ui,sans-serif">Agent responds</text>' +
        '<text x="20" y="158" font-size="12" fill="#8a7c78" font-family="\'General Sans\',system-ui,sans-serif"><tspan x="20" dy="0">Crawlers get canonical</tspan><tspan x="20" dy="16">answers, from you.</tspan></text>' +
      '</g>' +

      /* Card 3 */
      '<g class="s3-card s3-c3" transform="translate(420,76)" filter="url(#s3-shadow)">' +
        '<rect x="0" y="0" width="168" height="208" rx="10" fill="url(#s3-card)" stroke="#2a1418" stroke-width="1"/>' +
        '<text x="20" y="70" font-size="44" font-weight="400" fill="#5c1532" font-family="\'Instrument Serif\',Georgia,serif">03</text>' +
        '<line x1="20" y1="92" x2="60" y2="92" stroke="#5c1532" stroke-width="1"/>' +
        '<text x="20" y="128" font-size="16" font-weight="600" fill="#e8e3e0" font-family="\'General Sans\',system-ui,sans-serif">Traffic arrives</text>' +
        '<text x="20" y="158" font-size="12" fill="#8a7c78" font-family="\'General Sans\',system-ui,sans-serif"><tspan x="20" dy="0">Watch bot hits + AI</tspan><tspan x="20" dy="16">referrals in the dashboard.</tspan></text>' +
      '</g>' +

      '</svg>' +
    '</div>';
  }

  /* Scene 4, "Your dashboard, explained."
   *
   * A single refined browser mock, centered, with real drop shadow via SVG
   * filter. Two labels (not three), fewer is cleaner. Label lines are thin
   * solid strokes, not busy dashes. Chart line is a smooth spline.
   */
  function _scene4() {
    return '<div class="amcp-welcome-scene">' +
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360" style="width:100%;height:100%;display:block" aria-hidden="true">' +
      '<defs>' +
        '<radialGradient id="s4-bg" cx="50%" cy="50%" r="60%">' +
          '<stop offset="0%"  stop-color="#3d0a22" stop-opacity=".3"/>' +
          '<stop offset="80%" stop-color="#140a0c" stop-opacity=".15"/>' +
          '<stop offset="100%" stop-color="#050202" stop-opacity="0"/>' +
        '</radialGradient>' +
        '<linearGradient id="s4-win" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0%"  stop-color="#170c10"/>' +
          '<stop offset="100%" stop-color="#0d0507"/>' +
        '</linearGradient>' +
        '<linearGradient id="s4-spark" x1="0" y1="0" x2="1" y2="0">' +
          '<stop offset="0%"  stop-color="#3d0a22"/>' +
          '<stop offset="100%" stop-color="#7a1c40"/>' +
        '</linearGradient>' +
        '<filter id="s4-shadow" x="-15%" y="-15%" width="130%" height="130%">' +
          '<feGaussianBlur in="SourceAlpha" stdDeviation="8"/>' +
          '<feOffset dx="0" dy="12"/>' +
          '<feComponentTransfer><feFuncA type="linear" slope=".5"/></feComponentTransfer>' +
          '<feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>' +
        '</filter>' +
        '<style>' +
          '@keyframes s4-rise{from{opacity:0;transform:translateY(16px) scale(.98)}to{opacity:1;transform:translateY(0) scale(1)}}' +
          '@keyframes s4-fade{from{opacity:0}to{opacity:1}}' +
          '@keyframes s4-draw{to{stroke-dashoffset:0}}' +
          '.s4-win{animation:s4-rise .9s cubic-bezier(.22,1,.36,1) .1s both;transform-origin:center;transform-box:fill-box}' +
          '.s4-spark{stroke-dasharray:360;stroke-dashoffset:360;animation:s4-draw 1.4s cubic-bezier(.22,1,.36,1) .7s both}' +
          '.s4-lbl{animation:s4-fade .5s ease both}' +
          '.s4-lbl-line{stroke-dasharray:80;stroke-dashoffset:80;animation:s4-draw .55s cubic-bezier(.22,1,.36,1) both}' +
          '.s4-lbl1,.s4-lbl1-line{animation-delay:1s}' +
          '.s4-lbl2,.s4-lbl2-line{animation-delay:1.4s}' +
        '</style>' +
      '</defs>' +

      '<rect width="640" height="360" fill="#050202"/>' +
      '<rect width="640" height="360" fill="url(#s4-bg)"/>' +

      /* Browser window */
      '<g class="s4-win" filter="url(#s4-shadow)">' +
        /* body */
        '<rect x="130" y="60" width="380" height="240" rx="10" fill="url(#s4-win)" stroke="#2a1418" stroke-width="1"/>' +
        /* chrome */
        '<rect x="130" y="60" width="380" height="28" rx="10" fill="#0a0405"/>' +
        '<rect x="130" y="80" width="380" height="8" fill="#0a0405"/>' +
        '<circle cx="146" cy="74" r="3.5" fill="#2a1418"/>' +
        '<circle cx="158" cy="74" r="3.5" fill="#2a1418"/>' +
        '<circle cx="170" cy="74" r="3.5" fill="#2a1418"/>' +
        /* sidebar */
        '<rect x="130" y="88" width="92" height="212" fill="#080305" stroke="#2a1418" stroke-width=".5"/>' +
        '<rect x="144" y="104" width="64" height="8" rx="2" fill="#5c1532"/>' +
        '<rect x="142" y="126" width="68" height="14" rx="3" fill="#2a0811" stroke="#3d0a22" stroke-width=".5"/>' +
        '<rect x="148" y="150" width="44" height="6" rx="2" fill="#2a1418"/>' +
        '<rect x="148" y="168" width="52" height="6" rx="2" fill="#2a1418"/>' +
        '<rect x="148" y="186" width="36" height="6" rx="2" fill="#2a1418"/>' +
        '<rect x="148" y="204" width="48" height="6" rx="2" fill="#2a1418"/>' +
        /* KPI cards */
        '<rect x="240" y="110" width="78" height="54" rx="4" fill="#0d0507" stroke="#2a1418" stroke-width=".5"/>' +
        '<rect x="250" y="118" width="32" height="4" rx="1.5" fill="#8a7c78" opacity=".45"/>' +
        '<text x="250" y="152" font-size="18" font-weight="600" fill="#f5ebed" font-family="\'Instrument Serif\',Georgia,serif">1.4k</text>' +
        '<rect x="330" y="110" width="78" height="54" rx="4" fill="#0d0507" stroke="#2a1418" stroke-width=".5"/>' +
        '<rect x="340" y="118" width="32" height="4" rx="1.5" fill="#8a7c78" opacity=".45"/>' +
        '<text x="340" y="152" font-size="18" font-weight="600" fill="#f5ebed" font-family="\'Instrument Serif\',Georgia,serif">92</text>' +
        '<rect x="420" y="110" width="78" height="54" rx="4" fill="#0d0507" stroke="#2a1418" stroke-width=".5"/>' +
        '<rect x="430" y="118" width="32" height="4" rx="1.5" fill="#8a7c78" opacity=".45"/>' +
        '<text x="430" y="152" font-size="18" font-weight="600" fill="#f5ebed" font-family="\'Instrument Serif\',Georgia,serif">37</text>' +
        /* chart area */
        '<rect x="240" y="180" width="258" height="104" rx="4" fill="#0a0405" stroke="#2a1418" stroke-width=".5"/>' +
        /* grid */
        '<line x1="240" y1="232" x2="498" y2="232" stroke="#2a1418" stroke-width=".5"/>' +
        /* spark line (drawn) */
        '<path class="s4-spark" d="M252,264 C 280,258 294,248 320,240 C 346,232 360,226 384,216 C 408,206 422,204 448,200 C 472,196 482,190 494,188" fill="none" stroke="url(#s4-spark)" stroke-width="1.5" stroke-linecap="round"/>' +
      '</g>' +

      /* Label 1: top-right pointing to KPI card */
      '<g>' +
        '<line class="s4-lbl-line s4-lbl1-line" x1="460" y1="136" x2="560" y2="92" stroke="#5c1532" stroke-width="1"/>' +
        '<g class="s4-lbl s4-lbl1">' +
          '<text x="560" y="80" font-size="11" font-weight="600" fill="#e8e3e0" font-family="\'General Sans\',system-ui,sans-serif">Live KPIs</text>' +
          '<text x="560" y="96" font-size="10" fill="#8a7c78" font-family="\'General Sans\',system-ui,sans-serif">AI requests, referrals</text>' +
        '</g>' +
      '</g>' +

      /* Label 2: bottom pointing to chart */
      '<g>' +
        '<line class="s4-lbl-line s4-lbl2-line" x1="300" y1="250" x2="210" y2="316" stroke="#5c1532" stroke-width="1"/>' +
        '<g class="s4-lbl s4-lbl2">' +
          '<text x="210" y="332" font-size="11" font-weight="600" fill="#e8e3e0" font-family="\'General Sans\',system-ui,sans-serif">30-day trend</text>' +
          '<text x="210" y="348" font-size="10" fill="#8a7c78" font-family="\'General Sans\',system-ui,sans-serif">Who asked, who clicked</text>' +
        '</g>' +
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
    var skipBtn = document.getElementById('amcp-onb-skip-all');
    if (skipBtn) {
      skipBtn.addEventListener('click', _skipAll);
    }
    _refreshChecklist();
  }

  /* Mark every remaining checklist key as complete in series, then hide the
   * Get Started nav item and route the user to Overview. The server computes
   * allDone after each step and stamps onboarded_at on the final one, which
   * keeps the nav hidden on future logins. Triggered by the "Skip" button. */
  function _skipAll() {
    // DNS is the one step that materially matters, without it, AI
    // crawlers can't reach the tenant's agent. Never let skip bypass it.
    var dnsPending = checklistKeys().indexOf('dns_configured') !== -1 && !isStepDone('dns_configured');

    var confirmMsg = dnsPending
      ? 'Skip the tour? Your DNS is not wired up yet, so the Get Started checklist will stay visible until DNS is configured. The other steps will be marked complete.\n\nContinue?'
      : 'Skip the Get Started checklist?\n\nYou can restart it any time from Settings \u2192 Tutorial.';
    if (!confirm(confirmMsg)) return;

    var skipBtn = document.getElementById('amcp-onb-skip-all');
    if (skipBtn) { skipBtn.disabled = true; skipBtn.textContent = 'Skipping\u2026'; }

    // Skip marks every UNCHECKED required key except DNS. If DNS is pending,
    // onboarded_at won't be stamped (isOnboardingComplete returns false),
    // so the Get Started nav stays until the user wires DNS up.
    var keys = checklistKeys().filter(function (k) {
      if (k === 'dns_configured') return false;
      return !isStepDone(k);
    });
    var chain = Promise.resolve();
    keys.forEach(function (k) {
      chain = chain.then(function () { return markStep('checklist.' + k); });
    });
    chain
      .then(function () {
        _refreshChecklist();
        if (!dnsPending) {
          var navItem = document.querySelector('[data-onboarding-nav]');
          if (navItem) navItem.style.display = 'none';
          if (window.AMCP_UI && window.AMCP_UI.toast) {
            window.AMCP_UI.toast('Onboarding skipped \u2014 restart any time from Settings.', 'success');
          }
          var overview = document.querySelector('[data-section="overview"]');
          if (overview) overview.click();
        } else {
          if (window.AMCP_UI && window.AMCP_UI.toast) {
            window.AMCP_UI.toast('Other steps marked done. Wire up DNS to finish onboarding.', 'info');
          }
          if (skipBtn) { skipBtn.disabled = true; skipBtn.textContent = 'Only DNS remaining'; }
        }
      })
      .catch(function () {
        if (skipBtn) { skipBtn.disabled = false; skipBtn.textContent = 'Skip \u2014 I\u2019ll explore on my own'; }
        if (window.AMCP_UI && window.AMCP_UI.toast) {
          window.AMCP_UI.toast('Skip failed \u2014 please try again.', 'error');
        }
      });
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
          '<div class="amcp-onb-intro-copy">Most customers are live in under 10 minutes. Pick up where you left off, progress saves automatically.</div>' +
        '</div>' +
      '</div>' +
      '<div class="amcp-onb-progress"><div class="amcp-onb-progress-fill" id="amcp-onb-progress-fill"></div></div>' +
      '<div class="amcp-onb-list" id="amcp-onb-list"></div>' +
      '<div style="display:flex;justify-content:flex-end;margin-top:16px">' +
        '<button type="button" class="btn-sm btn-ghost" id="amcp-onb-skip-all">' +
          'Skip, I\u2019ll explore on my own' +
        '</button>' +
      '</div>'
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
          window.AMCP_UI && window.AMCP_UI.toast && window.AMCP_UI.toast('DNS wizard not available, reload the page.', 'error');
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

  /* Mock voice preview, pulls business_name out of AMCP_DATA and shows a
   * representative sample answer in the drawer. No API call; this is a tour
   * stop, not a live render. Marking it complete unblocks the checklist. */
  function _openVoicePreview() {
    var name   = (window.AMCP_DATA && window.AMCP_DATA.business_name) || 'your business';
    var sample =
      'Sure, ' + name + ' is a local business you can reach directly. ' +
      'They\u2019re open most weekdays and handle inquiries through their booking page. ' +
      'For pricing, hours, or to schedule, tap through to their site.';
    var html =
      '<div class="amcp-dns-step">' +
        '<p class="amcp-dns-step-copy">' +
          'Here\u2019s roughly what your agent returns when ChatGPT or Perplexity asks about your business. ' +
          'Your profile data (hours, services, pricing, credentials) shapes the tone, tune it in Settings.' +
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
      copy:     'Your 30-day snapshot, AI requests, referral clicks, bot activity. This is the first thing to check each week.',
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
      copy:     'Weekly polls against Perplexity + OpenAI. See your Share of Model, when an AI recommends someone in your category, how often is it you?',
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
      if (ev.key === 'Escape') { _endTour(true); ev.preventDefault(); }
    };
    document.addEventListener('keydown', _tourKeyHandler);
    _gotoTourStop(0);
  }

  function _buildTourBackdrop() {
    var b = document.createElement('div');
    b.className = 'amcp-tour-backdrop';
    b.addEventListener('click', function () { _endTour(true); });
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
    c.querySelector('#amcp-tour-skip').addEventListener('click', function () { _endTour(true); });
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
      // Chain to avoid the same race-wipe pattern as _closeWelcome.
      markStep('tour.completed_at', new Date().toISOString())
        .then(function () { return markStep('checklist.took_tour'); })
        .then(function () { _refreshChecklist(); });
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
    refreshChecklist:     _refreshChecklist,
  };

})();
