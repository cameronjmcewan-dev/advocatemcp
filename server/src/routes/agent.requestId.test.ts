import request from "supertest";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Mock Anthropic so we don't hit the network.
vi.mock("@anthropic-ai/sdk", () => {
  class MockAnthropic {
    messages = {
      create: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "mocked" }],
      }),
    };
    constructor() {}
  }
  return { default: MockAnthropic };
});

const RID = "01HQ4TESTTESTTESTTESTTESTV";

describe("POST /agents/:slug/query — requestId propagation", () => {
  const tmp = path.join(os.tmpdir(), `advocate-rid-test-${Date.now()}.db`);
  let app: import("express").Express;
  let getDb: typeof import("../db.js")["getDb"];
  let slug: string;
  let apiKey: string;

  beforeAll(async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.DATABASE_PATH = tmp;
    const { _resetDbForTests } = await import("../db.js");
    _resetDbForTests();
    const testAppMod = await import("../testApp.js");
    app = testAppMod.createTestApp();
    ({ getDb } = await import("../db.js"));

    slug = `agent-rid-${Date.now()}`;
    apiKey = "test-key-" + slug;
    getDb()
      .prepare(
        `INSERT INTO businesses (slug, name, description, services, api_key, referral_url)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(slug, "Test Biz", "desc", "services", apiKey, "https://example.com");
  });

  afterAll(async () => {
    const { _resetDbForTests } = await import("../db.js");
    _resetDbForTests();
    for (const suffix of ["", "-wal", "-shm"]) {
      fs.rmSync(tmp + suffix, { force: true });
    }
    delete process.env.DATABASE_PATH;
  });

  it("writes x-advocate-request-id header into queries.request_id", async () => {
    const res = await request(app)
      .post(`/agents/${slug}/query`)
      .set("Authorization", `Bearer ${apiKey}`)
      .set("x-advocate-request-id", RID)
      .send({ query: "hi" });

    expect(res.status).toBe(200);
    expect(res.headers["x-advocate-request-id"]).toBe(RID);

    const row = getDb()
      .prepare(
        "SELECT request_id FROM queries WHERE business_slug = ? ORDER BY id DESC LIMIT 1",
      )
      .get(slug) as { request_id: string | null };
    expect(row.request_id).toBe(RID);
  });
});
