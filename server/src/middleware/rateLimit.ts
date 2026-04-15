import type { Request, Response, NextFunction } from "express";
import { getDb } from "../db.js";
import { resolveAgentTier, TIER_LIMITS } from "../lib/agentTier.js";
import { AGENT_IDENTITY_HEADER } from "../lib/agentIdentity.js";

/**
 * Public rate-limit constants. The A2A manifest (`server/src/manifest/descriptor.ts`)
 * reads these so published rate_limits stay in lockstep with enforcement.
 */
export const PER_IP_LIMIT_PER_MINUTE = 100;
export const PER_API_KEY_LIMIT_PER_HOUR = 1000;

interface Bucket { count: number; resetAt: number }

const ipBuckets    = new Map<string, Bucket>();
const keyBuckets   = new Map<string, Bucket>();
const agentBuckets = new Map<string, Bucket>();

/**
 * Test-only helper: clear all in-memory rate-limit buckets so tests can
 * exercise tier ceilings from a fresh state without a process restart.
 */
export function _resetRateLimitBuckets(): void {
  ipBuckets.clear();
  keyBuckets.clear();
  agentBuckets.clear();
}

// Prune stale entries every minute to prevent unbounded growth
const _pruneInterval = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of ipBuckets)    if (v.resetAt < now) ipBuckets.delete(k);
  for (const [k, v] of keyBuckets)   if (v.resetAt < now) keyBuckets.delete(k);
  for (const [k, v] of agentBuckets) if (v.resetAt < now) agentBuckets.delete(k);
}, 60_000);
_pruneInterval.unref();

function consume(map: Map<string, Bucket>, key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  let b = map.get(key);
  if (!b || now > b.resetAt) {
    b = { count: 0, resetAt: now + windowMs };
    map.set(key, b);
  }
  b.count++;
  return b.count <= limit;
}

function retryAfter(map: Map<string, Bucket>, key: string): number {
  const b = map.get(key);
  return b ? Math.ceil((b.resetAt - Date.now()) / 1000) : 60;
}

function extractKey(req: Request): string | null {
  const xKey = req.headers["x-api-key"];
  if (typeof xKey === "string" && xKey) return xKey;
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
  return null;
}

function clientIp(req: Request): string {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string") return fwd.split(",")[0].trim();
  return req.socket?.remoteAddress ?? "unknown";
}

/**
 * Global rate limiting:
 *   - Per-agent (when x-agent-identity header is set): tier-resolved ceiling
 *     (unverified=100, known=250, trusted=1000) — keyed on agent_id, not IP
 *   - Per-IP:      100 req / min — backstop for traffic with no agent header
 *   - Per-api-key: 1000 req / hour
 * OPTIONS (CORS preflight) is skipped.
 *
 * Agent path takes precedence: if x-agent-identity is set, the per-IP bucket
 * is bypassed so a 'known' or 'trusted' tier actually gets its uplift.
 * Unverified agents (header set but no reputation row) get the same 100/min
 * ceiling as the IP backstop, just keyed on agent_id instead of IP.
 */
export function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (req.method === "OPTIONS") { next(); return; }

  const headerAgent = req.header(AGENT_IDENTITY_HEADER)?.trim();

  if (headerAgent) {
    // Tier resolution can fail (e.g. DB not initialized in some test paths).
    // On error, fall through to the IP backstop rather than blocking traffic.
    let limit = TIER_LIMITS.unverified;
    try {
      const tier = resolveAgentTier(getDb(), headerAgent);
      limit = TIER_LIMITS[tier];
    } catch {
      /* fall back to unverified ceiling */
    }
    if (!consume(agentBuckets, headerAgent, limit, 60_000)) {
      console.info(`[rate-limit] agent ${headerAgent} exceeded ${limit} req/min`);
      res.setHeader("Retry-After", String(retryAfter(agentBuckets, headerAgent)));
      res.status(429).json({
        error: "Rate limit exceeded — try again shortly",
        retry_after: retryAfter(agentBuckets, headerAgent),
      });
      return;
    }
  } else {
    const ip = clientIp(req);
    if (!consume(ipBuckets, ip, PER_IP_LIMIT_PER_MINUTE, 60_000)) {
      console.info(`[rate-limit] IP ${ip} exceeded ${PER_IP_LIMIT_PER_MINUTE} req/min`);
      res.setHeader("Retry-After", String(retryAfter(ipBuckets, ip)));
      res.status(429).json({ error: "Rate limit exceeded — try again shortly", retry_after: retryAfter(ipBuckets, ip) });
      return;
    }
  }

  const apiKey = extractKey(req);
  if (apiKey) {
    if (!consume(keyBuckets, apiKey, PER_API_KEY_LIMIT_PER_HOUR, 3_600_000)) {
      console.info(`[rate-limit] api_key ${apiKey.slice(0, 8)}… exceeded ${PER_API_KEY_LIMIT_PER_HOUR} req/hour`);
      res.setHeader("Retry-After", String(retryAfter(keyBuckets, apiKey)));
      res.status(429).json({ error: "API key hourly limit exceeded", retry_after: retryAfter(keyBuckets, apiKey) });
      return;
    }
  }

  next();
}
