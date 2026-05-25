/**
 * Static contract test for the impersonation banner's `name` argument
 * in site/js/v2/shell.js and site/js/v2/router.js.
 *
 * Why this test exists
 * --------------------
 * The banner render path at `mountImpersonationBanner(slug, name)` reads
 * `const shown = name ? \`${name} (${slug})\` : slug` — so passing a non-
 * null name displays "Impersonating <name> (<slug>)" and passing null
 * shows just "Impersonating <slug>".
 *
 * Three call sites historically passed `window.AMCP_DATA.business_name`
 * for `name`. But `business_name` falls back to
 * `accessible_businesses[0].name` when the impersonated slug isn't in
 * the user's access list — so admins impersonating a non-owned tenant
 * saw their OWN tenant name awkwardly glued to the impersonated slug,
 * e.g. "Impersonating Workman Copy Co (advocate)" for a Workman Copy Co
 * admin viewing /app.html?as=advocate. Reported as a confusing UX bug.
 *
 * Fix: pass `null` in all three sites until we have the impersonated
 * tenant's real name to display (a follow-up that would require
 * fetching it via /api/client/metrics?slug=<impersonated>).
 *
 * The boot-time site at shell.js (around line 288) already passed null
 * correctly — the bug was only in the post-data remount, preview, and
 * SPA-nav sites.
 */

/// <reference types="node" />
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const SHELL_JS = "../site/js/v2/shell.js";
const ROUTER_JS = "../site/js/v2/router.js";

describe("impersonation banner mount sites never pass business_name as `name`", () => {
  it("shell.js: no mountImpersonationBanner(..., window.AMCP_DATA.business_name) call", () => {
    const src = readFileSync(SHELL_JS, "utf-8");
    // Loose match — any call that ends with business_name as the second arg
    // would re-introduce the wrong-tenant fallback. The legitimate calls
    // pass `null` or a literal computed name.
    expect(src).not.toMatch(/mountImpersonationBanner\([^)]*window\.AMCP_DATA\.business_name\)/);
  });

  it("router.js: AMCP_SHELL_MOUNT_BANNER never passes business_name", () => {
    const src = readFileSync(ROUTER_JS, "utf-8");
    expect(src).not.toMatch(/AMCP_SHELL_MOUNT_BANNER\([^)]*window\.AMCP_DATA\.business_name\)/);
  });
});
