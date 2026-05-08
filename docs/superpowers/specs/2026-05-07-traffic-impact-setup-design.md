# Traffic Impact setup: unified connector model + three coordinated surfaces

**Status:** draft 2026-05-07
**Owner:** Cameron McEwan
**Driver:** Self-reported pain — every aspect of Traffic Impact setup (GA4, GSC, HubSpot, Salesforce, Stripe webhook, Authority Kit) is hard for users. Discovery, per-integration friction, external prerequisites, and post-setup visibility are all broken. Friction blocks tenants from getting the value of the data-depth roadmap that shipped Phases 1–6.

## Problem

Six integrations now power the Traffic Impact page:

| Integration | Auth | Backfill | Plan | External prereqs |
|---|---|---|---|---|
| Google Analytics 4 | OAuth | 18mo | Base+ | GA4 property exists |
| Google Search Console | OAuth | 18mo | Pro+ | Verified site in GSC |
| HubSpot | OAuth | passthrough | Pro+ | HubSpot account |
| Salesforce | OAuth | passthrough | Pro+ | Salesforce account |
| Stripe / Shopify webhook | Advocate-generated URL + secret pasted into customer's Stripe dashboard | forward-only | Pro+ | Stripe account |
| Authority Kit | Plain config | nightly cron | Pro+ | Brand keyword + Google Place ID |

Today these live across **five separate surfaces** on `site/Settings.html`: four dedicated cards (`renderGa4Card`, `renderGscCard`, `renderCrmCard` which renders HubSpot + Salesforce side-by-side, `renderAuthorityCard` in `site/js/v2/settings.js`) plus the Verified-revenue webhook controls inline in the Revenue tracking section (around `settings.js:292-310`). The customer experience:

1. **Discovery** — `Settings.html` scrolls forever. Users can't see what's available, what's required, or what each integration unlocks.
2. **Per-integration friction** — each connect button has its own micro-flow. Two of the post-OAuth pickers (Choose site, Choose property) silently no-op'd until 2026-05-07. The setup-state-after-OAuth-callback ("Connected · pick a site") is its own confusing micro-state.
3. **External prereqs** — Stripe webhook secret, Google Place ID, GSC site verification all live outside Advocate. Users don't know where to get them and aren't coached.
4. **Post-setup visibility** — once connected, no central view of what's syncing, what's stale, what errored. `last_sync_error` is buried per-card.

A `/TrafficImpact.html` page that renders zeros because the customer hasn't connected anything looks broken, not "not configured yet" — there's no in-context CTA explaining what's missing or how to fix it.

## Approved approach

**Server-driven setup engine + shared connector component model + three coordinated surfaces.**

One backend endpoint computes setup state for all integrations. One frontend component (`<ConnectorCard>`) renders any integration in any state. One sub-component (`<PrereqCoach>`) handles "go to Stripe → Webhooks → copy secret" / "find your Place ID" coaching the same way everywhere. Three surfaces compose these primitives in different layouts:

- **Surface 1: Settings hub** — replaces the four current cards with one ordered, status-visible, value-explained "Traffic Impact integrations" card.
- **Surface 2: Wizard on `/TrafficImpact.html`** — when the page would otherwise render zeros, swap in a guided stepper instead of the broken-looking dashboard.
- **Surface 3: Dedicated `/setup/traffic-impact` page** — focus-mode (no nav distractions) for the user committing 30 minutes to set everything up. Linked from Settings, dashboard empty state, and onboarding.

A "smart engine" computes `recommended_next` server-side based on plan tier, what's already connected, and integration ROI — all three surfaces read the same recommendation.

Why this and not the alternatives:
- **B (frontend-only, three implementations)** — faster to ship Phase 1, but every UX change has to be made 3× and inconsistencies will accumulate. The 7th integration is 3× the work.
- **C (single mega-component switching on `mode` prop)** — file becomes a 1500-line conditional that's hard to test and grows surface-specific hacks. Settings/wizard/setup-page have legitimately different needs.

## Architecture

### Setup-state endpoint

`GET /api/client/integrations/status` (worker, new) returns the full state for every integration in one call so each surface can render without N round-trips.

```jsonc
{
  "tenant": { "slug": "...", "plan": "pro" },
  "integrations": [
    {
      "id": "ga4",
      "name": "Google Analytics",
      "category": "traffic",        // traffic | search | crm | revenue | authority
      "plan_required": "base",      // base | pro | enterprise
      "status": "connected_active", // not_connected | connecting | connected_pending_config | connected_active | connected_error | disconnected | plan_locked
      "value_props": ["See AI vs human traffic split on the dashboard"],
      "external_prereqs": [],       // see PrereqCoach section
      "config_summary": "Property: 532200123",
      "last_sync_at": "2026-05-07T12:00:00Z",
      "last_sync_error": null,
      "actions": ["resync", "disconnect"]
    },
    {
      "id": "stripe_webhook",
      "name": "Verified revenue",
      "category": "revenue",
      "plan_required": "pro",
      "status": "not_connected",
      "value_props": ["Attribute revenue dollars to AI-acquired customers"],
      "external_prereqs": [
        { "id": "stripe_account", "label": "A Stripe account", "coach_id": "stripe_webhook" }
      ],
      "config_summary": null,
      "last_sync_at": null,
      "last_sync_error": null,
      "actions": ["generate", "rotate"]
    }
    // ... one entry per integration
  ],
  "recommended_next": "gsc",
  "completion": { "connected": 2, "available": 6, "pct": 33 }
}
```

Implementation: a single helper `buildIntegrationsStatus(env, slug)` in `worker/src/lib/integrationsStatus.ts` consults the existing per-integration status queries (`apiGA4Status`, `apiGSCStatus`, `gsc_connections`, `crm_connections`, `revenue_events` count, `authority_config`). The endpoint is read-only; mutating actions still go through their existing per-integration endpoints unchanged. This keeps the existing OAuth flows + select-site/select-property/disconnect handlers untouched.

### `<ConnectorCard>` component

A single rendering function in `site/js/v2/connectorCard.js` (new module). Inputs: an integration object from the status endpoint + a `surface: "hub" | "wizard" | "setup-page"` prop. Outputs: HTML matching the surface's layout but using the same status pills, value-prop copy, action buttons, and error formatting everywhere. The seven `status` values map to seven distinct render variants — the same seven across all three surfaces.

The existing per-integration logic in `wireGa4Card`, `wireGscCard`, `wireCrmCard`, `wireAuthorityCard` is preserved as the action implementations. The connector card just renders + delegates to those handlers.

### `<PrereqCoach>` component

For integrations with external prereqs (Stripe webhook, Authority Kit Place ID, GSC site verification), a sub-component renders inline coaching. Lives in `site/js/v2/prereqCoach.js`.

Coach payloads ship as a static map keyed by `coach_id`:

```js
const COACHES = {
  stripe_webhook: {
    title: "Connect Stripe to send revenue events to Advocate",
    steps: [
      { text: "Click Generate below — Advocate will mint a webhook URL + signing secret for you." },
      { text: "Open your Stripe dashboard → Developers → Webhooks → Add endpoint." },
      { text: "Paste the URL into the Endpoint URL field. Subscribe to: charge.succeeded, payment_intent.succeeded, invoice.paid." },
      { text: "Stripe will ask for a signing secret — paste the secret Advocate generated above." },
      { text: "Save in Stripe. The first event we receive flips this card to Connected." }
    ],
    helper_links: [{ label: "Stripe webhook docs", url: "https://stripe.com/docs/webhooks" }]
  },
  google_place_id: { /* ... */ },
  gsc_verification: { /* ... */ }
};
```

Coaches surface in all three surfaces — same content, scaled layout (collapsed accordion in hub, expanded inline in wizard, full-page in setup).

### Smart engine

`recommended_next` is computed server-side in `buildIntegrationsStatus`. v1 logic (kept simple, deterministic):

1. If GA4 not connected → recommend GA4. (It's the baseline; everything else is incremental.)
2. Else if Pro tenant and GSC not connected → recommend GSC. (AI Overview detection is the differentiator.)
3. Else if Pro tenant and any CRM not connected → recommend HubSpot. (Highest-ROI per minute of setup.)
4. Else if Pro tenant and revenue webhook not connected → recommend Stripe. (Closes the dollars-attribution loop.)
5. Else if Pro tenant and Authority Kit not configured → recommend Authority Kit.
6. Else `null` (fully set up).

Plan-locked integrations are returned in the list with `status: "plan_locked"` so the UI can show them as previews + an upgrade CTA, never as "next".

v2 (deferred — see Open questions): personalize ordering by tenant business type (e.g. SaaS tenants deprioritize Place ID; e-commerce prioritizes Stripe).

## Surface 1: Settings hub (Phase 1)

Replaces the four dedicated cards (GA4, GSC, CRM, Authority) **and folds in the Verified-revenue webhook controls currently inline in the Revenue tracking section** on `site/Settings.html`. Becomes one card titled "Traffic Impact integrations" with:

- Header: "X of Y connected · last sync 2h ago" + completion progress bar
- Recommended-next callout if any: "Recommended next: Connect Search Console →" (one-click expand)
- Six rows, ordered by category, each a `<ConnectorCard>` in `surface: "hub"` mode (collapsed accordion — header always visible: name, status pill, value-prop one-liner, last-sync, primary action button)
- Pro-locked rows shown as preview with maroon "Pro" pill + "See what this unlocks" expand
- Rows expand inline to show the `<PrereqCoach>` (if applicable) + connect/configure flow + advanced controls (resync, disconnect)

This single change addresses the 4 friction dimensions:
- **Discovery** — one card, ordered, value-explained
- **Per-integration friction** — accordion keeps the surface scannable; expanded view embeds the existing per-integration UX
- **External prereqs** — `<PrereqCoach>` surfaces inline before the user clicks Connect
- **Post-setup visibility** — header completion summary + per-row last-sync + sync-error pills

## Surface 2: Wizard on /TrafficImpact.html (Phase 2)

The existing State A ("not connected — connect GA4") on `site/TrafficImpact.html` (rendered by `site/js/v2/traffic-impact.js`) becomes a multi-step wizard instead of a single Connect button. Triggered when `completion.connected < 2` (no integration data is meaningful with only 0 or 1 connections).

Wizard flow:

1. **Welcome card**: "Set up Traffic Impact in 4 steps. ~10 min." + skip-for-now link
2. **Step 1 — GA4**: full `<ConnectorCard>` in `surface: "wizard"` mode (expanded, no accordion). Connect → OAuth → property pick → backfill progress → next.
3. **Step 2..N**: same pattern for `recommended_next` chain. Each step has Back / Skip / Done buttons. Skipping persists "deferred" state in `localStorage` so we don't re-nag.
4. **Done**: "Setup complete. Your dashboard will populate as data syncs over the next 24 hours."

The wizard is dismissable — users can Skip All to get to the empty dashboard, which then shows a "Resume setup" pill in the header.

State A's existing GA4-only Connect button is removed; State B (connected, no data) and State C (full data) on `traffic-impact.js` are unchanged.

## Surface 3: Dedicated /setup/traffic-impact page (Phase 3)

A focus-mode page (no sidebar/topbar nav, just a back arrow) for users who want to commit 30 minutes to setting everything up. Same `<ConnectorCard>` components, but:

- All six cards visible at once, in a vertical scroll
- Each card opens its full UX inline (not modal/expand)
- Side rail shows progress + jump-to anchors
- "Save & exit" returns to wherever they came from

Linked from:
- Settings hub header ("Open setup wizard →")
- TrafficImpact.html header when partially set up ("Resume setup →")
- The post-payment / activation flow (added to the existing first-login experience)

## Critical files

- `worker/src/routes/portal.ts` — register new `GET /api/client/integrations/status` route alongside existing `/api/client/ga4/status`, `/api/client/gsc/status` etc.
- `worker/src/lib/integrationsStatus.ts` (new) — `buildIntegrationsStatus(env, slug)` aggregator
- `site/js/v2/connectorCard.js` (new) — shared rendering
- `site/js/v2/prereqCoach.js` (new) — coach component + static `COACHES` map
- `site/js/v2/settings.js` — replace `renderGa4Card`, `renderGscCard`, `renderCrmCard`, `renderAuthorityCard` callsites with one `<ConnectorCard>` loop. Keep the `wireGa4Card`/`wireGscCard`/`wireCrmCard`/`wireAuthorityCard` action handlers and call them from the connector card's button click.
- `site/js/v2/traffic-impact.js` — replace State A with the wizard
- `site/setup/traffic-impact.html` (new) — focus-mode page shell
- `site/js/v2/setupPage.js` (new) — page module

## What's reused

- All existing OAuth start/callback/disconnect endpoints stay byte-identical (`apiGA4StartLink`, `apiGSCStartLink`, `apiCrmStartLink`, `apiGSCSites`, `apiGSCSelectSite`, `apiGA4Properties`, `apiGA4SelectProperty`, `apiAuthorityConfigure`, `apiAuthorityDisconnect`, etc.). The new connector card uses them.
- The just-shipped `runInlinePicker` helper in `settings.js` (2026-05-07) is the picker primitive `<ConnectorCard>` reuses for "Connected · pick a site" / "pick a property" states.
- The just-shipped `authedFetch` 401 refresh-and-retry (2026-05-07) means the new endpoint inherits the same auth resilience.
- The just-shipped `runInlinePicker`'s buildBody pattern handles multi-field selection bodies — reused for any future integration that needs it.

## Phasing

Each phase is shippable on its own and provides independent value:

| Phase | What ships | Pain dimension fixed |
|---|---|---|
| **1** | Backend status endpoint + `<ConnectorCard>` + `<PrereqCoach>` + Settings hub replaces 4 cards | Discovery, per-integration friction, external prereqs, visibility — all four, on the surface where existing customers spend time |
| **2** | Wizard on /TrafficImpact.html empty state | First-run experience — dashboard no longer looks broken when not configured |
| **3** | Dedicated /setup/traffic-impact page + onboarding link | Power users + post-payment flow |
| **4** | Smart engine v2 (per-tenant ordering by business type / vertical) | Personalization |

## Non-goals

- Reworking the OAuth flows themselves. The picker UX shipped 2026-05-07 is the picker UX.
- Building a generic "integrations marketplace". Scope is the 6 Traffic Impact integrations.
- Touching the Authority Kit, CRM passthrough, or GSC sync internals. This spec is purely setup UX.
- Multi-tenant team-member-permissioned integration management. Today only owners can connect.
- Rewriting `Settings.html`'s other cards (Connection / API & Webhooks / Install / Tutorial / Team / Danger zone). Out of scope.

## Verification

End-to-end manual test, on a fresh Pro tenant with nothing connected:

1. Land on `/Settings.html`. Confirm the new "Traffic Impact integrations" card shows 0/6 connected, GA4 as recommended next, all 6 rows visible, Pro-locked rows none (Pro tenant), Stripe + Authority showing PrereqCoach inline.
2. Connect GA4 from inside the hub card. Verify property picker fires (uses existing `runInlinePicker`). Verify hub re-renders with GA4 status flipping to `connected_pending_config` → `connected_active`, completion ticking to 1/6, recommended-next moving to GSC.
3. Land on `/TrafficImpact.html` (still has only GA4). Verify the wizard renders State A — not the empty dashboard. Step through to GSC. Verify Skip All path lands on the empty dashboard with a "Resume setup" pill.
4. Open `/setup/traffic-impact`. Verify all 6 cards render in focus mode. Connect Stripe webhook end-to-end via the PrereqCoach. Verify webhook URL copy-button works.
5. Disconnect GA4. Verify `recommended_next` flips back to GA4 across all three surfaces on next render.
6. Land on `/Settings.html` as a Base tenant. Verify GSC + CRM + Stripe + Authority cards show `plan_locked` state with maroon Pro pill + "See what this unlocks" expand.

Worker tests: extend `worker/src/routes/portal.ts` test coverage with a `GET /api/client/integrations/status` happy-path test + a Pro-locked-row test + a recommended-next-respects-plan test. Target: keep 631-test green baseline; add 5–10 tests across `lib/integrationsStatus.test.ts`.

Frontend: no automated tests today on `site/js/v2/*` (per session notes). Manual verification via the steps above.

## Open questions

1. **Resume-from-where-you-stopped**: when wizard is skipped mid-step (e.g. completed GA4, started GSC, hit OAuth, didn't return), where do they resume on next visit — the GSC step or back to the welcome card? (Recommendation: GSC step, with a "show me everything again" link.)
2. **Authority Kit prereq verification**: Place IDs are validated server-side on save (per existing `apiAuthorityConfigure`). Should the PrereqCoach include a "test this Place ID" button before save? (Recommendation: yes, lazy GET to a new validation endpoint.)
3. **Webhook secret rotation UX**: today the only way to rotate the Stripe webhook secret is to disconnect + reconnect. Should the connector card surface "rotate secret" as a separate action? (Out of scope for Phase 1; revisit Phase 4.)
4. **Smart engine personalization signal**: tenants don't currently self-report business type / vertical. Either ask (one onboarding question), infer from `business_name` + `category`, or skip until v2 with the answer the user provides above.
