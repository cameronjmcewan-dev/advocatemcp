/**
 * In-memory sliding-window rate limiter for the `/mcp` proxy (Session 3).
 *
 * Why not a Durable Object:
 *   DOs give globally coherent counters across every CF edge but add
 *   migration complexity + higher latency per request. For v1 — before any
 *   MCP directory listing drives traffic — per-isolate limiting is
 *   adequate and ships faster. An attacker hitting N edge locations gets
 *   up to N × LIMIT, but for /mcp at v1 that's still a meaningful ceiling.
 *
 *   Upgrade path: if real traffic volumes justify global coherence, swap
 *   the Map-backed store for a DO-backed one. The `check()` interface stays
 *   identical so call sites don't change.
 *
 * Algorithm: sliding 1-minute window via a per-IP ring buffer of timestamps.
 * On every check, evict entries older than `windowMs` and count what
 * remains. LRU-style bounded storage (MAX_IPS) prevents unbounded growth
 * from abuse patterns that cycle through IPs.
 */

export interface RateLimitDecision {
  allowed:    boolean;
  limit:      number;
  remaining:  number;
  retryAfter: number; // seconds until next allowed request (0 if currently allowed)
}

export interface RateLimitOptions {
  limit?:    number;   // requests per window (default 60)
  windowMs?: number;   // window size in milliseconds (default 60_000)
  maxIps?:   number;   // LRU cap — number of distinct IPs tracked (default 10_000)
}

const DEFAULT_LIMIT      = 60;
const DEFAULT_WINDOW_MS  = 60_000;
const DEFAULT_MAX_IPS    = 10_000;

export class McpRateLimiter {
  private readonly limit:     number;
  private readonly windowMs:  number;
  private readonly maxIps:    number;
  // Map insertion order is iteration order, so on eviction we drop the
  // least-recently-inserted entry. We `set` after `delete` on every hit to
  // move an IP to the end of the iteration order — cheap LRU.
  private readonly hits: Map<string, number[]> = new Map();

  constructor(opts: RateLimitOptions = {}) {
    this.limit    = opts.limit    ?? DEFAULT_LIMIT;
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.maxIps   = opts.maxIps   ?? DEFAULT_MAX_IPS;
  }

  /**
   * Record a request from `ip` and decide whether to allow it. `now` is
   * injectable so tests can simulate time without sleeping.
   */
  check(ip: string, now: number = Date.now()): RateLimitDecision {
    if (!ip) {
      // A request without an IP can't be rate-limited per-client. Allow
      // but don't count — surfacing this as a remaining=0 decision would
      // mislead callers into thinking the limiter did something.
      return { allowed: true, limit: this.limit, remaining: this.limit, retryAfter: 0 };
    }

    const cutoff = now - this.windowMs;
    const prev = this.hits.get(ip);
    // Filter out timestamps older than the window.
    const recent = prev ? prev.filter((t) => t > cutoff) : [];

    if (recent.length >= this.limit) {
      // Rebuild the entry without adding this request so we don't drift
      // past the cap via repeated denials.
      this.hits.delete(ip);
      this.hits.set(ip, recent);
      const oldest = recent[0]!;
      const retryAfter = Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000));
      return { allowed: false, limit: this.limit, remaining: 0, retryAfter };
    }

    recent.push(now);
    // LRU touch: delete then set moves this IP to the tail of insertion order.
    this.hits.delete(ip);
    this.hits.set(ip, recent);

    // Evict the least-recently-touched IP if we've grown past the cap.
    if (this.hits.size > this.maxIps) {
      const first = this.hits.keys().next().value;
      if (first !== undefined) this.hits.delete(first);
    }

    return {
      allowed:    true,
      limit:      this.limit,
      remaining:  this.limit - recent.length,
      retryAfter: 0,
    };
  }

  /** Test-only: drop all tracked IPs. */
  _resetForTests(): void {
    this.hits.clear();
  }

  /** Test-only: current number of tracked IPs. */
  _sizeForTests(): number {
    return this.hits.size;
  }
}

/**
 * Module-level singleton so every request through the Worker isolate shares
 * the same counters. Export a factory too, so callers who want a dedicated
 * limiter (e.g. tests, or a hypothetical second-endpoint use) can create one.
 */
export const mcpRateLimiter = new McpRateLimiter();
