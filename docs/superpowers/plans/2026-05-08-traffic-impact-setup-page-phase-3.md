# Traffic Impact Setup Page — Phase 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a dedicated focus-mode setup page at `/setup/traffic-impact` that renders all 6 integrations as `<ConnectorCard surface="wizard">` cards in a vertical scroll, with a sticky left side rail (progress + jump-to anchors). No sidebar, no topbar — minimal shell.

**Architecture:** New static HTML at `site/setup/traffic-impact.html` outside the v2 dashboard chrome. New `site/js/v2/setupPage.js` IIFE module fetches the integrations status endpoint, renders the side rail + content column, wires action delegation. Reuses Phase 1's `<ConnectorCard>` (in PR 2's wizard surface), `<PrereqCoach>`, `runInlinePicker` (with PR 1's `mountTarget` option), and `/api/client/integrations/status`. No backend change.

**Tech Stack:** Vanilla JS IIFE modules, no bundler, no automated tests on static-site assets — verification via `node --check` + manual.

**Spec:** `docs/superpowers/specs/2026-05-08-traffic-impact-setup-page-phase-3-design.md` (commit `a460bc4`).

---

## File Map

### New
- `site/setup/traffic-impact.html` — minimal page shell (~80 lines)
- `site/js/v2/setupPage.js` — page module (~200 lines)

### Modified
- `site/css/integrations-hub.css` — append `.setup-page-*` rules (~80 lines)
- `site/js/v2/settings.js` — add "Open setup page →" link to hub header
- `site/js/v2/traffic-impact.js` — add "Resume setup →" link in dashboard topbar when wizard isn't showing

### Untouched
- `site/js/v2/connectorCard.js` — wizard surface from PR 2 reused as-is
- `site/js/v2/prereqCoach.js` — reused as-is
- `worker/**` — no backend change

---

## Task 1: Page shell + minimal HTML

**Files:**
- Create: `/Users/cameronmcewan/Desktop/advocate/advocatemcp/site/setup/traffic-impact.html`

- [ ] **Step 1: Create the directory if it doesn't exist**

```bash
mkdir -p /Users/cameronmcewan/Desktop/advocate/advocatemcp/site/setup
```

- [ ] **Step 2: Create the HTML shell**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="light dark" />
  <title>Set Up Traffic Impact — Advocate</title>
  <link rel="icon" type="image/png" href="/assets/favicon.png" />
  <link rel="stylesheet" href="/css/tokens.css" />
  <link rel="stylesheet" href="/assets/styles.css" />
  <link rel="stylesheet" href="/css/integrations-hub.css" />
  <link rel="preconnect" href="https://api.fontshare.com" />
  <link href="https://api.fontshare.com/v2/css?f[]=general-sans@400,500,600&display=swap" rel="stylesheet" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&display=swap" rel="stylesheet" />
</head>
<body class="setup-page-body">
  <header class="setup-page-header">
    <a href="/Settings.html" class="setup-page-back" aria-label="Back to Settings">
      <span class="setup-page-back-arrow">←</span>
      <span>Back</span>
    </a>
    <div class="setup-page-title">Set up Traffic Impact</div>
    <button type="button" class="btn btn-ghost btn-sm setup-page-signout" id="setup-page-signout">Sign out</button>
  </header>

  <main class="setup-page-main">
    <aside class="setup-page-rail" id="setup-page-rail">
      <div class="setup-page-rail-loading">Loading…</div>
    </aside>
    <section class="setup-page-content" id="setup-page-content">
      <div class="setup-page-loading">Loading your integrations…</div>
    </section>
  </main>

  <script src="/js/dashboard-auth.js"></script>
  <script src="/js/v2/prereqCoach.js"></script>
  <script src="/js/v2/connectorCard.js"></script>
  <script src="/js/v2/setupPage.js"></script>
</body>
</html>
```

- [ ] **Step 3: Commit**

```bash
git -C /Users/cameronmcewan/Desktop/advocate/advocatemcp add site/setup/traffic-impact.html
git -C /Users/cameronmcewan/Desktop/advocate/advocatemcp commit -m "feat(integrations): page shell for /setup/traffic-impact

Minimal focus-mode HTML — no sidebar, no topbar, no v2 shell. Just
back-arrow header, two-column main (side rail + content), and the
4 script modules the page needs. setupPage.js (next task) will fetch
the integrations status and populate the rail + content."
```

---

## Task 2: Page module skeleton + auth + boot

**Files:**
- Create: `/Users/cameronmcewan/Desktop/advocate/advocatemcp/site/js/v2/setupPage.js`

- [ ] **Step 1: Write the skeleton**

```js
// site/js/v2/setupPage.js
//
// Phase-3 dedicated focus-mode page at /setup/traffic-impact. Renders
// all 6 integrations as <ConnectorCard surface="wizard"> cards in a
// vertical scroll, with a sticky left side rail showing progress +
// jump-to anchors. No v2 dashboard chrome — this is its own minimal
// page shell (see site/setup/traffic-impact.html).
//
// Reuses:
//   - Phase 1: /api/client/integrations/status, prereqCoach.js
//   - Phase 2 PR 1: runInlinePicker mountTarget option
//   - Phase 2 PR 2: connectorCard.js surface:"wizard"
//
// Spec: docs/superpowers/specs/2026-05-08-traffic-impact-setup-page-phase-3-design.md

(function () {
  'use strict';

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Maps integration_id → DOM id of legacy card on Settings.html.
  // Same mapping as traffic-impact.js's LEGACY_CARD_IDS — Phase 1.5 will
  // extract this into a shared connectorActions.js module.
  const LEGACY_CARD_IDS = {
    ga4:            'legacy-ga4-card',
    gsc:            'legacy-gsc-card',
    hubspot:        'legacy-crm-card',
    salesforce:     'legacy-crm-card',
    stripe_webhook: 'legacy-revenue-webhook-card',
    authority:      'legacy-authority-card',
  };

  function legacyCardUrl(integrationId) {
    const id = LEGACY_CARD_IDS[integrationId];
    let url = id ? '/Settings.html#' + id : '/Settings.html';
    try {
      const asSlug = new URL(window.location.href).searchParams.get('as');
      if (asSlug) {
        url = url.indexOf('#') >= 0
          ? url.replace('#', '?as=' + encodeURIComponent(asSlug) + '#')
          : url + '?as=' + encodeURIComponent(asSlug);
      }
    } catch (_) { /* URL parse error → no slug appended */ }
    return url;
  }

  // Boot — Tasks 3-5 fill in renderRail, renderContent, wireActions
  async function boot() {
    const authed = await window.AMCP.requireAuth();
    if (!authed) return;

    // Sign-out wire
    const signOutBtn = document.getElementById('setup-page-signout');
    if (signOutBtn) {
      signOutBtn.addEventListener('click', () => window.AMCP.logout());
    }

    // Fetch hub status
    let hub = null;
    try {
      const r = await window.AMCP.authedFetch('/api/client/integrations/status');
      if (r.ok) hub = await r.json();
    } catch (_) { /* hub stays null → render error */ }

    if (!hub) {
      const content = document.getElementById('setup-page-content');
      if (content) {
        content.innerHTML = '<div class="setup-page-error">Couldn\'t load your integrations. <button type="button" class="btn btn-ghost btn-sm" onclick="window.location.reload()">Refresh</button></div>';
      }
      return;
    }

    // Tasks 3-5 fill these in
    renderRail(hub);
    renderContent(hub);
    wireActions(hub);
  }

  // Stubs filled in by subsequent tasks
  function renderRail() {}
  function renderContent() {}
  function wireActions() {}

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
```

- [ ] **Step 2: Verify it parses**

Run: `node --check /Users/cameronmcewan/Desktop/advocate/advocatemcp/site/js/v2/setupPage.js`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git -C /Users/cameronmcewan/Desktop/advocate/advocatemcp add site/js/v2/setupPage.js
git -C /Users/cameronmcewan/Desktop/advocate/advocatemcp commit -m "feat(integrations): setupPage.js skeleton — auth + hub fetch + legacyCardUrl

Boots on DOMContentLoaded, calls AMCP.requireAuth (redirects to login
on fail), fetches /api/client/integrations/status, and dispatches to
renderRail / renderContent / wireActions stubs (filled in by tasks 3-5).
Carries the legacyCardUrl helper that mirrors traffic-impact.js's
mapping for deep-links to legacy Settings cards."
```

---

## Task 3: renderContent — welcome card + 6 connector cards

**Files:**
- Modify: `site/js/v2/setupPage.js`

- [ ] **Step 1: Replace the renderContent stub**

Find:
```js
  function renderContent() {}
```

Replace with:

```js
  function renderContent(hub) {
    const root = document.getElementById('setup-page-content');
    if (!root) return;

    const integrations = (hub.integrations || []);
    const completion = hub.completion || { connected: 0, available: 0 };

    // Welcome card (compact — the rail handles progress + nav)
    const welcomeHtml = `
      <div class="setup-page-welcome">
        <h1>These connections power your Traffic Impact dashboard.</h1>
        <p>Set them up in any order. Your dashboard fills in as data syncs from each connection.</p>
        <div class="setup-page-welcome-meta">${escHtml(completion.connected)} of ${escHtml(completion.available)} connected · ${escHtml(completion.pct)}% complete</div>
      </div>`;

    // Connector cards in recommended_next chain order, with non-recommended
    // (e.g. Salesforce) appended after. plan_locked rows still render so
    // Base tenants see what they're missing + the upgrade CTA.
    const ORDER = ['ga4', 'gsc', 'hubspot', 'salesforce', 'stripe_webhook', 'authority'];
    const sorted = ORDER
      .map(id => integrations.find(i => i.id === id))
      .filter(Boolean);

    const cardsHtml = sorted.map(integration => {
      const cardHtml = (window.AMCP_CONNECTOR_CARD && window.AMCP_CONNECTOR_CARD.render)
        ? window.AMCP_CONNECTOR_CARD.render(integration, 'wizard')
        : `<div class="setup-page-error">Connector card module didn't load — refresh to retry.</div>`;
      // Wrap each card in an anchor target div so the side rail jump-to works
      return `<div class="setup-page-card-wrap" id="setup-card-${escHtml(integration.id)}">${cardHtml}</div>`;
    }).join('');

    root.innerHTML = welcomeHtml + cardsHtml;
  }
```

- [ ] **Step 2: Verify parse**

Run: `node --check /Users/cameronmcewan/Desktop/advocate/advocatemcp/site/js/v2/setupPage.js`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git -C /Users/cameronmcewan/Desktop/advocate/advocatemcp add site/js/v2/setupPage.js
git -C /Users/cameronmcewan/Desktop/advocate/advocatemcp commit -m "feat(integrations): setupPage renderContent — welcome + 6 connector cards

Renders a compact welcome card + all 6 integrations as connector cards
in surface:'wizard' mode (full-card layout from PR 2). Each card
wrapped in a setup-card-<id> anchor div so the side rail's jump-to
links can scroll to it. Order follows the recommended chain with
Salesforce appended, then plan-locked rows render last."
```

---

## Task 4: renderRail — progress + jump-to anchors

**Files:**
- Modify: `site/js/v2/setupPage.js`

- [ ] **Step 1: Replace the renderRail stub**

Find:
```js
  function renderRail() {}
```

Replace with:

```js
  function renderRail(hub) {
    const rail = document.getElementById('setup-page-rail');
    if (!rail) return;

    const integrations = (hub.integrations || []);
    const completion = hub.completion || { connected: 0, available: 0 };

    const STATUS_DOT = {
      not_connected:            '○',
      connecting:               '◐',
      connected_pending_config: '◐',
      connected_active:         '✓',
      connected_error:          '!',
      disconnected:             '○',
      plan_locked:              '🔒',
    };

    const ORDER = ['ga4', 'gsc', 'hubspot', 'salesforce', 'stripe_webhook', 'authority'];
    const items = ORDER
      .map(id => integrations.find(i => i.id === id))
      .filter(Boolean);

    const itemsHtml = items.map(i => {
      const dot = STATUS_DOT[i.status] || '○';
      const isConnected = i.status === 'connected_active' || i.status === 'connected_pending_config' || i.status === 'connected_error';
      const cls = i.status === 'plan_locked' ? 'setup-rail-item-locked' : (isConnected ? 'setup-rail-item-done' : 'setup-rail-item-todo');
      return `
        <li class="setup-rail-item ${cls}">
          <a href="#setup-card-${escHtml(i.id)}" data-rail-jump="${escHtml(i.id)}">
            <span class="setup-rail-dot">${dot}</span>
            <span class="setup-rail-name">${escHtml(i.name)}</span>
          </a>
        </li>`;
    }).join('');

    rail.innerHTML = `
      <div class="setup-page-rail-inner">
        <div class="setup-page-rail-header">
          <div class="setup-page-rail-title">Progress</div>
          <div class="setup-page-rail-progress">
            <div class="setup-page-rail-progress-bar">
              <div class="setup-page-rail-progress-fill" style="width: ${escHtml(completion.pct)}%"></div>
            </div>
            <div class="setup-page-rail-progress-meta">${escHtml(completion.connected)} of ${escHtml(completion.available)} · ${escHtml(completion.pct)}%</div>
          </div>
        </div>
        <ul class="setup-rail-list">${itemsHtml}</ul>
        <div class="setup-page-rail-footer">
          <button type="button" class="btn btn-ghost btn-sm setup-page-exit" id="setup-page-exit">Save & exit</button>
        </div>
      </div>`;
  }
```

- [ ] **Step 2: Verify parse**

Run: `node --check /Users/cameronmcewan/Desktop/advocate/advocatemcp/site/js/v2/setupPage.js`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git -C /Users/cameronmcewan/Desktop/advocate/advocatemcp add site/js/v2/setupPage.js
git -C /Users/cameronmcewan/Desktop/advocate/advocatemcp commit -m "feat(integrations): setupPage renderRail — progress + jump-to anchors

Sticky left side rail showing progress bar (X/Y · pct%) and the 6
integrations as a list with status dots + click-to-anchor-scroll.
plan-locked rows show with a 🔒 dot; connected_active rows show ✓.
Save & exit button at the bottom of the rail."
```

---

## Task 5: wireActions — click delegation + jump-to scrolling

**Files:**
- Modify: `site/js/v2/setupPage.js`

- [ ] **Step 1: Replace the wireActions stub + helpers**

Find:
```js
  function wireActions() {}
```

Replace with:

```js
  function wireActions(hub) {
    // Save & exit
    const exitBtn = document.getElementById('setup-page-exit');
    if (exitBtn) {
      exitBtn.addEventListener('click', () => {
        const ref = document.referrer;
        if (ref && ref.indexOf(window.location.origin) === 0) {
          window.location.href = ref;
        } else {
          window.location.href = '/Settings.html';
        }
      });
    }

    // Side rail jump-to (smooth scroll + brief highlight)
    const rail = document.getElementById('setup-page-rail');
    if (rail) {
      rail.addEventListener('click', (e) => {
        const link = e.target.closest('[data-rail-jump]');
        if (!link) return;
        e.preventDefault();
        const id = link.getAttribute('data-rail-jump');
        const target = document.getElementById('setup-card-' + id);
        if (!target) return;
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        flashHighlight(target);
      });
    }

    // Action buttons (data-cc-action) on connector cards
    const content = document.getElementById('setup-page-content');
    if (content) {
      content.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-cc-action]');
        if (!btn) return;
        const action = btn.getAttribute('data-cc-action');
        const id = btn.getAttribute('data-cc-id');
        if (!action || !id || action === 'upgrade') return;
        e.preventDefault();
        handleAction(id, action, btn);
      });
    }
  }

  function flashHighlight(el) {
    const original = el.style.boxShadow;
    el.style.transition = 'box-shadow 200ms';
    el.style.boxShadow = '0 0 0 3px var(--maroon, #7d2550)';
    setTimeout(() => { el.style.boxShadow = original; }, 1400);
  }

  function handleAction(integrationId, action, btn) {
    if (action === 'connect') {
      startConnect(integrationId, btn);
      return;
    }
    if (action === 'pick_property' || action === 'pick_site') {
      const card = btn.closest('.cc-wizard-card');
      const stepBody = card ? card.querySelector('.cc-wizard-step-body') : null;
      openPicker(integrationId, btn, stepBody);
      return;
    }
    // disconnect / resync / configure / generate / rotate / edit
    // → deep-link to legacy Settings card. Phase 1.5 inlines these forms.
    window.location.href = legacyCardUrl(integrationId);
  }

  async function startConnect(integrationId, btn) {
    const paths = {
      ga4:        '/api/client/ga4/start-link',
      gsc:        '/api/client/gsc/start-link',
      hubspot:    '/api/client/crm/start-link?provider=hubspot',
      salesforce: '/api/client/crm/start-link?provider=salesforce',
    };
    const path = paths[integrationId];
    if (!path) {
      // Authority + Stripe webhook don't OAuth-connect; deep-link to legacy.
      window.location.href = legacyCardUrl(integrationId);
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

  function openPicker(integrationId, btn, mountTarget) {
    if (typeof window.runInlinePicker !== 'function') {
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
```

**Critical**: this depends on `window.runInlinePicker` being exposed by `settings.js` (done in Phase 2 PR 3). Confirm by grepping: `grep -n "window.runInlinePicker = " /Users/cameronmcewan/Desktop/advocate/advocatemcp/site/js/v2/settings.js` — expected 1 match. The setup page does NOT load `settings.js`, so this means we need to either also load `settings.js` from the page shell OR copy the runInlinePicker function. The plan goes with: include `settings.js` from the page shell so the existing `window.runInlinePicker` is available.

If `settings.js` proves heavyweight to include (it has its own DOMContentLoaded boot path that might fire on the wrong page), consider Phase 1.5 extraction. For Phase 3 v1, including settings.js is the simplest correct path.

- [ ] **Step 2: Add settings.js to the page shell**

Modify `/Users/cameronmcewan/Desktop/advocate/advocatemcp/site/setup/traffic-impact.html` — find the existing script tags and add `/js/v2/settings.js` BEFORE `setupPage.js`. The shell becomes:

```html
  <script src="/js/dashboard-auth.js"></script>
  <script src="/js/v2/prereqCoach.js"></script>
  <script src="/js/v2/connectorCard.js"></script>
  <script src="/js/v2/settings.js"></script>
  <script src="/js/v2/setupPage.js"></script>
```

settings.js's IIFE registers `window.runInlinePicker`. The setup page only uses that one export.

**Caveat**: settings.js's boot code may try to render Settings UI. If it errors loudly when not on `/Settings.html`, this breaks. Check the head of `settings.js` — it likely has a guard like `document.getElementById('settings-root')` that returns false on this page, making boot a no-op. If it doesn't have such a guard, add one as a small follow-up edit (see Step 3).

- [ ] **Step 3: Defensive guard in settings.js (only if needed)**

Look at the boot path of `settings.js` — find where it calls `window.AMCP_SHELL.boot(...)` or starts its own DOMContentLoaded handler. If it boots unconditionally, add a guard at the top:

```js
// Phase 3: settings.js may load on /setup/traffic-impact for the
// runInlinePicker export. Skip the Settings-page boot when the
// expected mount point isn't present.
if (!document.getElementById('settings-root') && window.location.pathname !== '/Settings.html') {
  // Still expose runInlinePicker since other pages need it.
  window.runInlinePicker = window.runInlinePicker || runInlinePicker;
  return;
}
```

(Insert at the top of the IIFE body, after the `'use strict';` line. Adjust the mount-point id if it's different.)

If settings.js's existing flow already no-ops cleanly when its DOM isn't present (most likely the case since `getElementById(...)` will return null and the boot will short-circuit), skip this step.

- [ ] **Step 4: Verify parse + commit**

```bash
node --check /Users/cameronmcewan/Desktop/advocate/advocatemcp/site/js/v2/setupPage.js
node --check /Users/cameronmcewan/Desktop/advocate/advocatemcp/site/js/v2/settings.js
```
Both exit 0.

```bash
git -C /Users/cameronmcewan/Desktop/advocate/advocatemcp add site/js/v2/setupPage.js site/setup/traffic-impact.html
git -C /Users/cameronmcewan/Desktop/advocate/advocatemcp commit -m "feat(integrations): setupPage wireActions — clicks + jump-to + picker

Save & exit returns to document.referrer (or /Settings.html). Side
rail jump-to does smooth scroll + brief maroon outline pulse on the
target card. Connector card buttons (data-cc-action) delegate to:
- connect → OAuth start-link redirect
- pick_property/pick_site → runInlinePicker with mountTarget set
- everything else → legacyCardUrl deep-link to Settings

settings.js loaded via the page shell to expose window.runInlinePicker."
```

(If a settings.js guard was needed in Step 3, include `site/js/v2/settings.js` in the `git add`.)

---

## Task 6: CSS for setup page

**Files:**
- Modify: `site/css/integrations-hub.css`

- [ ] **Step 1: Append the rules**

Read the END of the file first. Then append:

```css

/* ── 12. Setup page (Phase 3) ─────────────────────────────────────
   Dedicated focus-mode page at /setup/traffic-impact. Two-column
   layout with a sticky left rail (progress + jump-to anchors) and
   a centered content column.
*/

.setup-page-body {
  background: var(--paper-2, #faf7f2);
  min-height: 100vh;
  margin: 0;
  font-family: var(--sans, system-ui);
}

.setup-page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 28px;
  background: var(--paper, #fff);
  border-bottom: 1px solid var(--line, rgba(0,0,0,.08));
  position: sticky;
  top: 0;
  z-index: 10;
}

.setup-page-back {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  text-decoration: none;
  color: var(--ink-2, #555);
  font-size: 14px;
}

.setup-page-back:hover { color: var(--maroon, #7d2550); }
.setup-page-back-arrow { font-size: 18px; line-height: 1; }

.setup-page-title {
  font-family: var(--serif, Georgia);
  font-size: 18px;
  color: var(--ink, #141210);
}

.setup-page-main {
  display: grid;
  grid-template-columns: 280px 1fr;
  gap: 32px;
  max-width: 1100px;
  margin: 0 auto;
  padding: 32px 28px 96px;
}

.setup-page-rail {
  position: sticky;
  top: 88px;
  align-self: start;
}

.setup-page-rail-inner {
  background: var(--paper, #fff);
  border: 1px solid var(--line, rgba(0,0,0,.08));
  border-radius: 12px;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.setup-page-rail-title {
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: .08em;
  text-transform: uppercase;
  color: var(--maroon, #7d2550);
  margin-bottom: 8px;
}

.setup-page-rail-progress {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.setup-page-rail-progress-bar {
  height: 6px;
  background: var(--line, rgba(0,0,0,.08));
  border-radius: 999px;
  overflow: hidden;
}

.setup-page-rail-progress-fill {
  height: 100%;
  background: var(--maroon, #7d2550);
  transition: width 200ms ease;
}

.setup-page-rail-progress-meta {
  font-size: 12px;
  color: var(--muted, #888);
  font-family: var(--mono);
}

.setup-rail-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.setup-rail-item a {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 6px;
  text-decoration: none;
  color: var(--ink-2, #555);
  font-size: 13.5px;
  transition: background .12s ease;
}

.setup-rail-item a:hover {
  background: var(--paper-2, #faf7f2);
  color: var(--ink, #141210);
}

.setup-rail-dot {
  display: inline-grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: 999px;
  font-size: 11px;
  flex-shrink: 0;
}

.setup-rail-item-todo .setup-rail-dot {
  border: 1px solid var(--line);
  color: var(--muted);
}

.setup-rail-item-done .setup-rail-dot {
  background: var(--sage, #4a7559);
  color: white;
}

.setup-rail-item-locked .setup-rail-dot {
  background: var(--maroon-tint, rgba(125,37,80,.1));
  color: var(--maroon, #7d2550);
}

.setup-page-rail-footer {
  border-top: 1px solid var(--line, rgba(0,0,0,.08));
  padding-top: 12px;
  margin-top: 4px;
}

.setup-page-content {
  display: flex;
  flex-direction: column;
  gap: 20px;
  max-width: 720px;
}

.setup-page-welcome {
  background: var(--paper, #fff);
  border: 1px solid var(--line, rgba(0,0,0,.08));
  border-radius: 16px;
  padding: 32px;
}

.setup-page-welcome h1 {
  font-family: var(--serif, Georgia);
  font-weight: 400;
  font-size: 28px;
  line-height: 1.15;
  margin: 0 0 12px;
  color: var(--ink, #141210);
}

.setup-page-welcome p {
  color: var(--ink-2, #555);
  font-size: 15px;
  line-height: 1.55;
  margin: 0 0 16px;
}

.setup-page-welcome-meta {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--muted, #888);
}

.setup-page-card-wrap {
  /* Anchor target for side rail jump-to. The .cc-wizard-card inside
     it owns its own padding + border. */
  scroll-margin-top: 80px;
}

.setup-page-loading,
.setup-page-rail-loading {
  padding: 24px;
  color: var(--muted, #888);
  text-align: center;
}

.setup-page-error {
  padding: 24px;
  background: rgba(180, 40, 40, 0.08);
  border: 1px solid rgba(180, 40, 40, 0.25);
  color: var(--red, #b3261e);
  border-radius: 8px;
}

@media (max-width: 880px) {
  .setup-page-main {
    grid-template-columns: 1fr;
  }
  .setup-page-rail {
    position: static;
  }
}
```

- [ ] **Step 2: Verify**

```bash
wc -l /Users/cameronmcewan/Desktop/advocate/advocatemcp/site/css/integrations-hub.css
grep -c "setup-page" /Users/cameronmcewan/Desktop/advocate/advocatemcp/site/css/integrations-hub.css
```
Expected: line count grew, ≥10 setup-page rules.

- [ ] **Step 3: Commit**

```bash
git -C /Users/cameronmcewan/Desktop/advocate/advocatemcp add site/css/integrations-hub.css
git -C /Users/cameronmcewan/Desktop/advocate/advocatemcp commit -m "feat(integrations): setup page CSS — page shell + side rail layout

Two-column layout (280px sticky rail + flexible content column),
header with back-arrow + sign-out, rail with progress bar + jump-to
list, welcome card, error/loading states. Reuses existing CSS vars
(--paper, --maroon, --sage, --line, --serif, --mono).

Mobile: collapses to single-column at <880px (rail stacks above)."
```

---

## Task 7: Entry-point links from Settings hub + TrafficImpact dashboard

**Files:**
- Modify: `site/js/v2/settings.js` — add "Open setup page →" link to hub header
- Modify: `site/js/v2/traffic-impact.js` — add "Resume setup →" link in dashboard

- [ ] **Step 1: settings.js — add link in hub header**

In `site/js/v2/settings.js`, find the hub render code (search for `Traffic Impact integrations` — should be in the section that mounts `<div id="cc-hub">`). The hub header today shows the completion summary; add an "Open setup page →" link at the right side.

The cleanest spot: inside the existing `card-head` div that wraps the title. Add a link element:

```html
<a href="/setup/traffic-impact" class="setup-page-link" style="margin-left:auto">Open setup page →</a>
```

Or — if connectorCard.js is what renders the hub head and editing connectorCard would be wider scope — instead modify settings.js's hub render path to inject the link AFTER the connectorCard hub renders (e.g. as a sibling element in the wrapping `<div class="row single">`).

The simplest correct path: edit `connectorCard.js`'s `renderHub` to optionally include the link. But that conflicts with the "untouched" constraint above — `connectorCard.js` shouldn't change for Phase 3.

**Compromise**: in `settings.js`'s `afterMount`, query the rendered hub's card-head and append the link via `appendChild` or `insertAdjacentHTML`. That way no module changes, just settings.js wiring.

```js
// Inside afterMount, after the existing hub-mount block:
const hubCard = document.getElementById('cc-hub');
if (hubCard) {
  const head = hubCard.querySelector('.card-head');
  if (head && !head.querySelector('.setup-page-link')) {
    head.insertAdjacentHTML('beforeend', '<a href="/setup/traffic-impact" class="setup-page-link" style="margin-left:auto;font-size:13.5px;color:var(--maroon);text-decoration:none">Open setup page →</a>');
  }
}
```

Place this just after the existing hub-action-delegator wiring in `afterMount`.

- [ ] **Step 2: traffic-impact.js — add link in dashboard topbar**

In `site/js/v2/traffic-impact.js`, find the dashboard render path (the path that runs when wizard `shouldRender` returns false — i.e., the actual dashboard content). At the top of that render, add a "Resume setup →" link if the tenant isn't fully set up.

The simplest spot: in `afterMount` after the wizard shouldRender check (which returns early if wizard is rendering). When the wizard ISN'T rendering, check if `data.integrationsHub` shows progress < 100% AND the user has at least 2 connections (so they're past the wizard threshold but not done). If so, inject a link.

```js
// In afterMount, after the wizard early-return:
const hub = data.integrationsHub;
if (hub && hub.completion && hub.completion.connected >= 2 && hub.recommended_next != null) {
  // User is past the wizard threshold but has more to set up. Surface a
  // small "Resume setup →" link in the dashboard so they can return to
  // the focused setup page anytime.
  const topbar = document.querySelector('.topbar') || document.querySelector('.page-topbar');
  if (topbar && !topbar.querySelector('.resume-setup-link')) {
    topbar.insertAdjacentHTML('beforeend', '<a href="/setup/traffic-impact" class="resume-setup-link" style="margin-left:auto;font-size:13.5px;color:var(--maroon);text-decoration:none">Resume setup →</a>');
  }
}
```

If `.topbar` / `.page-topbar` selectors don't match (the v2 chrome might use a different class), grep `site/js/v2/shell.js` to find what the topbar element is. The link can also go inside the page's `#page-content` head — adapt to whatever's available. The key is it's visible above-the-fold on the dashboard.

- [ ] **Step 3: Verify**

```bash
node --check /Users/cameronmcewan/Desktop/advocate/advocatemcp/site/js/v2/settings.js
node --check /Users/cameronmcewan/Desktop/advocate/advocatemcp/site/js/v2/traffic-impact.js
```
Both exit 0.

- [ ] **Step 4: Commit**

```bash
git -C /Users/cameronmcewan/Desktop/advocate/advocatemcp add site/js/v2/settings.js site/js/v2/traffic-impact.js
git -C /Users/cameronmcewan/Desktop/advocate/advocatemcp commit -m "feat(integrations): entry-point links to /setup/traffic-impact

- Settings.html: hub card header gets an 'Open setup page →' link
  injected after mount (no connectorCard.js change needed).
- TrafficImpact.html: when the wizard isn't rendering AND the tenant
  isn't fully set up, a 'Resume setup →' link surfaces in the
  dashboard topbar so users can return to the focused flow anytime.

Both link to /setup/traffic-impact. Phase 3's setup page is now
discoverable from both surfaces."
```

---

## Task 8: End-to-end manual verification + branch + push + PR

**Files:** none modified.

- [ ] **Step 1: Worker tests + parse checks**

```bash
cd /Users/cameronmcewan/Desktop/advocate/advocatemcp/worker && npm test 2>&1 | grep "Tests" | tail -1
node --check /Users/cameronmcewan/Desktop/advocate/advocatemcp/site/js/v2/setupPage.js
node --check /Users/cameronmcewan/Desktop/advocate/advocatemcp/site/js/v2/settings.js
node --check /Users/cameronmcewan/Desktop/advocate/advocatemcp/site/js/v2/traffic-impact.js
node --check /Users/cameronmcewan/Desktop/advocate/advocatemcp/site/js/v2/connectorCard.js
node --check /Users/cameronmcewan/Desktop/advocate/advocatemcp/site/js/v2/prereqCoach.js
```
Expected: 660 PASS + 5 OK.

- [ ] **Step 2: Branch + push + open PR**

```bash
git -C /Users/cameronmcewan/Desktop/advocate/advocatemcp branch feat/traffic-impact-setup-page-phase3
git -C /Users/cameronmcewan/Desktop/advocate/advocatemcp push -u origin feat/traffic-impact-setup-page-phase3
cd /Users/cameronmcewan/Desktop/advocate/advocatemcp
gh pr create --base main --head feat/traffic-impact-setup-page-phase3 \
  --title "feat: Phase 3 — dedicated /setup/traffic-impact page" \
  --body "<see PR template at the bottom of this plan file>"
```

- [ ] **Step 3: Manual verification before merge** (controller does this — implementer reports DONE_WITH_CONCERNS noting manual gate)

Verification list per the spec's `## Verification` section. Cameron walks through 10 steps on a Pro tenant.

- [ ] **Step 4: Merge after manual verification**

```bash
gh pr merge <pr-number> --squash --delete-branch
```

---

## Verification (full set from spec)

1. Navigate to `/setup/traffic-impact` directly. Page renders with no sidebar/topbar, the side rail on the left, the welcome card + 6 connector cards in scroll on the right.
2. Side rail shows correct progress (e.g. 2/6 · 33% if 2 connected) and the integration list with status pills.
3. Click a side-rail integration name → page scrolls to + briefly highlights the corresponding card.
4. From a partially set up state, click "Connect HubSpot →" → OAuth redirect → return → page reloads → side rail updates to 3/6.
5. Click "Pick property →" on a `connected_pending_config` GA4 card → picker mounts inline in `.cc-wizard-step-body` (NOT clobbering the card's other action buttons).
6. Click "Save & exit" in the side rail → navigates to `document.referrer` or `/Settings.html`.
7. From `/Settings.html` integrations hub, click "Open setup page →" link → arrives at `/setup/traffic-impact` with the same data.
8. From `/TrafficImpact.html` (with 2+ connected so wizard isn't showing), click the "Resume setup →" link in the topbar → arrives at `/setup/traffic-impact`.
9. Visit `/setup/traffic-impact` while logged out → redirects to `/login.html?next=/setup/traffic-impact`.
10. As a Base tenant: page renders with only GA4 connectable; Pro integrations show plan_locked with maroon "Pro" pill + Upgrade button.

Phase 1.5 follow-ups (file as separate plan):
- Inline forms for Authority Kit + Stripe webhook into ConnectorCard (replaces "scroll to legacy" fallback on hub + wizard + setup page)
- Extract shared `connectorActions.js` module from the 3× duplication across settings.js / trafficImpactWizard.js / setupPage.js
- Wire onboarding/post-payment redirect to `/setup/traffic-impact` (touches `worker/src/routes/activatePage.ts` + Stripe success redirect)
