import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../db/migrations.js";

let testDb: Database.Database;
vi.mock("../db.js", () => ({ getDb: () => testDb }));
vi.mock("../agent/embeddings.js", () => ({
  embedBatch: vi.fn(),
}));

beforeEach(() => {
  testDb = new Database(":memory:");
  applyMigrations(testDb);
  testDb.prepare(
    `INSERT INTO businesses (slug, name, description, services, pricing, phone, api_key)
     VALUES ('t1', 'Test', 'd', 's', '$1', '555', 'k1')`
  ).run();
  process.env.VOYAGE_API_KEY = "test-key";
  process.env.EMBEDDINGS_DAILY_BUDGET_CENTS = "10";
});

afterEach(() => {
  testDb.close();
  vi.restoreAllMocks();
  delete process.env.VOYAGE_API_KEY;
  delete process.env.EMBEDDINGS_DAILY_BUDGET_CENTS;
});

describe("backfillEmbeddings", () => {
  it("embeds rows with NULL query_embedding only", async () => {
    const { embedBatch } = await import("../agent/embeddings.js");
    const { backfillEmbeddings } = await import("./backfillEmbeddings.js");

    // Two rows without embeddings, one row WITH
    testDb.prepare(`INSERT INTO queries (business_slug, query_text, response_text) VALUES ('t1', 'q1', 'r')`).run();
    testDb.prepare(`INSERT INTO queries (business_slug, query_text, response_text) VALUES ('t1', 'q2', 'r')`).run();
    const existing = new Float32Array(512);
    existing[0] = 1;
    testDb.prepare(
      `INSERT INTO queries (business_slug, query_text, response_text, query_embedding)
       VALUES ('t1', 'q3', 'r', ?)`
    ).run(Buffer.from(existing.buffer));

    (embedBatch as ReturnType<typeof vi.fn>).mockResolvedValue([
      new Float32Array(512).fill(0.1),
      new Float32Array(512).fill(0.2),
    ]);

    const result = await backfillEmbeddings();

    expect(result.scanned).toBe(2);
    expect(result.filled).toBe(2);
    const calls = (embedBatch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[];
    expect(calls.sort()).toEqual(["q1", "q2"]);
  });

  it("halts mid-batch when daily budget exceeded", async () => {
    process.env.EMBEDDINGS_DAILY_BUDGET_CENTS = "0"; // zero budget → halt immediately
    const { backfillEmbeddings } = await import("./backfillEmbeddings.js");

    testDb.prepare(`INSERT INTO queries (business_slug, query_text, response_text) VALUES ('t1', 'q1', 'r')`).run();
    testDb.prepare(`INSERT INTO queries (business_slug, query_text, response_text) VALUES ('t1', 'q2', 'r')`).run();

    const result = await backfillEmbeddings();
    expect(result.budget_halted).toBe(true);
    expect(result.filled).toBe(0);
  });

  it("skips silently if VOYAGE_API_KEY is unset", async () => {
    delete process.env.VOYAGE_API_KEY;
    const { backfillEmbeddings } = await import("./backfillEmbeddings.js");
    const result = await backfillEmbeddings();
    expect(result.scanned).toBe(0);
    expect(result.skipped_no_api_key).toBe(true);
  });
});
