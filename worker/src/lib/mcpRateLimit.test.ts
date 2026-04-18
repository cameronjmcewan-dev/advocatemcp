import { describe, it, expect, beforeEach } from "vitest";
import { McpRateLimiter } from "./mcpRateLimit.js";

describe("McpRateLimiter", () => {
  let limiter: McpRateLimiter;
  beforeEach(() => { limiter = new McpRateLimiter({ limit: 3, windowMs: 60_000, maxIps: 5 }); });

  it("allows requests up to the limit", () => {
    const now = 1_000_000;
    expect(limiter.check("1.2.3.4", now).allowed).toBe(true);
    expect(limiter.check("1.2.3.4", now + 100).allowed).toBe(true);
    expect(limiter.check("1.2.3.4", now + 200).allowed).toBe(true);
  });

  it("denies the Nth+1 request within the window", () => {
    const now = 1_000_000;
    limiter.check("1.2.3.4", now);
    limiter.check("1.2.3.4", now + 100);
    limiter.check("1.2.3.4", now + 200);
    const denial = limiter.check("1.2.3.4", now + 300);
    expect(denial.allowed).toBe(false);
    expect(denial.remaining).toBe(0);
    expect(denial.retryAfter).toBeGreaterThanOrEqual(1);
  });

  it("allows the Nth+1 request once the window has slid past the oldest", () => {
    const now = 1_000_000;
    limiter.check("1.2.3.4", now);          // t=0
    limiter.check("1.2.3.4", now + 100);    // t=0.1s
    limiter.check("1.2.3.4", now + 200);    // t=0.2s
    // At t=60.1s entries at t=0 and t=100ms have aged past the 60s window
    // (strict >cutoff). Only t=200ms survives + the new hit → 2 in window,
    // 1 remaining under the limit of 3.
    const after = limiter.check("1.2.3.4", now + 60_100);
    expect(after.allowed).toBe(true);
    expect(after.remaining).toBe(1);
  });

  it("retryAfter counts down as the oldest entry ages out", () => {
    const now = 1_000_000;
    limiter.check("1.2.3.4", now);
    limiter.check("1.2.3.4", now + 100);
    limiter.check("1.2.3.4", now + 200);
    const earlyDenial = limiter.check("1.2.3.4", now + 300);
    const lateDenial  = limiter.check("1.2.3.4", now + 30_000);
    expect(earlyDenial.retryAfter).toBeGreaterThan(lateDenial.retryAfter);
  });

  it("tracks different IPs independently", () => {
    const now = 1_000_000;
    limiter.check("1.2.3.4", now);
    limiter.check("1.2.3.4", now + 1);
    limiter.check("1.2.3.4", now + 2);
    expect(limiter.check("1.2.3.4", now + 3).allowed).toBe(false);
    expect(limiter.check("5.6.7.8", now + 4).allowed).toBe(true);
  });

  it("allows but does not count requests with no IP", () => {
    expect(limiter.check("", 1).allowed).toBe(true);
    expect(limiter._sizeForTests()).toBe(0);
  });

  it("caps the tracked-IP table at maxIps via LRU eviction", () => {
    const now = 1_000_000;
    for (let i = 0; i < 5; i++) limiter.check(`ip-${i}`, now + i);
    expect(limiter._sizeForTests()).toBe(5);
    // 6th distinct IP → should evict ip-0 (least recently touched).
    limiter.check("ip-5", now + 5);
    expect(limiter._sizeForTests()).toBe(5);
    // ip-0 gets a fresh allowance because it was evicted.
    const afterEvict = limiter.check("ip-0", now + 6);
    expect(afterEvict.allowed).toBe(true);
    expect(afterEvict.remaining).toBe(2);  // freshly reset → this is the 1st hit
  });

  it("LRU touches on every check so heavy-use IPs don't get evicted", () => {
    const now = 1_000_000;
    // Fill to capacity with ip-0..ip-4.
    for (let i = 0; i < 5; i++) limiter.check(`ip-${i}`, now + i);
    // Touch ip-0 to move it to the tail of the LRU order.
    limiter.check("ip-0", now + 10);
    // Add ip-5 — ip-1 should evict (next oldest after ip-0's touch).
    limiter.check("ip-5", now + 11);
    // ip-0 should still be tracked (not evicted).
    expect(limiter.check("ip-0", now + 12).remaining).toBe(0); // 3 hits @ now+0, now+10, now+12 → limit=3 reached
  });

  it("reports the correct remaining count on each allowed hit", () => {
    const now = 1_000_000;
    expect(limiter.check("x", now).remaining).toBe(2);
    expect(limiter.check("x", now + 1).remaining).toBe(1);
    expect(limiter.check("x", now + 2).remaining).toBe(0);
  });
});
