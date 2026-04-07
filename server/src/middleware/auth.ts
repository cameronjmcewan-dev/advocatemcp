import type { Request, Response, NextFunction } from "express";
import { getDb, type BusinessRow } from "../db.js";

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
