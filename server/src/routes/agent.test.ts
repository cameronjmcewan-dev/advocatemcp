import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Mock queryAgent so tests don't call Claude or DB.
vi.mock("../agent/query.js", () => ({
  queryAgent: vi.fn(async (business: any) => ({
    response: "mock",
    referral_url: business.referral_url,
    business: business.name,
    business_slug: business.slug,
    intent: "general" as const,
    timestamp: "2026-04-14T00:00:00Z",
    powered_by: "AdvocateMCP" as const,
    query_id: 42,
  })),
}));

// Mock auth middleware to always pass.
vi.mock("../middleware/auth.js", () => ({
  requireApiKey: (_req: any, _res: any, next: any) => next(),
}));

// Mock db with a minimal business row.
vi.mock("../db.js", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db.js");
  return {
    ...actual,
    getDb: () => ({
      prepare: (sql: string) => ({
        get: (_slug: string) => {
          if (sql.includes("FROM businesses")) {
            return {
              id: 1,
              slug: "x",
              name: "Acme",
              description: "d",
              services: '["drain"]',
              pricing: null,
              location: "Boise",
              phone: null,
              website: null,
              referral_url: "https://acme.example",
              tone: "friendly",
              api_key: "k",
              created_at: "2026-01-01",
            };
          }
          return undefined;
        },
      }),
    }),
  };
});

import { agentRouter } from "./agent.js";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(agentRouter);
  return app;
}

describe("POST /agents/:slug/query validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects missing query with 400 invalid_body", async () => {
    const res = await request(makeApp())
      .post("/agents/x/query")
      .send({ crawler: "PerplexityBot" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("rejects whitespace-only query with 400", async () => {
    const res = await request(makeApp())
      .post("/agents/x/query")
      .send({ query: "   " });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("rejects query longer than 2000 chars with 400", async () => {
    const res = await request(makeApp())
      .post("/agents/x/query")
      .send({ query: "a".repeat(2001) });
    expect(res.status).toBe(400);
  });

  it("rejects non-string crawler with 400", async () => {
    const res = await request(makeApp())
      .post("/agents/x/query")
      .send({ query: "hi", crawler: 123 });
    expect(res.status).toBe(400);
  });

  it("accepts valid body and returns 200 with mock response", async () => {
    const res = await request(makeApp())
      .post("/agents/x/query")
      .send({ query: "what are your hours", crawler: "PerplexityBot" });
    expect(res.status).toBe(200);
    expect(res.body.response).toBe("mock");
    expect(res.body.business_slug).toBe("x");
  });

  it("accepts valid body without crawler field", async () => {
    const res = await request(makeApp())
      .post("/agents/x/query")
      .send({ query: "hi" });
    expect(res.status).toBe(200);
  });
});
