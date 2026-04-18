import fs from "fs";
import os from "os";
import path from "path";
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
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

  it("is a no-op for base-tier tenants", async () => {
    const { getDb } = await import("../db.js");
    const { seedBasketIfEmpty } = await import("./competitorRadar.js");
    const db = getDb();
    db.prepare(`INSERT INTO businesses
      (slug, name, description, services, api_key, category, location, star_rating, review_count, plan)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'base')`).run(
        "t3", "T3", "d", JSON.stringify(["drain"]),
        "k3", "plumber", "Boise, ID", 4.5, 10
      );

    seedBasketIfEmpty("t3");

    const { count } = db.prepare(
      "SELECT COUNT(*) AS count FROM competitor_query_baskets WHERE slug='t3'"
    ).get() as { count: number };
    expect(count).toBe(0);
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

describe("pollAll", () => {
  const tmp = path.join(os.tmpdir(), `p3-poll-${Date.now()}.db`);

  beforeEach(async () => {
    process.env.DATABASE_PATH = tmp;
    process.env.COMPETITOR_POLL_DAILY_BUDGET_USD = "10";
    // Ensure Perplexity provider passes the API-key gate; individual tests
    // opt OpenAI in by also setting OPENAI_API_KEY.
    process.env.PERPLEXITY_API_KEY = "pplx-test";
    // Disable the rate-limit sleep in tests so multi-provider fan-out
    // finishes well inside the default vitest timeout.
    process.env.RADAR_RATE_INTERVAL_MS = "1";
    delete process.env.OPENAI_API_KEY;
    delete process.env.PERPLEXITY_DAILY_BUDGET_USD;
    delete process.env.OPENAI_DAILY_BUDGET_USD;
    const { _resetDbForTests } = await import("../db.js");
    _resetDbForTests();
    // Wipe the DB file so each test starts with a clean slate.
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(tmp + suffix, { force: true });
    const { getDb } = await import("../db.js");
    getDb();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(tmp + suffix, { force: true });
    delete process.env.DATABASE_PATH;
    delete process.env.COMPETITOR_POLL_DAILY_BUDGET_USD;
    delete process.env.PERPLEXITY_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.PERPLEXITY_DAILY_BUDGET_USD;
    delete process.env.OPENAI_DAILY_BUDGET_USD;
    delete process.env.RADAR_RATE_INTERVAL_MS;
    vi.restoreAllMocks();
  });

  it("writes 3 poll rows + 15 citations for a tenant whose domain is cited at rank 3", async () => {
    const { getDb } = await import("../db.js");
    const { pollAll } = await import("./competitorRadar.js");
    const perplexity = await import("../lib/perplexity.js");

    const db = getDb();
    db.prepare(`INSERT INTO businesses
      (slug, name, description, services, api_key, category, location, website, star_rating, review_count, plan)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pro')`).run(
        "t1", "T1", "d", "[]", "k1", "plumber", "Boise, ID",
        "https://tenant.com", 4.5, 10
      );
    db.prepare(`INSERT INTO competitor_query_baskets (slug, query, source, enabled, created_at)
      VALUES ('t1', 'best plumber boise', 'tenant', 1, datetime('now'))`).run();

    vi.spyOn(perplexity, "perplexitySearch").mockResolvedValue({
      citations: [
        "https://other1.com",
        "https://other2.com",
        "https://tenant.com/about",
        "https://other3.com",
        "https://other4.com",
      ],
      answerText: "T1 is reliable and affordable.",
      costUsd: 0.005,
    });

    await pollAll();

    const polls = db.prepare("SELECT * FROM competitor_polls WHERE slug='t1'").all() as Array<{
      our_domain_cited: number; our_cited_rank: number | null; citation_count: number;
      bot: string; sentiment_descriptors: string | null;
    }>;
    expect(polls).toHaveLength(3);
    expect(polls.every((p) => p.our_domain_cited === 1)).toBe(true);
    expect(polls.every((p) => p.our_cited_rank === 3)).toBe(true);
    expect(polls.every((p) => p.citation_count === 5)).toBe(true);
    // With only PERPLEXITY_API_KEY set, every row should be 'perplexity'.
    expect(polls.every((p) => p.bot === "perplexity")).toBe(true);
    // Sentiment extracted from answerText mentioning the tenant name "T1".
    expect(polls.every((p) => p.sentiment_descriptors !== null)).toBe(true);
    expect(JSON.parse(polls[0]!.sentiment_descriptors!)).toEqual(["affordable", "reliable"]);

    const citations = db.prepare("SELECT COUNT(*) AS c FROM competitor_citations").get() as { c: number };
    expect(citations.c).toBe(15);
  });

  it("skips polling and sends alert when daily budget cap is breached", async () => {
    const { getDb } = await import("../db.js");
    const { pollAll } = await import("./competitorRadar.js");
    const perplexity = await import("../lib/perplexity.js");
    const alert      = await import("../lib/alert.js");

    process.env.COMPETITOR_POLL_DAILY_BUDGET_USD = "10";
    const db = getDb();
    db.prepare(`INSERT INTO businesses
      (slug, name, description, services, api_key, category, location, website, star_rating, review_count, plan)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pro')`).run(
        "t2", "T2", "d", "[]", "k2", "plumber", "Boise, ID", "https://t2.com", 4.5, 10
      );
    db.prepare(`INSERT INTO competitor_query_baskets (slug, query, source, enabled, created_at)
      VALUES ('t2', 'q', 'tenant', 1, datetime('now'))`).run();

    // Pre-seed today's spend above the cap.
    db.prepare(`INSERT INTO competitor_polls
      (slug, query_basket_id, bot, phrasing, phrasing_variant, polled_at, our_domain_cited, citation_count, cost_usd)
      VALUES ('t2', 1, 'perplexity', 'x', 0, ?, 0, 0, 10.01)`).run(new Date().toISOString());

    const searchSpy = vi.spyOn(perplexity, "perplexitySearch");
    const alertSpy  = vi.spyOn(alert, "sendBudgetAlert").mockResolvedValue();

    await pollAll();

    expect(searchSpy).not.toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledOnce();
  });

  it("isolates errors: one failing call does not abort the batch", async () => {
    const { getDb } = await import("../db.js");
    const { pollAll } = await import("./competitorRadar.js");
    const perplexity = await import("../lib/perplexity.js");

    const db = getDb();
    db.prepare(`INSERT INTO businesses
      (slug, name, description, services, api_key, category, location, website, star_rating, review_count, plan)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pro')`).run(
        "t3", "T3", "d", "[]", "k3", "plumber", "Boise, ID", "https://t3.com", 4.5, 10
      );
    db.prepare(`INSERT INTO competitor_query_baskets (slug, query, source, enabled, created_at)
      VALUES ('t3', 'q', 'tenant', 1, datetime('now'))`).run();

    let call = 0;
    vi.spyOn(perplexity, "perplexitySearch").mockImplementation(async () => {
      call++;
      if (call === 2) throw new Error("500 api");
      return { citations: ["https://t3.com"], answerText: "", costUsd: 0.005 };
    });

    await pollAll();

    const polls = db.prepare(
      "SELECT our_domain_cited, citation_count, error FROM competitor_polls WHERE slug='t3' ORDER BY id"
    ).all() as Array<{ our_domain_cited: number; citation_count: number; error: string | null }>;
    expect(polls).toHaveLength(3);
    expect(polls[1]!.error).toBe("500 api");
    expect(polls[1]!.citation_count).toBe(0);
    expect(polls[0]!.error).toBeNull();
    expect(polls[2]!.error).toBeNull();
  });

  it("fans out to both providers when both API keys are set (6 rows = 3 variants × 2 bots)", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const { getDb } = await import("../db.js");
    const { pollAll } = await import("./competitorRadar.js");
    const perplexity = await import("../lib/perplexity.js");
    const openai     = await import("../lib/openai.js");

    const db = getDb();
    db.prepare(`INSERT INTO businesses
      (slug, name, description, services, api_key, category, location, website, star_rating, review_count, plan)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pro')`).run(
        "t4", "T4", "d", "[]", "k4", "plumber", "Boise, ID", "https://t4.com", 4.5, 10
      );
    db.prepare(`INSERT INTO competitor_query_baskets (slug, query, source, enabled, created_at)
      VALUES ('t4', 'q', 'tenant', 1, datetime('now'))`).run();

    vi.spyOn(perplexity, "perplexitySearch").mockResolvedValue({
      citations: ["https://t4.com"], answerText: "T4 is reliable.", costUsd: 0.005,
    });
    vi.spyOn(openai, "openaiSearch").mockResolvedValue({
      citations: ["https://t4.com"], answerText: "T4 is professional.", costUsd: 0.03,
    });

    await pollAll();

    const rows = db.prepare(
      "SELECT bot, sentiment_descriptors FROM competitor_polls WHERE slug='t4' ORDER BY id"
    ).all() as Array<{ bot: string; sentiment_descriptors: string | null }>;
    expect(rows).toHaveLength(6);
    const byBot = rows.reduce<Record<string, number>>((acc, r) => {
      acc[r.bot] = (acc[r.bot] ?? 0) + 1; return acc;
    }, {});
    expect(byBot).toEqual({ perplexity: 3, openai: 3 });
    // Perplexity rows should carry 'reliable', OpenAI rows 'professional'.
    const ppxDesc = rows.filter((r) => r.bot === "perplexity").map((r) => JSON.parse(r.sentiment_descriptors!));
    const oaiDesc = rows.filter((r) => r.bot === "openai").map((r) => JSON.parse(r.sentiment_descriptors!));
    expect(ppxDesc.every((d) => d.includes("reliable"))).toBe(true);
    expect(oaiDesc.every((d) => d.includes("professional"))).toBe(true);
  });

  it("per-provider budget cap: OpenAI paused while Perplexity keeps polling", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.OPENAI_DAILY_BUDGET_USD = "1.0";
    const { getDb } = await import("../db.js");
    const { pollAll } = await import("./competitorRadar.js");
    const perplexity = await import("../lib/perplexity.js");
    const openai     = await import("../lib/openai.js");
    const alert      = await import("../lib/alert.js");

    const db = getDb();
    db.prepare(`INSERT INTO businesses
      (slug, name, description, services, api_key, category, location, website, star_rating, review_count, plan)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pro')`).run(
        "t5", "T5", "d", "[]", "k5", "plumber", "Boise, ID", "https://t5.com", 4.5, 10
      );
    db.prepare(`INSERT INTO competitor_query_baskets (slug, query, source, enabled, created_at)
      VALUES ('t5', 'q', 'tenant', 1, datetime('now'))`).run();
    // Pre-seed OpenAI spend above its $1 cap. Perplexity's unlimited-default $10 still has room.
    db.prepare(`INSERT INTO competitor_polls
      (slug, query_basket_id, bot, phrasing, phrasing_variant, polled_at, our_domain_cited, citation_count, cost_usd)
      VALUES ('t5', 1, 'openai', 'x', 0, ?, 0, 0, 1.50)`).run(new Date().toISOString());

    const ppxSpy  = vi.spyOn(perplexity, "perplexitySearch").mockResolvedValue({
      citations: ["https://t5.com"], answerText: "", costUsd: 0.005,
    });
    const oaiSpy  = vi.spyOn(openai, "openaiSearch");
    const alertSpy = vi.spyOn(alert, "sendBudgetAlert").mockResolvedValue();

    await pollAll();

    expect(ppxSpy).toHaveBeenCalled();        // Perplexity still runs.
    expect(oaiSpy).not.toHaveBeenCalled();    // OpenAI paused for the day.
    expect(alertSpy).toHaveBeenCalledOnce();  // One alert for the OpenAI cap hit.
    // The pre-seeded OpenAI row plus 3 perplexity rows = 4 total.
    const { c } = db.prepare("SELECT COUNT(*) AS c FROM competitor_polls WHERE slug='t5'").get() as { c: number };
    expect(c).toBe(4);
  });

  it("writes NULL sentiment_descriptors when the tenant is not cited", async () => {
    const { getDb } = await import("../db.js");
    const { pollAll } = await import("./competitorRadar.js");
    const perplexity = await import("../lib/perplexity.js");

    const db = getDb();
    db.prepare(`INSERT INTO businesses
      (slug, name, description, services, api_key, category, location, website, star_rating, review_count, plan)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pro')`).run(
        "t6", "T6", "d", "[]", "k6", "plumber", "Boise, ID", "https://t6.com", 4.5, 10
      );
    db.prepare(`INSERT INTO competitor_query_baskets (slug, query, source, enabled, created_at)
      VALUES ('t6', 'q', 'tenant', 1, datetime('now'))`).run();

    // No tenant-matching citation → our_domain_cited=0 → sentiment must be NULL
    // even though the answer text mentions descriptors.
    vi.spyOn(perplexity, "perplexitySearch").mockResolvedValue({
      citations: ["https://other.com"],
      answerText: "T6 is reliable and fast.",  // deliberately rich text
      costUsd: 0.005,
    });

    await pollAll();

    const rows = db.prepare(
      "SELECT our_domain_cited, sentiment_descriptors FROM competitor_polls WHERE slug='t6'"
    ).all() as Array<{ our_domain_cited: number; sentiment_descriptors: string | null }>;
    expect(rows.every((r) => r.our_domain_cited === 0)).toBe(true);
    expect(rows.every((r) => r.sentiment_descriptors === null)).toBe(true);
  });

  it("returns early when no provider API keys are configured", async () => {
    delete process.env.PERPLEXITY_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const { getDb } = await import("../db.js");
    const { pollAll } = await import("./competitorRadar.js");
    const perplexity = await import("../lib/perplexity.js");

    const db = getDb();
    db.prepare(`INSERT INTO businesses
      (slug, name, description, services, api_key, category, location, website, star_rating, review_count, plan)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pro')`).run(
        "t7", "T7", "d", "[]", "k7", "plumber", "Boise, ID", "https://t7.com", 4.5, 10
      );
    db.prepare(`INSERT INTO competitor_query_baskets (slug, query, source, enabled, created_at)
      VALUES ('t7', 'q', 'tenant', 1, datetime('now'))`).run();

    const ppxSpy = vi.spyOn(perplexity, "perplexitySearch");
    await pollAll();

    expect(ppxSpy).not.toHaveBeenCalled();
    const { c } = db.prepare("SELECT COUNT(*) AS c FROM competitor_polls").get() as { c: number };
    expect(c).toBe(0);
  });
});
