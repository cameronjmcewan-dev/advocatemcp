import { Router } from "express";
import type { Request, Response } from "express";
import { getDb, type BusinessRow } from "../db.js";
import { queryAgent } from "../agent/query.js";

export const agentRouter = Router();

/**
 * POST /agents/:slug/query
 *
 * Body: { query: string, crawler?: string }
 *
 * Looks up the business, calls Claude with the business system prompt,
 * logs the exchange, and returns a structured response.
 */
agentRouter.post("/agents/:slug/query", async (req: Request, res: Response) => {
  const { slug } = req.params;
  const { query, crawler } = req.body as {
    query?: string;
    crawler?: string;
  };

  if (!query || typeof query !== "string" || !query.trim()) {
    res.status(400).json({
      error: "Missing required field: query",
      required: { query: "string", crawler: "string (optional)" },
    });
    return;
  }

  const db = getDb();
  const business = db
    .prepare("SELECT * FROM businesses WHERE slug = ?")
    .get(slug) as BusinessRow | undefined;

  if (!business) {
    res.status(404).json({
      error: `No business registered with slug: ${slug}`,
      hint: "Register a business first at POST /register",
    });
    return;
  }

  try {
    const result = await queryAgent(business, query.trim(), crawler);
    res.json(result);
  } catch (err) {
    console.error(`[agent] Error querying ${slug}:`, err);
    res.status(500).json({
      error: "Agent query failed",
      message: err instanceof Error ? err.message : "Unknown error",
    });
  }
});
