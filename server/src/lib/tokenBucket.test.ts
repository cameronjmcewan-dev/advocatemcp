import { describe, it, expect } from "vitest";
import { TokenBucket } from "./tokenBucket.js";

describe("TokenBucket", () => {
  it("allows the first call immediately", async () => {
    const bucket = new TokenBucket({ intervalMs: 1000 });
    const t0 = Date.now();
    await bucket.acquire();
    expect(Date.now() - t0).toBeLessThan(50);
  });

  it("delays the Nth call by (N-1) * intervalMs", async () => {
    const bucket = new TokenBucket({ intervalMs: 100 });
    const t0 = Date.now();
    await Promise.all([bucket.acquire(), bucket.acquire(), bucket.acquire()]);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(elapsed).toBeLessThan(400);
  });

  it("throws RangeError on non-positive intervalMs", () => {
    expect(() => new TokenBucket({ intervalMs: 0 })).toThrow(RangeError);
    expect(() => new TokenBucket({ intervalMs: -5 })).toThrow(/positive/);
  });
});
