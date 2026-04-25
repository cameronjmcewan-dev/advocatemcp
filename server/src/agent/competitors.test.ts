import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../db/migrations.js";
import {
  parseCompetitorsList,
  extractCompetitorMentions,
  extractAndPersist,
} from "./competitors.js";

// Shared in-memory DB handle. Reset per-test in beforeEach. The
// vi.mock below returns this handle to competitors.ts so every
// extractAndPersist call lands against the same database we set up
// in the test.
let testDb: Database.Database;
vi.mock("../db.js", () => ({
  getDb: () => testDb,
}));

describe("parseCompetitorsList", () => {
  it("returns empty array for null / empty / whitespace", () => {
    expect(parseCompetitorsList(null)).toEqual([]);
    expect(parseCompetitorsList("")).toEqual([]);
    expect(parseCompetitorsList("   ")).toEqual([]);
  });

  it("splits comma-separated, trims each entry", () => {
    expect(parseCompetitorsList("Scrunch AI, Profound,BrightEdge")).toEqual([
      "Scrunch AI", "Profound", "BrightEdge",
    ]);
  });

  it("dedups case-insensitively preserving first-seen casing", () => {
    expect(parseCompetitorsList("Profound, profound, PROFOUND")).toEqual(["Profound"]);
  });

  it("drops empty entries from trailing commas", () => {
    expect(parseCompetitorsList("A, , B,")).toEqual(["A", "B"]);
  });
});

describe("extractCompetitorMentions", () => {
  const list = ["Scrunch AI", "Profound", "BrightEdge", "Joe's Pizza"];

  it("finds exact word-boundary matches case-insensitively", () => {
    expect(extractCompetitorMentions("Is scrunch ai better than Profound?", list)).toEqual([
      "Scrunch AI", "Profound",
    ]);
  });

  it("returns canonical spelling regardless of input casing", () => {
    expect(extractCompetitorMentions("PROFOUND vs brightedge", list)).toEqual([
      "Profound", "BrightEdge",
    ]);
  });

  it("does not match inside other words (Pro ≠ product)", () => {
    // "Pro" is not in the list here, but let's verify a shorter competitor
    // would not match inside a bigger word.
    expect(extractCompetitorMentions("This product is great", ["Pro"])).toEqual([]);
    // "edge" shouldn't match just because BrightEdge is in the list
    expect(extractCompetitorMentions("edge case", list)).toEqual([]);
  });

  it("tolerates extra whitespace in the query", () => {
    expect(extractCompetitorMentions("I prefer  Scrunch   AI here", list)).toEqual(["Scrunch AI"]);
  });

  it("handles apostrophes in competitor names", () => {
    expect(extractCompetitorMentions("Have you tried Joe's Pizza recently?", list)).toEqual([
      "Joe's Pizza",
    ]);
  });

  it("returns empty array when no competitor appears", () => {
    expect(extractCompetitorMentions("Just a generic question", list)).toEqual([]);
  });

  it("returns empty array when tenant list is empty", () => {
    expect(extractCompetitorMentions("Scrunch AI is great", [])).toEqual([]);
  });

  it("dedupes when the same competitor appears twice in the query", () => {
    expect(extractCompetitorMentions("Profound vs Profound", list)).toEqual(["Profound"]);
  });
});

describe("extractAndPersist", () => {
  beforeEach(() => {
    testDb = new Database(":memory:");
    applyMigrations(testDb);
    testDb.prepare(
      `INSERT INTO businesses (slug, name, description, services, pricing, phone, api_key, competitors)
       VALUES ('t1', 'Test', 'd', 's', '$1', '555', 'k1', 'Scrunch AI, Profound')`,
    ).run();
  });
  afterEach(() => {
    testDb.close();
    delete process.env.DISABLE_COMPETITOR_EXTRACTOR;
  });

  it("stamps competitors_mentioned JSON array on the queries row", () => {
    const { lastInsertRowid } = testDb.prepare(
      `INSERT INTO queries (business_slug, query_text, response_text)
       VALUES ('t1', 'Is Scrunch AI better than Profound?', 'r')`,
    ).run();
    extractAndPersist(Number(lastInsertRowid), "t1", "Is Scrunch AI better than Profound?");

    const row = testDb.prepare(
      `SELECT competitors_mentioned FROM queries WHERE id = ?`,
    ).get(Number(lastInsertRowid)) as { competitors_mentioned: string | null };
    expect(row.competitors_mentioned).toBe(JSON.stringify(["Scrunch AI", "Profound"]));
  });

  it("stamps '[]' when the tenant's competitors column is empty", () => {
    testDb.prepare(`UPDATE businesses SET competitors = NULL WHERE slug = 't1'`).run();

    const { lastInsertRowid } = testDb.prepare(
      `INSERT INTO queries (business_slug, query_text, response_text)
       VALUES ('t1', 'generic query', 'r')`,
    ).run();
    extractAndPersist(Number(lastInsertRowid), "t1", "generic query");

    const row = testDb.prepare(
      `SELECT competitors_mentioned FROM queries WHERE id = ?`,
    ).get(Number(lastInsertRowid)) as { competitors_mentioned: string | null };
    expect(row.competitors_mentioned).toBe("[]");
  });

  it("honours DISABLE_COMPETITOR_EXTRACTOR=true kill switch", () => {
    process.env.DISABLE_COMPETITOR_EXTRACTOR = "true";

    const { lastInsertRowid } = testDb.prepare(
      `INSERT INTO queries (business_slug, query_text, response_text)
       VALUES ('t1', 'Profound is great', 'r')`,
    ).run();
    extractAndPersist(Number(lastInsertRowid), "t1", "Profound is great");

    const row = testDb.prepare(
      `SELECT competitors_mentioned FROM queries WHERE id = ?`,
    ).get(Number(lastInsertRowid)) as { competitors_mentioned: string | null };
    expect(row.competitors_mentioned).toBeNull();
  });
});
