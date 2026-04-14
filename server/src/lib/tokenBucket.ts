/**
 * Simple serial token bucket: each acquire() returns at least `intervalMs`
 * after the previous acquire(). Used to rate-limit outbound Perplexity calls
 * across parallel workers.
 */
export class TokenBucket {
  private readonly intervalMs: number;
  private nextAvailable = 0;

  constructor(opts: { intervalMs: number }) {
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
