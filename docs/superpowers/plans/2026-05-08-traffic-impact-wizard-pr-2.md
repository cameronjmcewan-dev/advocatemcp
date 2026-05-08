# Traffic Impact Wizard — PR 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `surface: "wizard"` rendering mode to `connectorCard.js` — a full-card layout (not the hub's accordion row) with bulleted value props, inline `<PrereqCoach>`, vertical action stack, and a `.cc-wizard-step-body` mount-point div for the picker.

**Architecture:** New `renderWizard(integration)` helper inside the connectorCard IIFE. The existing `render(integration, surface)` dispatches to `renderWizard` when `surface === "wizard"`, else falls through to the existing hub layout. Hub rendering is byte-identical. New CSS classes `.cc-wizard-*` join the existing `integrations-hub.css` partial.

**Tech Stack:** Vanilla JS IIFE, no bundler, no automated tests on static-site assets — verification via `node --check` + manual.

**Spec:** `docs/superpowers/specs/2026-05-08-traffic-impact-wizard-phase-2-design.md` (commit `7bd449d`).

**Out of scope:** PR 3 (the stepper module + traffic-impact.js wire-up). The wizard surface defined here is dormant until PR 3 calls it.

---

## File Map

### Modified
- `site/js/v2/connectorCard.js` — add `renderWizard(integration)` helper + dispatch from `render(integration, surface)`.
- `site/css/integrations-hub.css` — add `.cc-wizard-card`, `.cc-wizard-name`, `.cc-wizard-status`, `.cc-wizard-values`, `.cc-wizard-coach`, `.cc-wizard-step-body`, `.cc-wizard-actions` rules.

### Untouched
- `site/js/v2/prereqCoach.js` — already exposes `window.AMCP_PREREQ_COACH.render(coachId)`. Wizard renders just call it.
- Existing hub call sites + every `wire*Card` legacy function — wizard surface is dormant until PR 3.

---

## Task 1: Add `renderWizard` + dispatch in connectorCard.js

**Files:**
- Modify: `/Users/cameronmcewan/Desktop/advocate/advocatemcp/site/js/v2/connectorCard.js` (~lines 47-105 region)

- [ ] **Step 1: Replace the existing `render(integration, surface)` to dispatch on surface**

Find the existing `function render(integration, surface) {` block (around line 52) and add a wizard-dispatch line at the top:

```js
  function render(integration, surface) {
    surface = surface || 'hub';
    if (surface === 'wizard') return renderWizard(integration);
    // ... existing hub rendering body unchanged below ...
```

- [ ] **Step 2: Add `renderWizard(integration)` helper above `render`**

Insert this helper just BEFORE the existing `function render(integration, surface)` declaration (so dispatch can call it):

```js
  /**
   * Wizard-mode render: full-card layout for the Phase-2 stepper. Differs
   * from the hub's accordion row in:
   *   - larger heading, status pill on its own line
   *   - bulleted value_props (not just first oneliner)
   *   - <PrereqCoach> inlined above the action button
   *   - vertical action stack (primary CTA on top, ghost actions below)
   *   - dedicated <div class="cc-wizard-step-body"> the wizard stepper
   *     uses as the picker mountTarget so picker rendering doesn't
   *     clobber the wizard's own navigation buttons
   */
  function renderWizard(integration) {
    const pill = STATUS_PILL[integration.status] || STATUS_PILL.not_connected;
    const dot = pill.cls.indexOf('dot-chip') >= 0 ? '<span class="dot"></span>' : '';

    const values = (integration.value_props || []).map(v =>
      `<li>${escHtml(v)}</li>`
    ).join('');

    // Inline coaching for prereqs that have a coach_id
    const coachHtml = (integration.external_prereqs || [])
      .filter(p => p && p.coach_id)
      .map(p => {
        const coach = (window.AMCP_PREREQ_COACH && window.AMCP_PREREQ_COACH.render)
          ? window.AMCP_PREREQ_COACH.render(p.coach_id)
          : '';
        return coach;
      })
      .join('');

    // Same action labels + button styling rules as the hub render — kept inline
    // here rather than DRY'd into a shared helper because the wizard layout
    // stacks them vertically (primary CTA full-width, ghost actions below).
    const actionLabels = {
      connect:       'Connect →',
      pick_property: 'Pick property →',
      pick_site:     'Pick site →',
      configure:     'Configure →',
      generate:      'Generate webhook →',
      rotate:        'Rotate secret',
      resync:        'Resync now',
      disconnect:    'Disconnect',
      edit:          'Edit',
      upgrade:       'Upgrade to Pro →',
    };
    const actionsHtml = (integration.actions || []).map((a) => {
      const isPrimary = (a === 'connect' || a === 'configure' || a === 'generate' || a === 'upgrade');
      const cls = isPrimary ? 'btn btn-primary' : 'btn btn-ghost btn-sm';
      const href = a === 'upgrade' ? ' href="/Billing.html"' : '';
      const tag = a === 'upgrade' ? 'a' : 'button';
      const typeAttr = a === 'upgrade' ? '' : ' type="button"';
      return `<${tag} class="${cls}" data-cc-action="${escHtml(a)}" data-cc-id="${escHtml(integration.id)}"${typeAttr}${href}>${escHtml(actionLabels[a] || a)}</${tag}>`;
    }).join('');

    const errorPill = integration.last_sync_error
      ? `<div class="cc-wizard-error">${escHtml(String(integration.last_sync_error).slice(0, 200))}</div>`
      : '';

    return `
      <div class="cc-wizard-card" data-cc-row="${escHtml(integration.id)}">
        <div class="cc-wizard-name">${escHtml(integration.name)}</div>
        <div class="cc-wizard-status">
          <span class="${pill.cls}">${dot}${escHtml(pill.label)}</span>
        </div>
        ${values ? `<ul class="cc-wizard-values">${values}</ul>` : ''}
        ${coachHtml ? `<div class="cc-wizard-coach">${coachHtml}</div>` : ''}
        ${errorPill}
        <div class="cc-wizard-step-body"></div>
        <div class="cc-wizard-actions">${actionsHtml}</div>
      </div>`;
  }
```

- [ ] **Step 3: Verify parse**

Run: `node --check /Users/cameronmcewan/Desktop/advocate/advocatemcp/site/js/v2/connectorCard.js`
Expected: exits 0.

- [ ] **Step 4: Verify hub rendering unchanged**

Search for any caller that passes `surface: "wizard"`:
```bash
grep -rn "surface.*wizard\|'wizard'\|\"wizard\"" /Users/cameronmcewan/Desktop/advocate/advocatemcp/site/js/v2/
```
Expected: matches inside `connectorCard.js` itself (the new dispatch) and possibly in `prereqCoach.js` comments. NO call site outside `connectorCard.js` should call `render(integration, 'wizard')` yet — that's PR 3. If any do, that's a leakage from a prior task.

The `renderHub(payload)` function calls `render(i, 'hub')` so hub behavior stays unchanged. Confirm:
```bash
grep -n "render(i, 'hub')" /Users/cameronmcewan/Desktop/advocate/advocatemcp/site/js/v2/connectorCard.js
```
Expected: 1 match in `renderHub`.

## Task 2: Add CSS for `.cc-wizard-*` classes

**Files:**
- Modify: `/Users/cameronmcewan/Desktop/advocate/advocatemcp/site/css/integrations-hub.css`

- [ ] **Step 1: Append the wizard-mode rules**

Add these rules to the END of `site/css/integrations-hub.css`. They use existing CSS variables (`--maroon`, `--ink`, `--ink-2`, `--paper`, `--paper-2`, `--line`, `--mono`) — do NOT introduce new tokens.

```css

/* ── Wizard-mode card (PR 2 of Phase 2) ───────────────────────────────────
 *
 * Full-card layout used by the Phase-2 wizard stepper. Differs from the
 * hub's `.cc-row` accordion row in being a full card with a vertical
 * action stack and an inline prereq coach. The `.cc-wizard-step-body`
 * div is a mount target the wizard's picker uses (via runInlinePicker's
 * mountTarget option, PR 1). Empty by default; populated by the wizard
 * stepper or by runInlinePicker rendering into it.
 */

.cc-wizard-card {
  border: 1px solid var(--line, rgba(0,0,0,.08));
  border-radius: 12px;
  padding: 28px;
  max-width: 640px;
  margin: 0 auto;
  background: var(--paper, #fff);
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.cc-wizard-name {
  font-family: var(--serif, Georgia);
  font-size: 24px;
  font-weight: 400;
  line-height: 1.2;
  color: var(--ink, #141210);
}

.cc-wizard-status {
  margin-top: -6px;
}

.cc-wizard-values {
  list-style: disc;
  padding-left: 20px;
  margin: 4px 0 0 0;
  color: var(--ink-2, #555);
  font-size: 14px;
  line-height: 1.55;
}

.cc-wizard-values li {
  margin-bottom: 4px;
}

.cc-wizard-coach {
  background: var(--paper-2, #faf7f2);
  border: 1px solid var(--line, rgba(0,0,0,.08));
  border-radius: 8px;
  padding: 14px 16px;
}

.cc-wizard-coach .prereq-coach {
  /* Coach renders its own .prereq-coach wrapper; keep the inner padding tight. */
  margin: 0;
}

.cc-wizard-error {
  background: rgba(180, 40, 40, 0.08);
  border: 1px solid rgba(180, 40, 40, 0.25);
  color: var(--red, #b3261e);
  border-radius: 8px;
  padding: 10px 14px;
  font-size: 13px;
  line-height: 1.5;
}

.cc-wizard-step-body {
  /* Empty by default. Populated by runInlinePicker when the user clicks
     Pick property / Pick site, or by the wizard stepper for inline state. */
}

.cc-wizard-step-body:empty {
  display: none;
}

.cc-wizard-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: stretch;
  margin-top: 4px;
}

.cc-wizard-actions .btn-primary {
  width: 100%;
  padding: 14px 18px;
  font-size: 15px;
}

.cc-wizard-actions .btn-ghost {
  align-self: flex-start;
}
```

- [ ] **Step 2: Verify the CSS is reachable**

Run: `wc -l /Users/cameronmcewan/Desktop/advocate/advocatemcp/site/css/integrations-hub.css`
Expected: line count grew by ~70-80 lines from before.

- [ ] **Step 3: Worker tests sanity check**

Run: `cd /Users/cameronmcewan/Desktop/advocate/advocatemcp/worker && npm test 2>&1 | grep -E "Test Files|Tests" | tail -2`
Expected: `Test Files  64 passed (64)` and `Tests  660 passed (660)`. No worker change; just confirms working tree is clean.

## Task 3: Commit

- [ ] **Step 1: Commit both files in a single commit**

```bash
git -C /Users/cameronmcewan/Desktop/advocate/advocatemcp add site/js/v2/connectorCard.js site/css/integrations-hub.css
git -C /Users/cameronmcewan/Desktop/advocate/advocatemcp commit -m "feat(integrations): add surface:'wizard' mode to connectorCard

Full-card layout used by the Phase-2 wizard stepper. Differs from the
hub's accordion row in:
- Larger heading + status pill on its own line
- Bulleted value_props instead of just the first oneliner
- Inline <PrereqCoach> above the action button
- Vertical action stack (primary CTA full-width, ghost actions below)
- Dedicated .cc-wizard-step-body mount-point div for runInlinePicker
  (PR 1's mountTarget option) so pickers don't clobber the wizard's
  own navigation buttons

renderWizard() is dispatched from render(integration, 'wizard'). Hub
rendering is byte-identical. The wizard surface is dormant until PR 3
wires up the stepper module and traffic-impact.js call site.

Spec: docs/superpowers/specs/2026-05-08-traffic-impact-wizard-phase-2-design.md
"
```

---

## Verification

- ✅ `node --check site/js/v2/connectorCard.js` exit 0
- ✅ Hub call sites unchanged — no regression on Settings page
- ✅ No external caller passes `surface: "wizard"` yet — wizard surface is dormant
- ✅ Worker test count: 660/660 unchanged

## Self-review

- **Spec coverage**: PR 2's job per spec is "add a new branch to `connectorCard.render(integration, surface)` for `surface === "wizard"`" with bulleted value_props, inline PrereqCoach, vertical action stack, and `.cc-wizard-step-body` mount target. Plan delivers all four. Plus the CSS partial that PR 1's spec implied was missing.
- **Placeholders**: none. Every step has actual code.
- **Type consistency**: `renderWizard` is the helper name throughout. `surface === "wizard"` is the dispatch key. `.cc-wizard-step-body` is the mount-point class consistent with PR 3's planned `mountTarget` argument.
