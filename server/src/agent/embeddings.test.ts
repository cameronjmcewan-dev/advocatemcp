import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../db/migrations.js";

// Hoisted mock singleton — both the mocked module and the tests reference
// this directly. Avoids the "not a constructor" and "mock.results empty
// before lazy init" footguns that bit the plan's original version.
const mockEmbed = vi.fn();

vi.mock("voyageai", () => {
  return {
    VoyageAIClient: vi.fn().mockImplementation(function (this: { embed: typeof mockEmbed }) {
      this.embed = mockEmbed;
    }),
  };
});

let testDb: Database.Database;
vi.mock("../db.js", () => ({
  getDb: () => testDb,
}));

beforeEach(() => {
  testDb = new Database(":memory:");
  applyMigrations(testDb);
  testDb.prepare(
    `INSERT INTO businesses (slug, name, description, services, pricing, phone, api_key)
     VALUES ('t1', 'Test', 'd', 's', '$1', '555', 'k1')`
  ).run();
  process.env.DISABLE_EMBEDDINGS = "false";
  process.env.VOYAGE_API_KEY = "test-key";
  mockEmbed.mockReset();
});

afterEach(() => {
  testDb.close();
  delete process.env.DISABLE_EMBEDDINGS;
  delete process.env.VOYAGE_API_KEY;
});

describe("embeddings module", () => {
  it("embed() returns a Float32Array when voyage succeeds", async () => {
    const { embed } = await import("./embeddings.js");
    const fakeVec = Array.from({ length: 512 }, () => 0.01);
    mockEmbed.mockResolvedValueOnce({ data: [{ embedding: fakeVec }] });
    const out = await embed("hello world");
    expect(out).toBeInstanceOf(Float32Array);
    expect(out.length).toBe(512);
  });

  it("embedAndPersist UPDATEs queries.query_embedding via COALESCE", async () => {
    const { embedAndPersist } = await import("./embeddings.js");
    mockEmbed.mockResolvedValueOnce({
      data: [{ embedding: Array.from({ length: 512 }, () => 0.02) }],
    });
    const { lastInsertRowid } = testDb.prepare(
      `INSERT INTO queries (business_slug, query_text, response_text) VALUES ('t1', 'q', 'r')`
    ).run();
    const qid = Number(lastInsertRowid);
    embedAndPersist(qid, "q");
    await new Promise((resolve) => setTimeout(resolve, 30));
    const row = testDb.prepare(`SELECT query_embedding FROM queries WHERE id = ?`).get(qid) as {
      query_embedding: Buffer | null;
    };
    expect(row.query_embedding).not.toBeNull();
    expect(row.query_embedding!.length).toBe(512 * 4);
  });

  it("embedAndPersist honours DISABLE_EMBEDDINGS kill switch", async () => {
    process.env.DISABLE_EMBEDDINGS = "true";
    const { embedAndPersist } = await import("./embeddings.js");
    embedAndPersist(1, "q");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockEmbed).not.toHaveBeenCalled();
  });

  it("embedAndPersist swallows Voyage errors (no throw out of fire-and-forget)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { embedAndPersist } = await import("./embeddings.js");
    mockEmbed.mockRejectedValueOnce(new Error("API down"));
    const { lastInsertRowid } = testDb.prepare(
      `INSERT INTO queries (business_slug, query_text, response_text) VALUES ('t1', 'q', 'r')`
    ).run();
    embedAndPersist(Number(lastInsertRowid), "q");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(errSpy).toHaveBeenCalled();
    const row = testDb.prepare(
      `SELECT query_embedding FROM queries WHERE id = ?`
    ).get(Number(lastInsertRowid)) as { query_embedding: Buffer | null };
    expect(row.query_embedding).toBeNull();
    errSpy.mockRestore();
  });
});
