# Traffic Impact Wizard — PR 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Traffic Impact wizard stepper module + wire it into `/TrafficImpact.html` State A. When `completion.connected < 2 && recommended_next !== null`, the page renders the wizard instead of the legacy "Connect Google Analytics →" empty state.

**Architecture:** New `site/js/v2/trafficImpactWizard.js` IIFE module exposing `window.AMCP_TI_WIZARD = { shouldRender, renderState, mount }`. The state machine is server-driven — the `recommended_next` field of the integrations status payload IS the cursor. Each completed integration causes a natural OAuth-redirect-or-picker-reload, after which the page boots fresh and the wizard re-evaluates against the new payload. No localStorage. No cross-session state. Welcome card is shown when no step is active; Done card when `recommended_next === null && completion.connected >= 2`. `traffic-impact.js`'s State A render path delegates to the wizard when `shouldRender` is true.

**Tech Stack:** Vanilla JS IIFE, no bundler, no automated tests on static-site assets — verification via `node --check` + manual end-to-end.

**Spec:** `docs/superpowers/specs/2026-05-08-traffic-impact-wizard-phase-2-design.md` (commit `7bd449d`).

---

## File Map

### New
- `site/js/v2/trafficImpactWizard.js` — the wizard stepper module (~200 lines)

### Modified
- `site/js/v2/traffic-impact.js` — State A render + afterMount delegation (~25 lines added, ~5 modified)
- `site/TrafficImpact.html` — load the new module + connectorCard + prereqCoach + integrations-hub.css (~4 lines)
- `site/css/integrations-hub.css` — add wizard welcome/done card + stepper navigation styles (~80 lines appended)

### Untouched
- `site/js/v2/connectorCard.js` — uses PR 2's `surface: "wizard"` rendering mode unchanged
- `site/js/v2/prereqCoach.js` — used by connectorCard's wizard render unchanged
- `site/js/v2/settings.js` — `runInlinePicker` accepts PR 1's `mountTarget` option; the wizard passes it
- The whole worker — no backend change

---

## Task 1: Skeleton + `shouldRender`

**Files:**
- Create: `site/js/v2/trafficImpactWizard.js`

- [ ] **Step 1: Create the module skeleton**

```js
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

  // Phase 2 PR 3 stages 1-4 add: renderState, mount, helpers below.
  // Skeleton only in this task.
  function renderState() { return ''; }
  function mount() {}

  window.AMCP_TI_WIZARD = { shouldRender, renderState, mount };
})();
```

- [ ] **Step 2: Verify it parses**

Run: `node --check /Users/cameronmcewan/Desktop/advocate/advocatemcp/site/js/v2/trafficImpactWizard.js`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git -C /Users/cameronmcewan/Desktop/advocate/advocatemcp add site/js/v2/trafficImpactWizard.js
git -C /Users/cameronmcewan/Desktop/advocate/advocatemcp commit -m "feat(integrations): wizard module skeleton + shouldRender

First task of Phase 2 PR 3. Pure shouldRender check that the
traffic-impact.js render path will use to decide between the
legacy State A and the new wizard. renderState + mount are
stubs filled in by subsequent tasks."
```

---

## Task 2: Welcome card + Done card render

**Files:**
- Modify: `site/js/v2/trafficImpactWizard.js`

- [ ] **Step 1: Replace the renderState stub with real logic**

Replace `function renderState() { return ''; }` with:

```js
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
    const completion = hub.completion || { connected: 0, available: 0 };
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
```

- [ ] **Step 2: Verify it parses**

Run: `node --check /Users/cameronmcewan/Desktop/advocate/advocatemcp/site/js/v2/trafficImpactWizard.js`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git -C /Users/cameronmcewan/Desktop/advocate/advocatemcp add site/js/v2/trafficImpactWizard.js
git -C /Users/cameronmcewan/Desktop/advocate/advocatemcp commit -m "feat(integrations): wizard renderState — welcome / step / done / error

Welcome card greets new tenants with step count + time estimate.
Step view delegates to connectorCard surface:'wizard' rendering for
the recommended_next integration. Done card on completion. Error card
on missing hub payload. computeStepCount filters plan_locked rows
out so Base tenants see '1 step · ~3 min' instead of the Pro count.

Step transitions still stubbed (mount() is a no-op until Task 3)."
```

---

## Task 3: `mount` — wire navigation + advancement

**Files:**
- Modify: `site/js/v2/trafficImpactWizard.js`

- [ ] **Step 1: Replace the mount stub with real wiring**

Replace `function mount() {}` with the full implementation. This wires:
- The "Start setup →" button on welcome → advance to step 1
- "Skip All" on welcome OR any step → flip `dismissedThisSession`, re-render parent (which now shows legacy State A)
- "Skip this step" → not implemented in PR 3 (just a no-op + alert; wires in a future polish patch)
- "Back" → step index minus 1, re-render
- "View your dashboard →" on done → flip `dismissedThisSession`, re-render parent
- Hub action buttons (`data-cc-action`) — delegated handler that dispatches to the same handlers as the Settings hub. When the user clicks Connect → OAuth redirect happens externally; on return the page boots fresh with new state. When the user clicks Pick property/Pick site → `runInlinePicker` is called with `mountTarget` set to `.cc-wizard-step-body` so it doesn't clobber the wizard navigation. Picker reloads page on success → wizard re-mounts with fresh hub.

```js
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
      const stepBody = btn.closest('.cc-wizard-card')?.querySelector('.cc-wizard-step-body');
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
```

- [ ] **Step 2: Verify it parses**

Run: `node --check /Users/cameronmcewan/Desktop/advocate/advocatemcp/site/js/v2/trafficImpactWizard.js`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git -C /Users/cameronmcewan/Desktop/advocate/advocatemcp add site/js/v2/trafficImpactWizard.js
git -C /Users/cameronmcewan/Desktop/advocate/advocatemcp commit -m "feat(integrations): wizard mount() — listeners + action delegation

Welcome → Start, step Back / Skip step / Skip all, done → Finish all
flip the in-memory step index or the dismissedThisSession flag.

Hub action buttons (data-cc-action) are delegated to the parent's
window.AMCP_TI_WIZARD_ACTIONS object (set by traffic-impact.js).
Pickers open via runInlinePicker with mountTarget set to the wizard
card's .cc-wizard-step-body div so they don't clobber navigation.

Dismissal fires a 'ti-wizard-dismissed' CustomEvent the parent
listens for to swap to the legacy State A render."
```

---

## Task 4: Wire `traffic-impact.js` to use the wizard

**Files:**
- Modify: `site/js/v2/traffic-impact.js`

- [ ] **Step 1: Find the State A render path**

Read `site/js/v2/traffic-impact.js`. Find the `render(data)` function (or equivalent) where State A is determined. The state-A render is the branch that returns when `!impact.ga4_connected` (per the existing State A wiring). Identify the line(s) where the page emits the legacy "Connect Google Analytics →" UI.

- [ ] **Step 2: Add a wizard-shouldRender guard above legacy State A**

In `render()`, BEFORE the existing State A branch:

```js
// Phase-2 wizard: when the tenant has 0–1 integrations connected, replace
// the bare "Connect Google Analytics →" State A with the multi-step wizard.
if (window.AMCP_TI_WIZARD && window.AMCP_TI_WIZARD.shouldRender(d.integrationsHub)) {
  return window.AMCP_TI_WIZARD.renderState(d.integrationsHub);
}
```

The `d.integrationsHub` field is the same one settings.js uses; it's already fetched by `fetchReal` if the hub data is part of the same parallel-fetch (verify by reading the existing fetchReal).

If `traffic-impact.js`'s `fetchReal` doesn't already fetch `/api/client/integrations/status`, add a parallel fetch for it (mirror the settings.js pattern).

- [ ] **Step 3: Add wizard-mount + dismissal listener in afterMount**

In `afterMount(data)`:

```js
// Mount the wizard if it took over the State A render.
if (window.AMCP_TI_WIZARD && window.AMCP_TI_WIZARD.shouldRender(data.integrationsHub)) {
  // Provide the action map the wizard delegates to.
  window.AMCP_TI_WIZARD_ACTIONS = {
    startConnect: (integrationId, btn) => startGoogleOauthForId(integrationId, btn),
    openPicker:   (integrationId, btn, mountTarget) => openInlinePickerForId(integrationId, btn, mountTarget),
    dispatch:     (integrationId, action, btn) => dispatchHubAction(integrationId, action, btn),
  };
  window.AMCP_TI_WIZARD.mount(data.integrationsHub, document.getElementById('page-content'));
  document.addEventListener('ti-wizard-dismissed', () => window.location.reload(), { once: true });
  return; // skip legacy State A wiring
}
```

The `startGoogleOauthForId`, `openInlinePickerForId`, and `dispatchHubAction` helpers are NEW small wrapper functions in traffic-impact.js that mirror the settings.js patterns. Add them at module scope:

```js
async function startGoogleOauthForId(integrationId, btn) {
  // Maps integrationId → start-link path. Mirrors settings.js's startGoogleOauth.
  const paths = {
    ga4:        '/api/client/ga4/start-link',
    gsc:        '/api/client/gsc/start-link',
    hubspot:    '/api/client/crm/start-link?provider=hubspot',
    salesforce: '/api/client/crm/start-link?provider=salesforce',
  };
  const path = paths[integrationId];
  if (!path) {
    // Authority + Stripe webhook don't OAuth-connect; route them to Settings.
    window.location.href = '/Settings.html#legacy-' + integrationId.replace('_', '-') + '-card';
    return;
  }
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Opening Google…';
  try {
    const r = await window.AMCP.authedFetch(path, { method: 'POST' });
    const j = await r.json();
    if (j && j.url) { window.location.href = j.url; return; }
    throw new Error((j && (j.customer_message || j.error_code)) || 'Could not start');
  } catch (err) {
    alert('Could not connect: ' + (err.message || err));
    btn.disabled = false;
    btn.textContent = original;
  }
}

function openInlinePickerForId(integrationId, btn, mountTarget) {
  // The runInlinePicker function lives in settings.js; we call the same
  // module-level helper exposed via window. Phase 2 PR 1 added the
  // mountTarget option so the picker renders into the wizard's
  // step-body without clobbering nav buttons.
  if (typeof window.runInlinePicker !== 'function') {
    // settings.js's runInlinePicker isn't exposed on window today.
    // For Phase 2 PR 3 we expose it explicitly. See the small change
    // in settings.js below the wizard wire-up.
    alert('Picker module not loaded — refresh and try again.');
    return;
  }
  if (integrationId === 'ga4') {
    window.runInlinePicker({
      anchorBtn:    btn,
      mountTarget:  mountTarget,
      listPath:     '/api/client/ga4/properties',
      listKey:      'properties',
      selectPath:   '/api/client/ga4/select-property',
      buildBody:    (p) => ({ property_id: p.propertyId, property_label: p.displayName || p.propertyId }),
      isValid:      (p) => !!p.propertyId,
      rowLabel:     (p) => p.displayName || p.propertyId || '',
      rowSubLabel:  (p) => p.propertyId || '',
      emptyMessage: 'No GA4 properties on this Google account. Create one in Analytics first.',
      intro:        'Pick the GA4 property Advocate should pull traffic from. Selecting a property triggers a backfill — this can take 30 seconds.',
    });
  } else if (integrationId === 'gsc') {
    window.runInlinePicker({
      anchorBtn:    btn,
      mountTarget:  mountTarget,
      listPath:     '/api/client/gsc/sites',
      listKey:      'sites',
      selectPath:   '/api/client/gsc/select-site',
      buildBody:    (s) => ({ site_url: s.siteUrl }),
      isValid:      (s) => !!s.siteUrl,
      rowLabel:     (s) => s.siteUrl || '',
      rowSubLabel:  (s) => s.permissionLevel || '',
      emptyMessage: 'No verified sites on this Google account. Add and verify a site in Search Console first.',
      intro:        'Pick the site Advocate should pull data from. Selecting a site triggers an 18-month backfill — this can take 30 seconds.',
    });
  }
}

function dispatchHubAction(integrationId, action, btn) {
  // Disconnect / resync / configure / generate / rotate / edit — Phase 2
  // mid-wizard handling: the simplest correct behavior is to send users
  // to the Settings page where the legacy editing surfaces live. The
  // wizard is for happy-path setup; advanced edits happen elsewhere.
  window.location.href = '/Settings.html#legacy-' + integrationId.replace('_', '-') + '-card';
}
```

- [ ] **Step 4: Expose `runInlinePicker` on window**

In `site/js/v2/settings.js`, find the `runInlinePicker(opts)` declaration. AT MODULE SCOPE inside the IIFE, ALSO assign it to `window.runInlinePicker` (so traffic-impact.js can call it):

```js
// At the end of the IIFE in settings.js, after handleHubAction etc., add:
window.runInlinePicker = runInlinePicker;
```

This is a small surface-area widening. Phase 1 had `runInlinePicker` IIFE-scoped only. Phase 2 PR 3 needs cross-module access; expose explicitly.

- [ ] **Step 5: Verify both files parse**

Run:
```bash
node --check /Users/cameronmcewan/Desktop/advocate/advocatemcp/site/js/v2/traffic-impact.js && \
node --check /Users/cameronmcewan/Desktop/advocate/advocatemcp/site/js/v2/settings.js && \
echo "OK"
```
Expected: prints "OK".

- [ ] **Step 6: Commit**

```bash
git -C /Users/cameronmcewan/Desktop/advocate/advocatemcp add site/js/v2/traffic-impact.js site/js/v2/settings.js
git -C /Users/cameronmcewan/Desktop/advocate/advocatemcp commit -m "feat(integrations): traffic-impact.js delegates State A to the Phase-2 wizard

When the tenant has 0–1 integrations connected (and recommended_next
is not null), traffic-impact.js's render path now calls the wizard's
shouldRender → renderState; afterMount calls mount() with an
AMCP_TI_WIZARD_ACTIONS map that proxies button clicks to the same
OAuth/picker handlers settings.js uses.

Pickers open with runInlinePicker's PR-1 mountTarget option so they
render into the wizard's .cc-wizard-step-body div without clobbering
the wizard's navigation buttons.

Also exposes settings.js's runInlinePicker on window so the wizard
module can call it without re-implementing the picker logic."
```

---

## Task 5: Load the new modules + CSS in TrafficImpact.html

**Files:**
- Modify: `site/TrafficImpact.html`

- [ ] **Step 1: Add the script + stylesheet tags**

Read the head/script section of `site/TrafficImpact.html`. Find where `/js/v2/traffic-impact.js` is loaded. Add BEFORE that line:

```html
<link rel="stylesheet" href="/css/integrations-hub.css">
<script src="/js/v2/prereqCoach.js"></script>
<script src="/js/v2/connectorCard.js"></script>
<script src="/js/v2/trafficImpactWizard.js"></script>
```

If `integrations-hub.css` is already loaded (e.g. inherited from a shared chrome `<head>`), only add the missing script tags. If `prereqCoach.js`/`connectorCard.js` are already loaded by the shared chrome (they're loaded by Settings.html via shared.js or similar), only add `trafficImpactWizard.js`.

- [ ] **Step 2: Commit**

```bash
git -C /Users/cameronmcewan/Desktop/advocate/advocatemcp add site/TrafficImpact.html
git -C /Users/cameronmcewan/Desktop/advocate/advocatemcp commit -m "feat(integrations): load wizard modules on /TrafficImpact.html

Adds <script> tags for prereqCoach.js, connectorCard.js, and the new
trafficImpactWizard.js — plus the integrations-hub.css partial — so
the wizard's shouldRender check has its dependencies on the
TrafficImpact page when traffic-impact.js boots."
```

---

## Task 6: CSS for wizard welcome / done / stepper navigation

**Files:**
- Modify: `site/css/integrations-hub.css`

- [ ] **Step 1: Append the wizard layout rules**

Add to the END of `site/css/integrations-hub.css`:

```css

/* ── 11. Traffic Impact wizard layout (Phase 2 PR 3) ───────────────
   The wizard occupies the full main-content area on /TrafficImpact.html
   when shouldRender returns true. Welcome and Done are bespoke cards;
   step view delegates to .cc-wizard-card from PR 2.
*/

.ti-wizard {
  max-width: 720px;
  margin: 32px auto 64px;
  padding: 0 20px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.ti-wizard-eyebrow {
  font-family: var(--mono);
  font-size: 12px;
  letter-spacing: .08em;
  text-transform: uppercase;
  color: var(--maroon, #7d2550);
  margin-bottom: 8px;
}

.ti-wizard-done-eyebrow {
  color: var(--sage, #4a7559);
}

.ti-wizard-title {
  font-family: var(--serif, Georgia);
  font-weight: 400;
  font-size: 36px;
  line-height: 1.1;
  margin: 0 0 16px;
  color: var(--ink, #141210);
}

.ti-wizard-subtitle {
  color: var(--ink-2, #555);
  font-size: 16px;
  line-height: 1.55;
  margin: 0 0 24px;
  max-width: 580px;
}

.ti-wizard-actions {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  align-items: center;
}

.ti-wizard-meta {
  margin-top: 18px;
  font-size: 13px;
  color: var(--muted, #888);
}

.ti-wizard-welcome,
.ti-wizard-done,
.ti-wizard-error-card {
  background: var(--paper, #fff);
  border: 1px solid var(--line, rgba(0,0,0,.08));
  border-radius: 16px;
  padding: 40px;
}

.ti-wizard-stepper-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0 4px;
}

.ti-wizard-step-meta {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--muted, #888);
  letter-spacing: .04em;
}

.ti-wizard-step-foot {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0 4px;
  margin-top: 8px;
}

.ti-wizard-error-card {
  text-align: center;
}

.ti-wizard-error-card p {
  color: var(--red, #b3261e);
  margin-bottom: 14px;
}

.ti-wizard-actions .btn-primary {
  padding: 12px 24px;
  font-size: 15px;
}
```

- [ ] **Step 2: Verify it appended**

Run: `wc -l /Users/cameronmcewan/Desktop/advocate/advocatemcp/site/css/integrations-hub.css`
Expected: line count grew by ~85 lines.

- [ ] **Step 3: Commit**

```bash
git -C /Users/cameronmcewan/Desktop/advocate/advocatemcp add site/css/integrations-hub.css
git -C /Users/cameronmcewan/Desktop/advocate/advocatemcp commit -m "feat(integrations): wizard welcome / done / stepper nav CSS

Layout rules for .ti-wizard, .ti-wizard-welcome, .ti-wizard-done, the
stepper head/foot, and the error card. Reuses existing CSS variables
(--maroon, --ink, --paper, --serif, --mono) from tokens.css. PR-2's
.cc-wizard-card rules drive the active step body; this partial wraps
them with the welcome/done bookends."
```

---

## Task 7: End-to-end manual verification + push

**Files:** none modified.

- [ ] **Step 1: Worker tests + parse checks**

```bash
cd /Users/cameronmcewan/Desktop/advocate/advocatemcp/worker && npm test 2>&1 | grep "Tests" | tail -1
node --check /Users/cameronmcewan/Desktop/advocate/advocatemcp/site/js/v2/trafficImpactWizard.js
node --check /Users/cameronmcewan/Desktop/advocate/advocatemcp/site/js/v2/connectorCard.js
node --check /Users/cameronmcewan/Desktop/advocate/advocatemcp/site/js/v2/traffic-impact.js
node --check /Users/cameronmcewan/Desktop/advocate/advocatemcp/site/js/v2/settings.js
```
Expected: 660 PASS + 4 OK lines.

- [ ] **Step 2: Branch + push + open PR**

```bash
cd /Users/cameronmcewan/Desktop/advocate/advocatemcp
git branch feat/traffic-impact-wizard-pr3-stepper
git push -u origin feat/traffic-impact-wizard-pr3-stepper
gh pr create --base main --head feat/traffic-impact-wizard-pr3-stepper \
  --title "feat: Phase 2 PR 3 — Traffic Impact wizard goes live" \
  --body "..."
```

(PR body template included at the bottom of this plan file.)

- [ ] **Step 3: Manual verification before merge** (controller does this — implementer reports DONE)

The implementer cannot do the manual end-to-end test (requires a real Pro tenant logged into prod). Implementer reports DONE_WITH_CONCERNS noting that manual verification is required before merge per the spec's verification list.

- [ ] **Step 4: Merge after manual verification**

After Cameron walks through the spec's `## Verification` 7-step list and confirms all pass:
```bash
gh pr merge <pr-number> --squash --delete-branch
```

---

## Verification (full set from the spec)

1. Land on `/TrafficImpact.html`. Confirm the wizard renders (not the bare State A button). Welcome card shows step count tailored to recommended chain ("Set up in 4 steps" for Pro, "Set up in 1 step" for Base).
2. Click Start setup → step 1 (GA4) renders with full ConnectorCard in wizard mode, prereq coach inline if applicable, primary CTA "Connect Google Analytics →".
3. Click Connect → redirected to Google OAuth → return to /TrafficImpact.html → wizard re-fetches status, advances to step 2 (GSC).
4. On step 2, click "Pick site →" — picker mounts inline in `.cc-wizard-step-body` (NOT clobbering the wizard navigation buttons). Pick a site → picker resolves → wizard advances to step 3.
5. Click Skip All from any step → wizard hides → empty State A renders → reload page → wizard re-renders (auto-trigger; no localStorage).
6. After connecting 2 integrations (so `completion.connected >= 2`), reload `/TrafficImpact.html` → confirm wizard does NOT render; the actual dashboard renders.
7. Land on `/TrafficImpact.html` as a Base tenant with no integrations → wizard shows 1 step (GA4). Connect GA4 → wizard immediately shows Done card (because `recommended_next: null` after GA4 lands for Base). Reload → no wizard.
