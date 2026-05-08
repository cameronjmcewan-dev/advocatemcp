# Traffic Impact Setup — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 5 separate Traffic Impact integration surfaces on `/Settings.html` (4 cards + revenue webhook inline) with one unified "Traffic Impact integrations" hub powered by a single backend status endpoint and shared frontend connector components.

**Architecture:** New `GET /api/client/integrations/status` endpoint aggregates state for all 6 integrations (GA4, GSC, HubSpot, Salesforce, Stripe webhook, Authority Kit) in one round-trip. Pure aggregator function (`buildIntegrationsStatus`) takes a `IntegrationsFacts` input and returns the typed response — orchestrator function does the D1 queries. Frontend gets two new modules: `prereqCoach.js` (static coaching content for external setup steps) and `connectorCard.js` (single render function for any integration in any of 7 status states). `settings.js` swaps its 4 separate `render*Card()` calls + inline revenue-webhook block for one loop over the new endpoint's response.

**Tech Stack:** TypeScript Cloudflare Worker (vitest tests), D1 (SQLite), vanilla browser JS for the dashboard. Reuses the existing per-integration OAuth/connect/disconnect endpoints unchanged.

**Spec:** `docs/superpowers/specs/2026-05-07-traffic-impact-setup-design.md` (commit `ae27001`).

**Out of scope (future phases):** Phase 2 wizard on `/TrafficImpact.html`, Phase 3 dedicated `/setup/traffic-impact` page, Phase 4 smart engine personalization. Each is its own plan after Phase 1 ships.

---

## File Map

### New
- `worker/src/lib/integrationsStatus.ts` — pure aggregator + types
- `worker/src/lib/integrationsStatus.test.ts` — vitest unit tests for the aggregator
- `site/js/v2/prereqCoach.js` — static `COACHES` map + `renderCoach()` function
- `site/js/v2/connectorCard.js` — `renderConnectorCard(integration, surface)` function

### Modified
- `worker/src/routes/portal.ts` — register new `GET /api/client/integrations/status` route (+ OPTIONS preflight)
- `site/js/v2/settings.js` — replace `renderGa4Card`/`renderGscCard`/`renderCrmCard`/`renderAuthorityCard` callsites + inline revenue-webhook section with one `renderIntegrationsHub()` loop. Keep `wireGa4Card`/`wireGscCard`/`wireCrmCard`/`wireAuthorityCard` action handlers intact and wire them from the connector card's button click events.

### Untouched
- `worker/src/routes/portal.ts` — every existing OAuth/select/disconnect/configure/resync/generate handler (`apiGA4StartLink`, `apiGA4Properties`, `apiGA4SelectProperty`, `apiGA4Status`, `apiGA4Disconnect`, `apiGA4Resync`, `apiGSCStartLink`, `apiGSCSites`, `apiGSCSelectSite`, `apiGSCStatus`, `apiGSCDisconnect`, `apiGSCResync`, `apiCrmStartLink`, `apiCrmDisconnect`, `apiAuthorityConfigure`, `apiAuthorityDisconnect`, `apiAuthorityStatus`, the revenue-webhook generate/rotate handlers).
- `worker/src/routes/dashboard/api.ts`.
- D1 schema. No new tables, no new columns.

---

## Task 1: Backend — types + aggregator skeleton (TDD)

**Files:**
- Create: `worker/src/lib/integrationsStatus.ts`
- Create: `worker/src/lib/integrationsStatus.test.ts`

- [ ] **Step 1: Create the file with exported types**

```ts
// worker/src/lib/integrationsStatus.ts

/**
 * Pure aggregator that turns per-integration "facts" (the result of
 * D1 queries) into the response payload for GET /api/client/integrations/status.
 *
 * Lives separately from the route handler so it's pure-function testable
 * — same pattern as conversionAggregator.ts and authorityAggregator.ts.
 *
 * Spec: docs/superpowers/specs/2026-05-07-traffic-impact-setup-design.md
 */

export type IntegrationStatus =
  | "not_connected"
  | "connecting"
  | "connected_pending_config"
  | "connected_active"
  | "connected_error"
  | "disconnected"
  | "plan_locked";

export type IntegrationCategory = "traffic" | "search" | "crm" | "revenue" | "authority";

export type PlanRequired = "base" | "pro" | "enterprise";

export interface ExternalPrereq {
  id: string;
  label: string;
  coach_id?: string;
}

export interface IntegrationView {
  id: string;
  name: string;
  category: IntegrationCategory;
  plan_required: PlanRequired;
  status: IntegrationStatus;
  value_props: string[];
  external_prereqs: ExternalPrereq[];
  config_summary: string | null;
  last_sync_at: string | null;
  last_sync_error: string | null;
  actions: string[];
}

export interface IntegrationsFacts {
  tenant: { slug: string; plan: PlanRequired };
  ga4:        { connected: boolean; property_id: string | null; property_label: string | null; last_sync_at: string | null; last_sync_error: string | null };
  gsc:        { connected: boolean; site_url: string | null; last_sync_at: string | null; last_sync_error: string | null };
  hubspot:    { connected: boolean; account_id: string | null; last_used_at: string | null; last_error: string | null };
  salesforce: { connected: boolean; account_id: string | null; last_used_at: string | null; last_error: string | null };
  stripe_webhook: { configured: boolean; total_events: number; ai_events: number };
  authority:  { configured: boolean; brand_keyword: string | null; google_place_id: string | null; last_synced_at: string | null; last_sync_error: string | null };
}

export interface IntegrationsStatusResponse {
  tenant: { slug: string; plan: PlanRequired };
  integrations: IntegrationView[];
  recommended_next: string | null;
  completion: { connected: number; available: number; pct: number };
}

export function buildIntegrationsStatus(facts: IntegrationsFacts): IntegrationsStatusResponse {
  // Implementation lands in subsequent steps.
  return {
    tenant: facts.tenant,
    integrations: [],
    recommended_next: null,
    completion: { connected: 0, available: 0, pct: 0 },
  };
}
```

- [ ] **Step 2: Create the test file with the first failing test**

```ts
// worker/src/lib/integrationsStatus.test.ts

import { describe, it, expect } from "vitest";
import { buildIntegrationsStatus, type IntegrationsFacts } from "./integrationsStatus.js";

function emptyFacts(plan: "base" | "pro" = "pro"): IntegrationsFacts {
  return {
    tenant: { slug: "test-tenant", plan },
    ga4:        { connected: false, property_id: null, property_label: null, last_sync_at: null, last_sync_error: null },
    gsc:        { connected: false, site_url: null, last_sync_at: null, last_sync_error: null },
    hubspot:    { connected: false, account_id: null, last_used_at: null, last_error: null },
    salesforce: { connected: false, account_id: null, last_used_at: null, last_error: null },
    stripe_webhook: { configured: false, total_events: 0, ai_events: 0 },
    authority:  { configured: false, brand_keyword: null, google_place_id: null, last_synced_at: null, last_sync_error: null },
  };
}

describe("buildIntegrationsStatus", () => {
  it("returns 6 integrations regardless of connection state", () => {
    const result = buildIntegrationsStatus(emptyFacts());
    expect(result.integrations).toHaveLength(6);
    const ids = result.integrations.map(i => i.id).sort();
    expect(ids).toEqual(["authority", "ga4", "gsc", "hubspot", "salesforce", "stripe_webhook"]);
  });
});
```

- [ ] **Step 3: Run the test — expect it to fail**

Run: `cd worker && npx vitest run src/lib/integrationsStatus.test.ts`
Expected: FAIL — `expected length 0 to be 6`

- [ ] **Step 4: Implement the integrations array (skeleton — every integration `not_connected`)**

Replace the placeholder body of `buildIntegrationsStatus` in `worker/src/lib/integrationsStatus.ts`:

```ts
export function buildIntegrationsStatus(facts: IntegrationsFacts): IntegrationsStatusResponse {
  const isPro = facts.tenant.plan === "pro" || facts.tenant.plan === "enterprise";

  function lockOrStatus(planRequired: PlanRequired, computed: IntegrationStatus): IntegrationStatus {
    if (planRequired === "base") return computed;
    return isPro ? computed : "plan_locked";
  }

  const integrations: IntegrationView[] = [
    {
      id: "ga4",
      name: "Google Analytics",
      category: "traffic",
      plan_required: "base",
      status: lockOrStatus("base", "not_connected"),
      value_props: ["See AI vs human traffic split on the dashboard", "Track engagement quality + acquisition mix + geography"],
      external_prereqs: [],
      config_summary: null,
      last_sync_at: null,
      last_sync_error: null,
      actions: ["connect"],
    },
    {
      id: "gsc",
      name: "Google Search Console",
      category: "search",
      plan_required: "pro",
      status: lockOrStatus("pro", "not_connected"),
      value_props: ["Detect when Google's AI Overview shows for your queries", "See cite-rate per query"],
      external_prereqs: [{ id: "gsc_verified_site", label: "A site verified in Search Console", coach_id: "gsc_verification" }],
      config_summary: null,
      last_sync_at: null,
      last_sync_error: null,
      actions: ["connect"],
    },
    {
      id: "hubspot",
      name: "HubSpot",
      category: "crm",
      plan_required: "pro",
      status: lockOrStatus("pro", "not_connected"),
      value_props: ["Compare LTV of AI-acquired vs unknown-source customers"],
      external_prereqs: [{ id: "hubspot_account", label: "A HubSpot account" }],
      config_summary: null,
      last_sync_at: null,
      last_sync_error: null,
      actions: ["connect"],
    },
    {
      id: "salesforce",
      name: "Salesforce",
      category: "crm",
      plan_required: "pro",
      status: lockOrStatus("pro", "not_connected"),
      value_props: ["Compare LTV of AI-acquired vs unknown-source customers"],
      external_prereqs: [{ id: "salesforce_account", label: "A Salesforce account" }],
      config_summary: null,
      last_sync_at: null,
      last_sync_error: null,
      actions: ["connect"],
    },
    {
      id: "stripe_webhook",
      name: "Verified revenue",
      category: "revenue",
      plan_required: "pro",
      status: lockOrStatus("pro", "not_connected"),
      value_props: ["Attribute revenue dollars to AI-acquired customers"],
      external_prereqs: [{ id: "stripe_account", label: "A Stripe account", coach_id: "stripe_webhook" }],
      config_summary: null,
      last_sync_at: null,
      last_sync_error: null,
      actions: ["generate"],
    },
    {
      id: "authority",
      name: "Authority Kit",
      category: "authority",
      plan_required: "pro",
      status: lockOrStatus("pro", "not_connected"),
      value_props: ["Track Reddit + Google Reviews mentions + sentiment"],
      external_prereqs: [
        { id: "brand_keyword", label: "A brand keyword to monitor" },
        { id: "google_place_id", label: "Your Google Place ID", coach_id: "google_place_id" },
      ],
      config_summary: null,
      last_sync_at: null,
      last_sync_error: null,
      actions: ["configure"],
    },
  ];

  return {
    tenant: facts.tenant,
    integrations,
    recommended_next: null,
    completion: { connected: 0, available: integrations.filter(i => i.status !== "plan_locked").length, pct: 0 },
  };
}
```

- [ ] **Step 5: Run the test — expect it to pass**

Run: `cd worker && npx vitest run src/lib/integrationsStatus.test.ts`
Expected: PASS — 1 test.

- [ ] **Step 6: Commit**

```bash
git add worker/src/lib/integrationsStatus.ts worker/src/lib/integrationsStatus.test.ts
git commit -m "feat(integrations): pure aggregator skeleton — types + 6-integration list

First task of Phase 1 of the Traffic Impact setup redesign. Pure
function input/output to keep tests fast. Subsequent tasks add the
status-per-integration logic, recommended_next ranking, completion %,
plan-locked rendering, and the D1 orchestrator + route handler.

Spec: docs/superpowers/specs/2026-05-07-traffic-impact-setup-design.md"
```

---

## Task 2: Backend — per-integration status logic (TDD)

**Files:**
- Modify: `worker/src/lib/integrationsStatus.ts`
- Modify: `worker/src/lib/integrationsStatus.test.ts`

- [ ] **Step 1: Add tests for GA4 connected states**

Append to `worker/src/lib/integrationsStatus.test.ts` inside the `describe`:

```ts
  it("GA4 connected with property → connected_active + config_summary + actions", () => {
    const facts = emptyFacts();
    facts.ga4 = { connected: true, property_id: "properties/123", property_label: "Acme.com", last_sync_at: "2026-05-07T12:00:00Z", last_sync_error: null };
    const result = buildIntegrationsStatus(facts);
    const ga4 = result.integrations.find(i => i.id === "ga4")!;
    expect(ga4.status).toBe("connected_active");
    expect(ga4.config_summary).toBe("Acme.com (properties/123)");
    expect(ga4.last_sync_at).toBe("2026-05-07T12:00:00Z");
    expect(ga4.actions).toEqual(["resync", "disconnect"]);
  });

  it("GA4 connected without property selected → connected_pending_config", () => {
    const facts = emptyFacts();
    facts.ga4 = { connected: true, property_id: null, property_label: null, last_sync_at: null, last_sync_error: null };
    const result = buildIntegrationsStatus(facts);
    const ga4 = result.integrations.find(i => i.id === "ga4")!;
    expect(ga4.status).toBe("connected_pending_config");
    expect(ga4.actions).toEqual(["pick_property", "disconnect"]);
  });

  it("GA4 connected with last_sync_error → connected_error", () => {
    const facts = emptyFacts();
    facts.ga4 = { connected: true, property_id: "properties/123", property_label: "Acme.com", last_sync_at: "2026-05-07T12:00:00Z", last_sync_error: "GA4 API quota exceeded" };
    const result = buildIntegrationsStatus(facts);
    const ga4 = result.integrations.find(i => i.id === "ga4")!;
    expect(ga4.status).toBe("connected_error");
    expect(ga4.last_sync_error).toBe("GA4 API quota exceeded");
  });
```

- [ ] **Step 2: Run tests — expect 3 new failures**

Run: `cd worker && npx vitest run src/lib/integrationsStatus.test.ts`
Expected: 1 PASS, 3 FAIL.

- [ ] **Step 3: Implement the per-integration status logic**

In `worker/src/lib/integrationsStatus.ts`, add a helper above `buildIntegrationsStatus`:

```ts
function ga4View(facts: IntegrationsFacts, isPro: boolean): IntegrationView {
  const base = {
    id: "ga4",
    name: "Google Analytics",
    category: "traffic" as const,
    plan_required: "base" as const,
    value_props: ["See AI vs human traffic split on the dashboard", "Track engagement quality + acquisition mix + geography"],
    external_prereqs: [],
    last_sync_at: facts.ga4.last_sync_at,
    last_sync_error: facts.ga4.last_sync_error,
  };
  if (!facts.ga4.connected) {
    return { ...base, status: "not_connected", config_summary: null, actions: ["connect"] };
  }
  if (!facts.ga4.property_id) {
    return { ...base, status: "connected_pending_config", config_summary: null, actions: ["pick_property", "disconnect"] };
  }
  const summary = facts.ga4.property_label
    ? `${facts.ga4.property_label} (${facts.ga4.property_id})`
    : facts.ga4.property_id;
  if (facts.ga4.last_sync_error) {
    return { ...base, status: "connected_error", config_summary: summary, actions: ["resync", "disconnect"] };
  }
  return { ...base, status: "connected_active", config_summary: summary, actions: ["resync", "disconnect"] };
}
```

Replace the GA4 entry inside the `integrations` array in `buildIntegrationsStatus` with `ga4View(facts, isPro)`.

- [ ] **Step 4: Run tests — expect all 4 GA4-area tests to pass**

Run: `cd worker && npx vitest run src/lib/integrationsStatus.test.ts`
Expected: 4 PASS.

- [ ] **Step 5: Repeat the test → impl → pass cycle for each remaining integration**

For each of: GSC, HubSpot, Salesforce, Stripe webhook, Authority Kit — write 3 tests (not_connected → connected_pending_config / connected_active → connected_error or per-integration's actual states), then implement the corresponding `gscView`, `hubspotView`, `salesforceView`, `stripeWebhookView`, `authorityView` helpers. Replace the inline objects in the `integrations` array with the helper calls.

Per-integration `connected_pending_config` triggers:
- **GSC**: connected but `site_url` is null → "pick_site"
- **HubSpot / Salesforce**: never `connected_pending_config` (OAuth completes selection in one step)
- **Stripe webhook**: `configured` true but `total_events === 0` → still `connected_active` (just "Awaiting first event" in `config_summary`); never `connected_pending_config`
- **Authority Kit**: `configured` true requires both `brand_keyword` AND `google_place_id`; if only one is set → `connected_pending_config`

Per-integration `config_summary` examples:
- **GSC**: `facts.gsc.site_url` (e.g. "https://acme.com/")
- **HubSpot**: `facts.hubspot.account_id ? "Account: " + facts.hubspot.account_id : "Connected"`
- **Salesforce**: same pattern as HubSpot
- **Stripe webhook**: `facts.stripe_webhook.total_events > 0 ? "${total_events} events received · ${ai_events} attributed to AI" : "Awaiting first event"`
- **Authority Kit**: `facts.authority.brand_keyword + " · " + facts.authority.google_place_id` when both set

Per-integration `actions`:
- **GSC**: same as GA4 (`pick_site` instead of `pick_property` for pending state, else `resync` + `disconnect`)
- **HubSpot / Salesforce**: `["disconnect"]` when connected; `["connect"]` when not
- **Stripe webhook**: `["rotate"]` when configured; `["generate"]` when not (`view_secret` isn't possible — secrets aren't stored plaintext)
- **Authority Kit**: `["edit", "disconnect"]` when configured; `["configure"]` when not

- [ ] **Step 6: Run the full test file — expect all integration tests to pass (~16 tests)**

Run: `cd worker && npx vitest run src/lib/integrationsStatus.test.ts`
Expected: 16 PASS.

- [ ] **Step 7: Commit**

```bash
git add worker/src/lib/integrationsStatus.ts worker/src/lib/integrationsStatus.test.ts
git commit -m "feat(integrations): per-integration status mapping for all 6 surfaces

Each integration now reports the right status of:
not_connected | connected_pending_config | connected_active | connected_error,
plus typed config_summary + actions list. plan-locked handling stays
in the parent aggregator so per-integration helpers don't repeat it."
```

---

## Task 3: Backend — recommended_next + completion + plan_locked (TDD)

**Files:**
- Modify: `worker/src/lib/integrationsStatus.ts`
- Modify: `worker/src/lib/integrationsStatus.test.ts`

- [ ] **Step 1: Add tests for `recommended_next`**

Append to the test file:

```ts
  it("recommended_next is GA4 when nothing connected", () => {
    const result = buildIntegrationsStatus(emptyFacts());
    expect(result.recommended_next).toBe("ga4");
  });

  it("recommended_next moves to GSC after GA4 connected (Pro tenant)", () => {
    const facts = emptyFacts("pro");
    facts.ga4 = { connected: true, property_id: "properties/1", property_label: "X", last_sync_at: null, last_sync_error: null };
    expect(buildIntegrationsStatus(facts).recommended_next).toBe("gsc");
  });

  it("recommended_next stops at GA4 for Base tenant once GA4 is connected", () => {
    const facts = emptyFacts("base");
    facts.ga4 = { connected: true, property_id: "properties/1", property_label: "X", last_sync_at: null, last_sync_error: null };
    expect(buildIntegrationsStatus(facts).recommended_next).toBe(null);
  });

  it("recommended_next walks the full Pro chain in order: ga4 → gsc → hubspot → stripe_webhook → authority", () => {
    const facts = emptyFacts("pro");
    facts.ga4        = { connected: true, property_id: "properties/1", property_label: "X", last_sync_at: null, last_sync_error: null };
    facts.gsc        = { connected: true, site_url: "https://x.com/", last_sync_at: null, last_sync_error: null };
    expect(buildIntegrationsStatus(facts).recommended_next).toBe("hubspot");
    facts.hubspot    = { connected: true, account_id: "1", last_used_at: null, last_error: null };
    expect(buildIntegrationsStatus(facts).recommended_next).toBe("stripe_webhook");
    facts.stripe_webhook = { configured: true, total_events: 0, ai_events: 0 };
    expect(buildIntegrationsStatus(facts).recommended_next).toBe("authority");
    facts.authority  = { configured: true, brand_keyword: "x", google_place_id: "y", last_synced_at: null, last_sync_error: null };
    expect(buildIntegrationsStatus(facts).recommended_next).toBe(null);
  });
```

- [ ] **Step 2: Add tests for `completion`**

```ts
  it("completion is 0/6 with no connections (Pro)", () => {
    const r = buildIntegrationsStatus(emptyFacts("pro"));
    expect(r.completion).toEqual({ connected: 0, available: 6, pct: 0 });
  });

  it("completion is 0/1 for Base (only GA4 is available)", () => {
    const r = buildIntegrationsStatus(emptyFacts("base"));
    expect(r.completion).toEqual({ connected: 0, available: 1, pct: 0 });
  });

  it("completion counts connected_active + connected_pending_config + connected_error as connected", () => {
    const facts = emptyFacts("pro");
    facts.ga4 = { connected: true, property_id: "properties/1", property_label: "X", last_sync_at: null, last_sync_error: null };
    facts.gsc = { connected: true, site_url: null, last_sync_at: null, last_sync_error: null };
    facts.hubspot = { connected: true, account_id: "1", last_used_at: null, last_error: "stale token" };
    const r = buildIntegrationsStatus(facts);
    expect(r.completion.connected).toBe(3);
    expect(r.completion.available).toBe(6);
    expect(r.completion.pct).toBe(50);
  });
```

- [ ] **Step 3: Add tests for `plan_locked`**

```ts
  it("Base tenant sees Pro integrations as plan_locked, not not_connected", () => {
    const r = buildIntegrationsStatus(emptyFacts("base"));
    const gsc = r.integrations.find(i => i.id === "gsc")!;
    expect(gsc.status).toBe("plan_locked");
    const stripe = r.integrations.find(i => i.id === "stripe_webhook")!;
    expect(stripe.status).toBe("plan_locked");
  });

  it("Base tenant: GA4 stays unlocked even when not connected", () => {
    const r = buildIntegrationsStatus(emptyFacts("base"));
    const ga4 = r.integrations.find(i => i.id === "ga4")!;
    expect(ga4.status).toBe("not_connected");
  });
```

- [ ] **Step 4: Run tests — expect 9 new failures**

Run: `cd worker && npx vitest run src/lib/integrationsStatus.test.ts`
Expected: 16 PASS + 9 FAIL.

- [ ] **Step 5: Implement `recommended_next` + `completion` + `plan_locked` enforcement**

Replace the bottom of `buildIntegrationsStatus` with the real logic. Each `*View()` helper should still return its raw `status` (no plan-lock awareness); the wrapper enforces plan-lock by overriding `status` to `"plan_locked"` when the tenant's plan can't access the integration.

```ts
const RECOMMENDED_ORDER = ["ga4", "gsc", "hubspot", "stripe_webhook", "authority"] as const;

export function buildIntegrationsStatus(facts: IntegrationsFacts): IntegrationsStatusResponse {
  const isPro = facts.tenant.plan === "pro" || facts.tenant.plan === "enterprise";

  // Build raw views — each helper computes status assuming the integration
  // is available. We override to "plan_locked" below for Pro-gated integrations
  // when the tenant is on Base.
  const raw: IntegrationView[] = [
    ga4View(facts),
    gscView(facts),
    hubspotView(facts),
    salesforceView(facts),
    stripeWebhookView(facts),
    authorityView(facts),
  ];

  const integrations = raw.map((view): IntegrationView => {
    if (view.plan_required !== "base" && !isPro) {
      return { ...view, status: "plan_locked", actions: ["upgrade"] };
    }
    return view;
  });

  const isConnected = (s: IntegrationStatus) =>
    s === "connected_active" || s === "connected_pending_config" || s === "connected_error";

  const available = integrations.filter(i => i.status !== "plan_locked").length;
  const connected = integrations.filter(i => isConnected(i.status)).length;
  const pct = available === 0 ? 0 : Math.round((connected / available) * 100);

  // recommended_next: walk RECOMMENDED_ORDER, return the first integration
  // that is available to this tenant AND not yet connected. Skip Salesforce —
  // we recommend HubSpot first; Salesforce is an alt for tenants on it already.
  let recommended_next: string | null = null;
  for (const id of RECOMMENDED_ORDER) {
    const i = integrations.find(x => x.id === id);
    if (!i) continue;
    if (i.status === "plan_locked") continue;
    if (!isConnected(i.status)) {
      recommended_next = id;
      break;
    }
  }

  return {
    tenant: facts.tenant,
    integrations,
    recommended_next,
    completion: { connected, available, pct },
  };
}
```

Remove the unused `lockOrStatus()` helper and `isPro` parameter from each per-integration helper signature (helpers are now plan-blind).

- [ ] **Step 6: Run all tests — expect everything to pass**

Run: `cd worker && npx vitest run src/lib/integrationsStatus.test.ts`
Expected: ~25 PASS.

- [ ] **Step 7: Commit**

```bash
git add worker/src/lib/integrationsStatus.ts worker/src/lib/integrationsStatus.test.ts
git commit -m "feat(integrations): recommended_next + completion + plan_locked enforcement

Pro-gated integrations render as plan_locked for Base tenants and
never appear as recommended_next. Completion % counts connected
states only against the integrations available to the tenant's plan,
so a Base tenant with GA4 connected reads 100% complete (1/1) rather
than 17% (1/6)."
```

---

## Task 4: Backend — D1 orchestrator + route handler + OPTIONS

**Files:**
- Modify: `worker/src/lib/integrationsStatus.ts` (add orchestrator)
- Modify: `worker/src/routes/portal.ts` (add route + OPTIONS)

- [ ] **Step 1: Add the D1 orchestrator at the bottom of `integrationsStatus.ts`**

Append to `worker/src/lib/integrationsStatus.ts`:

```ts
import type { Business } from "../portalDb.js"; // re-export pattern; verify path

/**
 * Queries D1 for the per-integration facts and calls the pure aggregator.
 * Promise.allSettled per query — a transient D1 hiccup on one integration
 * doesn't blank the whole hub. Failed lookups fall back to "not_connected"
 * facts so the UI can still render.
 */
export async function fetchIntegrationsStatus(
  db: D1Database,
  biz: Business,
): Promise<IntegrationsStatusResponse> {
  const slug = biz.slug;
  const plan: PlanRequired = ((biz as { plan?: string }).plan ?? "base") as PlanRequired;

  const [ga4Row, gscRow, hubRow, sfRow, revRow, authRow, eventsRow] = await Promise.all([
    db.prepare("SELECT property_id, property_label, last_sync_at, last_sync_error FROM ga4_connections WHERE slug = ? LIMIT 1").bind(slug).first<{ property_id: string | null; property_label: string | null; last_sync_at: string | null; last_sync_error: string | null }>().catch(() => null),
    db.prepare("SELECT site_url, last_sync_at, last_sync_error FROM gsc_connections WHERE slug = ? LIMIT 1").bind(slug).first<{ site_url: string | null; last_sync_at: string | null; last_sync_error: string | null }>().catch(() => null),
    db.prepare("SELECT account_id, last_used_at, last_error FROM crm_connections WHERE slug = ? AND provider = 'hubspot' LIMIT 1").bind(slug).first<{ account_id: string | null; last_used_at: string | null; last_error: string | null }>().catch(() => null),
    db.prepare("SELECT account_id, last_used_at, last_error FROM crm_connections WHERE slug = ? AND provider = 'salesforce' LIMIT 1").bind(slug).first<{ account_id: string | null; last_used_at: string | null; last_error: string | null }>().catch(() => null),
    db.prepare("SELECT revenue_webhook_secret FROM businesses WHERE slug = ? LIMIT 1").bind(slug).first<{ revenue_webhook_secret: string | null }>().catch(() => null),
    db.prepare("SELECT brand_keyword, google_place_id, last_synced_at, last_sync_error FROM authority_config WHERE slug = ? LIMIT 1").bind(slug).first<{ brand_keyword: string | null; google_place_id: string | null; last_synced_at: string | null; last_sync_error: string | null }>().catch(() => null),
    db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN referrer_classification = 'ai' THEN 1 ELSE 0 END) AS ai FROM revenue_events WHERE business_slug = ?").bind(slug).first<{ total: number; ai: number }>().catch(() => ({ total: 0, ai: 0 })),
  ]);

  const facts: IntegrationsFacts = {
    tenant: { slug, plan },
    ga4: {
      connected:        ga4Row !== null,
      property_id:      ga4Row?.property_id ?? null,
      property_label:   ga4Row?.property_label ?? null,
      last_sync_at:     ga4Row?.last_sync_at ?? null,
      last_sync_error:  ga4Row?.last_sync_error ?? null,
    },
    gsc: {
      connected:        gscRow !== null,
      site_url:         gscRow?.site_url ?? null,
      last_sync_at:     gscRow?.last_sync_at ?? null,
      last_sync_error:  gscRow?.last_sync_error ?? null,
    },
    hubspot: {
      connected:        hubRow !== null,
      account_id:       hubRow?.account_id ?? null,
      last_used_at:     hubRow?.last_used_at ?? null,
      last_error:       hubRow?.last_error ?? null,
    },
    salesforce: {
      connected:        sfRow !== null,
      account_id:       sfRow?.account_id ?? null,
      last_used_at:     sfRow?.last_used_at ?? null,
      last_error:       sfRow?.last_error ?? null,
    },
    stripe_webhook: {
      configured:       !!revRow?.revenue_webhook_secret,
      total_events:     Number(eventsRow?.total ?? 0),
      ai_events:        Number(eventsRow?.ai ?? 0),
    },
    authority: {
      configured:       !!(authRow?.brand_keyword && authRow?.google_place_id),
      brand_keyword:    authRow?.brand_keyword ?? null,
      google_place_id:  authRow?.google_place_id ?? null,
      last_synced_at:   authRow?.last_synced_at ?? null,
      last_sync_error:  authRow?.last_sync_error ?? null,
    },
  };

  return buildIntegrationsStatus(facts);
}
```

If `Business` isn't exported from `portalDb.ts`, take a `{ slug: string; plan?: string }` shape parameter instead — the orchestrator only needs slug + plan.

- [ ] **Step 2: Add the route handler in `portal.ts`**

Open `worker/src/routes/portal.ts`. Find the registration block where the GA4 and GSC status routes live (around line 210, near `pathname === "/api/client/ga4/status"`). Add the new route registration alongside them:

```ts
if (pathname === "/api/client/integrations/status" && method === "GET")     return apiIntegrationsStatus(request, env);
if (pathname === "/api/client/integrations/status" && method === "OPTIONS") return handleCorsPreflight(request, { credentials: true });
```

Then add the handler function alongside `apiGA4Status` etc. — search for `async function apiGA4Status` and add the new handler nearby:

```ts
import { fetchIntegrationsStatus } from "../lib/integrationsStatus.js";

// ── GET /api/client/integrations/status ────────────────────────────────────
//
// Aggregator for the unified Traffic Impact integrations hub on Settings.
// Returns the status of all 6 integrations (GA4, GSC, HubSpot, Salesforce,
// Stripe webhook, Authority Kit) in one round-trip. Read-only; mutating
// actions still go through the per-integration endpoints.

async function apiIntegrationsStatus(request: Request, env: Env): Promise<Response> {
  const guard = await requireVerifiedSession(request, env);
  if (!guard.ok) return guard.resp;
  const ctx = guard.ctx;

  const businesses = ctx.role === "admin"
    ? await getActiveBusinesses(env.DB)
    : await getUserBusinesses(env.DB, ctx.user_id);
  const reqUrl = new URL(request.url);
  const slugParam = reqUrl.searchParams.get("slug");
  const biz = (slugParam ? businesses.find(b => b.slug === slugParam) : null) ?? businesses[0] ?? null;
  if (!biz) {
    return withCors(jsonErr(404, "No business"), request, { credentials: true });
  }

  const status = await fetchIntegrationsStatus(env.DB, biz);
  return withCors(jsonOk(status), request, { credentials: true });
}
```

(Place the import at the top of `portal.ts` with the other lib imports.)

- [ ] **Step 3: Run the worker typecheck**

Run: `cd worker && npm run typecheck`
Expected: exit 0, no output.

- [ ] **Step 4: Run the full worker test suite**

Run: `cd worker && npm test`
Expected: all 631 existing tests still pass + ~25 new aggregator tests = ~656 PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/lib/integrationsStatus.ts worker/src/routes/portal.ts
git commit -m "feat(integrations): wire D1 orchestrator + GET /api/client/integrations/status route

Single-round-trip status for all 6 Traffic Impact integrations. Promise.all
parallelism over the per-integration D1 lookups; per-query catch falls back
to not_connected facts so a transient hiccup on one table doesn't blank the
whole hub. OPTIONS preflight registered alongside (cross-origin POST blockers
were the root cause of the May 7 Settings audit findings)."
```

---

## Task 5: Frontend — `prereqCoach.js` static module

**Files:**
- Create: `site/js/v2/prereqCoach.js`

- [ ] **Step 1: Create the file with the static `COACHES` map + render function**

```js
// site/js/v2/prereqCoach.js
//
// Static coaching content for the external prerequisites that block
// some integration setups (Stripe webhook, Google Place ID lookup,
// GSC site verification). Same content surfaces in all 3 surfaces
// (Settings hub, Traffic Impact wizard, dedicated setup page) — the
// outer layout differs but the steps + helper links are constant.
//
// Spec: docs/superpowers/specs/2026-05-07-traffic-impact-setup-design.md
// Phase 1 of the Traffic Impact setup redesign.

(function () {
  'use strict';

  const COACHES = {
    stripe_webhook: {
      title: 'Connect Stripe to send revenue events to Advocate',
      steps: [
        { text: 'Click Generate below — Advocate will mint a webhook URL + signing secret for you.' },
        { text: 'Open your Stripe dashboard → Developers → Webhooks → Add endpoint.' },
        { text: 'Paste the URL into the Endpoint URL field. Subscribe to: charge.succeeded, payment_intent.succeeded, invoice.paid.' },
        { text: 'Stripe will ask for a signing secret — paste the secret Advocate generated above.' },
        { text: 'Save in Stripe. The first event we receive flips this card to Connected.' },
      ],
      helper_links: [{ label: 'Stripe webhook docs', url: 'https://stripe.com/docs/webhooks' }],
    },
    google_place_id: {
      title: 'Find your Google Place ID',
      steps: [
        { text: 'Open Google\'s Place ID Finder.' },
        { text: 'Search for your business by name (the same way customers find you).' },
        { text: 'Copy the Place ID — it looks like ChIJ… and is shown beneath the business name.' },
        { text: 'Paste it into the field below.' },
      ],
      helper_links: [{ label: 'Place ID Finder', url: 'https://developers.google.com/maps/documentation/places/web-service/place-id' }],
    },
    gsc_verification: {
      title: 'Verify your site in Google Search Console first',
      steps: [
        { text: 'Open Google Search Console.' },
        { text: 'Add your site as a property if it isn\'t already there.' },
        { text: 'Verify ownership using whichever method works (DNS TXT record, HTML file upload, or your existing Google Analytics).' },
        { text: 'Once verified, come back and click Connect — your verified site will appear in the picker.' },
      ],
      helper_links: [{ label: 'Search Console', url: 'https://search.google.com/search-console' }],
    },
  };

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /**
   * Render coach HTML for a given coach_id. Returns '' if the coach_id
   * isn't in the COACHES map (so callers can blindly call this with
   * the prereq's coach_id).
   */
  function render(coachId) {
    const coach = COACHES[coachId];
    if (!coach) return '';
    const stepsHtml = coach.steps.map((s, i) => `
      <li class="coach-step">
        <span class="coach-step-num">${i + 1}</span>
        <span class="coach-step-text">${escHtml(s.text)}</span>
      </li>`).join('');
    const linksHtml = (coach.helper_links || []).map(l =>
      `<a href="${escHtml(l.url)}" target="_blank" rel="noopener" class="coach-link">${escHtml(l.label)} →</a>`
    ).join(' ');
    return `
      <div class="prereq-coach">
        <div class="coach-title">${escHtml(coach.title)}</div>
        <ol class="coach-steps">${stepsHtml}</ol>
        ${linksHtml ? `<div class="coach-links">${linksHtml}</div>` : ''}
      </div>`;
  }

  window.AMCP_PREREQ_COACH = { render, COACHES };
})();
```

- [ ] **Step 2: Verify it parses**

Run: `node --check /Users/cameronmcewan/Desktop/advocate/advocatemcp/site/js/v2/prereqCoach.js`
Expected: exits 0 with no output.

- [ ] **Step 3: Commit**

```bash
git add site/js/v2/prereqCoach.js
git commit -m "feat(integrations): prereqCoach static coaching module for setup hub

Three coaches today (stripe_webhook, google_place_id, gsc_verification)
covering every external prereq across the 6 Traffic Impact integrations.
Same module reused in subsequent phases (TrafficImpact wizard, dedicated
setup page) so the coaching copy stays consistent."
```

---

## Task 6: Frontend — `connectorCard.js` shared render

**Files:**
- Create: `site/js/v2/connectorCard.js`

- [ ] **Step 1: Create the file with the render function**

```js
// site/js/v2/connectorCard.js
//
// Shared render function for any Traffic Impact integration in any of
// 7 status states (not_connected | connecting | connected_pending_config
// | connected_active | connected_error | disconnected | plan_locked).
// One source of truth for the visual contract across all 3 setup surfaces.
//
// Inputs: an integration object from /api/client/integrations/status,
// a `surface` prop ("hub" | "wizard" | "setup-page"), and an `actions`
// callback object that wires button clicks to the existing per-integration
// handlers in settings.js (wireGa4Card, wireGscCard, wireCrmCard,
// wireAuthorityCard, plus the revenue-webhook generate/rotate flow).
//
// Phase 1 surface: "hub" only. "wizard" + "setup-page" land in Phase 2-3.
//
// Spec: docs/superpowers/specs/2026-05-07-traffic-impact-setup-design.md

(function () {
  'use strict';

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function timeAgo(iso) {
    if (!iso) return 'never';
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 60_000) return 'just now';
    if (ms < 3_600_000) return Math.floor(ms / 60_000) + 'm ago';
    if (ms < 86_400_000) return Math.floor(ms / 3_600_000) + 'h ago';
    return Math.floor(ms / 86_400_000) + 'd ago';
  }

  // Map status → status-pill class + label
  const STATUS_PILL = {
    not_connected:            { cls: 'chip',                       label: 'Not connected' },
    connecting:               { cls: 'chip amber dot-chip',        label: 'Connecting…' },
    connected_pending_config: { cls: 'chip amber dot-chip',        label: 'Connected · pick configuration' },
    connected_active:         { cls: 'chip sage dot-chip',         label: 'Connected' },
    connected_error:          { cls: 'chip',                       label: 'Sync error' },
    disconnected:             { cls: 'chip',                       label: 'Disconnected' },
    plan_locked:              { cls: 'chip maroon',                label: 'Pro' },
  };

  /**
   * Renders one connector card row. Returns HTML string.
   * Surface-specific layout (hub uses an accordion row; wizard/setup-page
   * will use full-card layouts in later phases).
   */
  function render(integration, surface) {
    surface = surface || 'hub';
    const pill = STATUS_PILL[integration.status] || STATUS_PILL.not_connected;
    const dot = pill.cls.indexOf('dot-chip') >= 0 ? '<span class="dot"></span>' : '';
    const valueOneliner = (integration.value_props && integration.value_props[0]) || '';
    const lastSync = (integration.status === 'connected_active' || integration.status === 'connected_error')
      ? `<span class="cc-meta">Last sync ${escHtml(timeAgo(integration.last_sync_at))}</span>`
      : '';
    const summary = integration.config_summary
      ? `<span class="cc-summary">${escHtml(integration.config_summary)}</span>`
      : '';
    const errorPill = integration.last_sync_error
      ? `<span class="chip" style="background:rgba(180,40,40,.08);color:var(--red);border:1px solid rgba(180,40,40,.25);margin-left:6px">${escHtml(String(integration.last_sync_error).slice(0, 80))}</span>`
      : '';

    // Action buttons. Each action label is a known string from the aggregator;
    // settings.js wires click handlers via data-cc-action="${action}" + data-cc-id="${integration.id}".
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
    const actionsHtml = (integration.actions || []).map((a, i) => {
      const cls = (a === 'connect' || a === 'configure' || a === 'generate' || a === 'upgrade')
        ? 'btn btn-primary btn-sm'
        : 'btn btn-ghost btn-sm';
      const href = a === 'upgrade' ? ' href="/Billing.html"' : '';
      const tag = a === 'upgrade' ? 'a' : 'button';
      const typeAttr = a === 'upgrade' ? '' : ' type="button"';
      const margin = i > 0 ? ' style="margin-left:6px"' : '';
      return `<${tag} class="${cls}" data-cc-action="${escHtml(a)}" data-cc-id="${escHtml(integration.id)}"${typeAttr}${href}${margin}>${escHtml(actionLabels[a] || a)}</${tag}>`;
    }).join('');

    return `
      <div class="cc-row" data-cc-row="${escHtml(integration.id)}">
        <div class="cc-row-head">
          <div class="cc-row-name">
            <strong>${escHtml(integration.name)}</strong>
            <span class="${pill.cls}" style="margin-left:8px">${dot}${escHtml(pill.label)}</span>
            ${errorPill}
          </div>
          ${valueOneliner ? `<div class="cc-row-value">${escHtml(valueOneliner)}</div>` : ''}
          <div class="cc-row-meta">${summary} ${lastSync}</div>
        </div>
        <div class="cc-row-actions">${actionsHtml}</div>
      </div>`;
  }

  /**
   * Renders the whole hub: one card containing N connector rows + a
   * header with completion + recommended-next callout.
   */
  function renderHub(payload) {
    const completion = payload.completion || { connected: 0, available: 0, pct: 0 };
    const recommended = payload.recommended_next;
    const recommendedRow = recommended
      ? (payload.integrations.find(i => i.id === recommended) || null)
      : null;
    const rows = (payload.integrations || []).map(i => render(i, 'hub')).join('');
    const recommendedCallout = recommendedRow
      ? `<div class="cc-recommended">
           <span class="cc-recommended-label">Recommended next:</span>
           <strong>${escHtml(recommendedRow.name)}</strong>
           <button type="button" class="btn btn-primary btn-sm" data-cc-action="${escHtml(recommendedRow.actions[0] || 'connect')}" data-cc-id="${escHtml(recommendedRow.id)}" style="margin-left:10px">${escHtml(recommendedRow.name)} →</button>
         </div>`
      : '';
    return `
      <div class="card-dash" id="cc-hub">
        <div class="card-head">
          <div>
            <h3>Traffic Impact integrations</h3>
            <div class="sub">${completion.connected} of ${completion.available} connected · ${completion.pct}% complete</div>
          </div>
        </div>
        ${recommendedCallout}
        <div class="cc-rows">${rows}</div>
      </div>`;
  }

  window.AMCP_CONNECTOR_CARD = { render, renderHub };
})();
```

- [ ] **Step 2: Verify it parses**

Run: `node --check /Users/cameronmcewan/Desktop/advocate/advocatemcp/site/js/v2/connectorCard.js`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add site/js/v2/connectorCard.js
git commit -m "feat(integrations): connectorCard render module for the unified hub

One render() per integration (7 status variants), one renderHub() that
composes the whole card with completion summary + recommended-next
callout. Action buttons emit data-cc-action attributes so settings.js
can delegate clicks to the existing per-integration wire functions
without those handlers being aware of the new component."
```

---

## Task 7: Frontend — wire `settings.js` to use the hub

**Files:**
- Modify: `site/Settings.html` — load the two new modules
- Modify: `site/js/v2/settings.js` — replace 4 card render calls + revenue inline section with a single `renderHub()` call; add a delegated click listener that maps `data-cc-action` to the existing wire functions.

- [ ] **Step 1: Add the new module script tags to Settings.html**

Find the `<script>` tag that loads `/js/v2/settings.js` in `site/Settings.html`. Add these two `<script>` tags BEFORE it (so the modules are defined when settings.js runs):

```html
<script src="/js/v2/prereqCoach.js"></script>
<script src="/js/v2/connectorCard.js"></script>
```

- [ ] **Step 2: Update `fetchReal()` in `settings.js` to also fetch the hub payload**

Find the existing `fetchReal()` (or equivalent boot function) inside `site/js/v2/settings.js`. Add a parallel fetch to `/api/client/integrations/status` and merge the result into the data object that `render()` receives:

```js
// Inside fetchReal — before the existing Promise.all, add:
const hubPromise = window.AMCP.authedFetch('/api/client/integrations/status')
  .then(r => r.ok ? r.json() : null)
  .catch(() => null);

// Add hubPromise to the existing Promise.all([...]). Then in the .then,
// add to the returned object:
//   integrationsHub: hubResult,
```

- [ ] **Step 3: Mount the hub above the existing surfaces (transitional layering)**

Phase 1 layers the hub ABOVE the existing surfaces; it does NOT delete them. The hub gives users discovery + status + the simple OAuth flows; the existing cards remain as the editing surface for the complex inline forms (Authority Kit's brand-keyword + place-id form, the Verified-revenue webhook URL/secret/test-curl block). Phase 1.5 inlines those forms inside the hub and removes the legacy surfaces. **Don't remove or hide them in Phase 1** — the hub's `Configure →` / `Generate webhook →` buttons scroll-to + flash-highlight the corresponding legacy card.

Find the existing `render()` output. **Just before** the line that calls `renderGa4Card(...)`, insert the hub mount point:

```js
<div class="row single">
  ${d.integrationsHub ? window.AMCP_CONNECTOR_CARD.renderHub(d.integrationsHub) : '<div class="card-dash" style="padding:24px;color:var(--muted)">Loading integrations…</div>'}
</div>
```

Leave the four `renderGa4Card` / `renderGscCard` / `renderCrmCard` / `renderAuthorityCard` calls AND the inline Verified-revenue webhook block UNCHANGED. They render below the hub in Phase 1. Add `id="legacy-ga4-card"`, `id="legacy-gsc-card"`, `id="legacy-crm-card"`, `id="legacy-authority-card"`, `id="legacy-revenue-webhook-card"` attributes to the wrapping `<div class="card-dash">` of each so the hub's scroll-to handlers can find them. (Apply via `.replace()` of the existing render strings or restructure the render function — the implementer's call.)

- [ ] **Step 4: Add the action delegator inside `afterMount()`**

Find `afterMount()` in `settings.js` (or the equivalent). Add a single delegated listener that maps the connector card's button clicks to the existing wire functions:

```js
// Hub action delegator — maps data-cc-action="connect"/"pick_property"/etc.
// to the existing wire functions so we don't duplicate the OAuth + select
// + disconnect logic. Each wire function still does its own heavy lifting;
// the hub is just the new mounting surface.
const hub = document.getElementById('cc-hub');
if (hub) {
  hub.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-cc-action]');
    if (!btn) return;
    const action = btn.getAttribute('data-cc-action');
    const id = btn.getAttribute('data-cc-id');
    if (!action || !id) return;
    e.preventDefault();
    handleHubAction(id, action, btn);
  });
}

function handleHubAction(integrationId, action, btn) {
  const af = window.AMCP && window.AMCP.authedFetch;
  if (!af) return;

  // Map (id, action) → existing flow. Each branch reuses the existing
  // wire function's logic (e.g. apiGA4StartLink fetch + redirect, the
  // runInlinePicker call, the disconnect confirm + POST).
  const handlers = {
    'ga4|connect':       () => startGoogleOauth('/api/client/ga4/start-link', btn),
    'ga4|pick_property': () => openInlinePicker(btn, 'ga4'),
    'ga4|resync':        () => triggerResync('/api/client/ga4/resync', btn),
    'ga4|disconnect':    () => confirmDisconnect('/api/client/ga4/disconnect', 'Google Analytics', btn),

    'gsc|connect':       () => startGoogleOauth('/api/client/gsc/start-link', btn),
    'gsc|pick_site':     () => openInlinePicker(btn, 'gsc'),
    'gsc|resync':        () => triggerResync('/api/client/gsc/resync', btn),
    'gsc|disconnect':    () => confirmDisconnect('/api/client/gsc/disconnect', 'Google Search Console', btn),

    'hubspot|connect':    () => startGoogleOauth('/api/client/crm/start-link?provider=hubspot', btn),
    'hubspot|disconnect': () => confirmDisconnect('/api/client/crm/disconnect?provider=hubspot', 'HubSpot', btn),

    'salesforce|connect':    () => startGoogleOauth('/api/client/crm/start-link?provider=salesforce', btn),
    'salesforce|disconnect': () => confirmDisconnect('/api/client/crm/disconnect?provider=salesforce', 'Salesforce', btn),

    'stripe_webhook|generate':    () => scrollToLegacy('legacy-revenue-webhook-card'),
    'stripe_webhook|rotate':      () => scrollToLegacy('legacy-revenue-webhook-card'),

    'authority|configure':  () => scrollToLegacy('legacy-authority-card'),
    'authority|edit':       () => scrollToLegacy('legacy-authority-card'),
    'authority|disconnect': () => confirmDisconnect('/api/client/authority/disconnect', 'Authority Kit', btn),
  };

  const handler = handlers[`${integrationId}|${action}`];
  if (handler) handler();
}

// Each helper below wraps an existing flow so the hub stays thin.
// startGoogleOauth, openInlinePicker, triggerResync, confirmDisconnect,
// generateRevenueSecret, and openAuthorityForm are extracted from the
// existing wireGa4Card/wireGscCard/wireCrmCard/wireAuthorityCard
// implementations — same code paths, just hoisted to module scope so
// the hub can invoke them.

async function startGoogleOauth(path, btn) {
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

function openInlinePicker(btn, integrationId) {
  // Reuse the runInlinePicker helper added to settings.js on 2026-05-07.
  if (integrationId === 'ga4') {
    runInlinePicker({
      anchorBtn:    btn,
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
    runInlinePicker({
      anchorBtn:    btn,
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

async function triggerResync(path, btn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Syncing…';
  try {
    const r = await window.AMCP.authedFetch(path, { method: 'POST' });
    const j = await r.json();
    if (j && j.error) throw new Error(j.error);
    btn.textContent = 'Synced ✓';
    setTimeout(() => window.location.reload(), 1200);
  } catch (err) {
    alert('Sync failed: ' + (err.message || err));
    btn.disabled = false;
    btn.textContent = original;
  }
}

async function confirmDisconnect(path, name, btn) {
  if (!window.confirm(`Disconnect ${name}? Your imported data stays in your account; new syncs will stop until you reconnect.`)) return;
  btn.disabled = true;
  try {
    await window.AMCP.authedFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    setTimeout(() => window.location.reload(), 800);
  } catch (err) {
    alert('Could not disconnect: ' + (err.message || err));
    btn.disabled = false;
  }
}

/**
 * Scroll to + flash-highlight the legacy card for Authority / Revenue
 * webhook so users can use the existing form. Phase 1.5 inlines those
 * forms inside the hub; for Phase 1 we keep the legacy surfaces working
 * and just route the hub buttons to them.
 */
function scrollToLegacy(elementId) {
  const el = document.getElementById(elementId);
  if (!el) {
    console.warn('[hub] legacy element not found:', elementId);
    return;
  }
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  // Brief outline pulse so the user notices where they landed.
  const original = el.style.boxShadow;
  el.style.transition = 'box-shadow 200ms';
  el.style.boxShadow = '0 0 0 3px var(--maroon, #7d2550)';
  setTimeout(() => { el.style.boxShadow = original; }, 1400);
}
```

If `runInlinePicker` is currently a function-scope local in another `wire*Card()` (not module-scoped), hoist it to module scope so `openInlinePicker()` above can call it. The function body shipped 2026-05-07 — copy it as-is.

- [ ] **Step 4: Verify the file parses**

Run: `node --check /Users/cameronmcewan/Desktop/advocate/advocatemcp/site/js/v2/settings.js`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add site/Settings.html site/js/v2/settings.js
git commit -m "feat(integrations): replace 4 separate cards + revenue inline with the unified hub

Settings.html now mounts /js/v2/connectorCard.js + /js/v2/prereqCoach.js
before settings.js. The four renderGa4Card/renderGscCard/renderCrmCard/
renderAuthorityCard call sites + the inline Verified-revenue webhook block
collapse to a single renderHub() call backed by /api/client/integrations/status.

A delegated click handler maps data-cc-action attributes to the existing
wire functions, so OAuth, picker, resync, disconnect, and the webhook
generate/rotate flows all keep their proven implementations."
```

---

## Task 8: End-to-end manual verification + push

**Files:** none modified.

- [ ] **Step 1: Run worker tests one more time**

Run: `cd /Users/cameronmcewan/Desktop/advocate/advocatemcp/worker && npm test`
Expected: ~656 PASS (631 baseline + ~25 new aggregator tests).

- [ ] **Step 2: Run worker typecheck**

Run: `cd /Users/cameronmcewan/Desktop/advocate/advocatemcp/worker && npm run typecheck`
Expected: exit 0.

- [ ] **Step 3: Verify all touched JS files parse**

Run:
```bash
node --check /Users/cameronmcewan/Desktop/advocate/advocatemcp/site/js/v2/prereqCoach.js && \
node --check /Users/cameronmcewan/Desktop/advocate/advocatemcp/site/js/v2/connectorCard.js && \
node --check /Users/cameronmcewan/Desktop/advocate/advocatemcp/site/js/v2/settings.js && \
echo "OK"
```
Expected: prints "OK".

- [ ] **Step 4: Manual end-to-end on a fresh Pro tenant in production**

Hard-refresh `/Settings.html` and walk through each verification step from the spec's `## Verification` section:

1. New "Traffic Impact integrations" card shows 0/6 connected, GA4 as recommended next, all 6 rows visible. Stripe + Authority show their PrereqCoach references.
2. Connect GA4 from inside the hub. Verify property picker fires (uses existing `runInlinePicker`). Verify hub re-renders with GA4 status flipping to `connected_pending_config` → `connected_active`, completion ticking to 1/6, recommended-next moving to GSC.
3. Disconnect GA4. Verify `recommended_next` flips back to GA4.
4. Land on `/Settings.html` as a Base tenant. Verify GSC + CRM + Stripe + Authority cards show `plan_locked` state with maroon Pro pill + Upgrade button linking to `/Billing.html`.

If any step fails, fix inline + re-test. Do not proceed to push until verification clean.

- [ ] **Step 5: Push to origin/main**

Run: `git -C /Users/cameronmcewan/Desktop/advocate/advocatemcp push origin main`
Expected: 7 new commits pushed. Cloudflare Pages + Worker GitHub Actions deploys auto-fire on push (`deploy-pages.yml` watches `site/**`, `deploy-worker.yml` watches `worker/**` — both touched).

- [ ] **Step 6: Watch the deploys**

Open https://github.com/cameronjmcewan-dev/advocatemcp/actions — confirm `deploy-worker.yml` + `deploy-pages.yml` both succeed for the head commit. Once green, the unified hub is live in production.

---

## Phase-1 done criteria

- ✅ `GET /api/client/integrations/status` returns the typed payload for Pro and Base tenants
- ✅ Worker test count ≥ 656 (baseline 631 + ~25 new), all green
- ✅ Settings page renders one "Traffic Impact integrations" card instead of the 4 separate cards + inline revenue block
- ✅ Every existing connect/disconnect/resync/generate flow still works through the hub's button delegator
- ✅ Plan-locked Pro integrations are visible to Base tenants with an Upgrade CTA, never silently hidden
- ✅ `recommended_next` highlights the correct integration after each state change

Phase 2 (wizard on `/TrafficImpact.html`) and Phase 3 (dedicated `/setup/traffic-impact` page) reuse the same `connectorCard.js` + `prereqCoach.js` + `/integrations/status` endpoint shipped in this phase. They are separate plans — don't start them until Phase 1 is in production for ≥ 48 hours and at least one customer has gone through the new hub.
