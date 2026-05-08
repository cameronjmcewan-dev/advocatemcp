# Traffic Impact Wizard — PR 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Widen `runInlinePicker` in `site/js/v2/settings.js` with an optional `mountTarget` option so callers (the upcoming Phase-2 wizard) can render the picker into a dedicated container instead of clobbering the anchor button's parent.

**Architecture:** Backward-compatible single-line change to the `const container = ...` derivation. When `opts.mountTarget` is provided, `runInlinePicker` uses it as the picker mount point. When absent, current behavior preserved (anchor's `parentElement`). All downstream `container.*` references work unchanged because they're rooted at this single variable. JSDoc comment updated to document the new option.

**Tech Stack:** Vanilla browser JS (IIFE module). No bundler. No automated tests on static-site assets — verification via `node --check` for parse + manual smoke against the live Phase-1 hub to confirm no regression.

**Spec:** `docs/superpowers/specs/2026-05-08-traffic-impact-wizard-phase-2-design.md` (commit `7bd449d`).

**Out of scope:** PR 2 (wizard surface mode in connectorCard.js) and PR 3 (the wizard stepper module + traffic-impact.js wire-up). Each is its own plan.

---

## File Map

### Modified
- `site/js/v2/settings.js` — line 808-816 region. JSDoc and the `container` derivation.

### Untouched
- Every existing call site of `runInlinePicker` in `settings.js` — there are two today (GA4 property picker, GSC site picker), both inside `handleHubAction` → `openInlinePicker`. Neither passes `mountTarget`, so behavior is identical.

---

## Task 1: Add mountTarget option + verify backward compat

**Files:**
- Modify: `/Users/cameronmcewan/Desktop/advocate/advocatemcp/site/js/v2/settings.js` (lines 786-816 region)

- [ ] **Step 1: Read the current `runInlinePicker` implementation**

The function lives at `site/js/v2/settings.js` starting around line 808. The relevant region for this task is lines 786-816 (the JSDoc block + the function declaration through `const container = ...`).

Current JSDoc and head of function:

```js
  /* Generic inline picker for "Connected · pick X" states (GA4 properties,
   * GSC sites). Replaces the button row with a list of selectable items
   * fetched from listPath, then POSTs the chosen value to selectPath which
   * runs a server-side backfill and persists the choice. Reloads the page
   * on success so the card re-renders from the live status endpoint.
   *
   * Shape of opts:
   *   anchorBtn    — the clicked "Choose X" button. Its parent .r row is
   *                  replaced with the picker UI.
   *   listPath     — GET endpoint that returns { [listKey]: [item, ...] }.
   *   listKey      — top-level key in the list response holding the items.
   *   selectPath   — POST endpoint that persists the selection.
   *   buildBody    — fn(item) -> object sent as the JSON request body.
   *                  Lets endpoints that need multiple fields (e.g. GA4's
   *                  property_id + property_label) work without bespoke wiring.
   *   isValid      — fn(item) -> boolean. Skips invalid rows on click.
   *   rowLabel     — fn(item) -> primary display string.
   *   rowSubLabel  — fn(item) -> secondary display string (mono, muted).
   *   emptyMessage — text shown when the list is empty.
   *   intro        — paragraph above the list explaining what selection does.
   */
  function runInlinePicker(opts) {
    const af = window.AMCP && window.AMCP.authedFetch;
    const anchor = opts.anchorBtn;
    const container = anchor && anchor.parentElement;
    if (!af || !container) return;
```

You're modifying the JSDoc block (add one new option line) and the `const container = ...` line.

- [ ] **Step 2: Apply the edit**

Use `Edit` tool to replace this block:

```js
  /* Generic inline picker for "Connected · pick X" states (GA4 properties,
   * GSC sites). Replaces the button row with a list of selectable items
   * fetched from listPath, then POSTs the chosen value to selectPath which
   * runs a server-side backfill and persists the choice. Reloads the page
   * on success so the card re-renders from the live status endpoint.
   *
   * Shape of opts:
   *   anchorBtn    — the clicked "Choose X" button. Its parent .r row is
   *                  replaced with the picker UI.
   *   listPath     — GET endpoint that returns { [listKey]: [item, ...] }.
   *   listKey      — top-level key in the list response holding the items.
   *   selectPath   — POST endpoint that persists the selection.
   *   buildBody    — fn(item) -> object sent as the JSON request body.
   *                  Lets endpoints that need multiple fields (e.g. GA4's
   *                  property_id + property_label) work without bespoke wiring.
   *   isValid      — fn(item) -> boolean. Skips invalid rows on click.
   *   rowLabel     — fn(item) -> primary display string.
   *   rowSubLabel  — fn(item) -> secondary display string (mono, muted).
   *   emptyMessage — text shown when the list is empty.
   *   intro        — paragraph above the list explaining what selection does.
   */
  function runInlinePicker(opts) {
    const af = window.AMCP && window.AMCP.authedFetch;
    const anchor = opts.anchorBtn;
    const container = anchor && anchor.parentElement;
    if (!af || !container) return;
```

with:

```js
  /* Generic inline picker for "Connected · pick X" states (GA4 properties,
   * GSC sites). Replaces a container's contents with a list of selectable
   * items fetched from listPath, then POSTs the chosen value to selectPath
   * which runs a server-side backfill and persists the choice. Reloads the
   * page on success so the card re-renders from the live status endpoint.
   *
   * Shape of opts:
   *   anchorBtn    — the clicked "Choose X" button. Disabled while the
   *                  list endpoint is in flight.
   *   mountTarget  — (optional) DOM element the picker UI renders into.
   *                  When omitted, defaults to anchorBtn.parentElement
   *                  (legacy behavior — the picker replaces the button's
   *                  parent row contents). When provided (e.g. the wizard's
   *                  step-body div), the picker renders into mountTarget so
   *                  it doesn't clobber sibling buttons next to anchorBtn.
   *   listPath     — GET endpoint that returns { [listKey]: [item, ...] }.
   *   listKey      — top-level key in the list response holding the items.
   *   selectPath   — POST endpoint that persists the selection.
   *   buildBody    — fn(item) -> object sent as the JSON request body.
   *                  Lets endpoints that need multiple fields (e.g. GA4's
   *                  property_id + property_label) work without bespoke wiring.
   *   isValid      — fn(item) -> boolean. Skips invalid rows on click.
   *   rowLabel     — fn(item) -> primary display string.
   *   rowSubLabel  — fn(item) -> secondary display string (mono, muted).
   *   emptyMessage — text shown when the list is empty.
   *   intro        — paragraph above the list explaining what selection does.
   */
  function runInlinePicker(opts) {
    const af = window.AMCP && window.AMCP.authedFetch;
    const anchor = opts.anchorBtn;
    // Phase 2 PR 1: opts.mountTarget overrides the default container so the
    // wizard can render pickers into a dedicated step-body div without
    // clobbering its own navigation buttons.
    const container = opts.mountTarget || (anchor && anchor.parentElement);
    if (!af || !container) return;
```

The diff is: JSDoc gets a new `mountTarget` line + the description text reworded slightly (replaces "the button row" with "a container's contents" since the target is now configurable). The `const container = ...` line gets `opts.mountTarget ||` prepended, and a 3-line comment above it explaining why.

- [ ] **Step 3: Verify the file parses**

Run: `node --check /Users/cameronmcewan/Desktop/advocate/advocatemcp/site/js/v2/settings.js`
Expected: exits 0 with no output.

- [ ] **Step 4: Verify no behavior change for existing callers**

There are exactly two call sites of `runInlinePicker` in this file today, both inside `openInlinePicker`. Confirm via grep:

```bash
grep -n "runInlinePicker(" /Users/cameronmcewan/Desktop/advocate/advocatemcp/site/js/v2/settings.js
```

Expected output: 3 lines — 1 declaration (`function runInlinePicker(opts) {`) and 2 calls (the GA4 + GSC pickers in `openInlinePicker`). **Confirm neither call passes `mountTarget`.** If either does, that's a defect — Phase 1 didn't ship that option. They should match the pattern:

```js
runInlinePicker({
  anchorBtn:    btn,
  listPath:     '/api/client/...',
  // ... other options, NOT including mountTarget
});
```

If both calls are clean of `mountTarget`, behavior is identical to today (because `opts.mountTarget` is `undefined`, so the OR falls through to `anchor.parentElement`). No further check needed.

- [ ] **Step 5: Worker tests sanity check**

Run: `cd /Users/cameronmcewan/Desktop/advocate/advocatemcp/worker && npm test 2>&1 | tail -3`
Expected: `Tests  660 passed (660)` — no change. This task touches no worker code; the test count just confirms nothing accidentally broke from the working tree.

- [ ] **Step 6: Commit**

```bash
git -C /Users/cameronmcewan/Desktop/advocate/advocatemcp add site/js/v2/settings.js
git -C /Users/cameronmcewan/Desktop/advocate/advocatemcp commit -m "feat(integrations): runInlinePicker accepts optional mountTarget

Backward-compatible. When opts.mountTarget is provided, the picker
renders into that element instead of the anchor button's parent.
Default (no mountTarget) preserves current behavior — Phase 1's hub
call sites in openInlinePicker stay unchanged.

Foundation for Phase 2's wizard, where pickers need to mount into a
dedicated .cc-wizard-step-body div without clobbering the wizard's
own navigation buttons.

Spec: docs/superpowers/specs/2026-05-08-traffic-impact-wizard-phase-2-design.md"
```

---

## Verification (after the commit lands)

1. `node --check site/js/v2/settings.js` — exit 0
2. `grep -n "runInlinePicker(" site/js/v2/settings.js` — 3 matches; no caller passes `mountTarget` (Phase 1's hub call sites unchanged)
3. Manual smoke (post-deploy on a Pro tenant in production): hard-refresh `/Settings.html`, click Choose site / Choose property in the hub. Picker still works — same UX as Phase 1. **This is the backward-compat check.**
4. Worker test count unchanged at 660/660.

PR 2 (`surface: "wizard"` rendering mode in `connectorCard.js`) follows next as its own plan + execution. PR 3 (the stepper) follows that. Each is independently shippable.

## Self-review

- **Spec coverage**: PR 1's job per the spec is to "widen `runInlinePicker` with a `mountTarget` option (Phase-1.5 prerequisite). Single file, ~20-line change. Backward compatible — anchor's parent stays the default." Plan exactly delivers this.
- **Placeholders**: none. Every step has actual code/commands.
- **Type consistency**: `mountTarget` is the option name throughout (JSDoc, comment, code). Task 1 is the entire plan — no cross-task naming.
