/**
 * Simple serial token bucket: each acquire() returns at least `intervalMs`
 * after the previous acquire(). Used to rate-limit outbound Perplexity calls
 * across concurrent promises in a single Node.js event loop.
 *
 * Single-process, single-event-loop only — not safe across worker_threads
 * or child processes. If we ever scale the cron across workers, replace
 * with a Redis-backed rate limiter.
 */
export class TokenBucket {
  private readonly intervalMs: number;
  private nextAvailable = 0;

  constructor(opts: { intervalMs: number }) {
    if (opts.intervalMs <= 0) {
      throw new RangeError(`intervalMs must be positive, got ${opts.intervalMs}`);
    }
    this.intervalMs = opts.intervalMs;
  }

  async acquire(): Promise<void> {
    const now  = Date.now();
    const slot = Math.max(now, this.nextAvailable);
    this.nextAvailable = slot + this.intervalMs;
    const waitMs = slot - now;
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
  }
}
