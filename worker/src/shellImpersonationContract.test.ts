/**
 * Static contract test for the admin-impersonation gate in
 * site/js/v2/shell.js.
 *
 * Why this test exists
 * --------------------
 * The original gate computed `impersonating = isAdmin && asSlug ? asSlug : null`,
 * which fired the impersonation banner for ANY admin viewing a page with
 * `?as=<slug>` — including the case where the admin OWNS that tenant
 * via accessible_businesses. Symptom: clicking an AI recommendation
 * like "Open Pricing →" (which ships `?as=<own-slug>` in the href)
 * triggered a banner reading "Impersonating <wrong tenant name> (own-slug)"
 * because accessible_businesses[0] was a different tenant in the admin's
 * list. Same root cause also broke the deep-link scroll-to-section
 * behavior because the banner's padding-top adjustment shifted the
 * scroll target out of view.
 *
 * Fix: the gate now additionally requires `!_ownsAsSlug` — admin
 * viewing a tenant they already have direct access to is NOT
 * impersonation, no banner mounts, and the scroll behavior is
 * undisturbed.
 *
 * Static-grep mirrors PRs #249/#250/#251/PR-A contract tests.
 */

/// <reference types="node" />
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const SHELL_JS = "../site/js/v2/shell.js";

describe("shell.js impersonation gate: admin-on-own-tenant is not impersonation", () => {
  const src = readFileSync(SHELL_JS, "utf-8");

  it("declares an _ownsAsSlug accessible-businesses check", () => {
    // The fix introduces this exact identifier. Future refactors that
    // drop the check would re-introduce the wrong-name banner bug.
    expect(src).toMatch(/_ownsAsSlug\s*=\s*asSlug\s*\?\s*_accessibleList\.some/);
  });

  it("the impersonating expression includes !_ownsAsSlug", () => {
    // Match the full conditional. Loose whitespace tolerated.
    expect(src).toMatch(/impersonating\s*=\s*isAdmin\s*&&\s*asSlug\s*&&\s*!_ownsAsSlug\s*\?\s*asSlug\s*:\s*null/);
  });

  it("does NOT contain the legacy gate that fires for ALL admin+asSlug", () => {
    // The pre-fix expression was exactly this string. Forbid it so a
    // careless revert dies in CI.
    expect(src).not.toMatch(/const\s+impersonating\s*=\s*isAdmin\s*&&\s*asSlug\s*\?\s*asSlug\s*:\s*null/);
  });
});
