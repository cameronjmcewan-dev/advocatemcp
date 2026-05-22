/**
 * Static contract test for the POST /api/client/crm/start-link handler.
 *
 * Mirrors worker/src/ga4StartLinkContract.test.ts and
 * worker/src/gscStartLinkContract.test.ts. Single endpoint, two providers
 * (hubspot + salesforce). The handler's header comment used to read
 * `// Mirrors apiGSCStartLink's pattern exactly` — which it did,
 * including the same slug-require bug that broke the setup wizard's
 * HubSpot and Salesforce Connect buttons. This test locks in the
 * post-fix shape so a future regression dies in CI rather than on a
 * tenant's setup page.
 */

/// <reference types="node" />
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const PORTAL_TS = "src/routes/portal.ts";

describe("apiCrmStartLink: slug is optional (matches every other CRM endpoint)", () => {
  it("apiCrmStartLink body contains no `slug query param required` early-rejection", () => {
    // Scoped to apiCrmStartLink only. apiCrmDisconnect deliberately
    // keeps the strict require for the disconnect path. start-link is
    // a READ-ish operation (just generates a HubSpot/Salesforce OAuth
    // URL bound to a tenant); the strict-require here broke both
    // Connect buttons silently and is unnecessary for safety because
    // the OAuth callback verifies the resolved slug end-to-end via
    // the signed state.
    const src = readFileSync(PORTAL_TS, "utf-8");
    const m = src.match(/async function apiCrmStartLink[\s\S]*?\n}\n/);
    expect(m).not.toBeNull();
    expect(m![0]).not.toMatch(/slug query param required/);
  });

  it("apiCrmStartLink uses the `(querySlug ? businesses.find ... : null) ?? businesses[0]` fallback pattern", () => {
    const src = readFileSync(PORTAL_TS, "utf-8");
    const m = src.match(/async function apiCrmStartLink[\s\S]*?\n}\n/);
    expect(m).not.toBeNull();
    const body = m![0];
    expect(body).toMatch(/businesses\.find\(b => b\.slug === querySlug\).+\?\?\s*businesses\[0\]/);
  });

  it("apiCrmStartLink still rejects with 403 when an explicit-but-foreign slug is supplied", () => {
    const src = readFileSync(PORTAL_TS, "utf-8");
    const m = src.match(/async function apiCrmStartLink[\s\S]*?\n}\n/);
    expect(m).not.toBeNull();
    const body = m![0];
    expect(body).toMatch(/querySlug && biz\.slug !== querySlug/);
    expect(body).toMatch(/no access to this business/);
  });

  it("apiCrmStartLink preserves the provider whitelist (hubspot|salesforce only)", () => {
    // Defence against a sloppy refactor stripping the provider check —
    // the handler intentionally rejects unknown providers with a clear
    // `provider_not_supported_yet` error rather than constructing an
    // invalid OAuth URL.
    const src = readFileSync(PORTAL_TS, "utf-8");
    const m = src.match(/async function apiCrmStartLink[\s\S]*?\n}\n/);
    expect(m).not.toBeNull();
    const body = m![0];
    expect(body).toMatch(/provider !== "hubspot" && provider !== "salesforce"/);
    expect(body).toMatch(/provider_not_supported_yet/);
  });
});
