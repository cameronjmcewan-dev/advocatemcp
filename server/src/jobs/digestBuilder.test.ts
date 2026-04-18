import fs from "fs";
import os from "os";
import path from "path";
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { buildDigest, fmtPct, weekWindow } from "./digestBuilder.js";

describe("fmtPct", () => {
  it("formats a rate as a percentage with one decimal", () => {
    expect(fmtPct(0.333)).toBe("33.3%");
    expect(fmtPct(0)).toBe("0.0%");
    expect(fmtPct(1)).toBe("100.0%");
  });
  it("returns '—' for non-finite values", () => {
    expect(fmtPct(Number.NaN)).toBe("—");
    expect(fmtPct(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("weekWindow", () => {
  it("returns start ISO rangeDays earlier than end ISO", () => {
    const w = weekWindow(7);
    const gap = new Date(w.end_iso).getTime() - new Date(w.start_iso).getTime();
    expect(gap).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe("buildDigest", () => {
  const tmp = path.join(os.tmpdir(), `p5-digest-${Date.now()}.db`);

  beforeEach(async () => {
    process.env.DATABASE_PATH = tmp;
    const { _resetDbForTests } = await import("../db.js");
    _resetDbForTests();
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(tmp + suffix, { force: true });
    const { getDb } = await import("../db.js");
    getDb();
  });

  afterAll(() => {
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(tmp + suffix, { force: true });
    delete process.env.DATABASE_PATH;
  });

  async function seedTenant(overrides: Partial<{
    slug: string; email: string | null; digest_unsubscribed: number; plan: string; name: string; website: string;
  }> = {}): Promise<void> {
    const { getDb } = await import("../db.js");
    const db = getDb();
    const t = {
      slug: "acme", name: "Acme Plumbing", email: "owner@acme.example",
      digest_unsubscribed: 0, plan: "pro", website: "https://acme.example",
      ...overrides,
    };
    db.prepare(`INSERT INTO businesses
      (slug, name, description, services, api_key, category, location, website,
       star_rating, review_count, plan, email, digest_unsubscribed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        t.slug, t.name, "d", "[]", `key-${t.slug}`, "plumber", "Boise, ID", t.website,
        4.5, 10, t.plan, t.email, t.digest_unsubscribed
      );
  }

  async function seedPoll(
    slug: string,
    opts: { bot?: string; cited?: boolean; cited_rank?: number; sentiment?: string[]; phrasing?: string; competitors?: string[] } = {},
  ): Promise<number> {
    const { getDb } = await import("../db.js");
    const db = getDb();
    const {
      bot = "perplexity", cited = false, cited_rank,
      sentiment, phrasing = "best plumber", competitors = [],
    } = opts;
    // Ensure a basket row with matching id exists (FK) — use one shared basket row.
    const existing = db.prepare("SELECT id FROM competitor_query_baskets WHERE slug=? LIMIT 1").get(slug) as { id: number } | undefined;
    const basketId = existing
      ? existing.id
      : Number(db.prepare(`INSERT INTO competitor_query_baskets (slug, query, source, enabled, created_at)
          VALUES (?, ?, 'auto', 1, datetime('now'))`).run(slug, phrasing).lastInsertRowid);
    const info = db.prepare(`INSERT INTO competitor_polls
      (slug, query_basket_id, bot, phrasing, phrasing_variant, polled_at,
       our_domain_cited, our_cited_rank, citation_count, cost_usd, sentiment_descriptors)
      VALUES (?, ?, ?, ?, 0, datetime('now'), ?, ?, ?, 0.005, ?)`).run(
        slug, basketId, bot, phrasing, cited ? 1 : 0, cited ? (cited_rank ?? 3) : null,
        competitors.length + (cited ? 1 : 0),
        sentiment ? JSON.stringify(sentiment) : null,
      );
    const pollId = Number(info.lastInsertRowid);
    competitors.forEach((domain, i) => {
      db.prepare(`INSERT INTO competitor_citations (poll_id, rank, url, domain)
        VALUES (?, ?, ?, ?)`).run(pollId, i + 1, `https://${domain}/`, domain);
    });
    return pollId;
  }

  it("returns null when the tenant does not exist", async () => {
    expect(buildDigest("nonexistent")).toBeNull();
  });

  it("returns null when the tenant has no email", async () => {
    await seedTenant({ slug: "t1", email: null });
    await seedPoll("t1");
    expect(buildDigest("t1")).toBeNull();
  });

  it("returns null when the tenant is unsubscribed", async () => {
    await seedTenant({ slug: "t2", digest_unsubscribed: 1 });
    await seedPoll("t2");
    expect(buildDigest("t2")).toBeNull();
  });

  it("returns null when the tenant is not on Pro plan", async () => {
    await seedTenant({ slug: "t3", plan: "base" });
    await seedPoll("t3");
    expect(buildDigest("t3")).toBeNull();
  });

  it("returns null when the window has zero polls", async () => {
    await seedTenant({ slug: "t4" });
    expect(buildDigest("t4")).toBeNull();
  });

  it("produces a digest with subject + totals + per-bot breakdown + recipient", async () => {
    await seedTenant({ slug: "t5", name: "Acme Co", email: "owner@acme.example" });
    await seedPoll("t5", { bot: "perplexity", cited: true,  sentiment: ["reliable", "fast"] });
    await seedPoll("t5", { bot: "perplexity", cited: false, competitors: ["rival.com", "other.com"] });
    await seedPoll("t5", { bot: "openai",     cited: true,  sentiment: ["affordable"] });

    const d = buildDigest("t5");
    expect(d).not.toBeNull();
    expect(d!.recipient).toBe("owner@acme.example");
    expect(d!.totals.polls).toBe(3);
    expect(d!.totals.cited).toBe(2);
    expect(d!.subject).toContain("cited in 2 of 3");
    // HTML + text should mention both providers and both descriptor sets.
    expect(d!.html).toContain("Perplexity");
    expect(d!.html).toContain("ChatGPT (OpenAI)");
    expect(d!.html).toContain("reliable");
    expect(d!.html).toContain("affordable");
    expect(d!.text).toContain("SHARE OF MODEL");
    expect(d!.text).toContain("Perplexity");
    expect(d!.text).toContain("rival.com");
  });

  it("uses a 'zero citations' subject when cited=0 but polls>0", async () => {
    await seedTenant({ slug: "t6" });
    await seedPoll("t6", { cited: false });
    const d = buildDigest("t6");
    expect(d).not.toBeNull();
    expect(d!.subject).toContain("0 of 1");
  });

  it("HTML-escapes the business name to prevent injection in the subject line", async () => {
    await seedTenant({ slug: "t7", name: `Acme "& Sons" <Plumbing>` });
    await seedPoll("t7", { cited: true });
    const d = buildDigest("t7");
    expect(d).not.toBeNull();
    // Subject is plain text — raw characters pass through, which is fine.
    // HTML body must NOT contain the raw < or &.
    expect(d!.html).toContain("&amp;");
    expect(d!.html).toContain("&lt;Plumbing&gt;");
    expect(d!.html).not.toContain("<Plumbing>");
  });

  it("renders a friendly empty state when there are no lost queries", async () => {
    await seedTenant({ slug: "t8" });
    // Only wins.
    await seedPoll("t8", { cited: true });
    await seedPoll("t8", { cited: true });
    const d = buildDigest("t8");
    expect(d).not.toBeNull();
    expect(d!.html).toContain("No lost queries this week");
    expect(d!.text).toContain("(none)");
  });

  it("passes through dashboardUrl and unsubscribeUrl overrides", async () => {
    await seedTenant({ slug: "t9" });
    await seedPoll("t9", { cited: true });
    const d = buildDigest("t9", {
      dashboardUrl:   "https://example.com/dash?slug=t9",
      unsubscribeUrl: "https://example.com/unsub/abc",
    });
    expect(d!.html).toContain("https://example.com/dash?slug=t9");
    expect(d!.html).toContain("https://example.com/unsub/abc");
    expect(d!.text).toContain("https://example.com/dash?slug=t9");
    expect(d!.text).toContain("https://example.com/unsub/abc");
  });
});
