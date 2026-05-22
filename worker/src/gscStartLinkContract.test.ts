/**
 * Static contract test for the POST /api/client/gsc/start-link handler.
 *
 * Mirrors worker/src/ga4StartLinkContract.test.ts. The handler is module-
 * scoped inside `worker/src/routes/portal.ts` (no direct export), so we
 * lock the contract via a static grep on the file rather than a full
 * HTTP-plumbed integration test.
 *
 * Why this test exists
 * --------------------
 * Original implementation required `?slug=<slug>` strictly:
 *
 *   const querySlug = reqUrl.searchParams.get("slug");
 *   if (!querySlug) {
 *     return withCors(jsonErr(400, "slug query param required"), …);
 *   }
 *
 * Every other GSC endpoint (apiGSCStatus, apiGSCSites, apiGSCSelectSite,
 * apiGSCDisconnect) accepts an OPTIONAL slug and defaults to
 * `businesses[0]`. The strict-require here was the lone outlier — and
 * both the TrafficImpact page's GSC Connect button and the setup wizard
 * POST to this endpoint without a slug param, so the endpoint 400'd on
 * every Connect-button click. The frontend's generic "Could not start
 * GSC connection" alert made it look like a platform outage when the
 * real bug was just this API contract mismatch.
 *
 * Same bug class as PR #247 fixed for GA4. This test locks in the
 * matching fix for GSC so a future "tighten security" pass that
 * reintroduces the strict-require pattern fails CI immediately.
 */

/// <reference types="node" />
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const PORTAL_TS = "src/routes/portal.ts";

describe("apiGSCStartLink: slug is optional (matches every other GSC endpoint)", () => {
  it("apiGSCStartLink body contains no `slug query param required` early-rejection", () => {
    // Scoped to apiGSCStartLink only. Other portal.ts handlers (e.g.
    // apiGSCSelectSite, apiGSCDisconnect) deliberately keep the strict
    // require for write operations where the caller must be explicit
    // about which tenant to mutate. start-link is a READ-ish operation
    // (just generates a Google OAuth URL bound to a tenant); the same
    // strict-require here broke the Connect button silently and is
    // unnecessary for safety because the OAuth callback verifies the
    // resolved slug end-to-end via the signed state.
    const src = readFileSync(PORTAL_TS, "utf-8");
    const m = src.match(/async function apiGSCStartLink[\s\S]*?\n}\n/);
    expect(m).not.toBeNull();
    expect(m![0]).not.toMatch(/slug query param required/);
  });

  it("apiGSCStartLink uses the `(querySlug ? businesses.find ... : null) ?? businesses[0]` fallback pattern", () => {
    // The canonical pattern across every other GSC endpoint
    // (apiGSCStatus, apiGSCSites, apiGSCSelectSite) resolves the
    // business as a slug-then-fallback chain. Locking this in here
    // prevents a future divergence where one handler gets a different
    // slug-resolution path than the others.
    const src = readFileSync(PORTAL_TS, "utf-8");
    const m = src.match(/async function apiGSCStartLink[\s\S]*?\n}\n/);
    expect(m).not.toBeNull();
    const body = m![0];
    expect(body).toMatch(/businesses\.find\(b => b\.slug === querySlug\).+\?\?\s*businesses\[0\]/);
  });

  it("apiGSCStartLink still rejects with 403 when an explicit-but-foreign slug is supplied", () => {
    // Sanity: relaxing the require for missing-slug must not relax the
    // ownership check for explicit-but-wrong slug. A caller who passes
    // ?slug=some-other-tenant should NOT silently OAuth-link the wrong
    // tenant — the handler must 403 in that case.
    const src = readFileSync(PORTAL_TS, "utf-8");
    const m = src.match(/async function apiGSCStartLink[\s\S]*?\n}\n/);
    expect(m).not.toBeNull();
    const body = m![0];
    expect(body).toMatch(/querySlug && biz\.slug !== querySlug/);
    expect(body).toMatch(/no access to this business/);
  });
});
