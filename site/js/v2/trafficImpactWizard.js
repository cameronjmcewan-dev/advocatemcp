// site/js/v2/trafficImpactWizard.js
//
// Phase-2 wizard for /TrafficImpact.html empty state. Replaces the
// legacy "Connect Google Analytics →" State A with a guided stepper
// that walks the user through the server's recommended_next chain.
//
// State model: server-driven. recommended_next IS the cursor. Each
// completed integration triggers a natural OAuth-redirect-or-picker-
// reload; the page boots fresh and the wizard re-evaluates against
// the new payload. No localStorage. No cross-session state.
//
// Reuses connectorCard.js's surface:"wizard" mode (PR 2) and
// runInlinePicker's mountTarget option (PR 1).
//
// Spec: docs/superpowers/specs/2026-05-08-traffic-impact-wizard-phase-2-design.md

(function () {
  'use strict';

  // In-tab session flag for "Skip All" — resets on page reload, which
  // matches the user-chosen UX of "auto-wizard until 2+ connected".
  let dismissedThisSession = false;

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /**
   * Pure: returns true if the wizard should mount instead of the legacy
   * State A. Called by traffic-impact.js's render path. Falls back to
   * legacy on any input that doesn't satisfy the threshold.
   */
  function shouldRender(hub) {
    if (dismissedThisSession) return false;
    if (!hub) return false;
    const completion = hub.completion || {};
    const connected = Number(completion.connected || 0);
    return connected < 2 && hub.recommended_next != null;
  }

  /**
   * Renders the wizard's HTML for the current state. Three states:
   *   - "welcome": shown when the user lands fresh (no step started yet)
   *   - "step": one ConnectorCard for the current recommended integration
   *   - "done": shown when recommended_next is null AND completion >= 2
   *
   * State picked from in-memory step index + the live hub payload. The
   * wizard's <div id="ti-wizard-root"> is the outer wrapper traffic-
   * impact.js renders into; all step transitions swap its innerHTML.
   */
  let stepIndex = 0; // 0 = welcome, 1+ = active steps; tracked across mount() calls within the same load

  function renderState(hub) {
    if (!hub) return renderError("Couldn't load setup state — refresh to retry.");

    // Done card: completed via this session OR returned with everything done
    const completion = hub.completion || { connected: 0, available: 0 };
    if (hub.recommended_next == null && completion.connected >= 2) {
      return renderDone(hub);
    }

    // Welcome before any step
    if (stepIndex === 0) {
      return renderWelcome(hub);
    }

    // Active step: render the recommended_next integration as a wizard card
    const targetId = hub.recommended_next;
    const integration = (hub.integrations || []).find(i => i.id === targetId);
    if (!integration) {
      // Defensive: server says recommended_next but we can't find the row.
      // Fall back to welcome so the user has somewhere to click from.
      stepIndex = 0;
      return renderWelcome(hub);
    }
    return renderStep(integration, hub);
  }

  function renderWelcome(hub) {
    const completion = hub.completion || { connected: 0, available: 0 };
    const stepCount = computeStepCount(hub);
    const stepWord = stepCount === 1 ? 'step' : 'steps';
    const timeEst = stepCount <= 1 ? '~3 min' : `~${stepCount * 3} min`;
    return `
      <div id="ti-wizard-root" class="ti-wizard">
        <div class="ti-wizard-welcome">
          <div class="ti-wizard-eyebrow">Set up Traffic Impact</div>
          <h1 class="ti-wizard-title">See how AI search is moving your traffic.</h1>
          <p class="ti-wizard-subtitle">${stepCount} ${stepWord} · ${timeEst}. Connect your data sources and your dashboard fills in.</p>
          <div class="ti-wizard-actions">
            <button type="button" class="btn btn-primary ti-wizard-start">Start setup →</button>
            <button type="button" class="btn btn-ghost btn-sm ti-wizard-skip-all">Skip — I'll explore on my own</button>
          </div>
          <div class="ti-wizard-meta">${escHtml(completion.connected)} of ${escHtml(completion.available)} connected</div>
        </div>
      </div>`;
  }

  function renderStep(integration, hub) {
    const totalSteps = computeStepCount(hub);
    const cardHtml = (window.AMCP_CONNECTOR_CARD && window.AMCP_CONNECTOR_CARD.render)
      ? window.AMCP_CONNECTOR_CARD.render(integration, 'wizard')
      : `<div class="ti-wizard-error">Setup module didn't load — refresh to retry.</div>`;
    return `
      <div id="ti-wizard-root" class="ti-wizard">
        <div class="ti-wizard-stepper-head">
          <span class="ti-wizard-step-meta">Step ${stepIndex} of ${totalSteps}</span>
          <button type="button" class="btn btn-ghost btn-sm ti-wizard-skip-all">Skip all</button>
        </div>
        ${cardHtml}
        <div class="ti-wizard-step-foot">
          ${stepIndex > 1 ? `<button type="button" class="btn btn-ghost btn-sm ti-wizard-back">‹ Back</button>` : '<span></span>'}
          <button type="button" class="btn btn-ghost btn-sm ti-wizard-skip-step">Skip this step</button>
        </div>
      </div>`;
  }

  function renderDone(hub) {
    const completion = hub.completion || { connected: 0, available: 0 };
    return `
      <div id="ti-wizard-root" class="ti-wizard">
        <div class="ti-wizard-done">
          <div class="ti-wizard-eyebrow ti-wizard-done-eyebrow">Setup complete</div>
          <h1 class="ti-wizard-title">You're set up.</h1>
          <p class="ti-wizard-subtitle">${escHtml(completion.connected)} of ${escHtml(completion.available)} integrations connected. Your dashboard will populate as data syncs over the next 24 hours.</p>
          <div class="ti-wizard-actions">
            <button type="button" class="btn btn-primary ti-wizard-finish">View your dashboard →</button>
            <a class="btn btn-ghost btn-sm" href="/Settings.html">Add more integrations</a>
          </div>
        </div>
      </div>`;
  }

  function renderError(message) {
    return `
      <div id="ti-wizard-root" class="ti-wizard">
        <div class="ti-wizard-error-card">
          <p>${escHtml(message)}</p>
          <button type="button" class="btn btn-ghost btn-sm" onclick="window.location.reload()">Refresh</button>
        </div>
      </div>`;
  }

  /**
   * How many integrations the wizard will walk through. Equal to
   * (integrations.length - plan_locked.length - already_connected.length)
   * but capped at the recommended chain (Salesforce isn't in the chain).
   * Used for the Step N of M counter.
   */
  function computeStepCount(hub) {
    const integrations = (hub && hub.integrations) || [];
    const RECOMMENDED = ['ga4', 'gsc', 'hubspot', 'stripe_webhook', 'authority'];
    return RECOMMENDED.filter(id => {
      const i = integrations.find(x => x.id === id);
      return i && i.status !== 'plan_locked';
    }).length;
  }

  /**
   * Wires the wizard into the DOM. Idempotent — safe to call repeatedly
   * but swaps innerHTML so prior listeners don't double-fire.
   *
   * The parent (traffic-impact.js) is responsible for re-calling
   * traffic-impact's own render path when the wizard is dismissed. We
   * just flip dismissedThisSession + dispatch a custom event the
   * parent listens for, then traffic-impact decides what to render.
   */
  function mount(hub, root) {
    if (!root) return;

    // Initial render-then-wire.
    root.innerHTML = renderState(hub);
    wireListeners(hub);
  }

  function wireListeners(hub) {
    const root = document.getElementById('ti-wizard-root');
    if (!root) return;

    // Welcome → start
    const startBtn = root.querySelector('.ti-wizard-start');
    if (startBtn) {
      startBtn.addEventListener('click', () => {
        stepIndex = 1;
        root.outerHTML = renderState(hub);
        wireListeners(hub);
      });
    }

    // Skip-all (welcome or step)
    const skipAllBtns = root.querySelectorAll('.ti-wizard-skip-all');
    skipAllBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        dismissedThisSession = true;
        notifyDismissed();
      });
    });

    // Step nav: Back
    const backBtn = root.querySelector('.ti-wizard-back');
    if (backBtn) {
      backBtn.addEventListener('click', () => {
        stepIndex = Math.max(0, stepIndex - 1);
        root.outerHTML = renderState(hub);
        wireListeners(hub);
      });
    }

    // Step nav: Skip this step (advances cursor in-memory only — server still recommends it next reload)
    const skipStepBtn = root.querySelector('.ti-wizard-skip-step');
    if (skipStepBtn) {
      skipStepBtn.addEventListener('click', () => {
        stepIndex = stepIndex + 1;
        // Cap at total: if past end, show done.
        // (Skip-step doesn't unlock done; we re-evaluate from hub.)
        root.outerHTML = renderState(hub);
        wireListeners(hub);
      });
    }

    // Done → finish
    const finishBtn = root.querySelector('.ti-wizard-finish');
    if (finishBtn) {
      finishBtn.addEventListener('click', () => {
        dismissedThisSession = true;
        notifyDismissed();
      });
    }

    // Hub action buttons (data-cc-action) — delegated to the same handlers
    // as the Settings hub. We re-fetch the action map at click time from
    // window.AMCP_TI_WIZARD_ACTIONS (set by the parent), so the wizard
    // module stays decoupled from the specific endpoint URLs.
    root.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-cc-action]');
      if (!btn) return;
      // 'upgrade' is an <a> — let it navigate naturally
      const action = btn.getAttribute('data-cc-action');
      const id = btn.getAttribute('data-cc-id');
      if (!action || !id || action === 'upgrade') return;
      e.preventDefault();
      handleAction(id, action, btn);
    });
  }

  function handleAction(integrationId, action, btn) {
    const af = window.AMCP && window.AMCP.authedFetch;
    if (!af) return;

    // Picker actions mount into the wizard's step-body so they don't
    // clobber the wizard's navigation.
    if (action === 'pick_property' || action === 'pick_site') {
      const card = btn.closest('.cc-wizard-card');
      const stepBody = card ? card.querySelector('.cc-wizard-step-body') : null;
      if (!stepBody) return;
      // Use the same runInlinePicker the Settings hub uses, with mountTarget
      // set so the picker renders into stepBody instead of clobbering the
      // wizard's action stack.
      if (window.AMCP_TI_WIZARD_ACTIONS && typeof window.AMCP_TI_WIZARD_ACTIONS.openPicker === 'function') {
        window.AMCP_TI_WIZARD_ACTIONS.openPicker(integrationId, btn, stepBody);
        return;
      }
      // Fallback: alert + scroll-to legacy.
      window.alert('Picker module not loaded — refresh and try again.');
      return;
    }

    // OAuth start (connect): same flow as the hub. Redirects externally.
    // On return, page boots fresh and wizard re-evaluates.
    if (action === 'connect') {
      if (window.AMCP_TI_WIZARD_ACTIONS && typeof window.AMCP_TI_WIZARD_ACTIONS.startConnect === 'function') {
        window.AMCP_TI_WIZARD_ACTIONS.startConnect(integrationId, btn);
        return;
      }
      return;
    }

    // Disconnect / resync / configure / generate / rotate / edit:
    // delegate to the parent action map. Phase 2 doesn't expect users
    // to disconnect mid-wizard, but the buttons exist for completeness.
    if (window.AMCP_TI_WIZARD_ACTIONS && typeof window.AMCP_TI_WIZARD_ACTIONS.dispatch === 'function') {
      window.AMCP_TI_WIZARD_ACTIONS.dispatch(integrationId, action, btn);
    }
  }

  function notifyDismissed() {
    document.dispatchEvent(new CustomEvent('ti-wizard-dismissed'));
  }

  window.AMCP_TI_WIZARD = { shouldRender, renderState, mount };
})();
