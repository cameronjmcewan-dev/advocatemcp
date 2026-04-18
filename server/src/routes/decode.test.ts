import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { buildToken, type TokenPayload } from "../lib/tracked-url.js";

const KEY = "test-signing-key-decode";

describe("GET /r/:token/decode", () => {
  const tmp = path.join(os.tmpdir(), `s5-decode-${Date.now()}.db`);

  beforeEach(async () => {
    process.env.DATABASE_PATH = tmp;
    process.env.TOKEN_SIGNING_KEY = KEY;
    const { _resetDbForTests } = await import("../db.js");
    _resetDbForTests();
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(tmp + suffix, { force: true });
    const { getDb } = await import("../db.js");
    getDb();
  });

  afterAll(() => {
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(tmp + suffix, { force: true });
    delete process.env.DATABASE_PATH;
    delete process.env.TOKEN_SIGNING_KEY;
  });

  async function seedQuery(id: number, intent: string | null): Promise<void> {
    const { getDb } = await import("../db.js");
    const db = getDb();
    db.prepare(`INSERT INTO businesses
      (slug, name, description, services, api_key, category, location, star_rating, review_count, plan)
      VALUES ('acme', 'Acme', 'd', '[]', 'k-acme', 'plumber', 'Boise, ID', 4.5, 10, 'base')`).run();
    db.prepare(`INSERT INTO queries (id, business_slug, crawler_agent, query_text, response_text, intent)
      VALUES (?, 'acme', 'PerplexityBot', 'q', 'a', ?)`).run(id, intent);
  }

  function freshToken(overrides: Partial<TokenPayload> = {}): string {
    const payload: TokenPayload = {
      dest:     "https://acme.example/order",
      ref:      "PerplexityBot",
      slug:     "acme",
      query_id: 42,
      ts:       Math.floor(Date.now() / 1000),
      ...overrides,
    };
    return buildToken(payload, KEY);
  }

  it("returns { intent, ref, slug } for a valid token whose query has intent", async () => {
    await seedQuery(42, "emergency");
    const { createTestApp } = await import("../testApp.js");
    const res = await request(createTestApp()).get(`/r/${freshToken()}/decode`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ intent: "emergency", ref: "PerplexityBot", slug: "acme" });
  });

  it("returns intent: null when the queries row has no intent classified", async () => {
    await seedQuery(42, null);
    const { createTestApp } = await import("../testApp.js");
    const res = await request(createTestApp()).get(`/r/${freshToken()}/decode`);
    expect(res.status).toBe(200);
    expect(res.body.intent).toBeNull();
    expect(res.body.ref).toBe("PerplexityBot");
    expect(res.body.slug).toBe("acme");
  });

  it("returns intent: null when the query_id in the token does not exist", async () => {
    await seedQuery(42, "best_top");
    const { createTestApp } = await import("../testApp.js");
    // Token references query_id=999 which we never inserted.
    const token = freshToken({ query_id: 999 });
    const res = await request(createTestApp()).get(`/r/${token}/decode`);
    expect(res.status).toBe(200);
    expect(res.body.intent).toBeNull();
  });

  it("does NOT expose dest, query_id, or aid from the token", async () => {
    await seedQuery(42, "affordable");
    const { createTestApp } = await import("../testApp.js");
    const token = buildToken({
      dest:     "https://secret.example/internal",
      ref:      "PerplexityBot",
      slug:     "acme",
      query_id: 42,
      ts:       Math.floor(Date.now() / 1000),
      aid:      "claude-desktop",
    }, KEY);
    const res = await request(createTestApp()).get(`/r/${token}/decode`);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(["intent", "ref", "slug"]);
    expect(res.text).not.toContain("secret.example");
    expect(res.text).not.toContain("claude-desktop");
  });

  it("returns 400 for a malformed token", async () => {
    const { createTestApp } = await import("../testApp.js");
    const res = await request(createTestApp()).get(`/r/garbage/decode`);
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe("malformed");
  });

  it("returns 400 for a token with a tampered signature", async () => {
    await seedQuery(42, "emergency");
    const { createTestApp } = await import("../testApp.js");
    const token = freshToken();
    const dot = token.lastIndexOf(".");
    const tampered = token.slice(0, dot + 1) + "AAAAAAAAAAAAAAAAAAAAAA";
    const res = await request(createTestApp()).get(`/r/${tampered}/decode`);
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe("bad_signature");
  });

  it("returns 400 'expired' for a token older than 90 days", async () => {
    await seedQuery(42, "emergency");
    const { createTestApp } = await import("../testApp.js");
    const stale = freshToken({ ts: Math.floor(Date.now() / 1000) - (91 * 24 * 3600) });
    const res = await request(createTestApp()).get(`/r/${stale}/decode`);
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe("expired");
  });

  it("sets CORS headers so the endpoint is callable cross-origin", async () => {
    await seedQuery(42, "emergency");
    const { createTestApp } = await import("../testApp.js");
    const res = await request(createTestApp()).get(`/r/${freshToken()}/decode`);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.headers["cache-control"]).toContain("max-age=60");
  });

  it("OPTIONS preflight returns 204 with CORS headers", async () => {
    const { createTestApp } = await import("../testApp.js");
    const res = await request(createTestApp()).options(`/r/anything/decode`);
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.headers["access-control-allow-methods"]).toContain("GET");
  });
});
