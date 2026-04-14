import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

describe("db schema migrations", () => {
  const tmp = path.join(os.tmpdir(), `advocate-db-test-${Date.now()}.db`);

  beforeAll(() => {
    process.env.DATABASE_PATH = tmp;
  });

  afterAll(() => {
    for (const suffix of ["", "-wal", "-shm"]) {
      fs.rmSync(tmp + suffix, { force: true });
    }
  });

  it("adds the new onboarding profile columns to businesses", async () => {
    const { getDb } = await import("./db.js");
    const db = getDb();
    const cols = db
      .prepare("PRAGMA table_info(businesses)")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    for (const col of [
      "hours_json",
      "services_json_v2",
      "pricing_json_v2",
      "credentials_json",
      "ratings_json",
      "differentiators_text",
      "customer_quotes_json",
      "guarantee_text",
      "case_stories_json",
      "lead_routing_json",
    ]) {
      expect(names).toContain(col);
    }
  });
});

describe("P3 schema — competitor radar tables", () => {
  const tmp = path.join(os.tmpdir(), `p3-schema-${Date.now()}.db`);

  beforeEach(async () => {
    process.env.DATABASE_PATH = tmp;
    const { _resetDbForTests } = await import("./db.js");
    _resetDbForTests();
  });

  afterAll(() => {
    for (const suffix of ["", "-wal", "-shm"]) {
      fs.rmSync(tmp + suffix, { force: true });
    }
    delete process.env.DATABASE_PATH;
  });

  it("creates competitor_query_baskets table", async () => {
    const { getDb } = await import("./db.js");
    const db = getDb();
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get("competitor_query_baskets");
    expect(row).toBeTruthy();
  });

  it("creates competitor_polls table", async () => {
    const { getDb } = await import("./db.js");
    const db = getDb();
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get("competitor_polls");
    expect(row).toBeTruthy();
  });

  it("creates competitor_citations table", async () => {
    const { getDb } = await import("./db.js");
    const db = getDb();
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get("competitor_citations");
    expect(row).toBeTruthy();
  });

  it("enforces UNIQUE(slug, query) on baskets", async () => {
    const { getDb } = await import("./db.js");
    const db = getDb();
    const insert = db.prepare(
      "INSERT INTO competitor_query_baskets (slug, query, source, enabled, created_at) VALUES (?, ?, 'auto', 1, datetime('now'))"
    );
    insert.run("t1", "best plumber");
    expect(() => insert.run("t1", "best plumber")).toThrow(/UNIQUE/);
  });
});
