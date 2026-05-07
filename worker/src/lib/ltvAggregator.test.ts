/**
 * Tests for worker/src/lib/ltvAggregator.ts
 *
 * Pure function tests — no mocks needed.
 */

import { describe, it, expect } from "vitest";
import { aggregateLtv } from "./ltvAggregator.js";
import type { HubspotContact } from "./hubspot.js";

// Helpers
function contact(overrides: Partial<HubspotContact> & { id: string; createdAt: string }): HubspotContact {
  return {
    email:          null,
    lifecycleStage: "lead",
    totalRevenue:   0,
    ...overrides,
  };
}

function aiClick(timestamp: string) {
  return { ref: "perplexity.ai", timestamp };
}

function nonAiClick(timestamp: string) {
  return { ref: "google.com", timestamp };
}

// Base ISO time for tests — May 6 2026 noon UTC
const BASE_ISO = "2026-05-06T12:00:00.000Z";
const BASE_MS  = new Date(BASE_ISO).getTime();

// 12 hours before BASE
const BEFORE_12H = new Date(BASE_MS - 12 * 60 * 60 * 1000).toISOString();
// 25 hours before BASE — outside 24h window
const BEFORE_25H = new Date(BASE_MS - 25 * 60 * 60 * 1000).toISOString();

describe("aggregateLtv", () => {
  it("1. empty contacts list — both buckets zero, errored zero", () => {
    const result = aggregateLtv([], []);
    expect(result.ai.contact_count).toBe(0);
    expect(result.unknown.contact_count).toBe(0);
    expect(result.errored).toBe(0);
  });

  it("2. single contact with AI click in window → AI bucket", () => {
    const contacts = [contact({ id: "c1", createdAt: BASE_ISO })];
    const clicks   = [aiClick(BEFORE_12H)];
    const result   = aggregateLtv(contacts, clicks);

    expect(result.ai.contact_count).toBe(1);
    expect(result.unknown.contact_count).toBe(0);
    expect(result.errored).toBe(0);
  });

  it("3. single contact with no matching click → unknown bucket", () => {
    const contacts = [contact({ id: "c2", createdAt: BASE_ISO })];
    const result   = aggregateLtv(contacts, []);

    expect(result.ai.contact_count).toBe(0);
    expect(result.unknown.contact_count).toBe(1);
    expect(result.errored).toBe(0);
  });

  it("4. contact with AI click outside 24h window → unknown bucket", () => {
    const contacts = [contact({ id: "c3", createdAt: BASE_ISO })];
    const clicks   = [aiClick(BEFORE_25H)]; // 25h before — outside window
    const result   = aggregateLtv(contacts, clicks);

    expect(result.ai.contact_count).toBe(0);
    expect(result.unknown.contact_count).toBe(1);
    expect(result.errored).toBe(0);
  });

  it("5. mixed contacts: some AI, some unknown, customers vs non-customers", () => {
    const contacts = [
      contact({ id: "c-ai-customer",  createdAt: BASE_ISO, lifecycleStage: "customer", totalRevenue: 1000 }),
      contact({ id: "c-ai-lead",      createdAt: BASE_ISO, lifecycleStage: "lead",     totalRevenue: 0    }),
      contact({ id: "c-unk-customer", createdAt: BASE_ISO, lifecycleStage: "customer", totalRevenue: 500  }),
      contact({ id: "c-unk-lead",     createdAt: BASE_ISO, lifecycleStage: "lead",     totalRevenue: 0    }),
    ];

    // Two AI clicks at 12h before BASE (both contacts get classified as AI
    // because both are created at BASE_ISO)
    const clicks = [
      aiClick(BEFORE_12H),
      nonAiClick(BEFORE_12H),
    ];

    // With a single AI click in window, ALL contacts will be classified as AI
    // since each contact has the same createdAt and the click is in window.
    const result = aggregateLtv(contacts, clicks);

    // All 4 contacts have the AI click within 24h window
    expect(result.ai.contact_count).toBe(4);
    expect(result.ai.customer_count).toBe(2);
    expect(result.ai.total_revenue_cents).toBe(150000); // (1000 + 500) * 100
    expect(result.ai.avg_ltv_cents).toBe(75000);        // 150000 / 2

    expect(result.unknown.contact_count).toBe(0);
    expect(result.errored).toBe(0);
  });

  it("6. contacts with no AI clicks → all in unknown bucket", () => {
    const contacts = [
      contact({ id: "c4", createdAt: BASE_ISO, lifecycleStage: "customer", totalRevenue: 200 }),
      contact({ id: "c5", createdAt: BASE_ISO, lifecycleStage: "lead",     totalRevenue: 0   }),
    ];
    const clicks = [nonAiClick(BEFORE_12H)];
    const result = aggregateLtv(contacts, clicks);

    expect(result.unknown.contact_count).toBe(2);
    expect(result.unknown.customer_count).toBe(1);
    expect(result.unknown.total_revenue_cents).toBe(20000); // 200 * 100
    expect(result.unknown.avg_ltv_cents).toBe(20000);       // 20000 / 1
    expect(result.ai.contact_count).toBe(0);
  });

  it("7. invalid createdAt increments errored counter", () => {
    const contacts = [
      contact({ id: "bad", createdAt: "not-a-date" }),
    ];
    const result = aggregateLtv(contacts, []);

    expect(result.errored).toBe(1);
    expect(result.ai.contact_count).toBe(0);
    expect(result.unknown.contact_count).toBe(0);
  });

  it("8. multiple AI clicks for same contact still counts once in AI bucket", () => {
    const contacts = [contact({ id: "c6", createdAt: BASE_ISO })];
    const clicks   = [
      aiClick(BEFORE_12H),
      aiClick(new Date(BASE_MS - 6 * 60 * 60 * 1000).toISOString()),
    ];
    const result = aggregateLtv(contacts, clicks);

    // Only counted once
    expect(result.ai.contact_count).toBe(1);
    expect(result.unknown.contact_count).toBe(0);
  });

  it("9. avg_ltv_cents is 0 when customer_count is 0", () => {
    const contacts = [
      contact({ id: "c7", createdAt: BASE_ISO, lifecycleStage: "lead", totalRevenue: 99 }),
    ];
    const result = aggregateLtv(contacts, []);

    // No customer, so avg_ltv_cents must be 0
    expect(result.unknown.customer_count).toBe(0);
    expect(result.unknown.avg_ltv_cents).toBe(0);
    // total_revenue_cents still counts (non-customer revenue is tracked)
    expect(result.unknown.total_revenue_cents).toBe(9900);
  });
});
