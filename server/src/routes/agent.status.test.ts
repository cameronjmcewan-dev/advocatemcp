/**
 * Tests for POST /agents/:slug/status — the lifecycle-mirror endpoint the
 * Cloudflare Worker calls to push business_status transitions to the server.
 *
 * Mirrors the auth + 404 + 400 + 200 paths of the existing rotate-key endpoint.
 *
 * Scope: handler-level only. Uses an in-memory fake DB; does not exercise
 * the migration or sqlite. Auth middleware is NOT mocked here because the
 * endpoint authenticates inline against X-API-Key.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";

const SERVER_API_KEY = "test-server-api-key";

interface FakeBusinessRow {
  id: number;
  slug: string;
  business_status: string | null;
  status_changed_at: string | null;
}

const fakeRows = new Map<string, FakeBusinessRow>();

vi.mock("../db.js", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db.js");
  return {
    ...actual,
    getDb: () => ({
      prepare: (sql: string) => ({
        get: (slug: string) => {
          if (sql.includes("SELECT id, business_status FROM businesses WHERE slug")) {
            const row = fakeRows.get(slug);
            return row ? { id: row.id, business_status: row.business_status } : undefined;
          }
          if (sql.includes("FROM businesses")) {
            const row = fakeRows.get(slug);
            return row ?? undefined;
          }
          return undefined;
        },
        run: (...args: unknown[]) => {
          if (
            sql.includes("UPDATE businesses") &&
            sql.includes("SET business_status") &&
            sql.includes("status_changed_at")
          ) {
            const [newStatus, changedAt, slug] = args as [string, string, string];
            const row = fakeRows.get(slug);
            if (row) {
              row.business_status = newStatus;
              row.status_changed_at = changedAt;
            }
            return { changes: row ? 1 : 0 };
          }
          return { changes: 0 };
        },
      }),
    }),
  };
});

// Mock queryAgent — agent.ts imports it at module load.
vi.mock("../agent/query.js", () => ({ queryAgent: vi.fn() }));

import { agentRouter } from "./agent.js";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(agentRouter);
  return app;
}

describe("POST /agents/:slug/status", () => {
  beforeEach(() => {
    fakeRows.clear();
    process.env.API_KEY = SERVER_API_KEY;
  });

  afterEach(() => {
    delete process.env.API_KEY;
  });

  it("401 when X-API-Key is missing", async () => {
    fakeRows.set("acme", { id: 1, slug: "acme", business_status: "active", status_changed_at: null });
    const res = await request(makeApp())
      .post("/agents/acme/status")
      .send({ status: "cancelled" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Server API key required");
  });

  it("401 when X-API-Key is wrong", async () => {
    fakeRows.set("acme", { id: 1, slug: "acme", business_status: "active", status_changed_at: null });
    const res = await request(makeApp())
      .post("/agents/acme/status")
      .set("X-API-Key", "wrong-key")
      .send({ status: "cancelled" });
    expect(res.status).toBe(401);
  });

  it("400 invalid_status when status is missing", async () => {
    fakeRows.set("acme", { id: 1, slug: "acme", business_status: "active", status_changed_at: null });
    const res = await request(makeApp())
      .post("/agents/acme/status")
      .set("X-API-Key", SERVER_API_KEY)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_status");
  });

  it("400 invalid_status when status is not in the allowlist", async () => {
    fakeRows.set("acme", { id: 1, slug: "acme", business_status: "active", status_changed_at: null });
    const res = await request(makeApp())
      .post("/agents/acme/status")
      .set("X-API-Key", SERVER_API_KEY)
      .send({ status: "anything-else" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_status");
  });

  it("404 when the slug does not exist", async () => {
    const res = await request(makeApp())
      .post("/agents/unknown/status")
      .set("X-API-Key", SERVER_API_KEY)
      .send({ status: "cancelled" });
    expect(res.status).toBe(404);
  });

  it("200 transitions active -> cancelled, returns previous + new + timestamp", async () => {
    fakeRows.set("acme", { id: 1, slug: "acme", business_status: "active", status_changed_at: null });
    const res = await request(makeApp())
      .post("/agents/acme/status")
      .set("X-API-Key", SERVER_API_KEY)
      .send({ status: "cancelled" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      slug: "acme",
      previous_status: "active",
      new_status: "cancelled",
    });
    expect(typeof res.body.status_changed_at).toBe("string");
    expect(fakeRows.get("acme")?.business_status).toBe("cancelled");
  });

  it("accepts each of the closed status vocabulary values", async () => {
    for (const status of ["active", "cancelling", "past_due", "cancelled", "suspended"]) {
      fakeRows.set("acme", { id: 1, slug: "acme", business_status: "active", status_changed_at: null });
      const res = await request(makeApp())
        .post("/agents/acme/status")
        .set("X-API-Key", SERVER_API_KEY)
        .send({ status });
      expect(res.status).toBe(200);
      expect(res.body.new_status).toBe(status);
    }
  });

  it("reports previous_status as 'active' when the row had null", async () => {
    fakeRows.set("legacy", { id: 9, slug: "legacy", business_status: null, status_changed_at: null });
    const res = await request(makeApp())
      .post("/agents/legacy/status")
      .set("X-API-Key", SERVER_API_KEY)
      .send({ status: "suspended" });
    expect(res.status).toBe(200);
    expect(res.body.previous_status).toBe("active");
  });
});
