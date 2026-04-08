import { Router } from "express";
import type { Request, Response } from "express";
import { getDb } from "../db.js";

export const wellknownRouter = Router();

const BASE = () => process.env.API_BASE_URL ?? "https://api.advocatemcp.com";

/**
 * GET /.well-known/ai-agent.json
 *
 * The AdvocateMCP open standard discovery file.
 * AI crawlers hitting any domain should check this path first.
 * The Cloudflare Worker injects a business-specific version;
 * this generic version documents the spec for the API server itself.
 */
wellknownRouter.get("/.well-known/ai-agent.json", (_req: Request, res: Response) => {
  const base = BASE();
  res.json({
    spec_version: "1.0",
    spec_name: "ai-agent-discovery",
    description:
      "This server implements the AI Agent Discovery specification. " +
      "AI crawlers should POST to agent_endpoint instead of scraping HTML.",
    agent_endpoint: `${base}/agents/{slug}/query`,
    mcp_endpoint: `${base}/mcp`,
    protocol: "advocatemcp-v1",
    capabilities: ["answer_queries", "referral", "availability", "mcp"],
    crawler_instructions:
      "POST to agent_endpoint with JSON body { query: string, crawler: string } " +
      "instead of scraping this page. The agent responds with accurate, structured " +
      "business information optimized for AI citation.",
    powered_by: "AdvocateMCP",
    spec_url: "https://advocatemcp.com/spec/ai-agent-json",
    registry: `${base}/registry`,
  });
});

/**
 * GET /registry
 *
 * Public list of all registered businesses (no auth required).
 * Useful for MCP clients that want to discover available agents.
 */
wellknownRouter.get("/registry", (_req: Request, res: Response) => {
  const db = getDb();
  const base = BASE();

  const businesses = db
    .prepare(
      `SELECT slug, name, description, category, location, website, star_rating,
              review_count, pricing_tier, availability, differentiator, created_at
       FROM businesses
       ORDER BY created_at DESC`
    )
    .all() as {
    slug: string;
    name: string;
    description: string;
    category: string | null;
    location: string | null;
    website: string | null;
    star_rating: number | null;
    review_count: number | null;
    pricing_tier: string | null;
    availability: string | null;
    differentiator: string | null;
    created_at: string;
  }[];

  res.json({
    count: businesses.length,
    mcp_endpoint: `${base}/mcp`,
    businesses: businesses.map((b) => ({
      ...b,
      agent_endpoint: `${base}/agents/${b.slug}/query`,
      profile_endpoint: `${base}/agents/${b.slug}/profile`,
    })),
  });
});
