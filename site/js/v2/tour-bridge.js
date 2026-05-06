/* v2 Tour Bridge — welcome modal + spotlight walkthrough on /app.html.
 *
 * Phase 5 of the design rollout (per
 * ~/.claude/plans/for-a-is-there-unified-emerson.md): keep the legacy
 * `AMCP_ONBOARDING` state machine (markStep chaining, _skipAll DNS
 * gate, onboarded_at server write, race-free merge semantics) and
 * replace ONLY the visual renderer.
 *
 * Why a fresh module instead of reusing Max's site/assets/dashboard-tour.js:
 * that file is tightly coupled to ~16 DOM elements pre-baked into
 * Dashboard.html (spot-overlay, spot-tooltip, welcome modal, etc.).
 * The v2 dashboard mounts dynamically via shell.js, so we inject our
 * own minimal overlay + tooltip + modal lazily on first start(). This
 * keeps app.html lean (no static tour markup) and lets the chrome
 * persist across the SPA router's #page-content swap.
 *
 * Public API:
 *   window.AMCP_TOUR.start()           — kick the tour explicitly
 *   window.AMCP_TOUR.maybeAutoStart()  — show welcome modal on first login
 *
 * Triggered:
 *   - AMCP_TOUR.maybeAutoStart() — called once after the overview's
 *     afterMount completes; the welcome modal appears only when
 *     AMCP_ONBOARDING.isFirstLogin() returns true (i.e. fresh signup
 *     who has never dismissed the welcome).
 *   - "Replay the tutorial" footer link on Overview.
 *   - Settings → Tutorial → "Restart tour" button.
 *   - FAB → "Help" menu (when wired). */

(function () {
  'use strict';

  // Tour steps anchored to v2 selectors. Selectors come straight from
  // overview.js's HTML output and the shell's chrome layout. If you
  // change overview.js (e.g. rename data-tour values), update here too —
  // a missing selector silently skips the step rather than breaking
  // the tour.
  const STEPS = [
    {
      sels:  ['.sidebar', '.sb-nav'],
      title: 'Your dashboard',
      body:  'Every section lives in the sidebar — Overview, Mentions, Click-throughs, Competitor Radar, AI bookings, Activity feed.',
    },
    {
      sels:  ['[data-tour="kpis"], .row.kpi-row, .row.kpis, .row:nth-of-type(1)'],
      title: 'Your three headline numbers',
      body:  '<strong>Mentions</strong> is how many times AI brought you up. <strong>Click-throughs</strong> is how many people then visited your site. <strong>Reservations</strong> is bookings agents made on your behalf.',
    },
    {
      sels:  ['[data-tour="mentions"]'],
      title: 'Which AI tools are talking about you',
      body:  'The chart shows daily mentions across every AI tool. The list on the right breaks it down by crawler.',
    },
    {
      sels:  ['[data-tour="mentions-table"]'],
      title: 'Every mention, explained',
      body:  'Each row is one time AI cited your business. The last column shows what the visitor did next.',
    },
    {
      sels:  ['[data-tour="revenue"]'],
      title: 'The A2A funnel',
      body:  'Agents are calling your tools to book, quote, and hand off real work. This card tracks the funnel from agent calls → confirmed transactions.',
    },
    {
      sels:  ['#fab-btn, .fab, [data-tour="fab"]'],
      title: 'Need help?',
      body:  'Tap the “?” button anytime to replay this tour, see what a number means, or contact support.',
    },
  ];

  let _injected   = false;
  let _idx        = 0;
  let _active     = false;
  let _scrollLock = '';

  // Lazily inject overlay + tooltip + welcome modal markup. Done once
  // per page load (the SPA router doesn't reload app.html so this runs
  // once on a real session), bypassed entirely if the user never
  // triggers the tour.
  function injectMarkup() {
    if (_injected) return;
    _injected = true;
    const wrapper = document.createElement('div');
    wrapper.id = 'amcp-tour-root';
    wrapper.innerHTML = `
      <div id="amcp-tour-mask" aria-hidden="true">
        <div id="amcp-tour-cut"></div>
      </div>

      <div id="amcp-tour-tooltip" role="dialog" aria-modal="true" aria-labelledby="amcp-tour-title">
        <div class="amcp-tour-count" id="amcp-tour-count"></div>
        <div class="amcp-tour-title" id="amcp-tour-title"></div>
        <div class="amcp-tour-body" id="amcp-tour-body"></div>
        <div class="amcp-tour-foot">
          <button type="button" class="amcp-tour-skip" id="amcp-tour-skip">Skip</button>
          <div class="amcp-tour-dots" id="amcp-tour-dots" aria-hidden="true"></div>
          <div class="amcp-tour-nav">
            <button type="button" class="amcp-tour-back" id="amcp-tour-back">Back</button>
            <button type="button" class="amcp-tour-next" id="amcp-tour-next">Next →</button>
          </div>
        </div>
      </div>

      <div id="amcp-tour-welcome" role="dialog" aria-modal="true" aria-labelledby="amcp-tour-welcome-title">
        <div class="amcp-tour-welcome-card">
          <div class="amcp-tour-welcome-eyebrow">Welcome to Advocate</div>
          <h2 id="amcp-tour-welcome-title">Let's show you around.</h2>
          <p>A 90-second walkthrough of every section. You can replay it anytime from the help menu.</p>
          <div class="amcp-tour-welcome-actions">
            <button type="button" class="amcp-tour-welcome-skip" id="amcp-tour-welcome-skip">Maybe later</button>
            <button type="button" class="amcp-tour-welcome-start" id="amcp-tour-welcome-start">Take the tour →</button>
          </div>
        </div>
      </div>

      <style>
        #amcp-tour-mask {
          position: fixed; inset: 0; z-index: 9998; display: none;
          background: rgba(20, 18, 16, 0.55); pointer-events: auto;
        }
        #amcp-tour-mask.active { display: block; }
        #amcp-tour-cut {
          position: absolute; border-radius: 12px;
          box-shadow:
            0 0 0 4px rgba(125, 37, 80, 0.45),
            0 0 0 9999px rgba(20, 18, 16, 0.55);
          background: transparent; pointer-events: none;
          transition: top .25s, left .25s, width .25s, height .25s;
        }
        #amcp-tour-tooltip {
          position: fixed; z-index: 9999; display: none;
          width: 340px; max-width: calc(100vw - 40px);
          padding: 18px 20px 16px; border-radius: 12px;
          background: var(--paper, #fbf9f5); color: var(--ink, #1a1715);
          border: 1px solid var(--line, #e6dfd5);
          box-shadow: 0 18px 40px rgba(20, 18, 16, 0.18), 0 4px 12px rgba(20, 18, 16, 0.08);
          font-family: "General Sans", system-ui, -apple-system, sans-serif;
        }
        #amcp-tour-tooltip.active { display: block; }
        #amcp-tour-tooltip .amcp-tour-count {
          font-size: 11.5px; letter-spacing: 0.06em; text-transform: uppercase;
          color: var(--maroon, #7d2550); font-weight: 600; margin-bottom: 8px;
        }
        #amcp-tour-tooltip .amcp-tour-title {
          font-family: "Instrument Serif", serif; font-size: 22px; line-height: 1.2;
          color: var(--ink, #1a1715); margin: 0 0 8px;
        }
        #amcp-tour-tooltip .amcp-tour-body {
          font-size: 13.5px; line-height: 1.5; color: var(--ink-2, #46403a);
        }
        #amcp-tour-tooltip .amcp-tour-body strong { color: var(--ink, #1a1715); font-weight: 600; }
        #amcp-tour-tooltip .amcp-tour-foot {
          display: flex; align-items: center; justify-content: space-between;
          margin-top: 16px; gap: 12px;
        }
        #amcp-tour-tooltip .amcp-tour-skip {
          background: transparent; border: 0; color: var(--muted, #8a7c78);
          font-size: 12.5px; cursor: pointer; padding: 4px 0;
        }
        #amcp-tour-tooltip .amcp-tour-skip:hover { color: var(--ink-2, #46403a); }
        #amcp-tour-tooltip .amcp-tour-dots { display: flex; gap: 5px; }
        #amcp-tour-tooltip .amcp-tour-dots span {
          width: 6px; height: 6px; border-radius: 999px; background: var(--line, #e6dfd5);
        }
        #amcp-tour-tooltip .amcp-tour-dots span.active { background: var(--maroon, #7d2550); }
        #amcp-tour-tooltip .amcp-tour-nav { display: flex; gap: 8px; }
        #amcp-tour-tooltip .amcp-tour-back,
        #amcp-tour-tooltip .amcp-tour-next {
          font-size: 12.5px; padding: 6px 12px; border-radius: 6px;
          border: 1px solid var(--line, #e6dfd5); background: var(--paper, #fbf9f5);
          color: var(--ink, #1a1715); cursor: pointer; font-weight: 500;
        }
        #amcp-tour-tooltip .amcp-tour-next {
          background: var(--maroon, #7d2550); color: #fff; border-color: var(--maroon, #7d2550);
        }
        #amcp-tour-tooltip .amcp-tour-back:disabled { opacity: 0.4; cursor: not-allowed; }
        #amcp-tour-welcome {
          position: fixed; inset: 0; z-index: 9997; display: none;
          background: rgba(20, 18, 16, 0.65);
          align-items: center; justify-content: center; padding: 20px;
        }
        #amcp-tour-welcome.active { display: flex; }
        #amcp-tour-welcome .amcp-tour-welcome-card {
          background: var(--paper, #fbf9f5); border: 1px solid var(--line, #e6dfd5);
          border-radius: 14px; padding: 32px; max-width: 460px; width: 100%;
          box-shadow: 0 24px 60px rgba(20, 18, 16, 0.3);
          font-family: "General Sans", system-ui, -apple-system, sans-serif;
        }
        .amcp-tour-welcome-eyebrow {
          font-size: 11.5px; letter-spacing: 0.08em; text-transform: uppercase;
          color: var(--maroon, #7d2550); font-weight: 600; margin-bottom: 10px;
        }
        .amcp-tour-welcome-card h2 {
          font-family: "Instrument Serif", serif; font-weight: 400;
          font-size: 28px; line-height: 1.15; color: var(--ink, #1a1715); margin: 0 0 12px;
        }
        .amcp-tour-welcome-card p {
          color: var(--ink-2, #46403a); line-height: 1.5; font-size: 14.5px; margin: 0 0 24px;
        }
        .amcp-tour-welcome-actions {
          display: flex; gap: 10px; justify-content: flex-end;
        }
        .amcp-tour-welcome-skip {
          font-size: 13.5px; padding: 10px 16px; border-radius: 8px;
          border: 1px solid var(--line, #e6dfd5); background: transparent;
          color: var(--ink-2, #46403a); cursor: pointer;
        }
        .amcp-tour-welcome-start {
          font-size: 13.5px; padding: 10px 16px; border-radius: 8px;
          background: var(--maroon, #7d2550); color: #fff; border: 0;
          cursor: pointer; font-weight: 500;
        }
        @media (prefers-color-scheme: dark) {
          #amcp-tour-tooltip { background: #1f1c19; color: #e8e3dd; border-color: #3a342e; }
          #amcp-tour-tooltip .amcp-tour-back,
          #amcp-tour-tooltip .amcp-tour-back { background: #1f1c19; border-color: #3a342e; color: #e8e3dd; }
          #amcp-tour-welcome .amcp-tour-welcome-card { background: #1f1c19; border-color: #3a342e; }
          #amcp-tour-welcome .amcp-tour-welcome-card h2 { color: #f1ece5; }
          #amcp-tour-welcome .amcp-tour-welcome-card p { color: #c5bdb3; }
          .amcp-tour-welcome-skip { color: #c5bdb3; border-color: #3a342e; }
        }
      </style>
    `;
    document.body.appendChild(wrapper);

    document.getElementById('amcp-tour-next').addEventListener('click', () => next());
    document.getElementById('amcp-tour-back').addEventListener('click', () => back());
    document.getElementById('amcp-tour-skip').addEventListener('click', () => endTour({ skipped: true }));
    document.getElementById('amcp-tour-welcome-start').addEventListener('click', () => closeWelcomeAndStart());
    document.getElementById('amcp-tour-welcome-skip').addEventListener('click', () => closeWelcome({ skipped: true }));
    window.addEventListener('resize', () => { if (_active) showStep(_idx); });
    window.addEventListener('keydown', (e) => {
      if (!_active) return;
      if (e.key === 'Escape') endTour({ skipped: true });
      if (e.key === 'ArrowRight') next();
      if (e.key === 'ArrowLeft')  back();
    });
  }

  function lockScroll() {
    if (document.body.style.overflow === 'hidden') return;
    _scrollLock = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
  }
  function unlockScroll() {
    document.body.style.overflow = _scrollLock || '';
    document.documentElement.style.overflow = '';
  }

  function findTarget(step) {
    for (const sel of step.sels) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function placeTooltip(rect) {
    const tt   = document.getElementById('amcp-tour-tooltip');
    const vw   = window.innerWidth;
    const vh   = window.innerHeight;
    const ttW  = tt.offsetWidth  || 340;
    const ttH  = tt.offsetHeight || 200;
    const gap  = 18;
    const edge = 16;
    let top, left;
    // Prefer below the target if there's room, else above, else right of, else left.
    if (vh - rect.bottom >= ttH + gap + edge) {
      top  = rect.bottom + gap;
      left = Math.max(edge, Math.min(vw - ttW - edge, rect.left + rect.width / 2 - ttW / 2));
    } else if (rect.top >= ttH + gap + edge) {
      top  = rect.top - ttH - gap;
      left = Math.max(edge, Math.min(vw - ttW - edge, rect.left + rect.width / 2 - ttW / 2));
    } else if (vw - rect.right >= ttW + gap + edge) {
      top  = Math.max(edge, Math.min(vh - ttH - edge, rect.top + rect.height / 2 - ttH / 2));
      left = rect.right + gap;
    } else {
      top  = Math.max(edge, Math.min(vh - ttH - edge, rect.top + rect.height / 2 - ttH / 2));
      left = Math.max(edge, rect.left - ttW - gap);
    }
    tt.style.top  = top + 'px';
    tt.style.left = left + 'px';
  }

  function showStep(i) {
    if (i < 0 || i >= STEPS.length) return;
    _idx = i;
    const step = STEPS[i];
    const target = findTarget(step);
    if (!target) {
      // Selector missed — skip ahead. Avoids the tour stalling on a
      // missing element (e.g. FAB hasn't mounted yet).
      if (i < STEPS.length - 1) return showStep(i + 1);
      return endTour({ skipped: true });
    }

    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setTimeout(() => {
      const rect = target.getBoundingClientRect();
      const pad  = 6;
      const cut  = document.getElementById('amcp-tour-cut');
      cut.style.top    = (rect.top    - pad) + 'px';
      cut.style.left   = (rect.left   - pad) + 'px';
      cut.style.width  = (rect.width  + pad * 2) + 'px';
      cut.style.height = (rect.height + pad * 2) + 'px';

      document.getElementById('amcp-tour-count').textContent = `Step ${i + 1} of ${STEPS.length}`;
      document.getElementById('amcp-tour-title').textContent = step.title;
      document.getElementById('amcp-tour-body').innerHTML    = step.body;
      const dots = document.getElementById('amcp-tour-dots');
      dots.innerHTML = STEPS.map((_, j) => `<span class="${j === i ? 'active' : ''}"></span>`).join('');
      const back = document.getElementById('amcp-tour-back');
      back.disabled = i === 0;
      const nx = document.getElementById('amcp-tour-next');
      nx.textContent = i === STEPS.length - 1 ? 'Finish' : 'Next →';

      placeTooltip(rect);
    }, 280);
  }

  function next() { _idx < STEPS.length - 1 ? showStep(_idx + 1) : endTour({ completed: true }); }
  function back() { if (_idx > 0) showStep(_idx - 1); }

  function start() {
    injectMarkup();
    _active = true;
    _idx    = 0;
    lockScroll();
    document.getElementById('amcp-tour-mask').classList.add('active');
    document.getElementById('amcp-tour-tooltip').classList.add('active');
    showStep(0);
  }

  function endTour(opts) {
    opts = opts || {};
    _active = false;
    unlockScroll();
    const mask = document.getElementById('amcp-tour-mask');
    const tt   = document.getElementById('amcp-tour-tooltip');
    if (mask) mask.classList.remove('active');
    if (tt)   tt.classList.remove('active');

    // Mark the took_tour step complete on completion AND on skip — we
    // want skippers to advance past this step; the welcome.completed_at
    // write below independently records that the welcome flow is done.
    const ob = window.AMCP_ONBOARDING;
    if (ob && typeof ob.markStep === 'function') {
      // Chain (don't parallelise) — apiMarkOnboardingStep on the server
      // does a read-modify-write on the same JSON column; concurrent
      // requests can clobber each other.
      ob.markStep('checklist.took_tour')
        .then(() => ob.markStep('welcome.completed_at', new Date().toISOString()))
        .then(() => {
          // If the inline Get Started panel is visible, refresh it so
          // the took_tour row flips to ✓ immediately.
          if (window.AMCP_GET_STARTED && typeof window.AMCP_GET_STARTED.update === 'function') {
            window.AMCP_GET_STARTED.update();
          }
        })
        .catch(() => { /* non-fatal */ });
    }
  }

  function closeWelcomeAndStart() {
    closeWelcome({ skipped: false });
    setTimeout(start, 250);
  }

  function closeWelcome(opts) {
    const w = document.getElementById('amcp-tour-welcome');
    if (w) w.classList.remove('active');
    if (opts && opts.skipped) {
      // Mark welcome dismissed so we don't auto-show it again on next login.
      const ob = window.AMCP_ONBOARDING;
      if (ob && typeof ob.markStep === 'function') {
        ob.markStep('welcome.completed_at', new Date().toISOString())
          .then(() => ob.markStep('checklist.watched_welcome'))
          .then(() => {
            if (window.AMCP_GET_STARTED && typeof window.AMCP_GET_STARTED.update === 'function') {
              window.AMCP_GET_STARTED.update();
            }
          })
          .catch(() => { /* non-fatal */ });
      }
    }
  }

  function showWelcome() {
    injectMarkup();
    document.getElementById('amcp-tour-welcome').classList.add('active');
  }

  function isPreviewMode() {
    try {
      return new URL(window.location.href).searchParams.get('preview') === 'onboarding';
    } catch { return false; }
  }

  // First-login auto-trigger. Called by overview.js's afterMount once
  // the page has mounted. Conditions:
  //   - Onboarding state machine reports first login (welcome not yet
  //     completed)
  //   - User is not an admin (we never auto-trigger flows for admins
  //     viewing ?as=<slug> — they're not the user being onboarded)
  // Bypassed by ?preview=onboarding so operators can preview the
  // first-login experience without switching accounts.
  function maybeAutoStart() {
    if (isPreviewMode()) {
      setTimeout(showWelcome, 600);
      return;
    }
    const ob = window.AMCP_ONBOARDING;
    if (!ob || typeof ob.isFirstLogin !== 'function') return;
    const role = (window.AMCP_DATA && window.AMCP_DATA.user_role) || null;
    if (role === 'admin') return;
    if (!ob.isFirstLogin()) return;
    setTimeout(showWelcome, 600);
  }

  // Honor `?replay=1` — the FAB on non-Overview pages redirects here
  // with that flag so users can restart the tour from anywhere.
  function checkReplayFlag() {
    try {
      const u = new URL(window.location.href);
      if (u.searchParams.get('replay') === '1') {
        u.searchParams.delete('replay');
        history.replaceState(null, '', u.pathname + (u.search || '') + (u.hash || ''));
        setTimeout(start, 600);
      }
    } catch { /* URL parse blocked — ignore */ }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', checkReplayFlag);
  } else {
    checkReplayFlag();
  }

  window.AMCP_TOUR = { start, maybeAutoStart, showWelcome };
})();
