/**
 * Static-grep contract: the per-host AI-discovery dispatch in
 * worker/src/index.ts MUST stay in the right band of the request lifecycle.
 *
 * Why this test exists
 * --------------------
 * The /sitemap.xml + /robots.txt handlers (sections 2d, 2e — added in this
 * PR) sit in the SAME dispatch band as the existing /.well-known/ai-agent.json
 * + /llms.txt handlers (2b, 2c): ungated by isAiCrawler, pre-section-3
 * proxy. If a future edit moves either dispatch into the non-crawler proxy
 * branch (line ~1158, `if (!isAiCrawler(userAgent))`), the customer-hostname
 * fix silently breaks for AI crawlers — they'd never reach the new
 * handlers because Claude-SearchBot and friends fall into the proxy branch
 * (their UA isn't in AI_CRAWLERS).
 *
 * This test pins the structural invariant statically so the failure mode
 * surfaces in CI instead of in production AI Crawl Control panels weeks
 * later.
 *
 * Pattern mirrors worker/src/trafficImpactGateContract.test.ts (PR #249).
 */

/// <reference types="node" />
// ^ Pulls Node typings in for THIS file only. worker/tsconfig.json scopes
// types to @cloudflare/workers-types, but this test needs node:fs to read
// the file from disk for static-grep checks.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const INDEX_TS = "./src/index.ts";

describe("worker request-dispatch contract (per-host /sitemap.xml + /robots.txt)", () => {
  const src = readFileSync(INDEX_TS, "utf-8");

  it("ADVOCATE_OWN_HOSTS is declared at module scope (not inside a function)", () => {
    // Hoisting the constant out of section 3 is the precondition for the
    // dispatch blocks above to reference it. If a refactor accidentally
    // pushes it back inside a function body, the dispatch checks become
    // ReferenceErrors at deploy time.
    const declMatches = src.match(/^const ADVOCATE_OWN_HOSTS\b/gm) || [];
    expect(declMatches.length).toBe(1);
  });

  it("declares the /robots.txt dispatch exactly once, gated on !ADVOCATE_OWN_HOSTS.includes(domain)", () => {
    // The gate is essential: advocatemcp.com itself keeps its static
    // site/robots.txt served via the Pages proxy fallback. Removing the
    // gate would override the marketing site's robots.txt with a dynamic
    // one — a behavior change we don't want from this PR.
    const matches = src.match(/url\.pathname === "\/robots\.txt"\s*&&\s*!ADVOCATE_OWN_HOSTS\.includes\(domain\)/g) || [];
    expect(matches.length).toBe(1);
  });

  it("declares the /sitemap.xml dispatch exactly once, gated on !ADVOCATE_OWN_HOSTS.includes(domain)", () => {
    const matches = src.match(/url\.pathname === "\/sitemap\.xml"\s*&&\s*!ADVOCATE_OWN_HOSTS\.includes\(domain\)/g) || [];
    expect(matches.length).toBe(1);
  });

  it("calls buildRobotsResponse(domain) from exactly one site", () => {
    const matches = src.match(/buildRobotsResponse\s*\(\s*domain\s*\)/g) || [];
    expect(matches.length).toBe(1);
  });

  it("calls buildSitemapResponse(domain) from exactly one site", () => {
    const matches = src.match(/buildSitemapResponse\s*\(\s*domain\s*\)/g) || [];
    expect(matches.length).toBe(1);
  });

  it("the /robots.txt dispatch fires BEFORE the non-crawler !isAiCrawler branch", () => {
    // Critical invariant: Claude-SearchBot and Claude-User aren't in
    // AI_CRAWLERS, so they hit the !isAiCrawler branch. If /robots.txt
    // dispatch moves below that branch, the customer-hostname fix is
    // silently bypassed for the exact bot we shipped this PR to support.
    const robotsIdx = src.indexOf(`url.pathname === "/robots.txt"`);
    // The Worker has 3 `!isAiCrawler(userAgent)` checks in total — two
    // inside /track and one at section 3 (the non-crawler-traffic branch
    // around line 1204). We want the SECTION-3 one — the last match —
    // because that's the branch our dispatch must precede.
    const allNonCrawler = Array.from(src.matchAll(/if\s*\(\s*!isAiCrawler\s*\(\s*userAgent\s*\)\s*\)\s*\{/g));
    const nonCrawlerIdx = allNonCrawler.length > 0 ? allNonCrawler[allNonCrawler.length - 1].index! : -1;
    expect(robotsIdx).toBeGreaterThan(-1);
    expect(nonCrawlerIdx).toBeGreaterThan(-1);
    expect(robotsIdx).toBeLessThan(nonCrawlerIdx);
  });

  it("the /sitemap.xml dispatch fires BEFORE the non-crawler !isAiCrawler branch", () => {
    const sitemapIdx = src.indexOf(`url.pathname === "/sitemap.xml"`);
    // The Worker has 3 `!isAiCrawler(userAgent)` checks in total — two
    // inside /track and one at section 3 (the non-crawler-traffic branch
    // around line 1204). We want the SECTION-3 one — the last match —
    // because that's the branch our dispatch must precede.
    const allNonCrawler = Array.from(src.matchAll(/if\s*\(\s*!isAiCrawler\s*\(\s*userAgent\s*\)\s*\)\s*\{/g));
    const nonCrawlerIdx = allNonCrawler.length > 0 ? allNonCrawler[allNonCrawler.length - 1].index! : -1;
    expect(sitemapIdx).toBeGreaterThan(-1);
    expect(nonCrawlerIdx).toBeGreaterThan(-1);
    expect(sitemapIdx).toBeLessThan(nonCrawlerIdx);
  });

  it("the /robots.txt and /sitemap.xml dispatches sit AFTER the /llms.txt dispatch (same discovery band)", () => {
    // 2d/2e mirror 2b/2c. They share the same lifecycle position — pre-
    // crawler-gate, pre-slug-resolve — so they behave identically for
    // every UA. Out-of-band placement would re-introduce the bug.
    const llmsIdx    = src.indexOf(`url.pathname === "/llms.txt"`);
    const robotsIdx  = src.indexOf(`url.pathname === "/robots.txt"`);
    const sitemapIdx = src.indexOf(`url.pathname === "/sitemap.xml"`);
    expect(llmsIdx).toBeGreaterThan(-1);
    expect(robotsIdx).toBeGreaterThan(llmsIdx);
    expect(sitemapIdx).toBeGreaterThan(llmsIdx);
  });
});
