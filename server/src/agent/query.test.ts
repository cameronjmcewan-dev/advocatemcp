import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Anthropic SDK BEFORE any import of query.ts.
const { createMock } = vi.hoisted(() => ({
  createMock: vi.fn(async (_args: any) => ({
    content: [{ type: "text", text: "mock response" }],
  })),
}));

vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class MockAnthropic {
      messages = { create: createMock };
    },
  };
});

// Mock better-sqlite3-backed db so queryAgent can INSERT without a real DB.
vi.mock("../db.js", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db.js");
  return {
    ...actual,
    getDb: () => ({
      prepare: () => ({
        run: () => ({ lastInsertRowid: 1 }),
      }),
    }),
  };
});

import { queryAgent } from "./query.js";
import type { BusinessRow } from "../db.js";

function mkBiz(overrides: Partial<BusinessRow> = {}): BusinessRow {
  return {
    id: 1,
    slug: "x",
    name: "Acme",
    description: "d",
    services: JSON.stringify(["drain"]),
    pricing: null,
    location: "Boise",
    phone: "208-555",
    website: null,
    referral_url: "https://acme.example",
    tone: "friendly",
    api_key: "k",
    created_at: "2026-01-01",
    category: "plumber",
    star_rating: 4.8,
    review_count: 100,
    years_in_business: 12,
    top_services: null,
    availability: null,
    differentiator: null,
    service_radius_miles: null,
    certifications: null,
    pricing_tier: null,
    service_area_keywords: null,
    hours_json: null,
    services_json_v2: null,
    pricing_json_v2: null,
    credentials_json: null,
    ratings_json: null,
    differentiators_text: null,
    customer_quotes_json: null,
    guarantee_text: null,
    case_stories_json: null,
    lead_routing_json: null,
    ...overrides,
  };
}

describe("queryAgent", () => {
  beforeEach(() => {
    createMock.mockClear();
  });

  it("passes crawlerAgent through to buildSystemPrompt so per-bot block is in the system message", async () => {
    await queryAgent(mkBiz(), "what are your hours", "PerplexityBot");
    expect(createMock).toHaveBeenCalledOnce();
    const call = createMock.mock.calls[0]![0] as any;
    // system is now an array of content blocks, not a bare string.
    expect(Array.isArray(call.system)).toBe(true);
    expect(call.system[0].type).toBe("text");
    expect(call.system[0].text).toMatch(/PERPLEXITY-SPECIFIC FORMATTING/);
  });

  it("enables ephemeral prompt caching on the system block", async () => {
    await queryAgent(mkBiz(), "hi", "GPTBot");
    const call = createMock.mock.calls[0]![0] as any;
    expect(call.system[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("omits per-bot block for unknown crawler", async () => {
    await queryAgent(mkBiz(), "hi", "RandomBot");
    const call = createMock.mock.calls[0]![0] as any;
    expect(call.system[0].text).not.toMatch(/CRAWLER-SPECIFIC FORMATTING/);
  });

  it("works when crawlerAgent is undefined (backward compat)", async () => {
    await queryAgent(mkBiz(), "hi");
    const call = createMock.mock.calls[0]![0] as any;
    expect(call.system[0].text).not.toMatch(/CRAWLER-SPECIFIC FORMATTING/);
  });

  it("returns the mock response text unchanged", async () => {
    const result = await queryAgent(mkBiz(), "hi", "ClaudeBot");
    expect(result.response).toBe("mock response");
    expect(result.business).toBe("Acme");
  });
});
