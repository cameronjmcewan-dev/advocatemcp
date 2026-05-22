/**
 * Tests for buildSitemapResponse — per-host /sitemap.xml route handler.
 *
 * AI search crawlers follow /robots.txt to /sitemap.xml to learn which URLs
 * to crawl. For custom-hostname tenants neither was being served — both
 * 404'd, and Claude-SearchBot's grounding flow aborted before reaching any
 * content. (See companion robotsTxt.test.ts for the context.)
 *
 * v1 sitemap is intentionally minimal: customer homepage + /llms.txt +
 * /.well-known/ai-agent.json. A richer per-customer page list needs schema
 * support (the businesses table has only `website` + `referral_url`) and
 * is queued as a follow-up.
 *
 * Helper is pure (host -> Response). Tests pin: status, headers, sitemap-
 * protocol invariants (xml prolog, urlset namespace, well-formed close,
 * absolute same-host loc URLs).
 */

import { describe, it, expect } from "vitest";
import { buildSitemapResponse } from "./index";

async function bodyOf(res: Response): Promise<string> {
  return res.text();
}

describe("buildSitemapResponse — per-host /sitemap.xml", () => {
  it("returns 200", () => {
    const res = buildSitemapResponse("www.workmancopyco.com");
    expect(res.status).toBe(200);
  });

  it("sets Content-Type: application/xml; charset=utf-8", () => {
    const res = buildSitemapResponse("www.workmancopyco.com");
    expect(res.headers.get("Content-Type")).toBe("application/xml; charset=utf-8");
  });

  it("sets cache + CORS + X-Powered-By headers matching the existing discovery handlers", () => {
    const res = buildSitemapResponse("www.workmancopyco.com");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("X-Powered-By")).toBe("AdvocateMCP");
  });

  it("starts with the XML prolog", async () => {
    const res = buildSitemapResponse("www.workmancopyco.com");
    const body = await bodyOf(res);
    expect(body.startsWith(`<?xml version="1.0" encoding="UTF-8"?>`)).toBe(true);
  });

  it("declares the sitemaps.org urlset namespace", async () => {
    const res = buildSitemapResponse("www.workmancopyco.com");
    const body = await bodyOf(res);
    expect(body).toContain(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`);
  });

  it("closes the urlset element (well-formed XML)", async () => {
    const res = buildSitemapResponse("www.workmancopyco.com");
    const body = await bodyOf(res);
    expect(body.trimEnd().endsWith("</urlset>")).toBe(true);
  });

  it("includes the homepage <loc>", async () => {
    const res = buildSitemapResponse("www.workmancopyco.com");
    const body = await bodyOf(res);
    expect(body).toContain("<loc>https://www.workmancopyco.com/</loc>");
  });

  it("includes the /llms.txt <loc>", async () => {
    const res = buildSitemapResponse("www.workmancopyco.com");
    const body = await bodyOf(res);
    expect(body).toContain("<loc>https://www.workmancopyco.com/llms.txt</loc>");
  });

  it("includes the /.well-known/ai-agent.json <loc>", async () => {
    const res = buildSitemapResponse("www.workmancopyco.com");
    const body = await bodyOf(res);
    expect(body).toContain("<loc>https://www.workmancopyco.com/.well-known/ai-agent.json</loc>");
  });

  it("uses absolute https URLs for every <loc> (sitemap protocol requirement)", async () => {
    const res = buildSitemapResponse("www.workmancopyco.com");
    const body = await bodyOf(res);
    const locs = Array.from(body.matchAll(/<loc>([^<]+)<\/loc>/g)).map((m) => m[1]);
    expect(locs.length).toBeGreaterThan(0);
    for (const loc of locs) {
      expect(loc.startsWith("https://")).toBe(true);
    }
  });

  it("every <loc> is on the same host as the sitemap (protocol compliance)", async () => {
    const host = "acme.hosted.advocatemcp.com";
    const res = buildSitemapResponse(host);
    const body = await bodyOf(res);
    const locs = Array.from(body.matchAll(/<loc>([^<]+)<\/loc>/g)).map((m) => m[1]);
    expect(locs.length).toBeGreaterThan(0);
    for (const loc of locs) {
      expect(new URL(loc).host).toBe(host);
    }
  });

  it("uses the given host (not a hardcoded one) across all <loc> entries", async () => {
    const res = buildSitemapResponse("acme.hosted.advocatemcp.com");
    const body = await bodyOf(res);
    expect(body).toContain("<loc>https://acme.hosted.advocatemcp.com/</loc>");
    expect(body).not.toContain("workmancopyco");
  });

  it("emits changefreq and priority for every URL entry", async () => {
    const res = buildSitemapResponse("www.workmancopyco.com");
    const body = await bodyOf(res);
    const urlBlockCount = (body.match(/<url>/g) || []).length;
    const changefreqCount = (body.match(/<changefreq>/g) || []).length;
    const priorityCount = (body.match(/<priority>/g) || []).length;
    expect(urlBlockCount).toBeGreaterThan(0);
    expect(changefreqCount).toBe(urlBlockCount);
    expect(priorityCount).toBe(urlBlockCount);
  });
});
