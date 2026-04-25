import type { Request, Response, NextFunction } from "express";
import { getDb, type BusinessRow } from "../db.js";

// ── requireApiKey ───────────────────────────────────────────────────────────
// Accepts EITHER:
//   X-API-Key: <SERVER_API_KEY>           (Worker / server-to-server calls)
//   Authorization: Bearer <business_key>  (business owners / direct API calls)
//
// SERVER_API_KEY = process.env.API_KEY (set via Railway env var + wrangler secret)
// business_key  = any valid api_key in the businesses table

function extractKey(req: Request): string | null {
  const xKey = req.headers["x-api-key"];
  if (typeof xKey === "string" && xKey) return xKey;
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
  return null;
}

export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const key = extractKey(req);
  if (!key) {
    console.warn(`[auth] missing api_key — ${req.method} ${req.path} from ${req.headers["x-forwarded-for"] ?? req.socket?.remoteAddress}`);
    res.status(401).json({ error: "Invalid or missing api_key" });
    return;
  }

  // 1. Server-level key (used by Cloudflare Worker, CI, admin tools)
  const serverKey = process.env.API_KEY;
  if (serverKey && key === serverKey) { next(); return; }

  // 2. Any valid business api_key in the DB
  const db = getDb();
  const row = db.prepare("SELECT id FROM businesses WHERE api_key = ? LIMIT 1").get(key);
  if (row) { next(); return; }

  console.warn(`[auth] invalid api_key ${key.slice(0, 8)}… — ${req.method} ${req.path}`);
  res.status(401).json({ error: "Invalid or missing api_key" });
}

// Augment Express request so downstream handlers can access the resolved business
declare global {
  namespace Express {
    interface Request {
      business?: BusinessRow;
    }
  }
}

/**
 * Validates that the `Authorization: Bearer <api_key>` header belongs to
 * the business identified by `:slug` in the route params.
 * Attaches the business row to `req.business` on success.
 */
export function requireSlugApiKey(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers.authorization;
  const { slug } = req.params;

  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({
      error: "Missing Authorization header",
      hint: "Use: Authorization: Bearer <your_api_key>",
    });
    return;
  }

  const apiKey = authHeader.slice(7).trim();

  const db = getDb();
  const business = db
    .prepare("SELECT * FROM businesses WHERE slug = ? AND api_key = ?")
    .get(slug, apiKey) as BusinessRow | undefined;

  if (!business) {
    res.status(401).json({ error: "Invalid API key for this business" });
    return;
  }

  req.business = business;
  next();
}

/**
 * Strict server-only gate. Accepts ONLY the server admin key
 * (X-API-Key: <API_KEY>). Does NOT accept tenant Bearer keys.
 *
 * Used to lock down cost-sensitive endpoints (profile-score,
 * format-judge) so they can ONLY be reached via the Worker proxy
 * (which holds the secret). Direct Railway access with a leaked
 * tenant api_key is rejected — even though that tenant could call
 * cheap reads, they can't trigger paid Claude runs without going
 * through the Worker.
 *
 * Why this matters: tenant api_keys are visible in the dashboard
 * and could be screenshared, screenshot, or exfiltrated. A leaked
 * tenant key should not let an attacker spam expensive endpoints
 * by hitting Railway's public URL directly. The Worker is the
 * front door; SERVER_API_KEY is its key.
 *
 * The customer's path is unchanged: their session → Worker proxy
 * → Worker injects X-API-Key: SERVER_API_KEY → Railway accepts.
 * Direct curl-with-leaked-Bearer-token paths now get 401.
 */
export function requireServerKeyOnly(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const xKey = req.headers["x-api-key"];
  const serverKey = process.env.API_KEY;
  if (!serverKey) {
    // If SERVER_API_KEY isn't configured, fail closed. We'd rather
    // 503 than accept everything.
    res.status(503).json({ error: "server_misconfigured", message: "API_KEY not configured" });
    return;
  }
  if (typeof xKey === "string" && xKey === serverKey) {
    next();
    return;
  }
  console.warn(`[auth] requireServerKeyOnly rejected ${req.method} ${req.path} from ${req.headers["x-forwarded-for"] ?? req.socket?.remoteAddress}`);
  res.status(401).json({
    error: "server_key_required",
    message: "This endpoint can only be reached via the Worker proxy.",
  });
}

/**
 * Accept EITHER the server admin key (X-API-Key: <API_KEY>) OR a slug-bound
 * business key (Authorization: Bearer <business_api_key> matching :slug).
 *
 * Use for per-tenant read endpoints where admin tools and tenant portals
 * both need access but business keys must be scoped to their own slug.
 */
export function requireSlugOrAdminKey(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // 1. Server admin key fast-path
  const xKey = req.headers["x-api-key"];
  const serverKey = process.env.API_KEY;
  if (typeof xKey === "string" && serverKey && xKey === serverKey) {
    next();
    return;
  }

  // 2. Slug-bound business key
  const authHeader = req.headers.authorization;
  const { slug } = req.params;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Invalid or missing api_key" });
    return;
  }
  const apiKey = authHeader.slice(7).trim();
  const db = getDb();
  const row = db
    .prepare("SELECT id FROM businesses WHERE slug = ? AND api_key = ?")
    .get(slug, apiKey);
  if (!row) {
    res.status(401).json({ error: "Invalid api_key for this business" });
    return;
  }
  next();
}
