# Traffic Impact setup page: dedicated focus-mode setup at `/setup/traffic-impact`

**Status:** draft 2026-05-08
**Owner:** Cameron McEwan
**Driver:** Phase 1 + Phase 2 of the Traffic Impact setup redesign shipped a unified Settings hub and an in-dashboard wizard. The third surface — a dedicated focus-mode page at `/setup/traffic-impact` — is what onboarding emails and the post-payment activation flow link to. It's the polished landing for users committing real time to set everything up.

## Problem

Today the only "setup" surfaces are:
- The hub block on `/Settings.html` — discoverable but buried among other Settings sections (Connection, API & Webhooks, Install, Tutorial, Team, Danger zone).
- The wizard on `/TrafficImpact.html` — appears only when `completion.connected < 2`, and dismisses to the empty dashboard.

Neither is a great target for an onboarding email link, a Stripe-checkout success redirect, or a "set this up properly" pointer from support. Both put the setup work alongside other UX:
- Settings has a sidebar + topbar + 5 unrelated cards
- The wizard inherits the dashboard chrome and is gated behind a render condition

The fix needs a standalone URL with a focused layout — no sidebar, no topbar, just the work — that any of those entry points can deeplink to. The page should reuse Phase 1's connector card components and the same status endpoint so we don't fork the data model.

## Approved approach

**A focus-mode static page at `site/setup/traffic-impact.html` rendering all six integrations as `<ConnectorCard surface="wizard">` cards in a vertical scroll, with a sticky left side rail for progress + jump-to anchors.** The page loads outside the v2 dashboard chrome (no `shell.js`, no `dashboard-chrome.js`) — it's its own minimal shell with just a brand mark + back-arrow header. The `surface: "wizard"` rendering from Phase 2 PR 2 is reused as-is — every card is fully expanded with the inline `<PrereqCoach>` + vertical action stack. Action delegation mirrors the wizard's pattern: a small action map dispatches connect / picker / configure clicks to the same per-integration endpoints settings.js and trafficImpactWizard.js use.

**Why this and not the alternatives:**
- **Render inside the dashboard chrome** (sidebar/topbar visible) — defeats the "focus mode" framing the spec set out. The whole point is that setup is its own task with no nav distractions.
- **Build a new `surface: "setup-page"` rendering mode** in connectorCard.js — would duplicate ~80% of the Phase 2 PR 2 wizard surface for marginal differences. The wizard surface IS the right "full-expanded card with inline action stack" layout for this use case.
- **Use the hub accordion layout** (compact rows, click to expand) — saves vertical space but contradicts the spec's "each card opens its full UX inline (not modal/expand)" requirement.

## Trigger / entry points

The page itself has no auto-trigger logic — it's just a deeplinkable URL. Users land here only via explicit links:

1. **Settings hub header** — new "Open setup page →" link next to the existing "Recommended next" callout
2. **TrafficImpact.html header** when partially set up — new "Resume setup →" link in the topbar area when `completion.connected >= 2` (so the hub-completion banner offers a way back to the focused flow)
3. **Onboarding / post-payment flow** — Cameron updates the activation email + Stripe-success-redirect path to deeplink here. Not in this PR; tracked as a follow-up touching `worker/src/routes/activatePage.ts` and the Stripe webhook redirect logic.

## Architecture

### URL + page shell

`/setup/traffic-impact` resolves to `site/setup/traffic-impact.html` (Cloudflare Pages serves directory routes via `<dir>.html` lookup — same pattern as `site/admin/queries.html`).

Page structure:

```
┌──────────────────────────────────────────────────────────────────────┐
│ [← Back to dashboard]              Set up Traffic Impact   [Sign out]│  ← minimal header
├────────────────┬─────────────────────────────────────────────────────┤
│ Progress       │                                                     │
│ ───────────    │   Welcome card                                      │
│ ▓▓▓░░░  3/6   │   "These connections power your Traffic Impact      │
│                │    dashboard. Set them up in any order."            │
│                │                                                     │
│ ✓ GA4          │   ┌──────────────────────────────────────────────┐ │
│ ✓ GSC          │   │ Google Analytics                  [Connected]│ │
│ ○ HubSpot ◀━━━━│━━━│ • value prop 1                              │ │
│ ○ Salesforce   │   │ • value prop 2                              │ │
│ ○ Stripe       │   │ [Resync now] [Disconnect]                   │ │
│ ○ Authority    │   └──────────────────────────────────────────────┘ │
│                │                                                     │
│ [Save & exit]  │   ┌──────────────────────────────────────────────┐ │
│                │   │ Google Search Console            [Connected] │ │
│                │   │ ...                                          │ │
└────────────────┴─────────────────────────────────────────────────────┘
```

Layout details:
- Header is a 56px-tall plain row (no sidebar, no topbar). Contains a back-arrow link, a centered title, and a sign-out trigger.
- Two-column main: left side rail (240px sticky), right scroll-content (max-width 720px centered).
- Side rail shows: progress bar (X/Y connected · pct%), then a list of every available integration with a status pill + click-to-anchor-scroll. Plan-locked integrations show with a maroon "Pro" pill + Upgrade link.
- Content column shows: welcome card → 6 connector cards in vertical scroll, ordered by `recommended_next` chain (so the next-action integration is at the top).
- "Save & exit" button at the bottom of the side rail returns to the referrer (`document.referrer`) or `/Settings.html` if no referrer.

### Module layout

- `site/setup/traffic-impact.html` (new, ~80 lines) — page shell, loads modules + boots `setupPage.js`
- `site/js/v2/setupPage.js` (new, ~200 lines) — fetches `/api/client/integrations/status`, renders side rail + content column, wires action delegation
- `site/css/integrations-hub.css` — append `.setup-page-*` rules for the page shell + side rail (~80 lines)
- `site/js/v2/settings.js` — add "Open setup page →" link to hub header
- `site/js/v2/traffic-impact.js` — add "Resume setup →" link in dashboard topbar when wizard isn't showing

### Action delegation

`setupPage.js` defines its own `handleAction(integrationId, action, btn)` mirroring the wizard's pattern:
- `connect` → POST `/api/client/<integration>/start-link` → redirect to OAuth URL
- `pick_property` / `pick_site` → call `window.runInlinePicker` (exposed in Phase 2 PR 3) with `mountTarget` = the card's `.cc-wizard-step-body` div
- `disconnect` / `resync` / `configure` / `generate` / `rotate` / `edit` → for Phase 3 v1, scroll to + flash the legacy card on Settings (same pattern as the wizard); when Phase 1.5 inlines the legacy forms into ConnectorCard, this branch goes away
- `upgrade` → `<a href="/Billing.html">` short-circuit

The action helpers (`startGoogleOauthForId`, `openInlinePickerForId`, etc.) are duplicated from `traffic-impact.js`. Phase 1.5 cleanup will extract these into a shared `site/js/v2/connectorActions.js` module.

### Auth

The page requires authentication — same as Settings + dashboard. Loads `dashboard-auth.js` and calls `requireAuth()` on boot. Unauthenticated users redirect to `/login.html?next=/setup/traffic-impact`.

### Critical files

- `site/setup/traffic-impact.html` (new)
- `site/js/v2/setupPage.js` (new)
- `site/css/integrations-hub.css` (append)
- `site/js/v2/settings.js` (header link)
- `site/js/v2/traffic-impact.js` (header link)

### What's reused

- `<ConnectorCard surface="wizard">` from Phase 2 PR 2 — reused as-is for the per-integration cards
- `<PrereqCoach>` from Phase 1 — reused inline in each connector card
- `runInlinePicker` with `mountTarget` from Phase 2 PR 1 — reused for GA4 + GSC pickers
- `/api/client/integrations/status` from Phase 1 — reused as-is, no backend change
- The 14-key action contract from Phase 1's `handleHubAction` — duplicated patterns until Phase 1.5 dedupes

## Phasing

Single PR for Phase 3 v1. Subsequent Phase 1.5 work folds in:
- Inline forms for Authority Kit + Stripe webhook (replaces the current "scroll to legacy" fallback on this page + the hub + the wizard simultaneously)
- Shared `connectorActions.js` module (replaces 3× duplicated action helpers)
- Onboarding flow deeplink to `/setup/traffic-impact` (touches `worker/src/routes/activatePage.ts` + Stripe success redirect)

## Non-goals

- New `surface: "setup-page"` rendering mode in connectorCard.js — wizard surface fits, no need to fork
- Animated step transitions / progress-bar fill animation — first version is static; polish is a follow-up
- Mobile-responsive side rail collapse — first version stacks the rail above the content on narrow viewports via CSS; no JS toggle yet
- Inlining legacy forms (Authority + Stripe webhook) — Phase 1.5
- Wiring the onboarding/post-payment redirect — separate PR; this spec just creates the deeplinkable URL

## Verification

End-to-end manual test, on a Pro tenant:

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

Worker tests: no worker change. 660/660 vitest baseline holds.
Frontend: `node --check` for parse + manual verification per the steps above.

## Open questions

1. **Side rail jump-to: smooth scroll vs. instant?** Recommendation: smooth scroll (`behavior: "smooth"`) for the 240ms feel; matches the existing `scrollToLegacy` polish in settings.js.
2. **"Save & exit" referrer fallback for direct visits**: if `document.referrer` is empty (user visited via bookmark or onboarding email), where do they go? Recommendation: `/Settings.html` — the next-most-relevant surface for ongoing management.
3. **Side rail visibility on mobile**: collapse to a top progress bar that doesn't include jump-to links, OR stack the full rail above content? Recommendation: stack above for v1 (simpler); mobile users on a 30-min-setup task are on desktop in practice.
