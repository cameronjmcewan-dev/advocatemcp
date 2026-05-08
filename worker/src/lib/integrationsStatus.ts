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

function ga4View(facts: IntegrationsFacts): IntegrationView {
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

function gscView(facts: IntegrationsFacts): IntegrationView {
  const base = {
    id: "gsc",
    name: "Google Search Console",
    category: "search" as const,
    plan_required: "pro" as const,
    value_props: ["Detect when Google's AI Overview shows for your queries", "See cite-rate per query"],
    external_prereqs: [{ id: "gsc_verified_site", label: "A site verified in Search Console", coach_id: "gsc_verification" }],
    last_sync_at: facts.gsc.last_sync_at,
    last_sync_error: facts.gsc.last_sync_error,
  };
  if (!facts.gsc.connected) {
    return { ...base, status: "not_connected", config_summary: null, actions: ["connect"] };
  }
  if (!facts.gsc.site_url) {
    return { ...base, status: "connected_pending_config", config_summary: null, actions: ["pick_site", "disconnect"] };
  }
  if (facts.gsc.last_sync_error) {
    return { ...base, status: "connected_error", config_summary: facts.gsc.site_url, actions: ["resync", "disconnect"] };
  }
  return { ...base, status: "connected_active", config_summary: facts.gsc.site_url, actions: ["resync", "disconnect"] };
}

function hubspotView(facts: IntegrationsFacts): IntegrationView {
  const base = {
    id: "hubspot",
    name: "HubSpot",
    category: "crm" as const,
    plan_required: "pro" as const,
    value_props: ["Compare LTV of AI-acquired vs unknown-source customers"],
    external_prereqs: [{ id: "hubspot_account", label: "A HubSpot account" }],
    last_sync_at: facts.hubspot.last_used_at,
    last_sync_error: facts.hubspot.last_error,
  };
  if (!facts.hubspot.connected) {
    return { ...base, status: "not_connected", config_summary: null, actions: ["connect"] };
  }
  const summary = facts.hubspot.account_id ? `Account: ${facts.hubspot.account_id}` : "Connected";
  if (facts.hubspot.last_error) {
    return { ...base, status: "connected_error", config_summary: summary, actions: ["disconnect"] };
  }
  return { ...base, status: "connected_active", config_summary: summary, actions: ["disconnect"] };
}

function salesforceView(facts: IntegrationsFacts): IntegrationView {
  const base = {
    id: "salesforce",
    name: "Salesforce",
    category: "crm" as const,
    plan_required: "pro" as const,
    value_props: ["Compare LTV of AI-acquired vs unknown-source customers"],
    external_prereqs: [{ id: "salesforce_account", label: "A Salesforce account" }],
    last_sync_at: facts.salesforce.last_used_at,
    last_sync_error: facts.salesforce.last_error,
  };
  if (!facts.salesforce.connected) {
    return { ...base, status: "not_connected", config_summary: null, actions: ["connect"] };
  }
  const summary = facts.salesforce.account_id ? `Account: ${facts.salesforce.account_id}` : "Connected";
  if (facts.salesforce.last_error) {
    return { ...base, status: "connected_error", config_summary: summary, actions: ["disconnect"] };
  }
  return { ...base, status: "connected_active", config_summary: summary, actions: ["disconnect"] };
}

function stripeWebhookView(facts: IntegrationsFacts): IntegrationView {
  const base = {
    id: "stripe_webhook",
    name: "Verified revenue",
    category: "revenue" as const,
    plan_required: "pro" as const,
    value_props: ["Attribute revenue dollars to AI-acquired customers"],
    external_prereqs: [{ id: "stripe_account", label: "A Stripe account", coach_id: "stripe_webhook" }],
    last_sync_at: null,
    last_sync_error: null,
  };
  if (!facts.stripe_webhook.configured) {
    return { ...base, status: "not_connected", config_summary: null, actions: ["generate"] };
  }
  const summary = facts.stripe_webhook.total_events > 0
    ? `${facts.stripe_webhook.total_events} events received · ${facts.stripe_webhook.ai_events} attributed to AI`
    : "Awaiting first event";
  return { ...base, status: "connected_active", config_summary: summary, actions: ["rotate"] };
}

function authorityView(facts: IntegrationsFacts): IntegrationView {
  const base = {
    id: "authority",
    name: "Authority Kit",
    category: "authority" as const,
    plan_required: "pro" as const,
    value_props: ["Track Reddit + Google Reviews mentions + sentiment"],
    external_prereqs: [
      { id: "brand_keyword", label: "A brand keyword to monitor" },
      { id: "google_place_id", label: "Your Google Place ID", coach_id: "google_place_id" },
    ],
    last_sync_at: facts.authority.last_synced_at,
    last_sync_error: facts.authority.last_sync_error,
  };
  if (!facts.authority.configured) {
    return { ...base, status: "not_connected", config_summary: null, actions: ["configure"] };
  }
  const fullyConfigured = !!(facts.authority.brand_keyword && facts.authority.google_place_id);
  if (!fullyConfigured) {
    return { ...base, status: "connected_pending_config", config_summary: null, actions: ["edit", "disconnect"] };
  }
  const summary = `${facts.authority.brand_keyword} · ${facts.authority.google_place_id}`;
  if (facts.authority.last_sync_error) {
    return { ...base, status: "connected_error", config_summary: summary, actions: ["edit", "disconnect"] };
  }
  return { ...base, status: "connected_active", config_summary: summary, actions: ["edit", "disconnect"] };
}

export function buildIntegrationsStatus(facts: IntegrationsFacts): IntegrationsStatusResponse {
  const isPro = facts.tenant.plan === "pro" || facts.tenant.plan === "enterprise";

  function lockOrStatus(planRequired: PlanRequired, computed: IntegrationStatus): IntegrationStatus {
    if (planRequired === "base") return computed;
    return isPro ? computed : "plan_locked";
  }

  const integrations: IntegrationView[] = [
    ga4View(facts),
    gscView(facts),
    hubspotView(facts),
    salesforceView(facts),
    stripeWebhookView(facts),
    authorityView(facts),
  ];

  return {
    tenant: facts.tenant,
    integrations,
    recommended_next: null,
    completion: { connected: 0, available: integrations.filter(i => i.status !== "plan_locked").length, pct: 0 },
  };
}
