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
