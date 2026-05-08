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

  it("GSC connected without site selected → connected_pending_config + pick_site action", () => {
    const facts = emptyFacts();
    facts.gsc = { connected: true, site_url: null, last_sync_at: null, last_sync_error: null };
    const result = buildIntegrationsStatus(facts);
    const gsc = result.integrations.find(i => i.id === "gsc")!;
    expect(gsc.status).toBe("connected_pending_config");
    expect(gsc.config_summary).toBeNull();
    expect(gsc.actions).toEqual(["pick_site", "disconnect"]);
  });

  it("GSC connected with site_url → connected_active + config_summary + resync action", () => {
    const facts = emptyFacts();
    facts.gsc = { connected: true, site_url: "https://acme.com/", last_sync_at: "2026-05-07T12:00:00Z", last_sync_error: null };
    const result = buildIntegrationsStatus(facts);
    const gsc = result.integrations.find(i => i.id === "gsc")!;
    expect(gsc.status).toBe("connected_active");
    expect(gsc.config_summary).toBe("https://acme.com/");
    expect(gsc.last_sync_at).toBe("2026-05-07T12:00:00Z");
    expect(gsc.actions).toEqual(["resync", "disconnect"]);
  });

  it("GSC connected with last_sync_error → connected_error", () => {
    const facts = emptyFacts();
    facts.gsc = { connected: true, site_url: "https://acme.com/", last_sync_at: "2026-05-07T12:00:00Z", last_sync_error: "GSC API: forbidden" };
    const result = buildIntegrationsStatus(facts);
    const gsc = result.integrations.find(i => i.id === "gsc")!;
    expect(gsc.status).toBe("connected_error");
    expect(gsc.last_sync_error).toBe("GSC API: forbidden");
    expect(gsc.actions).toEqual(["resync", "disconnect"]);
  });

  it("HubSpot not_connected has [connect] action and null config_summary", () => {
    const facts = emptyFacts();
    const result = buildIntegrationsStatus(facts);
    const hs = result.integrations.find(i => i.id === "hubspot")!;
    expect(hs.status).toBe("not_connected");
    expect(hs.config_summary).toBeNull();
    expect(hs.actions).toEqual(["connect"]);
  });

  it("HubSpot connected with account_id → connected_active + Account: prefix in config_summary", () => {
    const facts = emptyFacts();
    facts.hubspot = { connected: true, account_id: "12345678", last_used_at: "2026-05-07T12:00:00Z", last_error: null };
    const result = buildIntegrationsStatus(facts);
    const hs = result.integrations.find(i => i.id === "hubspot")!;
    expect(hs.status).toBe("connected_active");
    expect(hs.config_summary).toBe("Account: 12345678");
    expect(hs.actions).toEqual(["disconnect"]);
  });

  it("HubSpot connected with last_error → connected_error", () => {
    const facts = emptyFacts();
    facts.hubspot = { connected: true, account_id: "12345678", last_used_at: "2026-05-07T12:00:00Z", last_error: "Token revoked" };
    const result = buildIntegrationsStatus(facts);
    const hs = result.integrations.find(i => i.id === "hubspot")!;
    expect(hs.status).toBe("connected_error");
    expect(hs.last_sync_error).toBe("Token revoked");
    expect(hs.actions).toEqual(["disconnect"]);
  });

  it("Salesforce not_connected has [connect] action and null config_summary", () => {
    const facts = emptyFacts();
    const result = buildIntegrationsStatus(facts);
    const sf = result.integrations.find(i => i.id === "salesforce")!;
    expect(sf.status).toBe("not_connected");
    expect(sf.config_summary).toBeNull();
    expect(sf.actions).toEqual(["connect"]);
  });

  it("Salesforce connected with account_id → connected_active + Account: prefix in config_summary", () => {
    const facts = emptyFacts();
    facts.salesforce = { connected: true, account_id: "00D000000000001", last_used_at: "2026-05-07T12:00:00Z", last_error: null };
    const result = buildIntegrationsStatus(facts);
    const sf = result.integrations.find(i => i.id === "salesforce")!;
    expect(sf.status).toBe("connected_active");
    expect(sf.config_summary).toBe("Account: 00D000000000001");
    expect(sf.actions).toEqual(["disconnect"]);
  });

  it("Salesforce connected with last_error → connected_error", () => {
    const facts = emptyFacts();
    facts.salesforce = { connected: true, account_id: "00D000000000001", last_used_at: "2026-05-07T12:00:00Z", last_error: "Refresh token expired" };
    const result = buildIntegrationsStatus(facts);
    const sf = result.integrations.find(i => i.id === "salesforce")!;
    expect(sf.status).toBe("connected_error");
    expect(sf.last_sync_error).toBe("Refresh token expired");
    expect(sf.actions).toEqual(["disconnect"]);
  });

  it("Stripe webhook not configured → not_connected + [generate] action", () => {
    const facts = emptyFacts();
    const result = buildIntegrationsStatus(facts);
    const sw = result.integrations.find(i => i.id === "stripe_webhook")!;
    expect(sw.status).toBe("not_connected");
    expect(sw.config_summary).toBeNull();
    expect(sw.actions).toEqual(["generate"]);
  });

  it("Stripe webhook configured but no events → connected_active + Awaiting first event + [rotate]", () => {
    const facts = emptyFacts();
    facts.stripe_webhook = { configured: true, total_events: 0, ai_events: 0 };
    const result = buildIntegrationsStatus(facts);
    const sw = result.integrations.find(i => i.id === "stripe_webhook")!;
    expect(sw.status).toBe("connected_active");
    expect(sw.config_summary).toBe("Awaiting first event");
    expect(sw.actions).toEqual(["rotate"]);
  });

  it("Stripe webhook configured with events → connected_active + formatted summary + [rotate]", () => {
    const facts = emptyFacts();
    facts.stripe_webhook = { configured: true, total_events: 142, ai_events: 31 };
    const result = buildIntegrationsStatus(facts);
    const sw = result.integrations.find(i => i.id === "stripe_webhook")!;
    expect(sw.status).toBe("connected_active");
    expect(sw.config_summary).toBe("142 events received · 31 attributed to AI");
    expect(sw.actions).toEqual(["rotate"]);
  });

  it("Authority Kit not configured → not_connected + [configure] action", () => {
    const facts = emptyFacts();
    const result = buildIntegrationsStatus(facts);
    const a = result.integrations.find(i => i.id === "authority")!;
    expect(a.status).toBe("not_connected");
    expect(a.config_summary).toBeNull();
    expect(a.actions).toEqual(["configure"]);
  });

  it("Authority Kit only brand_keyword set → connected_pending_config + [edit, disconnect]", () => {
    const facts = emptyFacts();
    facts.authority = { configured: true, brand_keyword: "Acme", google_place_id: null, last_synced_at: null, last_sync_error: null };
    const result = buildIntegrationsStatus(facts);
    const a = result.integrations.find(i => i.id === "authority")!;
    expect(a.status).toBe("connected_pending_config");
    expect(a.actions).toEqual(["edit", "disconnect"]);
  });

  it("Authority Kit fully configured → connected_active + brand · place_id summary", () => {
    const facts = emptyFacts();
    facts.authority = { configured: true, brand_keyword: "Acme", google_place_id: "ChIJxxx", last_synced_at: "2026-05-07T12:00:00Z", last_sync_error: null };
    const result = buildIntegrationsStatus(facts);
    const a = result.integrations.find(i => i.id === "authority")!;
    expect(a.status).toBe("connected_active");
    expect(a.config_summary).toBe("Acme · ChIJxxx");
    expect(a.last_sync_at).toBe("2026-05-07T12:00:00Z");
    expect(a.actions).toEqual(["edit", "disconnect"]);
  });

  it("Authority Kit fully configured with last_sync_error → connected_error", () => {
    const facts = emptyFacts();
    facts.authority = { configured: true, brand_keyword: "Acme", google_place_id: "ChIJxxx", last_synced_at: "2026-05-07T12:00:00Z", last_sync_error: "Reddit rate limited" };
    const result = buildIntegrationsStatus(facts);
    const a = result.integrations.find(i => i.id === "authority")!;
    expect(a.status).toBe("connected_error");
    expect(a.last_sync_error).toBe("Reddit rate limited");
    expect(a.actions).toEqual(["edit", "disconnect"]);
  });
});
