/* Per-key in-memory rate limiter for cost-sensitive endpoints.
 *
 * The Claude-API-spending endpoints (profile-score, format-judge,
 * preview-voice) need protection beyond the worker's per-IP limit
 * because:
 *   - A single legitimate session could spam the button
 *   - An attacker who steals a session token could rack up cost
 *   - Operator runaway scripts could empty the API budget overnight
 *
 * This module provides two limiter classes with different scopes:
 *   - Per-tenant slug: cheap-lookup, persists in memory across
 *     request-handler instances on the same Railway pod.
 *   - Per-admin key (or per-IP fallback): coarse global cap.
 *
 * Limitations of in-memory limits:
 *   - Resets on every Railway redeploy (rare in steady state).
 *   - Doesn't share state across multiple pods (we run a single pod
 *     today; if we go multi-pod, switch to D1 + atomic UPDATE).
 *   - Doesn't survive process restart; for v0 cost protection that's
 *     fine since the limits exist to prevent SPIKE abuse, not
 *     long-tail capping.
 *
 * Returned middleware: Express middleware that checks the limit and
 * either calls next() or responds 429 with a Retry-After header
 * indicating when the next request can proceed. */

import type { Request, Response, NextFunction } from "express";

interface BucketState {
  /** Timestamps of recent allowed requests (ms since epoch). */
  recent: number[];
}

interface LimitConfig {
  /** Max requests in the rolling window. */
  max: number;
  /** Window length in ms. */
  windowMs: number;
}

/* The raw bucket store. Keyed by whatever the caller chose (slug,
 * admin token hash, IP, etc.). New entries created lazily. Periodic
 * cleanup runs on each check to evict empty buckets. */
const buckets = new Map<string, BucketState>();

function check(key: string, cfg: LimitConfig): { allowed: boolean; retryAfterMs: number } {
  const now = Date.now();
  const cutoff = now - cfg.windowMs;
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { recent: [] };
    buckets.set(key, bucket);
  }
  // Drop timestamps outside the window.
  bucket.recent = bucket.recent.filter((t) => t > cutoff);

  if (bucket.recent.length < cfg.max) {
    bucket.recent.push(now);
    return { allowed: true, retryAfterMs: 0 };
  }

  // Limit hit. Retry-after = time until oldest in-window request ages out.
  const oldest = bucket.recent[0];
  const retryAfterMs = Math.max(0, oldest + cfg.windowMs - now);
  return { allowed: false, retryAfterMs };
}

/* Express middleware factory.
 *
 * keyFn extracts a stable key from the request (e.g. slug from
 * params, admin bearer from header). Return null to skip rate
 * limiting for that request (e.g. operator with all-bypass cred).
 *
 * limits is one or more LimitConfig — ALL must pass for the
 * request to proceed. Use multiple to stack a short-window burst
 * cap (1/min) with a long-window total cap (30/day). The caller
 * passes a label per config so the 429 response says which limit
 * tripped. */
export function rateLimit(opts: {
  keyFn: (req: Request) => string | null;
  limits: Array<{ label: string; cfg: LimitConfig }>;
}): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    const baseKey = opts.keyFn(req);
    if (!baseKey) {
      next();
      return;
    }
    for (const limit of opts.limits) {
      const fullKey = `${limit.label}:${baseKey}`;
      const { allowed, retryAfterMs } = check(fullKey, limit.cfg);
      if (!allowed) {
        const retryAfterSec = Math.ceil(retryAfterMs / 1000);
        res.setHeader("Retry-After", String(retryAfterSec));
        res.status(429).json({
          error: "rate_limited",
          message: `Rate limit exceeded (${limit.label}). Try again in ${retryAfterSec}s.`,
          retry_after_seconds: retryAfterSec,
        });
        return;
      }
    }
    next();
  };
}

/* Programmatic limit check — for cases where the rate limit needs
 * to fire AFTER some other condition (e.g. only count cache misses,
 * not cache hits). Returns the same shape as the middleware would
 * produce. Caller is responsible for setting Retry-After + 429 if
 * needed.
 *
 * Each call CONSUMES a slot if all limits pass. If any limit fails,
 * NO slot is consumed (fail-fast — we don't want a hit on the
 * 60-min limit to also tick the day limit). */
export function checkLimit(args: {
  key: string;
  limits: Array<{ label: string; cfg: LimitConfig }>;
}): { allowed: true } | { allowed: false; label: string; retryAfterMs: number } {
  // Probe all limits first WITHOUT consuming. This way a request that
  // would fail on one limit doesn't burn a slot in another's bucket.
  const now = Date.now();
  const probes = args.limits.map((limit) => {
    const fullKey = `${limit.label}:${args.key}`;
    const cfg = limit.cfg;
    const cutoff = now - cfg.windowMs;
    const bucket = buckets.get(fullKey);
    const recent = bucket ? bucket.recent.filter((t) => t > cutoff) : [];
    if (recent.length >= cfg.max) {
      const oldest = recent[0];
      return { failed: true as const, label: limit.label, retryAfterMs: Math.max(0, oldest + cfg.windowMs - now) };
    }
    return { failed: false as const, label: limit.label, fullKey, recent };
  });
  const failed = probes.find((p): p is { failed: true; label: string; retryAfterMs: number } => p.failed);
  if (failed) {
    return { allowed: false, label: failed.label, retryAfterMs: failed.retryAfterMs };
  }
  // All limits pass — consume a slot in each.
  for (const p of probes) {
    if (p.failed) continue;
    const bucket = buckets.get(p.fullKey) ?? { recent: [] as number[] };
    bucket.recent = [...p.recent, now];
    buckets.set(p.fullKey, bucket);
  }
  return { allowed: true };
}

/* Test-only: clear all buckets so vitest doesn't leak state across
 * tests in the same module. Production code should NEVER call this. */
export function _resetBucketsForTesting(): void {
  buckets.clear();
}
