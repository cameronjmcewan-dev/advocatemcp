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

  function shouldShow(snapshot) {
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
        // Phase 5 (tour bridge) wires v2 welcome modal. For now, mark
        // complete inline so users can advance — the tour bridge will
        // upgrade this to a real overlay.
        if (typeof ob.openWelcome === 'function') {
          ob.openWelcome();
          // Re-render after a delay so the user sees the welcome flow
          // mark itself complete.
          setTimeout(update, 500);
        } else {
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

      case 'previewed_voice': {
        // Inline mock preview — same content as legacy _openVoicePreview
        // but without the legacy drawer. We just toast a summary, mark
        // complete, and let the user explore the real agent in any AI tool.
        const name = (window.AMCP_DATA && window.AMCP_DATA.business_name) || 'your business';
        const sample =
          'Sure — ' + name + ' is a local business. They handle inquiries through ' +
          'their booking page. For pricing, hours, or to schedule, tap through to their site.';
        if (window.alert) window.alert('Sample agent answer:\n\n' + sample);
        ob.markStep('checklist.previewed_voice').then(update);
        break;
      }

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

  // Simulated bot hit — POST /api/client/domain-test pretends to be
  // PerplexityBot pinging the agent. On success the server responds
  // with a 200 + a synthesized query, and we mark the step. Identical
  // logic to legacy _triggerSimulatedHit, just inlined for the v2 panel.
  async function runSimulatedBotHit() {
    const af = window.AMCP && window.AMCP.authedFetch;
    if (!af) return setStatus('Network unavailable.', 'error');
    setStatus('Pinging your agent…');
    try {
      const slug = (window.AMCP_DATA && window.AMCP_DATA.slug) || '';
      const r = await af('/api/client/domain-test' + (slug ? '?slug=' + encodeURIComponent(slug) : ''));
      if (!r.ok) {
        setStatus('Simulation failed (HTTP ' + r.status + '). Check your domain setup.', 'error');
        return;
      }
      setStatus('PerplexityBot pinged — your agent answered.', 'ok');
      const ob = window.AMCP_ONBOARDING;
      if (ob && typeof ob.markStep === 'function') {
        await ob.markStep('checklist.simulated_bot_hit');
      }
      update();
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
