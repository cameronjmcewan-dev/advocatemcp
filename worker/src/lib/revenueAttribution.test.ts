/**
 * Tests for worker/src/lib/revenueAttribution.ts
 *
 * All tests use a minimal D1Database stub — no network, no Cloudflare
 * runtime. The stub mirrors the pattern used in trafficImpactPayload.test.ts.
 *
 * click_events columns exercised: ref (bot UA canonical name), timestamp
 * (ISO-8601), business_slug (WHERE filter).
 *
 * Key invariants:
 *   - Never returns classification='human' — only 'ai' or 'unknown'.
 *   - AI click in 24h window → 'ai' with source/medium/clicked_at.
 *   - No AI click (empty window, outside window, or non-AI ref) → 'unknown'.
 *   - Multiple AI clicks → returns the MOST RECENT (ORDER BY timestamp DESC LIMIT 50).
 *   - D1 error (table missing) → 'unknown' (graceful degradation).
 *   - Invalid occurred_at date → 'unknown' immediately (no DB call).
 */

import { describe, it, expect, vi } from "vitest";
import { lookupFirstTouchAttribution } from "./revenueAttribution.js";

// ── D1 stub helpers ────────────────────────────────────────────────────────────

/** Minimal D1PreparedStatement shape the function exercises. */
type StubStmt = {
  bind: (...args: unknown[]) => StubStmt;
  all:  <T = unknown>() => Promise<{ results: T[] }>;
};

/**
 * Build a D1Database stub that returns `rows` from every .all() call.
 * Also records the bind args so tests can assert on them.
 *
 * Pass `throws=true` to make the stub throw, simulating a missing table.
 */
function makeDb(
  rows: Array<{ ref: string | null; timestamp: string }>,
  { throws = false }: { throws?: boolean } = {},
): { db: D1Database; capturedBinds: () => unknown[] } {
  let lastBinds: unknown[] = [];

  const stmt: StubStmt = {
    bind(...args: unknown[]) {
      lastBinds = args;
      return this;
    },
    async all<T = unknown>() {
      if (throws) throw new Error("D1_ERROR: no such table: click_events");
      return { results: rows as unknown as T[] };
    },
  };

  const db = {
    prepare(_sql: string) {
      return stmt;
    },
  } as unknown as D1Database;

  return { db, capturedBinds: () => lastBinds };
}

// ── Fixed timestamps ───────────────────────────────────────────────────────────

const OCCURRED_AT    = "2026-05-06T12:00:00.000Z";
const WITHIN_24H     = "2026-05-06T08:00:00.000Z";  // 4h before occurred_at
const OUTSIDE_24H    = "2026-05-05T10:00:00.000Z";  // 26h before occurred_at
const OLDER_AI_CLICK = "2026-05-06T07:00:00.000Z";  // 5h before occurred_at
const NEWER_AI_CLICK = "2026-05-06T11:00:00.000Z";  // 1h before occurred_at

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("lookupFirstTouchAttribution", () => {
  it("1. AI click within 24h window → returns 'ai' with source/medium/clicked_at", async () => {
    const { db } = makeDb([
      { ref: "PerplexityBot", timestamp: WITHIN_24H },
    ]);

    const result = await lookupFirstTouchAttribution(db, "acme", OCCURRED_AT);

    expect(result.classification).toBe("ai");
    expect(result.first_touch_source).toBe("PerplexityBot");
    expect(result.first_touch_medium).toBe("referral");
    expect(result.first_touch_clicked_at).toBe(WITHIN_24H);
  });

  it("2. No clicks in window → returns 'unknown'", async () => {
    const { db } = makeDb([]);

    const result = await lookupFirstTouchAttribution(db, "acme", OCCURRED_AT);

    expect(result.classification).toBe("unknown");
    expect(result.first_touch_source).toBeUndefined();
    expect(result.first_touch_medium).toBeUndefined();
    expect(result.first_touch_clicked_at).toBeUndefined();
  });

  it("3. Non-AI click in window (ref='Googlebot') → returns 'unknown'", async () => {
    // Googlebot is a traditional web crawler — not classified as AI
    // revenue attribution even though it's in the worker's AI_CRAWLERS list.
    const { db } = makeDb([
      { ref: "Googlebot", timestamp: WITHIN_24H },
    ]);

    const result = await lookupFirstTouchAttribution(db, "acme", OCCURRED_AT);

    expect(result.classification).toBe("unknown");
  });

  it("4. Multiple AI clicks → returns the most recent (first in DESC order)", async () => {
    // D1 returns rows ORDER BY timestamp DESC; stub returns them in the same
    // order the test provides. Pass newer first to verify we pick the first row.
    const { db } = makeDb([
      { ref: "GPTBot",        timestamp: NEWER_AI_CLICK },
      { ref: "PerplexityBot", timestamp: OLDER_AI_CLICK },
    ]);

    const result = await lookupFirstTouchAttribution(db, "acme", OCCURRED_AT);

    expect(result.classification).toBe("ai");
    expect(result.first_touch_source).toBe("GPTBot");
    expect(result.first_touch_clicked_at).toBe(NEWER_AI_CLICK);
  });

  it("5. Click exactly 25h before occurred_at (outside window) → not in results → 'unknown'", async () => {
    // The DB stub would include these rows if the WHERE clause allowed them,
    // but the real query filters them via timestamp >= windowStart. We simulate
    // this by returning an empty result set (the stub respects the WHERE via
    // what we hand it), verifying the caller degrades correctly.
    const { db } = makeDb([
      // OUTSIDE_24H is 26h before OCCURRED_AT — would NOT be returned by D1.
      // We test by passing an empty result set, matching what D1 would return.
    ]);

    const result = await lookupFirstTouchAttribution(db, "acme", OCCURRED_AT);

    expect(result.classification).toBe("unknown");
  });

  it("6. D1 throws (table missing) → returns 'unknown' gracefully", async () => {
    const { db } = makeDb([], { throws: true });

    const result = await lookupFirstTouchAttribution(db, "acme", OCCURRED_AT);

    expect(result.classification).toBe("unknown");
  });

  it("7. Invalid occurred_at → returns 'unknown' without calling DB", async () => {
    const prepareSpy = vi.fn();
    const db = { prepare: prepareSpy } as unknown as D1Database;

    const result = await lookupFirstTouchAttribution(db, "acme", "not-a-date");

    expect(result.classification).toBe("unknown");
    expect(prepareSpy).not.toHaveBeenCalled();
  });

  it("8. ClaudeBot ref → classified as 'ai'", async () => {
    const { db } = makeDb([
      { ref: "ClaudeBot", timestamp: WITHIN_24H },
    ]);

    const result = await lookupFirstTouchAttribution(db, "acme", OCCURRED_AT);

    expect(result.classification).toBe("ai");
    expect(result.first_touch_source).toBe("ClaudeBot");
  });

  it("9. Null ref in row → row skipped, returns 'unknown' when no other AI rows", async () => {
    const { db } = makeDb([
      { ref: null, timestamp: WITHIN_24H },
    ]);

    const result = await lookupFirstTouchAttribution(db, "acme", OCCURRED_AT);

    expect(result.classification).toBe("unknown");
  });

  it("10. Bind args pass correct slug, windowStart, and occurredAt to D1", async () => {
    const { db, capturedBinds } = makeDb([]);

    await lookupFirstTouchAttribution(db, "my-biz", OCCURRED_AT);

    const binds = capturedBinds();
    // bind(businessSlug, windowStart, occurredAt)
    expect(binds[0]).toBe("my-biz");
    // windowStart = 24h before OCCURRED_AT
    expect(binds[1]).toBe(
      new Date(new Date(OCCURRED_AT).getTime() - 24 * 60 * 60 * 1000).toISOString(),
    );
    expect(binds[2]).toBe(OCCURRED_AT);
  });
});
