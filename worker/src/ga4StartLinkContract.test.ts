/**
 * Static contract test for the POST /api/client/ga4/start-link handler.
 *
 * The handler is a module-scoped function inside `worker/src/routes/portal.ts`
 * (no direct export), so we lock the contract via a static grep on the
 * file rather than a full HTTP-plumbed integration test. Same pattern as
 * `workerInternalAuth.test.ts`.
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
 * Every other GA4 endpoint (apiGA4Status, apiGA4Resync,
 * apiGA4SelectProperty, apiGA4Disconnect) accepts an OPTIONAL slug and
 * defaults to `businesses[0]`. The strict-require here was the lone
 * outlier — and the legacy Settings page calls both wireGa4Card and
 * startGoogleOauth without a slug param, so the endpoint 400'd on
 * every Connect-button click. The frontend's generic "Could not start"
 * alert made it look like a platform outage when the real bug was just
 * this API contract mismatch.
 *
 * Lock in the new contract: slug is optional, defaults to the caller's
 * primary business. A future "tighten security" pass that reintroduces
 * the strict-require pattern will fail this test immediately.
 */

/// <reference types="node" />
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const PORTAL_TS = "src/routes/portal.ts";

describe("apiGA4StartLink: slug is optional (matches every other GA4 endpoint)", () => {
  it("apiGA4StartLink body contains no `slug query param required` early-rejection", () => {
    // Scoped to apiGA4StartLink only. Other portal.ts handlers (e.g.
    // apiGA4SelectProperty, apiGA4Resync) deliberately keep the strict
    // require for write operations where the caller must be explicit
    // about which tenant to mutate. start-link is a READ-ish operation
    // (just generates a Google OAuth URL bound to a tenant); the same
    // strict-require here broke the Connect button silently and is
    // unnecessary for safety because the OAuth callback verifies the
    // resolved slug end-to-end via the signed state.
    const src = readFileSync(PORTAL_TS, "utf-8");
    const m = src.match(/async function apiGA4StartLink[\s\S]*?\n}\n/);
    expect(m).not.toBeNull();
    expect(m![0]).not.toMatch(/slug query param required/);
  });

  it("apiGA4StartLink uses the `(querySlug ? businesses.find ... : null) ?? businesses[0]` fallback pattern", () => {
    // The canonical pattern across every other GA4 endpoint
    // (apiGA4Status:3624, apiGA4Resync, apiGA4SelectProperty, etc.)
    // resolves the business as a slug-then-fallback chain. Locking
    // this in here prevents a future divergence where one handler
    // gets a different slug-resolution path than the others.
    const src = readFileSync(PORTAL_TS, "utf-8");
    // Find the apiGA4StartLink body — text between its declaration
    // and the next function declaration.
    const m = src.match(/async function apiGA4StartLink[\s\S]*?\n}\n/);
    expect(m).not.toBeNull();
    const body = m![0];
    // Expect the fallback pattern: `querySlug ? businesses.find(...) : null) ?? businesses[0]`
    expect(body).toMatch(/businesses\.find\(b => b\.slug === querySlug\).+\?\?\s*businesses\[0\]/);
  });

  it("apiGA4StartLink still rejects with 403 when an explicit-but-foreign slug is supplied", () => {
    // Sanity: relaxing the require for missing-slug must not relax the
    // ownership check for explicit-but-wrong slug. A caller who passes
    // ?slug=some-other-tenant should NOT silently OAuth-link the wrong
    // tenant — the handler must 403 in that case.
    const src = readFileSync(PORTAL_TS, "utf-8");
    const m = src.match(/async function apiGA4StartLink[\s\S]*?\n}\n/);
    expect(m).not.toBeNull();
    const body = m![0];
    expect(body).toMatch(/querySlug && biz\.slug !== querySlug/);
    expect(body).toMatch(/no access to this business/);
  });
});
