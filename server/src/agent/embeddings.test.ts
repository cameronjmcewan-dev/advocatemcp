import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../db/migrations.js";

// Voyage is accessed via global fetch — mock fetch directly. This also
// bypasses the broken `voyageai` SDK's ESM dist (ERR_UNSUPPORTED_DIR_IMPORT
// on Node 22), which is why we use fetch in prod too.
const mockFetch = vi.fn();

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
  mockFetch.mockReset();
  // Swap the global. Restored in afterEach.
  (globalThis as { fetch: typeof fetch }).fetch = mockFetch as unknown as typeof fetch;
});

afterEach(() => {
  testDb.close();
  delete process.env.DISABLE_EMBEDDINGS;
  delete process.env.VOYAGE_API_KEY;
});

function okResponse(vecs: number[][]): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      object: "list",
      data: vecs.map((v, i) => ({ object: "embedding", embedding: v, index: i })),
      model: "voyage-3.5-lite",
    }),
    text: async () => "",
  } as unknown as Response;
}

describe("embeddings module", () => {
  it("embed() returns a Float32Array when voyage succeeds", async () => {
    const { embed } = await import("./embeddings.js");
    const fakeVec = Array.from({ length: 512 }, () => 0.01);
    mockFetch.mockResolvedValueOnce(okResponse([fakeVec]));
    const out = await embed("hello world");
    expect(out).toBeInstanceOf(Float32Array);
    expect(out.length).toBe(512);
  });

  it("embed() POSTs to the Voyage endpoint with bearer auth and correct body", async () => {
    const { embed } = await import("./embeddings.js");
    mockFetch.mockResolvedValueOnce(okResponse([Array.from({ length: 512 }, () => 0.1)]));
    await embed("hi");
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.voyageai.com/v1/embeddings");
    expect(init.method).toBe("POST");
    expect(init.headers["authorization"]).toBe("Bearer test-key");
    const body = JSON.parse(init.body);
    expect(body.input).toEqual(["hi"]);
    expect(body.output_dimension).toBe(512);
    expect(body.model).toBe("voyage-3.5-lite");
  });

  it("embedAndPersist UPDATEs queries.query_embedding via COALESCE", async () => {
    const { embedAndPersist } = await import("./embeddings.js");
    mockFetch.mockResolvedValueOnce(okResponse([Array.from({ length: 512 }, () => 0.02)]));
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
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("embedAndPersist swallows Voyage errors (no throw out of fire-and-forget)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { embedAndPersist } = await import("./embeddings.js");
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => "server error",
      json: async () => ({}),
    } as unknown as Response);
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

  it("embedBatch reorders rows by `index` field", async () => {
    const { embedBatch } = await import("./embeddings.js");
    const v0 = Array.from({ length: 512 }, () => 0.0);
    const v1 = Array.from({ length: 512 }, () => 1.0);
    // Return in reverse order with correct index fields — verifies reorder
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        object: "list",
        data: [
          { object: "embedding", embedding: v1, index: 1 },
          { object: "embedding", embedding: v0, index: 0 },
        ],
        model: "voyage-3.5-lite",
      }),
      text: async () => "",
    } as unknown as Response);
    const out = await embedBatch(["first", "second"]);
    expect(out[0][0]).toBe(0.0); // position 0 should match input[0]
    expect(out[1][0]).toBe(1.0); // position 1 should match input[1]
  });
});
