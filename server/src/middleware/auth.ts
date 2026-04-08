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
