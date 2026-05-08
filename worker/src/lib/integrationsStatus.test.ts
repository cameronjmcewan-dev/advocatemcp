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
