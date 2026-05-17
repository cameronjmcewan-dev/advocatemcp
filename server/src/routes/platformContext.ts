/**
 * Per-platform context routes (Phase 2 of grey-hat AI optimization layer).
 *
 *   GET /agents/:slug/context/:platform
 *
 * Returns the same per-bot HTML the regular /agents/:slug/query handler
 * would emit, but FORCED to the named platform's renderer regardless of
 * the request's User-Agent. The worker proxies these through from
 * /<platform>-context paths on every customer host (and advocatemcp.com)
 * so AI crawlers can discover their own format directly via
 * `<link rel="alternate">` hints we emit on the default page.
 *
 * Public — no auth. Same posture as /agents/:slug/profile (also public).
 * Each request runs an agent query against a synthetic "tell me about X"
 * baseline query so the page has a real AI-generated body. Cached at
 * the worker (TTL 600s, key = host + path + profile_version) so the
 * Anthropic call only fires once per (slug × platform) per cache window.
 *
 * Apr 28 2026.
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { getDb } from "../db.js";
import type { BusinessRow } from "../db.js";
import { queryAgent } from "../agent/query.js";
import { renderForBot } from "../agent/renderers/dispatcher.js";

export const platformContextRouter = Router();

// Map URL platform slugs to the canonical bot names the dispatcher uses.
// Names must match BOT_RENDERER_MAP keys in
// server/src/agent/renderers/dispatcher.ts — keep in lockstep.
const PLATFORM_TO_BOT: Record<string, string> = {
  claude:     "ClaudeBot",
  perplexity: "PerplexityBot",
  openai:     "GPTBot",
  google:     "Googlebot",
};

// Synthetic query text used when the platform-context URL is hit. The
// renderer's FAQPage + ProfessionalService JSON-LD do the heavy lifting;
// the body answer is supplemental. Phrased to match the most-common AI
// prompt class for this category of query.
function syntheticQueryFor(business: BusinessRow): string {
  return `What does ${business.name} do, and is it a good fit for my needs?`;
}

platformContextRouter.get("/agents/:slug/context/:platform", async (req: Request, res: Response) => {
  const { slug, platform } = req.params;

  const botType = PLATFORM_TO_BOT[platform.toLowerCase()];
  if (!botType) {
    res.status(404).json({
      error:    "unknown_platform",
      platform,
      supported: Object.keys(PLATFORM_TO_BOT),
    });
    return;
  }

  const db = getDb();
  const business = db
    .prepare("SELECT * FROM businesses WHERE slug = ? LIMIT 1")
    .get(slug) as BusinessRow | undefined;
  if (!business) {
    res.status(404).json({ error: "business_not_found", slug });
    return;
  }

  // Feature flag — keeps the route 404'd until Phase 2 is rolled out
  // across the platform. Same gate pattern as FEATURE_FAQS_V2 in Phase 1.
  const flag = (process.env.FEATURE_PLATFORM_VARIANTS ?? "").toLowerCase();
  if (flag !== "true" && flag !== "1") {
    res.status(404).json({ error: "feature_disabled", flag: "FEATURE_PLATFORM_VARIANTS" });
    return;
  }

  try {
    const query = syntheticQueryFor(business);
    const result = await queryAgent(business, query, botType);
    const { html, renderer_id } = renderForBot({
      business,
      result,
      query,
      botType,
    });

    res.setHeader("Content-Type",       "text/html; charset=utf-8");
    res.setHeader("X-Renderer-Variant", renderer_id);
    res.setHeader("X-Forced-Bot",       botType);
    // Mirror the same Cache-Control as the worker — public, 5-min cache.
    // Worker caches at the edge; this header is a hint to other proxies.
    res.setHeader("Cache-Control",      "public, max-age=300");
    res.send(html);
  } catch (err) {
    console.error(`[platform-context] ${slug}/${platform}:`, err);
    res.status(500).json({
      error:   "render_failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
});
