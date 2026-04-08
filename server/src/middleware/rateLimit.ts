import type { Request, Response, NextFunction } from "express";

interface Bucket { count: number; resetAt: number }

const ipBuckets  = new Map<string, Bucket>();
const keyBuckets = new Map<string, Bucket>();

// Prune stale entries every minute to prevent unbounded growth
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of ipBuckets)  if (v.resetAt < now) ipBuckets.delete(k);
  for (const [k, v] of keyBuckets) if (v.resetAt < now) keyBuckets.delete(k);
}, 60_000);

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
 *   - Per-IP:      100 req / min
 *   - Per-api-key: 1000 req / hour
 * OPTIONS (CORS preflight) is skipped.
 */
export function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (req.method === "OPTIONS") { next(); return; }

  const ip = clientIp(req);

  if (!consume(ipBuckets, ip, 100, 60_000)) {
    console.info(`[rate-limit] IP ${ip} exceeded 100 req/min`);
    res.setHeader("Retry-After", String(retryAfter(ipBuckets, ip)));
    res.status(429).json({ error: "Rate limit exceeded — try again shortly", retry_after: retryAfter(ipBuckets, ip) });
    return;
  }

  const apiKey = extractKey(req);
  if (apiKey) {
    if (!consume(keyBuckets, apiKey, 1000, 3_600_000)) {
      console.info(`[rate-limit] api_key ${apiKey.slice(0, 8)}… exceeded 1000 req/hour`);
      res.setHeader("Retry-After", String(retryAfter(keyBuckets, apiKey)));
      res.status(429).json({ error: "API key hourly limit exceeded", retry_after: retryAfter(keyBuckets, apiKey) });
      return;
    }
  }

  next();
}
