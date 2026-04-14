import fs from "fs";
import os from "os";
import path from "path";
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { generateAutoQueries, phrasingVariants } from "./competitorRadar.js";

describe("generateAutoQueries", () => {
  it("produces 6 queries when category, location, and 3+ services present", () => {
    const qs = generateAutoQueries({
      category: "plumber",
      location: "Boise, ID",
      services: ["drain", "pipe", "heater", "sewer"],
    });
    expect(qs).toEqual([
      "best plumber in Boise, ID",
      "top plumber in Boise",
      "plumber near me in Boise, ID",
      "drain plumber Boise, ID",
      "pipe plumber Boise, ID",
      "heater plumber Boise, ID",
    ]);
  });

  it("omits service-based queries when services is empty", () => {
    const qs = generateAutoQueries({
      category: "plumber",
      location: "Boise, ID",
      services: [],
    });
    expect(qs).toEqual([
      "best plumber in Boise, ID",
      "top plumber in Boise",
      "plumber near me in Boise, ID",
    ]);
  });

  it("returns [] when category or location missing", () => {
    expect(generateAutoQueries({ category: "", location: "Boise", services: [] })).toEqual([]);
    expect(generateAutoQueries({ category: "plumber", location: "", services: [] })).toEqual([]);
  });

  it("returns base queries when services is not an array (defensive guard)", () => {
    const qs = generateAutoQueries({
      category: "plumber",
      location: "Boise, ID",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      services: null as any,
    });
    expect(qs).toEqual([
      "best plumber in Boise, ID",
      "top plumber in Boise",
      "plumber near me in Boise, ID",
    ]);
  });
});

describe("phrasingVariants", () => {
  it("fans a plain query into 3 variants", () => {
    expect(phrasingVariants("best plumber Boise")).toEqual([
      "best plumber Boise",
      "best plumber Boise reviews",
      "top rated best plumber Boise",
    ]);
  });

  it("skips variant 1 when query already contains 'reviews'", () => {
    expect(phrasingVariants("plumber reviews Boise")).toEqual([
      "plumber reviews Boise",
      "top rated plumber reviews Boise",
    ]);
  });

  it("skips variant 2 when query already contains 'top rated' (case-insensitive)", () => {
    expect(phrasingVariants("Top Rated plumber")).toEqual([
      "Top Rated plumber",
      "Top Rated plumber reviews",
    ]);
  });

  it("returns only the base variant when both affixes already present", () => {
    expect(phrasingVariants("top rated plumber reviews")).toEqual(["top rated plumber reviews"]);
  });

  it("skips 'top rated' variant when query contains hyphenated 'top-rated'", () => {
    expect(phrasingVariants("top-rated plumber")).toEqual([
      "top-rated plumber",
      "top-rated plumber reviews",
    ]);
  });
});

describe("seedBasketIfEmpty", () => {
  const tmp = path.join(os.tmpdir(), `p3-seed-${Date.now()}.db`);

  beforeEach(async () => {
    process.env.DATABASE_PATH = tmp;
    const { _resetDbForTests } = await import("../db.js");
    _resetDbForTests();
    const { getDb } = await import("../db.js");
    getDb(); // init schema
  });

  afterAll(() => {
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(tmp + suffix, { force: true });
    delete process.env.DATABASE_PATH;
  });

  it("seeds 6 auto rows for a fresh Pro tenant", async () => {
    const { getDb } = await import("../db.js");
    const { seedBasketIfEmpty } = await import("./competitorRadar.js");
    const db = getDb();
    db.prepare(`INSERT INTO businesses
      (slug, name, description, services, api_key, category, location, star_rating, review_count, plan)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pro')`).run(
        "t1", "T1", "d", JSON.stringify(["drain","pipe","heater"]),
        "k1", "plumber", "Boise, ID", 4.5, 10
      );

    seedBasketIfEmpty("t1");

    const rows = db.prepare(
      "SELECT query, source FROM competitor_query_baskets WHERE slug=? AND enabled=1 ORDER BY id"
    ).all("t1") as { query: string; source: string }[];
    expect(rows).toHaveLength(6);
    expect(rows.every((r) => r.source === "auto")).toBe(true);
    expect(rows[0]!.query).toBe("best plumber in Boise, ID");
  });

  it("is a no-op when basket already has rows", async () => {
    const { getDb } = await import("../db.js");
    const { seedBasketIfEmpty } = await import("./competitorRadar.js");
    const db = getDb();
    db.prepare(`INSERT INTO businesses
      (slug, name, description, services, api_key, category, location, star_rating, review_count, plan)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pro')`).run(
        "t2", "T2", "d", JSON.stringify([]), "k2", "plumber", "Boise, ID", 4.5, 10
      );
    db.prepare(`INSERT INTO competitor_query_baskets (slug, query, source, enabled, created_at)
      VALUES ('t2', 'custom q', 'tenant', 1, datetime('now'))`).run();

    seedBasketIfEmpty("t2");

    const { count } = db.prepare(
      "SELECT COUNT(*) AS count FROM competitor_query_baskets WHERE slug='t2'"
    ).get() as { count: number };
    expect(count).toBe(1);
  });
});
