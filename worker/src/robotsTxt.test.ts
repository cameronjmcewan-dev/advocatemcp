/**
 * Tests for buildRobotsResponse — per-host /robots.txt route handler.
 *
 * AI search crawlers fetch /robots.txt before deciding what to crawl. Custom-
 * hostname tenants had no Worker route serving it, so they 404'd — observed
 * May 21 2026 in Cloudflare's AI Crawl Control panel as Claude-SearchBot 4
 * unsuccessful hits to www.workmancopyco.com/sitemap.xml (sitemap fetch
 * preceded by a robots.txt 404 that aborted discovery).
 *
 * Helper is pure (host -> Response); no env, no KV, no profile fan-out.
 * These tests pin the contract: status, headers, body invariants, and
 * that the sitemap pointer uses the request host (not a hardcoded one).
 */

import { describe, it, expect } from "vitest";
import { buildRobotsResponse } from "./index";

async function bodyOf(res: Response): Promise<string> {
  return res.text();
}

describe("buildRobotsResponse — per-host /robots.txt", () => {
  it("returns 200", () => {
    const res = buildRobotsResponse("www.workmancopyco.com");
    expect(res.status).toBe(200);
  });

  it("sets Content-Type: text/plain; charset=utf-8", () => {
    const res = buildRobotsResponse("www.workmancopyco.com");
    expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
  });

  it("sets cache + CORS + X-Powered-By headers matching the existing discovery handlers", () => {
    const res = buildRobotsResponse("www.workmancopyco.com");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("X-Powered-By")).toBe("AdvocateMCP");
  });

  it("includes the universal User-agent + Allow directives", async () => {
    const res = buildRobotsResponse("www.workmancopyco.com");
    const body = await bodyOf(res);
    expect(body).toContain("User-agent: *");
    expect(body).toContain("Allow: /");
  });

  it("points to the per-host sitemap URL", async () => {
    const res = buildRobotsResponse("www.workmancopyco.com");
    const body = await bodyOf(res);
    expect(body).toContain("Sitemap: https://www.workmancopyco.com/sitemap.xml");
  });

  it("uses the given host (not a hardcoded one) in the sitemap pointer", async () => {
    const res = buildRobotsResponse("acme.hosted.advocatemcp.com");
    const body = await bodyOf(res);
    expect(body).toContain("Sitemap: https://acme.hosted.advocatemcp.com/sitemap.xml");
    expect(body).not.toContain("workmancopyco");
  });

  it("does NOT carry per-path Disallow rules — AI crawlers welcome", async () => {
    // The whole point: customers selling AI search visibility shouldn't ship
    // a robots.txt that locks out the crawlers they're paying to be cited by.
    // If a future edit introduces Disallow rules here, that's a regression.
    const res = buildRobotsResponse("www.workmancopyco.com");
    const body = await bodyOf(res);
    expect(body).not.toMatch(/^\s*Disallow:/m);
  });
});
