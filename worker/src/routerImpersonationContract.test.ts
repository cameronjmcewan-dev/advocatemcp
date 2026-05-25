/**
 * Static contract test for the admin-impersonation gate in
 * site/js/v2/router.js — the SPA-navigation companion to the boot-time
 * gate in shell.js (see shellImpersonationContract.test.ts).
 *
 * Why this test exists
 * --------------------
 * shellImpersonationContract.test.ts pinned the ownership check in
 * shell.js (initial page paint). But updateImpersonationBanner in
 * router.js runs on every SPA navigation, and the original PR only
 * patched shell.js. Symptom in the wild: a customer landing on
 * /BusinessProfile.html?as=advocate saw no banner (shell.js fix
 * worked), then clicked "Traffic impact" in the sidebar and the
 * banner suddenly appeared (router.js re-mounted via the legacy
 * `if (isAdmin && asSlug)` path).
 *
 * Fix: router.js now computes `_ownsAsSlug` against
 * window.AMCP_DATA.accessible_businesses and only mounts when
 * shouldShowBanner === true. This test pins the two halves so a
 * careless revert dies in CI.
 */

/// <reference types="node" />
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const ROUTER_JS = "../site/js/v2/router.js";

describe("router.js impersonation gate: admin-on-own-tenant is not impersonation (SPA nav)", () => {
  const src = readFileSync(ROUTER_JS, "utf-8");

  it("declares an _ownsAsSlug accessible-businesses check", () => {
    expect(src).toMatch(/_ownsAsSlug\s*=\s*asSlug\s*\?\s*ownedList\.some/);
  });

  it("computes shouldShowBanner from !_ownsAsSlug", () => {
    expect(src).toMatch(/shouldShowBanner\s*=\s*!!\(\s*isAdmin\s*&&\s*asSlug\s*&&\s*!_ownsAsSlug\s*\)/);
  });

  it("does NOT contain the legacy gate that fires for ALL admin+asSlug", () => {
    // Pre-fix shape mounted the banner unconditionally inside the
    // `if (isAdmin && asSlug)` branch. Forbid the direct assignment
    // that follows it so a revert can't slip through.
    expect(src).not.toMatch(/if\s*\(\s*isAdmin\s*&&\s*asSlug\s*\)\s*\{\s*\n\s*window\.AMCP_DATA\.impersonating\s*=\s*asSlug/);
  });
});
