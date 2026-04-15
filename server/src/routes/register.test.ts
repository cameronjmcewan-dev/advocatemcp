import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import fs from "fs";
import os from "os";
import path from "path";

describe("POST /register", () => {
  const tmp = path.join(os.tmpdir(), `advocate-reg-test-${Date.now()}.db`);
  let app: express.Express;

  beforeAll(async () => {
    process.env.DATABASE_PATH = tmp;
    process.env.API_KEY = "test-admin-key";
    const { _resetDbForTests } = await import("../db.js");
    _resetDbForTests();
    const { registerRouter } = await import("./register.js");
    app = express();
    app.use(express.json());
    app.use(registerRouter);
  });

  afterAll(async () => {
    const { _resetDbForTests } = await import("../db.js");
    _resetDbForTests();
    for (const suffix of ["", "-wal", "-shm"]) {
      fs.rmSync(tmp + suffix, { force: true });
    }
    delete process.env.API_KEY;
    delete process.env.DATABASE_PATH;
  });

  it("401 without API key", async () => {
    const res = await request(app).post("/register").send({ name: "x" });
    expect(res.status).toBe(401);
  });

  it("400 with invalid payload (missing required fields)", async () => {
    const res = await request(app)
      .post("/register")
      .set("Authorization", "Bearer test-admin-key")
      .send({ name: "X" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");
    expect(Array.isArray(res.body.issues)).toBe(true);
  });

  it("201 persists nested JSON fields on a full payload", async () => {
    const payload = {
      name: "Acme Plumbing Test",
      description: "desc",
      category: "plumber",
      location: "Boise, ID",
      services: ["drain"],
      star_rating: 4.8,
      review_count: 42,
      hours_json: {
        mon: { open: "08:00", close: "17:00" },
        tue: null, wed: null, thu: null, fri: null, sat: null, sun: null,
        emergency_24_7: true,
      },
      credentials_json: {
        licenses: [{ name: "ID", number: "P1" }],
        insured: true, bonded: false, certifications: [],
      },
    };
    const res = await request(app)
      .post("/register")
      .set("Authorization", "Bearer test-admin-key")
      .send(payload);
    expect(res.status).toBe(201);
    expect(res.body.slug).toBeDefined();
    expect(res.body.api_key).toBeDefined();

    const { getDb } = await import("../db.js");
    const row = getDb()
      .prepare("SELECT hours_json, credentials_json FROM businesses WHERE slug = ?")
      .get(res.body.slug) as { hours_json: string; credentials_json: string };
    expect(JSON.parse(row.hours_json).emergency_24_7).toBe(true);
    expect(JSON.parse(row.credentials_json).licenses[0].number).toBe("P1");
  });

  it("Session 4 followup: persists plan='pro' when wizard forwards it", async () => {
    // Without this wiring every wizard-onboarded tenant lands at the default
    // 'base' plan, so competitorRadar.pollAll's `WHERE plan='pro'` filter
    // silently skips them — the loop never closes for paying customers.
    const res = await request(app)
      .post("/register")
      .set("Authorization", "Bearer test-admin-key")
      .send({
        name: "Pro Biz",
        description: "d",
        category: "plumber",
        location: "Boise",
        services: ["x"],
        star_rating: 0,
        review_count: 0,
        plan: "pro",
      });
    expect(res.status).toBe(201);

    const { getDb } = await import("../db.js");
    const row = getDb()
      .prepare("SELECT plan FROM businesses WHERE slug = ?")
      .get(res.body.slug) as { plan: string };
    expect(row.plan).toBe("pro");
  });

  it("Session 4 followup: defaults plan='base' when omitted", async () => {
    const res = await request(app)
      .post("/register")
      .set("Authorization", "Bearer test-admin-key")
      .send({
        name: "Default Plan Biz",
        description: "d",
        category: "plumber",
        location: "Boise",
        services: ["x"],
        star_rating: 0,
        review_count: 0,
      });
    expect(res.status).toBe(201);

    const { getDb } = await import("../db.js");
    const row = getDb()
      .prepare("SELECT plan FROM businesses WHERE slug = ?")
      .get(res.body.slug) as { plan: string };
    expect(row.plan).toBe("base");
  });

  it("Session 4 followup: rejects an unknown plan value", async () => {
    const res = await request(app)
      .post("/register")
      .set("Authorization", "Bearer test-admin-key")
      .send({
        name: "Bogus Plan Biz",
        description: "d",
        category: "plumber",
        location: "Boise",
        services: ["x"],
        star_rating: 0,
        review_count: 0,
        plan: "enterprise",
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");
  });

  it("201 with minimal payload (no nested JSON)", async () => {
    const res = await request(app)
      .post("/register")
      .set("Authorization", "Bearer test-admin-key")
      .send({
        name: "Minimal Biz",
        description: "d",
        category: "plumber",
        location: "Boise",
        services: ["x"],
        star_rating: 0,
        review_count: 0,
      });
    expect(res.status).toBe(201);
    expect(res.body.slug).toBe("minimal-biz");
  });
});
