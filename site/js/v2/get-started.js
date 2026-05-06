/* v2 Get Started — inline onboarding checklist for /app.html (Overview).
 *
 * Reuses the legacy `AMCP_ONBOARDING` state machine (state cache, server
 * sync, race-safe markStep chaining, _skipAll DNS gate) — only the
 * visual rendering is new. The state machine lives in
 * site/js/dashboard-onboarding.js and is loaded alongside this module
 * by Dashboard.html.
 *
 * Render contract:
 *   AMCP_GET_STARTED.render(container, snapshot)  → paints the panel
 *   AMCP_GET_STARTED.update()                     → refreshes after a step
 *   AMCP_GET_STARTED.shouldShow(snapshot)         → true iff onboarded_at null
 *
 * Snapshot shape matches `OnboardingSnapshot` in worker/src/portalDb.ts:
 *   { first_dashboard_at, onboarded_at, state: { welcome, checklist, tour } }
 *
 * Why a separate module instead of extending dashboard-onboarding.js:
 * the legacy dashboard renders the checklist into a sidebar section
 * with its own CSS classes (amcp-onb-list, amcp-onb-item) and dark-
 * theme tokens. v2 uses paper/ink/maroon and the card-dash visual
 * language. This module keeps v2 styling self-contained while
 * delegating all state mutation to the proven legacy handlers. */

(function () {
  'use strict';

  // Step definitions — copy mirrors CHECKLIST_DEFS in dashboard-onboarding.js
  // but drops the dark-theme bullet style + adds an explicit CTA per step.
  // If you change this object, update CHECKLIST_DEFS in dashboard-onboarding.js
  // too — both are user-visible and should agree on titles.
  const DEFS = {
    watched_welcome: {
      title: 'Watch the welcome',
      desc:  'A quick 4-slide intro to what Advocate does.',
      cta:   'Open welcome',
    },
    dns_configured: {
      title: 'Wire up your DNS',
      desc:  'Point your domain at Advocate so AI crawlers reach your agent.',
      cta:   'Open DNS wizard',
    },
    previewed_voice: {
      title: 'Preview your agent’s voice',
      desc:  'See how your agent might answer a real AI question.',
      cta:   'Preview answer',
    },
    took_tour: {
      title: 'Take the dashboard tour',
      desc:  'A 5-stop walkthrough of every section.',
      cta:   'Start tour',
    },
    simulated_bot_hit: {
      title: 'Trigger a simulated bot hit',
      desc:  'We’ll pretend to be PerplexityBot and ping your agent.',
      cta:   'Run simulation',
    },
    first_real_bot_hit: {
      title: 'See your first real bot hit',
      desc:  'Once DNS is wired up, real AI crawlers will start arriving.',
      cta:   'Check status',
    },
  };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function isHosted() {
    const d = window.AMCP_DATA || {};
    if (typeof d.is_hosted === 'boolean') return d.is_hosted;
    // Derive from hostname suffix as a fallback so this module works
    // even when shell.js hasn't (yet) populated is_hosted.
    const host = (d.domain && d.domain.hostname) || '';
    return /\.hosted\.advocatemcp\.com$/i.test(host);
  }

  function checklistKeys() {
    return isHosted()
      ? ['watched_welcome', 'previewed_voice', 'took_tour', 'simulated_bot_hit']
      : ['watched_welcome', 'dns_configured', 'previewed_voice', 'took_tour', 'first_real_bot_hit'];
  }

  function isStepDone(snapshot, key) {
    const cl = snapshot && snapshot.state && snapshot.state.checklist;
    return !!(cl && cl[key] && cl[key].completed_at);
  }

  // ?preview=onboarding bypasses the admin gate AND synthesizes an
  // empty snapshot if the server returned none. Lets the operator see
  // the panel + tour from their own admin session without switching
  // accounts. Marking steps from a preview session still no-ops on
  // the server (admin role short-circuits markStep) so this is read-
  // only previewing, not real state mutation.
  function isPreviewMode() {
    try {
      return new URL(window.location.href).searchParams.get('preview') === 'onboarding';
    } catch { return false; }
  }

  function shouldShow(snapshot) {
    if (isPreviewMode()) return true;
    if (!snapshot) return false;
    if (snapshot.onboarded_at) return false;
    // Admin impersonating: server returns a no-op state (all empty) on
    // GET so admins don't accidentally trigger writes. Hide the panel
    // for admins regardless — they're not the user being onboarded.
    const role = (window.AMCP_DATA && window.AMCP_DATA.user_role) || null;
    if (role === 'admin') return false;
    return true;
  }

  // Re-fetch the latest snapshot after a step lands so the panel
  // reflects the new state immediately. Falls through to nothing if
  // the network is down — the next page load will reconcile.
  async function refreshSnapshot() {
    const af = window.AMCP && window.AMCP.authedFetch;
    if (!af) return null;
    try {
      const r = await af('/api/client/onboarding');
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }

  let _container = null;
  let _snapshot  = null;

  function render(container, snapshot) {
    _container = container;
    // Preview mode: if the server returned no snapshot (admin endpoint),
    // synthesize an empty one so the rendering path has data to work
    // with. Production-real tenants always get a real snapshot from
    // /api/client/onboarding so this branch never fires for them.
    if (!snapshot && isPreviewMode()) {
      snapshot = { first_dashboard_at: null, onboarded_at: null, state: {} };
    }
    _snapshot  = snapshot;
    if (!container) return;
    if (!shouldShow(snapshot)) {
      container.innerHTML = '';
      container.style.display = 'none';
      return;
    }
    container.style.display = '';

    const keys  = checklistKeys();
    const done  = keys.filter((k) => isStepDone(snapshot, k)).length;
    const total = keys.length;
    const pct   = total === 0 ? 0 : Math.round((done / total) * 100);
    const name  = (window.AMCP_DATA && window.AMCP_DATA.business_name) || 'your business';

    const rows = keys.map((k) => {
      const def    = DEFS[k] || { title: k, desc: '', cta: 'Do it' };
      const isDone = isStepDone(snapshot, k);
      return `
        <div class="gs-row${isDone ? ' done' : ''}">
          <div class="gs-check" aria-hidden="true">${isDone ? '✓' : ''}</div>
          <div class="gs-text">
            <div class="gs-title">${esc(def.title)}</div>
            <div class="gs-desc">${esc(def.desc)}</div>
          </div>
          <div class="gs-action">${
            isDone
              ? '<span class="gs-done-chip">Done</span>'
              : `<button type="button" class="btn btn-ghost btn-sm" data-gs-key="${esc(k)}">${esc(def.cta)} →</button>`
          }</div>
        </div>
      `;
    }).join('');

    container.innerHTML = `
      <div class="row single">
        <div class="card-dash gs-panel">
          <div class="card-head">
            <div>
              <h3>Get started</h3>
              <div class="sub">${esc(name === 'your business' ? 'Welcome' : 'Welcome, ' + name)} — finish these steps to go live.</div>
            </div>
            <div style="display:flex;align-items:center;gap:12px">
              <span style="font-size:13px;color:var(--muted)">${done}/${total} done</span>
              <button type="button" class="btn btn-ghost btn-sm" id="gs-skip">Skip — I'll explore on my own</button>
            </div>
          </div>
          <div class="gs-progress" aria-hidden="true"><div class="gs-progress-fill" style="width:${pct}%"></div></div>
          <div class="gs-list">${rows}</div>
          <div id="gs-status" aria-live="polite" class="gs-status"></div>
        </div>
      </div>

      <style>
        .gs-panel .gs-progress {
          height: 4px; background: var(--line); border-radius: 999px;
          overflow: hidden; margin-top: 16px;
        }
        .gs-panel .gs-progress-fill {
          height: 100%; background: var(--maroon); transition: width .3s ease;
        }
        .gs-list { margin-top: 18px; display: flex; flex-direction: column; }
        .gs-row {
          display: grid; grid-template-columns: 28px 1fr auto; gap: 12px;
          align-items: center; padding: 14px 0;
          border-top: 1px solid var(--line);
        }
        .gs-row:first-child { border-top: 0; }
        .gs-check {
          width: 22px; height: 22px; border-radius: 999px;
          border: 1.5px solid var(--line); color: var(--maroon);
          display: grid; place-items: center; font-weight: 700; font-size: 13px;
          background: var(--paper);
        }
        .gs-row.done .gs-check {
          background: var(--maroon); border-color: var(--maroon); color: #fff;
        }
        .gs-row.done .gs-title { color: var(--muted); text-decoration: line-through; }
        .gs-title { font-size: 14.5px; font-weight: 500; color: var(--ink); }
        .gs-desc  { font-size: 13px;   color: var(--muted); margin-top: 2px; }
        .gs-done-chip {
          font-size: 12px; color: var(--sage); font-weight: 500;
        }
        .gs-status { margin-top: 12px; font-size: 12.5px; color: var(--muted); min-height: 16px; }
        .gs-status.error { color: var(--red); }
        .gs-status.ok    { color: var(--sage); }
      </style>
    `;

    // Wire click handlers — delegate so we don't churn handlers on update().
    container.querySelectorAll('button[data-gs-key]').forEach((btn) => {
      btn.addEventListener('click', () => runStep(btn.getAttribute('data-gs-key')));
    });
    const skipBtn = container.querySelector('#gs-skip');
    if (skipBtn) skipBtn.addEventListener('click', skipAll);
  }

  function setStatus(msg, kind) {
    if (!_container) return;
    const el = _container.querySelector('#gs-status');
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'gs-status' + (kind ? ' ' + kind : '');
  }

  // After any step lands, refresh the snapshot from the server and
  // re-render. The state machine handles the actual write — we just
  // mirror the result.
  async function update() {
    const snap = await refreshSnapshot();
    if (snap) render(_container, snap);
  }

  function runStep(key) {
    const ob = window.AMCP_ONBOARDING;
    if (!ob) {
      setStatus('Onboarding module did not load. Try refreshing the page.', 'error');
      return;
    }
    setStatus(''); // clear stale messages

    switch (key) {
      case 'watched_welcome':
        // Use the v2 paper-themed welcome modal from tour-bridge.js,
        // NOT the legacy 4-scene SVG welcome from dashboard-onboarding.js
        // — that overlay is dark-theme and was designed for the legacy
        // /dashboard.html surface; it visibly clashes with v2's paper UI.
        // Tour bridge marks the welcome step complete on close.
        if (window.AMCP_TOUR && typeof window.AMCP_TOUR.showWelcome === 'function') {
          window.AMCP_TOUR.showWelcome();
          setTimeout(update, 500);
        } else {
          // Tour bridge not loaded — mark complete inline so the user
          // can still advance the checklist.
          ob.markStep('checklist.watched_welcome').then(update);
        }
        break;

      case 'dns_configured':
        if (window.AMCP_DNS_WIZARD && typeof window.AMCP_DNS_WIZARD.open === 'function') {
          window.AMCP_DNS_WIZARD.open();
          // The wizard marks the step itself when DNS validates.
          // Refresh on close so the panel updates.
          setTimeout(update, 1000);
        } else {
          setStatus('DNS wizard didn\'t load. Refresh the page.', 'error');
        }
        break;

      case 'previewed_voice':
        openVoicePreviewModal();
        break;

      case 'took_tour':
        if (window.AMCP_TOUR && typeof window.AMCP_TOUR.start === 'function') {
          window.AMCP_TOUR.start();
        } else if (typeof ob.startTour === 'function') {
          ob.startTour();
        } else {
          // Fallback: mark complete so users aren't stuck if neither
          // tour module loaded.
          ob.markStep('checklist.took_tour').then(update);
        }
        // Tour fires markStep on completion; refresh on a delay regardless.
        setTimeout(update, 1500);
        break;

      case 'simulated_bot_hit':
        runSimulatedBotHit();
        break;

      case 'first_real_bot_hit':
        checkRealBotHit();
        break;

      default:
        // Unknown key — just mark and move on so the user isn't stuck.
        ob.markStep('checklist.' + key).then(update);
    }
  }

  // Voice preview — calls the real agent endpoint via the worker proxy
  // and renders the answer in a paper-themed modal. The displayed
  // answer is what AI tools actually receive when they ask about this
  // tenant, so the user sees an honest preview rather than a mock.
  // Modal markup is injected once and re-used on subsequent opens.
  let _vpInjected = false;
  function injectVoicePreviewModal() {
    if (_vpInjected) return;
    _vpInjected = true;
    const wrap = document.createElement('div');
    wrap.id = 'amcp-vp-root';
    wrap.innerHTML = `
      <div id="amcp-vp-mask" role="dialog" aria-modal="true" aria-labelledby="amcp-vp-title">
        <div class="amcp-vp-card">
          <div class="amcp-vp-eyebrow">Sample agent answer</div>
          <h2 id="amcp-vp-title" class="amcp-vp-title">Preview your voice</h2>
          <div class="amcp-vp-question" id="amcp-vp-question"></div>
          <div class="amcp-vp-answer" id="amcp-vp-answer">
            <div class="amcp-vp-spinner" aria-hidden="true">
              <div class="amcp-vp-dot"></div>
              <div class="amcp-vp-dot"></div>
              <div class="amcp-vp-dot"></div>
            </div>
            <span class="amcp-vp-loading-text">Asking your agent…</span>
          </div>
          <p class="amcp-vp-hint">This is exactly what ChatGPT, Perplexity, or Claude get when they ask about your business. Edit your profile to refine the tone.</p>
          <div class="amcp-vp-actions">
            <button type="button" class="amcp-vp-close" id="amcp-vp-close">Close</button>
            <a class="amcp-vp-edit" href="/BusinessProfile.html">Edit profile →</a>
          </div>
        </div>
      </div>
      <style>
        #amcp-vp-mask {
          position: fixed; inset: 0; z-index: 9996; display: none;
          background: rgba(20, 18, 16, 0.6);
          align-items: center; justify-content: center; padding: 20px;
        }
        #amcp-vp-mask.active { display: flex; }
        .amcp-vp-card {
          background: var(--paper, #fbf9f5); border: 1px solid var(--line, #e6dfd5);
          border-radius: 14px; padding: 32px; max-width: 560px; width: 100%;
          box-shadow: 0 24px 60px rgba(20, 18, 16, 0.3);
          font-family: "General Sans", system-ui, -apple-system, sans-serif;
          max-height: 80vh; overflow-y: auto;
        }
        .amcp-vp-eyebrow {
          font-size: 11.5px; letter-spacing: 0.08em; text-transform: uppercase;
          color: var(--maroon, #7d2550); font-weight: 600; margin-bottom: 10px;
        }
        .amcp-vp-title {
          font-family: "Instrument Serif", serif; font-weight: 400;
          font-size: 26px; line-height: 1.15; color: var(--ink, #1a1715);
          margin: 0 0 18px;
        }
        .amcp-vp-question {
          font-size: 13.5px; color: var(--ink-2, #46403a);
          background: var(--paper-2, #f3ede2); padding: 12px 14px; border-radius: 8px;
          margin-bottom: 14px; font-style: italic;
        }
        .amcp-vp-question::before { content: '"'; }
        .amcp-vp-question::after  { content: '"'; }
        .amcp-vp-answer {
          font-size: 14.5px; line-height: 1.6; color: var(--ink, #1a1715);
          padding: 16px 18px; background: var(--paper, #fbf9f5);
          border: 1px solid var(--line, #e6dfd5); border-radius: 10px;
          min-height: 80px;
          white-space: pre-wrap;
        }
        .amcp-vp-answer.error { color: var(--red, #c64242); }
        .amcp-vp-spinner { display: inline-flex; gap: 4px; margin-right: 8px; vertical-align: middle; }
        .amcp-vp-dot {
          width: 6px; height: 6px; border-radius: 999px; background: var(--maroon, #7d2550);
          animation: amcp-vp-bounce 1.2s infinite ease-in-out both;
        }
        .amcp-vp-dot:nth-child(1) { animation-delay: -.32s; }
        .amcp-vp-dot:nth-child(2) { animation-delay: -.16s; }
        @keyframes amcp-vp-bounce {
          0%, 80%, 100% { transform: scale(0.4); opacity: 0.4; }
          40%           { transform: scale(1);   opacity: 1; }
        }
        .amcp-vp-loading-text { color: var(--muted, #8a7c78); font-size: 13.5px; vertical-align: middle; }
        .amcp-vp-hint {
          margin: 14px 0 0; font-size: 12.5px; color: var(--muted, #8a7c78); line-height: 1.5;
        }
        .amcp-vp-actions {
          display: flex; gap: 10px; justify-content: flex-end; margin-top: 22px;
          align-items: center;
        }
        .amcp-vp-close {
          font-size: 13.5px; padding: 9px 16px; border-radius: 8px;
          border: 1px solid var(--line, #e6dfd5); background: transparent;
          color: var(--ink-2, #46403a); cursor: pointer;
        }
        .amcp-vp-edit {
          font-size: 13.5px; padding: 9px 16px; border-radius: 8px;
          background: var(--maroon, #7d2550); color: #fff !important;
          text-decoration: none; font-weight: 500;
        }
        @media (prefers-color-scheme: dark) {
          .amcp-vp-card { background: #1f1c19; border-color: #3a342e; }
          .amcp-vp-title { color: #f1ece5; }
          .amcp-vp-question { background: #15120f; color: #c5bdb3; }
          .amcp-vp-answer { background: #1f1c19; border-color: #3a342e; color: #e8e3dd; }
          .amcp-vp-close { background: transparent; border-color: #3a342e; color: #c5bdb3; }
        }
      </style>
    `;
    document.body.appendChild(wrap);
    document.getElementById('amcp-vp-close').addEventListener('click', closeVoicePreviewModal);
    document.getElementById('amcp-vp-mask').addEventListener('click', (e) => {
      if (e.target.id === 'amcp-vp-mask') closeVoicePreviewModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && document.getElementById('amcp-vp-mask').classList.contains('active')) {
        closeVoicePreviewModal();
      }
    });
  }

  function closeVoicePreviewModal() {
    const m = document.getElementById('amcp-vp-mask');
    if (m) m.classList.remove('active');
  }

  async function openVoicePreviewModal() {
    injectVoicePreviewModal();
    const m  = document.getElementById('amcp-vp-mask');
    const q  = document.getElementById('amcp-vp-question');
    const a  = document.getElementById('amcp-vp-answer');
    const name = (window.AMCP_DATA && window.AMCP_DATA.business_name) || 'your business';
    const question = `Tell me about ${name}.`;
    q.textContent = question;
    a.classList.remove('error');
    a.innerHTML = `
      <span class="amcp-vp-spinner" aria-hidden="true">
        <span class="amcp-vp-dot"></span><span class="amcp-vp-dot"></span><span class="amcp-vp-dot"></span>
      </span>
      <span class="amcp-vp-loading-text">Asking your agent…</span>
    `;
    m.classList.add('active');

    const af = window.AMCP && window.AMCP.authedFetch;
    if (!af) {
      a.classList.add('error');
      a.textContent = 'Not signed in. Refresh and try again.';
      return;
    }
    try {
      const res = await af('/api/client/preview-voice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: question }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        a.classList.add('error');
        a.textContent = body.error || `Preview failed (HTTP ${res.status})`;
        return;
      }
      const answer = (body.answer || '').trim();
      if (answer && answer !== '(no answer returned)') {
        a.textContent = answer;
        // Mark complete after the answer renders so the checklist
        // updates. Server short-circuits markStep for admins so preview
        // mode doesn't accidentally stamp anything.
        const ob = window.AMCP_ONBOARDING;
        if (ob && typeof ob.markStep === 'function') {
          ob.markStep('checklist.previewed_voice').then(update);
        }
        return;
      }
      // Empty answer — usually means admin is previewing without an
      // impersonation target so we hit the alphabetical-first business
      // (sparse profile). Tell them how to see a real answer instead
      // of leaving "(no answer returned)" hanging.
      const role = (window.AMCP_DATA && window.AMCP_DATA.user_role) || null;
      const asSlug = new URL(window.location.href).searchParams.get('as') || null;
      if (role === 'admin' && !asSlug) {
        a.classList.add('error');
        a.innerHTML =
          'No answer came back. You\'re signed in as <strong>admin</strong> without an impersonation target, so the preview hit the alphabetically-first business — usually a test row with no profile data.<br><br>' +
          'To see a real answer, append <code>&amp;as=example-tenant</code> (or any real tenant slug) to the URL, or pick one from <a href="/admin/tenants" style="color:var(--maroon, #7d2550);font-weight:500">Tenants</a> and click Replay tutorial after impersonating.';
      } else {
        a.classList.add('error');
        a.innerHTML =
          'Your agent didn\'t return any text. This usually means your <strong>profile is empty</strong>. Add a description, services, or hours in <a href="/BusinessProfile.html" style="color:var(--maroon, #7d2550);font-weight:500">Business profile</a> and try again.';
      }
    } catch (err) {
      a.classList.add('error');
      a.textContent = 'Network error: ' + String((err && err.message) || err);
    }
  }

  // Simulated bot hit — uses the shared DNS probe to check whether a live
  // request has reached the worker. Marks the step when live_request.state === 'ok'.
  async function runSimulatedBotHit() {
    const af = window.AMCP && window.AMCP.authedFetch;
    if (!af) return setStatus('Network unavailable.', 'error');
    setStatus('Pinging your agent…');
    try {
      const slug = (window.AMCP_DATA && window.AMCP_DATA.slug) || '';
      // Use the unified probe — live_request.state === 'ok' means a real bot
      // request reached the worker (same signal the DNS wizard's 5-light check uses).
      const status = await window.AMCP_DNS_STATUS.runOnce(slug);
      const live = status && status.signals && status.signals.live_request;
      if (live && live.state === 'ok') {
        setStatus('PerplexityBot pinged — your agent answered.', 'ok');
        const ob = window.AMCP_ONBOARDING;
        if (ob && typeof ob.markStep === 'function') {
          await ob.markStep('checklist.simulated_bot_hit');
        }
        update();
      } else {
        const msg = (live && live.message) || 'Domain isn\'t live yet — check the DNS wizard.';
        setStatus(msg, 'error');
      }
    } catch (e) {
      setStatus('Network error: ' + String((e && e.message) || e), 'error');
    }
  }

  // Real bot hit — GET /api/client/domain-info, check last_bot_hit.
  // Marks complete only if a bot has actually hit; otherwise informs
  // the user crawlers typically arrive within ~24h of DNS going live.
  async function checkRealBotHit() {
    const af = window.AMCP && window.AMCP.authedFetch;
    if (!af) return setStatus('Network unavailable.', 'error');
    setStatus('Checking…');
    try {
      const slug = (window.AMCP_DATA && window.AMCP_DATA.slug) || '';
      const r = await af('/api/client/domain-info' + (slug ? '?slug=' + encodeURIComponent(slug) : ''));
      if (!r.ok) {
        setStatus('Could not read domain status (HTTP ' + r.status + ').', 'error');
        return;
      }
      const data = await r.json();
      if (data && data.last_bot_hit) {
        setStatus('First real bot hit recorded.', 'ok');
        const ob = window.AMCP_ONBOARDING;
        if (ob && typeof ob.markStep === 'function') {
          await ob.markStep('checklist.first_real_bot_hit');
        }
        update();
      } else {
        setStatus('No bot hits yet — real crawlers typically arrive within ~24h of DNS going live.', '');
      }
    } catch (e) {
      setStatus('Network error: ' + String((e && e.message) || e), 'error');
    }
  }

  // Skip — same DNS gate as legacy _skipAll. Marks every UNCHECKED
  // required key (except DNS) complete; if DNS is still pending,
  // onboarded_at won't be stamped server-side and the panel stays.
  async function skipAll() {
    const ob = window.AMCP_ONBOARDING;
    if (!ob || typeof ob.markStep !== 'function') {
      setStatus('Onboarding module not loaded.', 'error');
      return;
    }
    const keys = checklistKeys();
    const dnsPending = keys.indexOf('dns_configured') !== -1
      && !isStepDone(_snapshot, 'dns_configured');
    const msg = dnsPending
      ? 'Skip the tour? Your DNS is not wired up yet, so the Get Started panel will stay until DNS is configured. Other steps will be marked complete.\n\nContinue?'
      : 'Skip the Get Started panel? You can restart it any time from Settings → Tutorial.';
    if (!window.confirm(msg)) return;

    const skipBtn = _container && _container.querySelector('#gs-skip');
    if (skipBtn) { skipBtn.disabled = true; skipBtn.textContent = 'Skipping…'; }

    const remaining = keys.filter((k) => k !== 'dns_configured' && !isStepDone(_snapshot, k));
    let chain = Promise.resolve();
    remaining.forEach((k) => {
      chain = chain.then(() => ob.markStep('checklist.' + k));
    });
    chain.then(update).catch(() => {
      setStatus('Skip failed partway through. Try again.', 'error');
      if (skipBtn) { skipBtn.disabled = false; skipBtn.textContent = 'Skip — I\'ll explore on my own'; }
    });
  }

  window.AMCP_GET_STARTED = {
    render,
    update,
    shouldShow,
    refreshSnapshot,
  };
})();
