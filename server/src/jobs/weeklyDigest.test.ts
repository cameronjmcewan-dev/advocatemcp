import fs from "fs";
import os from "os";
import path from "path";
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

describe("sendAllDigests", () => {
  const tmp = path.join(os.tmpdir(), `p5-cron-${Date.now()}.db`);

  beforeEach(async () => {
    process.env.DATABASE_PATH = tmp;
    process.env.RESEND_API_KEY = "re_test";
    process.env.TOKEN_SIGNING_KEY = "test-signing-key";
    const { _resetDbForTests } = await import("../db.js");
    _resetDbForTests();
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(tmp + suffix, { force: true });
    const { getDb } = await import("../db.js");
    getDb();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(tmp + suffix, { force: true });
    delete process.env.DATABASE_PATH;
    delete process.env.RESEND_API_KEY;
    delete process.env.TOKEN_SIGNING_KEY;
    vi.restoreAllMocks();
  });

  async function seed(slug: string, overrides: Partial<{ plan: string; email: string | null; unsub: number }> = {}): Promise<void> {
    const { getDb } = await import("../db.js");
    const db = getDb();
    const t = { plan: "pro", email: `${slug}@example.com`, unsub: 0, ...overrides };
    db.prepare(`INSERT INTO businesses
      (slug, name, description, services, api_key, category, location, website,
       star_rating, review_count, plan, email, digest_unsubscribed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        slug, `${slug} LLC`, "d", "[]", `key-${slug}`, "plumber", "Boise, ID",
        `https://${slug}.example`, 4.5, 10, t.plan, t.email, t.unsub,
      );
    const basketId = Number(db.prepare(`INSERT INTO competitor_query_baskets
      (slug, query, source, enabled, created_at) VALUES (?, ?, 'auto', 1, datetime('now'))`).run(slug, "q").lastInsertRowid);
    db.prepare(`INSERT INTO competitor_polls
      (slug, query_basket_id, bot, phrasing, phrasing_variant, polled_at,
       our_domain_cited, our_cited_rank, citation_count, cost_usd)
      VALUES (?, ?, 'perplexity', 'q', 0, datetime('now'), 1, 2, 3, 0.005)`).run(slug, basketId);
  }

  it("sends a digest for each eligible Pro tenant and records sent_at + resend_id", async () => {
    await seed("t1");
    await seed("t2");
    const resend = await import("../lib/resend.js");
    vi.spyOn(resend, "sendEmail")
      .mockResolvedValueOnce({ id: "msg_t1" })
      .mockResolvedValueOnce({ id: "msg_t2" });

    const { sendAllDigests } = await import("./weeklyDigest.js");
    const stats = await sendAllDigests(new Date("2026-04-20T14:00:00.000Z"));

    expect(stats).toEqual({ considered: 2, sent: 2, skipped: 0, errors: 0 });

    const { getDb } = await import("../db.js");
    const rows = getDb().prepare("SELECT slug, resend_id, sent_at, error FROM radar_digests ORDER BY slug").all() as Array<{ slug: string; resend_id: string | null; sent_at: string | null; error: string | null }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ slug: "t1", resend_id: "msg_t1", error: null });
    expect(rows[1]).toMatchObject({ slug: "t2", resend_id: "msg_t2", error: null });
    expect(rows[0]!.sent_at).not.toBeNull();
  });

  it("skips tenants that are unsubscribed, base-plan, or have no email", async () => {
    await seed("pro-ok");
    await seed("pro-unsub", { unsub: 1 });
    await seed("pro-no-email", { email: null });
    await seed("base-ok", { plan: "base" });
    const resend = await import("../lib/resend.js");
    const sendSpy = vi.spyOn(resend, "sendEmail").mockResolvedValue({ id: "msg_ok" });

    const { sendAllDigests } = await import("./weeklyDigest.js");
    const stats = await sendAllDigests();
    // base-ok is filtered at the SQL layer (WHERE plan='pro'), so it doesn't
    // count toward `considered`. The three Pro tenants break down:
    // pro-ok → sent; pro-unsub + pro-no-email → skipped.
    expect(stats.considered).toBe(3);
    expect(stats.sent).toBe(1);
    expect(stats.skipped).toBe(2);
    expect(sendSpy).toHaveBeenCalledOnce();
    expect(sendSpy.mock.calls[0]![0].to).toBe("pro-ok@example.com");
  });

  it("skips tenants with no polls in the window (stats.skipped, no Resend call)", async () => {
    const { getDb } = await import("../db.js");
    getDb().prepare(`INSERT INTO businesses
      (slug, name, description, services, api_key, category, location, website,
       star_rating, review_count, plan, email, digest_unsubscribed)
      VALUES ('lurker', 'Lurker', 'd', '[]', 'k-lurker', 'plumber', 'Boise, ID',
              'https://lurker.example', 4.5, 10, 'pro', 'lurker@example.com', 0)`).run();
    const resend = await import("../lib/resend.js");
    const sendSpy = vi.spyOn(resend, "sendEmail").mockResolvedValue({ id: "msg_x" });

    const { sendAllDigests } = await import("./weeklyDigest.js");
    const stats = await sendAllDigests();
    expect(stats).toEqual({ considered: 1, sent: 0, skipped: 1, errors: 0 });
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("is idempotent within a UTC day — second run skips already-sent tenants", async () => {
    await seed("t1");
    const resend = await import("../lib/resend.js");
    vi.spyOn(resend, "sendEmail").mockResolvedValue({ id: "msg_1" });

    const { sendAllDigests } = await import("./weeklyDigest.js");
    const day = new Date("2026-04-20T14:00:00.000Z");
    const first  = await sendAllDigests(day);
    const second = await sendAllDigests(day);
    expect(first.sent).toBe(1);
    expect(second.sent).toBe(0);
    expect(second.skipped).toBe(1);

    const { getDb } = await import("../db.js");
    const rows = getDb().prepare("SELECT COUNT(*) AS c FROM radar_digests WHERE slug='t1'").get() as { c: number };
    expect(rows.c).toBe(1);
  });

  it("records Resend errors on the row but does not stop the batch", async () => {
    await seed("good");
    await seed("bad");
    const resend = await import("../lib/resend.js");
    const firstCall = { done: false };
    vi.spyOn(resend, "sendEmail").mockImplementation(async (input) => {
      if (input.to === "bad@example.com") throw new Error("resend 422: invalid_from");
      firstCall.done = true;
      return { id: "msg_good" };
    });

    const { sendAllDigests } = await import("./weeklyDigest.js");
    const stats = await sendAllDigests(new Date("2026-04-20T14:00:00.000Z"));
    expect(stats.sent).toBe(1);
    expect(stats.errors).toBe(1);

    const { getDb } = await import("../db.js");
    const bad = getDb().prepare("SELECT sent_at, error FROM radar_digests WHERE slug='bad'").get() as { sent_at: string | null; error: string | null };
    expect(bad.sent_at).toBeNull();
    expect(bad.error).toContain("resend 422");
    const good = getDb().prepare("SELECT sent_at, error FROM radar_digests WHERE slug='good'").get() as { sent_at: string | null; error: string | null };
    expect(good.sent_at).not.toBeNull();
    expect(good.error).toBeNull();
  });

  it("passes a signed unsubscribe URL through to the Resend body", async () => {
    await seed("signed");
    const resend = await import("../lib/resend.js");
    const sendSpy = vi.spyOn(resend, "sendEmail").mockResolvedValue({ id: "msg_s" });

    const { sendAllDigests } = await import("./weeklyDigest.js");
    await sendAllDigests();
    const call = sendSpy.mock.calls[0]![0];
    expect(call.html).toMatch(/\/digest\/unsubscribe\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
  });
});
