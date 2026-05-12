/**
 * Tests for SOC 2 CC6.2/CC6.3 business_status enforcement added in
 * server/src/middleware/auth.ts (migration 038).
 *
 * Verifies all three Bearer-accepting middlewares fail-closed for blocked
 * statuses ('cancelled', 'suspended') and pass through for non-blocked
 * statuses ('active', 'cancelling', 'past_due', null/legacy).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";

interface FakeRow {
  id: number;
  slug: string;
  api_key: string;
  business_status: string | null;
}

const fake = new Map<string, FakeRow>();

vi.mock("../db.js", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db.js");
  return {
    ...actual,
    getDb: () => ({
      prepare: (sql: string) => ({
        get: (...args: unknown[]) => {
          // requireApiKey path: SELECT id, business_status FROM businesses WHERE api_key=?
          if (sql.includes("SELECT id, business_status FROM businesses WHERE api_key")) {
            const [key] = args as [string];
            for (const row of fake.values()) {
              if (row.api_key === key) {
                return { id: row.id, business_status: row.business_status };
              }
            }
            return undefined;
          }
          // requireSlugApiKey: SELECT * FROM businesses WHERE slug=? AND api_key=?
          if (sql.includes("SELECT * FROM businesses WHERE slug")) {
            const [slug, key] = args as [string, string];
            const row = fake.get(slug);
            return row && row.api_key === key ? row : undefined;
          }
          // requireSlugOrAdminKey: SELECT id, business_status FROM businesses WHERE slug=? AND api_key=?
          if (sql.includes("SELECT id, business_status FROM businesses WHERE slug")) {
            const [slug, key] = args as [string, string];
            const row = fake.get(slug);
            return row && row.api_key === key
              ? { id: row.id, business_status: row.business_status }
              : undefined;
          }
          return undefined;
        },
      }),
    }),
  };
});

import {
  requireApiKey,
  requireSlugApiKey,
  requireSlugOrAdminKey,
} from "./auth.js";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.get("/r/any", requireApiKey, (_req, res) => { res.json({ ok: true }); });
  app.get("/r/slug/:slug", requireSlugApiKey, (_req, res) => { res.json({ ok: true }); });
  app.get("/r/either/:slug", requireSlugOrAdminKey, (_req, res) => { res.json({ ok: true }); });
  return app;
}

describe("auth middleware — business_status enforcement", () => {
  beforeEach(() => {
    fake.clear();
    delete process.env.API_KEY;
  });

  afterEach(() => {
    delete process.env.API_KEY;
  });

  // ── requireApiKey ────────────────────────────────────────────────────────

  it("requireApiKey: 200 for active subscription", async () => {
    fake.set("acme", { id: 1, slug: "acme", api_key: "k_active", business_status: "active" });
    const res = await request(makeApp()).get("/r/any").set("Authorization", "Bearer k_active");
    expect(res.status).toBe(200);
  });

  it("requireApiKey: 200 for null status (legacy pre-migration rows)", async () => {
    fake.set("legacy", { id: 2, slug: "legacy", api_key: "k_legacy", business_status: null });
    const res = await request(makeApp()).get("/r/any").set("Authorization", "Bearer k_legacy");
    expect(res.status).toBe(200);
  });

  it("requireApiKey: 200 for cancelling (still within paid period)", async () => {
    fake.set("acme", { id: 1, slug: "acme", api_key: "k_canc", business_status: "cancelling" });
    const res = await request(makeApp()).get("/r/any").set("Authorization", "Bearer k_canc");
    expect(res.status).toBe(200);
  });

  it("requireApiKey: 200 for past_due (Stripe dunning in progress)", async () => {
    fake.set("acme", { id: 1, slug: "acme", api_key: "k_pd", business_status: "past_due" });
    const res = await request(makeApp()).get("/r/any").set("Authorization", "Bearer k_pd");
    expect(res.status).toBe(200);
  });

  it("requireApiKey: 401 subscription_inactive for cancelled status", async () => {
    fake.set("acme", { id: 1, slug: "acme", api_key: "k_cx", business_status: "cancelled" });
    const res = await request(makeApp()).get("/r/any").set("Authorization", "Bearer k_cx");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("subscription_inactive");
  });

  it("requireApiKey: 401 subscription_inactive for suspended status", async () => {
    fake.set("acme", { id: 1, slug: "acme", api_key: "k_sus", business_status: "suspended" });
    const res = await request(makeApp()).get("/r/any").set("Authorization", "Bearer k_sus");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("subscription_inactive");
  });

  it("requireApiKey: server admin key bypasses the status check entirely", async () => {
    process.env.API_KEY = "server-admin-key";
    // No business row exists at all — admin key should still pass.
    const res = await request(makeApp()).get("/r/any").set("X-API-Key", "server-admin-key");
    expect(res.status).toBe(200);
  });

  // ── requireSlugApiKey ───────────────────────────────────────────────────

  it("requireSlugApiKey: 200 for active", async () => {
    fake.set("acme", { id: 1, slug: "acme", api_key: "k_a", business_status: "active" });
    const res = await request(makeApp())
      .get("/r/slug/acme")
      .set("Authorization", "Bearer k_a");
    expect(res.status).toBe(200);
  });

  it("requireSlugApiKey: 401 subscription_inactive for cancelled", async () => {
    fake.set("acme", { id: 1, slug: "acme", api_key: "k_a", business_status: "cancelled" });
    const res = await request(makeApp())
      .get("/r/slug/acme")
      .set("Authorization", "Bearer k_a");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("subscription_inactive");
  });

  it("requireSlugApiKey: 401 for suspended", async () => {
    fake.set("acme", { id: 1, slug: "acme", api_key: "k_a", business_status: "suspended" });
    const res = await request(makeApp())
      .get("/r/slug/acme")
      .set("Authorization", "Bearer k_a");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("subscription_inactive");
  });

  // ── requireSlugOrAdminKey ───────────────────────────────────────────────

  it("requireSlugOrAdminKey: 200 for active tenant Bearer", async () => {
    fake.set("acme", { id: 1, slug: "acme", api_key: "k_a", business_status: "active" });
    const res = await request(makeApp())
      .get("/r/either/acme")
      .set("Authorization", "Bearer k_a");
    expect(res.status).toBe(200);
  });

  it("requireSlugOrAdminKey: 401 for cancelled tenant Bearer", async () => {
    fake.set("acme", { id: 1, slug: "acme", api_key: "k_a", business_status: "cancelled" });
    const res = await request(makeApp())
      .get("/r/either/acme")
      .set("Authorization", "Bearer k_a");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("subscription_inactive");
  });

  it("requireSlugOrAdminKey: admin X-API-Key bypasses status check", async () => {
    process.env.API_KEY = "server-admin-key";
    fake.set("acme", { id: 1, slug: "acme", api_key: "k_a", business_status: "cancelled" });
    const res = await request(makeApp())
      .get("/r/either/acme")
      .set("X-API-Key", "server-admin-key");
    expect(res.status).toBe(200);
  });
});
