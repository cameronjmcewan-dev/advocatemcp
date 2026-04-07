import { Router } from "express";
import type { Request, Response } from "express";
import { getDb } from "../db.js";
import crypto from "crypto";

export const registerRouter = Router();

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-{2,}/g, "-")
    .slice(0, 60);
}

/**
 * POST /register
 *
 * Onboard a new business. Auto-generates a slug and API key.
 * Returns the slug, API key, and all endpoint URLs.
 */
registerRouter.post("/register", (req: Request, res: Response) => {
  const {
    name,
    description,
    services,
    pricing,
    location,
    phone,
    website,
    referral_url,
    tone,
  } = req.body as Record<string, unknown>;

  // Validate required fields
  if (!name || typeof name !== "string") {
    res.status(400).json({ error: "Missing required field: name (string)" });
    return;
  }
  if (!description || typeof description !== "string") {
    res.status(400).json({ error: "Missing required field: description (string)" });
    return;
  }
  if (!services) {
    res.status(400).json({
      error: "Missing required field: services (string[] or string)",
    });
    return;
  }

  const db = getDb();

  // Generate a unique slug (append -1, -2, … on collision)
  const baseSlug = slugify(name);
  let slug = baseSlug;
  let attempt = 0;
  while (db.prepare("SELECT id FROM businesses WHERE slug = ?").get(slug)) {
    attempt++;
    slug = `${baseSlug}-${attempt}`;
  }

  const apiKey = crypto.randomUUID();
  const servicesJson = Array.isArray(services)
    ? JSON.stringify(services)
    : JSON.stringify([String(services)]);

  try {
    db.prepare(
      `INSERT INTO businesses
         (slug, name, description, services, pricing, location, phone, website, referral_url, tone, api_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      slug,
      name,
      description,
      servicesJson,
      typeof pricing === "string" ? pricing : null,
      typeof location === "string" ? location : null,
      typeof phone === "string" ? phone : null,
      typeof website === "string" ? website : null,
      typeof referral_url === "string"
        ? referral_url
        : typeof website === "string"
          ? website
          : null,
      typeof tone === "string" ? tone : "friendly",
      apiKey
    );

    const base = process.env.API_BASE_URL ?? "https://api.advocatemcp.com";

    res.status(201).json({
      slug,
      api_key: apiKey,
      agent_endpoint: `${base}/agents/${slug}/query`,
      mcp_endpoint: `${base}/mcp`,
      wellknown_url: `https://<your-domain>/.well-known/ai-agent.json`,
      instructions: {
        query_agent: `POST ${base}/agents/${slug}/query\n  Body: { "query": "...", "crawler": "YourBotName" }`,
        view_analytics: `GET ${base}/analytics/${slug}\n  Header: Authorization: Bearer ${apiKey}`,
        connect_mcp: `Add ${base}/mcp to your MCP client (Claude Desktop, Cursor, etc.)`,
        install_worker: `Deploy the Cloudflare Worker and add "${slug}" to your BUSINESS_MAP KV store with your domain as the key`,
      },
    });
  } catch (err) {
    console.error("[register] Error:", err);
    res.status(500).json({
      error: "Registration failed",
      message: err instanceof Error ? err.message : "Unknown error",
    });
  }
});
