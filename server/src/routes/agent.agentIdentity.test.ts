/**
 * Session 11.5: REST /agents/:slug/query honors `x-agent-identity` header.
 *
 * The MCP path already resolves agent identity (Session 10) — the REST path
 * was the missing half. Without this, every direct API caller looks anonymous
 * to the reputation system, even when they self-identify.
 *
 * Three things must happen:
 *   1. queries.agent_id is populated from the header
 *   2. The minted attribution_token carries the agent id in its `aid` claim
 *   3. Anonymous callers (no header) still mint legacy aid-less tokens
 */

import request from "supertest";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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

function decodeTokenPayload(token: string): Record<string, unknown> {
  const [encodedPayload] = token.split(".");
  if (!encodedPayload) throw new Error("malformed token");
  const padded = encodedPayload.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? 0 : 4 - (padded.length % 4);
  return JSON.parse(
    Buffer.from(padded + "=".repeat(pad), "base64").toString("utf8"),
  );
}

describe("POST /agents/:slug/query — agent identity (Session 11.5)", () => {
  const tmp = path.join(os.tmpdir(), `advocate-aid-rest-test-${Date.now()}.db`);
  let app: import("express").Express;
  let getDb: typeof import("../db.js")["getDb"];
  let slug: string;
  let apiKey: string;

  beforeAll(async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.TOKEN_SIGNING_KEY = "test-signing-key-rest-aid";
    process.env.DATABASE_PATH = tmp;
    const { _resetDbForTests } = await import("../db.js");
    _resetDbForTests();
    const testAppMod = await import("../testApp.js");
    app = testAppMod.createTestApp();
    ({ getDb } = await import("../db.js"));

    slug = `agent-aid-${Date.now()}`;
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
    delete process.env.TOKEN_SIGNING_KEY;
  });

  it("persists header agent_id into queries and stamps aid into the token", async () => {
    const res = await request(app)
      .post(`/agents/${slug}/query`)
      .set("Authorization", `Bearer ${apiKey}`)
      .set("x-agent-identity", "claude-desktop")
      .send({ query: "hi" });

    expect(res.status).toBe(200);
    expect(typeof res.body.attribution_token).toBe("string");

    const payload = decodeTokenPayload(res.body.attribution_token as string);
    expect(payload.aid).toBe("claude-desktop");

    const row = getDb()
      .prepare(
        "SELECT agent_id FROM queries WHERE business_slug = ? ORDER BY id DESC LIMIT 1",
      )
      .get(slug) as { agent_id: string | null };
    expect(row.agent_id).toBe("claude-desktop");
  });

  it("anonymous caller (no header) still mints a legacy aid-less token", async () => {
    const res = await request(app)
      .post(`/agents/${slug}/query`)
      .set("Authorization", `Bearer ${apiKey}`)
      .send({ query: "hi" });

    expect(res.status).toBe(200);
    expect(typeof res.body.attribution_token).toBe("string");

    const payload = decodeTokenPayload(res.body.attribution_token as string);
    expect("aid" in payload).toBe(false);

    const row = getDb()
      .prepare(
        "SELECT agent_id FROM queries WHERE business_slug = ? ORDER BY id DESC LIMIT 1",
      )
      .get(slug) as { agent_id: string | null };
    expect(row.agent_id).toBeNull();
  });
});
