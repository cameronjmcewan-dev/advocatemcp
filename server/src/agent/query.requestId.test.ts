import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// Mock the Anthropic SDK so we don't make a network call.
vi.doMock("@anthropic-ai/sdk", () => {
  class MockAnthropic {
    messages = {
      create: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "mocked response" }],
      }),
    };
    constructor() {}
  }
  return { default: MockAnthropic };
});

const RID = "01HQ1TESTTESTTESTTESTTESTV"; // 26-char Crockford base32

describe("queryAgent — requestId threading", () => {
  let queryAgent: typeof import("./query.js")["queryAgent"];
  let getDb: typeof import("../db.js")["getDb"];

  beforeEach(async () => {
    vi.resetModules();
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.DATABASE_PATH = path.join(
      os.tmpdir(),
      `advocate-req-id-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    // Import AFTER mocks are registered.
    ({ queryAgent } = await import("./query.js"));
    ({ getDb } = await import("../db.js"));
  });

  afterEach(() => {
    const p = process.env.DATABASE_PATH;
    if (p) {
      for (const suffix of ["", "-wal", "-shm"]) {
        fs.rmSync(p + suffix, { force: true });
      }
    }
    vi.clearAllMocks();
  });

  it("persists the provided requestId to queries.request_id", async () => {
    const db = getDb();
    const slug = `req-id-test-${Date.now()}`;
    db.prepare(
      `INSERT INTO businesses (slug, name, description, services, api_key, referral_url) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(slug, "Test", "d", "[]", `k-${slug}`, "https://example.com");
    const business = db
      .prepare("SELECT * FROM businesses WHERE slug = ?")
      .get(slug) as any;

    await queryAgent(business, "hello", "claude", RID);

    const row = db
      .prepare(
        "SELECT request_id FROM queries WHERE business_slug = ? ORDER BY id DESC LIMIT 1",
      )
      .get(slug) as { request_id: string | null };
    expect(row.request_id).toBe(RID);
  });

  it("writes NULL when requestId is omitted (back-compat)", async () => {
    const db = getDb();
    const slug = `req-id-null-${Date.now()}`;
    db.prepare(
      `INSERT INTO businesses (slug, name, description, services, api_key, referral_url) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(slug, "Test", "d", "[]", `k-${slug}`, "https://example.com");
    const business = db
      .prepare("SELECT * FROM businesses WHERE slug = ?")
      .get(slug) as any;

    await queryAgent(business, "hello", "claude");

    const row = db
      .prepare(
        "SELECT request_id FROM queries WHERE business_slug = ? ORDER BY id DESC LIMIT 1",
      )
      .get(slug) as { request_id: string | null };
    expect(row.request_id).toBeNull();
  });
});
