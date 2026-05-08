# Traffic Impact wizard: replace empty-state dashboard with a guided stepper

**Status:** draft 2026-05-08
**Owner:** Cameron McEwan
**Driver:** Phase 1 of the Traffic Impact setup redesign shipped a unified Settings hub. The next-most-broken surface is `/TrafficImpact.html` itself — when a tenant hasn't connected at least 2 integrations, the dashboard renders mostly zeros and looks broken. The spec for this work was sketched in `docs/superpowers/specs/2026-05-07-traffic-impact-setup-design.md` under "Surface 2: Wizard on /TrafficImpact.html (Phase 2)" and is detailed here.

## Problem

`/TrafficImpact.html` has three render states today (`site/js/v2/traffic-impact.js`):
- **State A** (not connected): single "Connect Google Analytics →" button + an explanation card
- **State B** (connected, no data): a status card explaining that data is syncing
- **State C** (full data): the actual dashboard with charts

State A is the one that looks broken. A new Pro tenant who lands here sees one button and no clear sense of what setting up Traffic Impact actually involves. Phase 1's hub on `/Settings.html` is great if the user finds it, but the dashboard is the surface they hit first when they land on the product. Today that landing experience signals "this is missing" rather than "this is set up in 5 minutes." The result is high drop-off mid-funnel.

The fix needs to: (a) replace State A with a guided multi-step setup flow when the tenant has 0–1 integrations connected, (b) reuse Phase 1's connector card and prereq coach so visual + behavior stays consistent, (c) handle plan-locked integrations cleanly (don't show wizard steps the tenant can't complete), and (d) be dismissable so users who want to skip can land on the empty dashboard.

## Approved approach

**Linear stepper that replaces State A when `completion.connected < 2 && recommended_next !== null`.** The wizard's step order follows the server's `recommended_next` walker, so the first step is always whatever the smart engine recommends. Step state is in-memory only (just a step index) — no localStorage, no resume across sessions. Returning users get the wizard fresh until they've connected at least 2 integrations or until the smart engine reports they're fully set up at their plan tier (which can mean 1/1 for Base).

Each step renders Phase 1's `<ConnectorCard>` in a new `surface: "wizard"` mode — full card, expanded, no accordion. Connect / Pick property / Pick site flows reuse the same per-integration handlers the hub uses. The Phase-1.5 fix to `runInlinePicker` (a `mountTarget` option) is folded into this work because the wizard's pickers need to render inline without clobbering the wizard's own navigation buttons.

**Why this and not the alternatives:**
- **Single-page scroll-list (option B)** — loses the "focused, guided" feel that justifies a wizard in the first place. Makes "Skip All" ambiguous and weakens the activation pressure that's the whole point.
- **Modal overlay (option C)** — signals "this is optional" which contradicts the auto-trigger UX choice. Modals also fight with the existing `<aside class="sidebar">` chrome on the dashboard.

## Trigger logic

The wizard mounts when ALL of:
- The user is authenticated and the tenant context loaded
- `data.integrationsHub.completion.connected < 2`
- `data.integrationsHub.recommended_next !== null` (the server reports there's a meaningful next step)

That second clause is what handles Base tenants gracefully: a Base tenant with GA4 connected gets `completion: {connected: 1, available: 1}` AND `recommended_next: null` — wizard does not show. Same for a fully set-up Pro tenant.

When the tenant skips the wizard via "Skip All", the wizard hides for the rest of the session but a return visit re-evaluates against the same trigger. No localStorage. The user's chosen "auto-wizard until 2+ connected" UX means the wizard is a state-of-the-data decision, not a user-preference one.

State A's existing single-Connect-GA4 button path is removed — the wizard is the new State A. State B (connected, no data) and State C (full data) are unchanged.

## Architecture

Three coordinated pieces, each in its own PR for reviewability:

### PR 1 — `runInlinePicker` mount-target option

Today `site/js/v2/settings.js`'s `runInlinePicker(opts)` does `container.innerHTML = ...` where `container` is the anchor button's parent element. This works inside the legacy GSC card (the parent contains only the picker button + msg span) but blows away sibling buttons when the anchor lives inside `.cc-row-actions` or wizard-step navigation buttons.

The fix: add an optional `mountTarget` option. If provided, `runInlinePicker` renders into that element. If absent (default), behavior is identical to today.

```js
// New optional option:
runInlinePicker({
  anchorBtn:    pickPropertyBtn,
  mountTarget:  document.getElementById('wizard-step-content'), // NEW: where to render
  listPath:     '/api/client/ga4/properties',
  // ...
});
```

When `mountTarget` is provided, the picker renders into that element, and the cancel/abort path restores `mountTarget`'s previous innerHTML. The anchor button's siblings are untouched.

**Critical**: this is backward-compatible. Existing callers that don't pass `mountTarget` keep their current behavior. The Phase-1 hub's settings.js call sites are unchanged.

### PR 2 — Wizard surface mode in `connectorCard.js`

Add a new branch to `connectorCard.render(integration, surface)` for `surface === "wizard"`. The wizard variant:
- Always renders expanded (no accordion collapse)
- Shows a larger `<h3>` for the integration name
- Renders `value_props` as a bulleted list (not just the first oneliner)
- Renders the `<PrereqCoach>` inline above the action button (not collapsed behind it)
- Lays out actions as a vertical stack (single primary CTA at top, smaller ghost actions below)
- Adds a `<div class="cc-wizard-step-body">` wrapper that the wizard stepper uses as the picker `mountTarget`

The hub's `surface: "hub"` rendering is unchanged.

### PR 3 — `<TrafficImpactWizard>` stepper

New module `site/js/v2/trafficImpactWizard.js`:

```js
window.AMCP_TI_WIZARD = {
  shouldRender(hub),  // pure: returns true if completion.connected < 2 && recommended_next !== null
  renderState(hub),   // returns the welcome card + a stepper container
  mount(hub, root),   // wires step navigation, picker dispatch, OAuth flow, completion polling
};
```

State machine:

```
welcome → step1 → step2 → ... → done
  ↓        ↓        ↓                ↓
skipAll skipStep skipStep        (close, hide wizard, show empty dashboard)
```

- **Step ordering**: derived once on mount from `hub.recommended_next` chain (server-driven). Length follows the chain — typically 5 for a fresh Pro tenant (ga4 → gsc → hubspot → stripe_webhook → authority), 1 for a Base tenant (ga4). The wizard does not impose an artificial cap; if the user has more to set up, the wizard walks them all.
- **Step content**: each step renders one `<ConnectorCard>` in `surface: "wizard"` mode. Welcome and Done are bespoke cards (no ConnectorCard).
- **Navigation**: top-of-card "Step N of M · ‹‹ back ›› next" stepper. Bottom-of-card primary CTA per step ("Connect Google Analytics →" / "Pick property →" / "Configure →"). "Skip this step" link below the CTA. "Skip All" link in the page header (small, muted).
- **Completion advancement**: no active polling. The user clicks Connect → redirects to Google OAuth → returns to `/TrafficImpact.html` via the OAuth callback's natural redirect → the page boots fresh, `fetchReal` re-fetches `/api/client/integrations/status`, and the wizard re-mounts with the new connection counted. The same flow advances pickers (`/api/client/ga4/select-property` etc.) — those endpoints already redirect-or-reload the dashboard.

`site/js/v2/traffic-impact.js`'s State A render path becomes:

```js
if (window.AMCP_TI_WIZARD && window.AMCP_TI_WIZARD.shouldRender(d.integrationsHub)) {
  return window.AMCP_TI_WIZARD.renderState(d.integrationsHub);
}
// else fall through to existing State A
```

`afterMount` mirrors:

```js
if (window.AMCP_TI_WIZARD && window.AMCP_TI_WIZARD.shouldRender(d.integrationsHub)) {
  window.AMCP_TI_WIZARD.mount(d.integrationsHub, document.getElementById('page-content'));
  return; // skip the existing State A wiring
}
```

The existing State A's "Connect Google Analytics →" button + explainer card stay in the codebase as fallback for the case where the wizard module fails to load (defensive, mirroring the Phase 1 connectorCard guard pattern).

### Critical files

- `site/js/v2/settings.js` — PR 1: add `mountTarget` to `runInlinePicker`
- `site/js/v2/connectorCard.js` — PR 2: add `surface: "wizard"` rendering branch
- `site/css/integrations-hub.css` — PR 2: add `.cc-wizard-step-*` classes (full-card layout)
- `site/js/v2/trafficImpactWizard.js` (new) — PR 3: the stepper module
- `site/js/v2/traffic-impact.js` — PR 3: State A delegates to the wizard when shouldRender is true
- `site/TrafficImpact.html` — PR 3: load the new module before traffic-impact.js

### What's reused

- `<ConnectorCard>` and the action-id contract from Phase 1 — extended, not replaced
- `<PrereqCoach>` — referenced inline in wizard steps for integrations with external prereqs
- The hub's delegated click handler pattern (`data-cc-action`/`data-cc-id`) — wizard listens for the same attributes
- `runInlinePicker` — extended with `mountTarget` (Phase-1.5 follow-up subsumed by PR 1)
- All per-integration OAuth/select/disconnect endpoints — unchanged
- `/api/client/integrations/status` — unchanged; wizard polls it between steps

## Phasing

PRs ship in order — each is independently mergeable + shippable + reversible.

| PR | What ships | Risk if rolled back |
|---|---|---|
| **1** | `runInlinePicker` `mountTarget` option | Hub unchanged (no caller passes the new option yet); zero user-visible change |
| **2** | Wizard surface mode in connectorCard | Hub unchanged; wizard surface defined but unmounted; zero user-visible change |
| **3** | Wizard stepper + State A delegation | Wizard goes live; State A behavior changes for tenants with `completion.connected < 2` |

PR 1 + PR 2 can ship without making any user-facing change — safest possible roll-up. PR 3 is the user-visible change.

## Non-goals

- Dedicated `/setup/traffic-impact` focus-mode page — that's Phase 3
- Smart engine personalisation by business type / vertical — that's Phase 4
- Resume-across-sessions state in localStorage — explicitly rejected per user's "auto-wizard until 2+ connected" choice
- Reworking State B (connected, no data) or State C (full data) — out of scope
- Removing the legacy 4 cards on Settings — that's Phase 1.5 (separate plan)
- Animating step transitions — first version is instant swap; polish is a follow-up
- Multi-tenant team-permissioned wizard handoff — single-owner only

## Verification

End-to-end manual test, on a fresh Pro tenant with nothing connected:

1. Land on `/TrafficImpact.html`. Confirm the wizard renders (not the bare State A button). Welcome card shows step count tailored to recommended chain ("Set up in 4 steps").
2. Click Next from welcome → step 1 (GA4) renders with full ConnectorCard in wizard mode, prereq coach inline if applicable, primary CTA "Connect Google Analytics →".
3. Click Connect → redirected to Google OAuth → return to /TrafficImpact.html → wizard re-fetches status, advances to step 2 (GSC).
4. On step 2, click "Pick site →" — picker mounts inline in `.cc-wizard-step-body` (NOT clobbering the wizard navigation buttons). Pick a site → picker resolves → wizard advances to step 3.
5. Click Skip All from any step → wizard hides → empty State A renders → reload page → wizard re-renders (auto-trigger; no localStorage).
6. After connecting 2 integrations (so `completion.connected >= 2`), reload `/TrafficImpact.html` → confirm wizard does NOT render; the actual dashboard renders.
7. Land on `/TrafficImpact.html` as a Base tenant with no integrations → wizard shows 1 step (GA4). Connect GA4 → wizard immediately shows Done card (because `recommended_next: null` after GA4 lands for Base). Reload → no wizard.

Worker tests: extending the existing `integrationsStatus.test.ts` for the threshold logic is unnecessary because the wizard's trigger logic is client-side — the server already returns `recommended_next: null` correctly. No new worker tests; existing 660-test baseline holds.

Frontend: no automated tests on `site/js/v2/*` per project convention. Manual verification via the 7 steps above.

## Open questions

1. **Welcome card copy variation per plan**: should a Base tenant's welcome say "Connect Google Analytics in ~3 minutes" while Pro says "Set up Traffic Impact in 4 steps · ~15 min"? Recommendation: yes, derived from `recommended_next` chain length on mount. Cheap to implement.
2. **Done card next-step CTA**: after the wizard, what's the most useful next link? "View your dashboard" (just hides the wizard) vs "Open Settings to add more" vs "Set a tracking goal". Recommendation: "View your dashboard" for simplicity in PR 3; revisit in Phase 4.
3. **Skip-step persistence within session**: if a user skips step 2, does the wizard skip it next time they revisit (within the same browser tab) or auto-walk back to it? Recommendation: in-session memory only — clicking Skip on step 2 advances to step 3 but if they reload the page, the wizard re-evaluates from scratch via `recommended_next`. Matches the user's "auto-wizard until 2+" choice.
