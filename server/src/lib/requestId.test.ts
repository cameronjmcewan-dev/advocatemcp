import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { requestIdMiddleware, generateUlid, REQUEST_ID_HEADER } from "./requestId.js";

describe("generateUlid", () => {
  it("returns a 26-char Crockford base32 string", () => {
    const id = generateUlid();
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("returns distinct values across 1000 calls", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) ids.add(generateUlid());
    expect(ids.size).toBe(1000);
  });

  it("emits lexicographically sortable ids (first 10 chars are the timestamp)", () => {
    const a = generateUlid();
    // small busy loop so the ms tick advances
    const start = Date.now();
    while (Date.now() === start) { /* spin ~1ms */ }
    const b = generateUlid();
    expect(b.slice(0, 10) >= a.slice(0, 10)).toBe(true);
  });
});

describe("requestIdMiddleware", () => {
  it("sets res.locals.requestId to a fresh ULID when no inbound header is present", async () => {
    const app = express();
    app.use(requestIdMiddleware);
    app.get("/t", (_req, res) => {
      res.json({ id: res.locals.requestId });
    });
    const resp = await request(app).get("/t");
    expect(resp.status).toBe(200);
    expect(resp.body.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(resp.headers[REQUEST_ID_HEADER.toLowerCase()]).toBe(resp.body.id);
  });

  it("echoes a valid inbound x-advocate-request-id header unchanged", async () => {
    const app = express();
    app.use(requestIdMiddleware);
    app.get("/t", (_req, res) => res.json({ id: res.locals.requestId }));
    const inbound = "01HQ1TESTTESTTESTTESTTESTV";
    const resp = await request(app).get("/t").set(REQUEST_ID_HEADER, inbound);
    expect(resp.body.id).toBe(inbound);
    expect(resp.headers[REQUEST_ID_HEADER.toLowerCase()]).toBe(inbound);
  });

  it("rejects a malformed inbound header and generates a fresh id instead", async () => {
    const app = express();
    app.use(requestIdMiddleware);
    app.get("/t", (_req, res) => res.json({ id: res.locals.requestId }));
    const resp = await request(app).get("/t").set(REQUEST_ID_HEADER, "not-a-ulid");
    expect(resp.body.id).not.toBe("not-a-ulid");
    expect(resp.body.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});
