/**
 * Static contract test for the onboarding wizard's payload coverage.
 *
 * The wizard at site/onboarding.html builds a `profile` object via
 * `buildOnboardPayload()`. Historically several fields the Business
 * Profile editor reads from were never collected at signup — the
 * editor then had to ask for them post-onboarding, producing the
 * "you're asking me what I just told you" UX bug surfaced in PR #256.
 *
 * Three fields lacked wizard collection: `top_services`, `pricing`
 * (free-form), `years_in_business`. The 2026-05-23 change adds inputs
 * for all three to Step 2 of the wizard and threads them through
 * `buildOnboardPayload()` into `profile.*`.
 *
 * This test pins the additions statically so a future refactor of
 * the wizard JS can't silently drop them and re-introduce the
 * redundancy gap. Same static-grep pattern as PR #249's
 * trafficImpactGateContract.test.ts and PR #258's
 * gscOauth.test.ts scope regression catcher.
 */

/// <reference types="node" />
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const ONBOARDING_HTML = "../site/onboarding.html";

describe("onboarding wizard — Step 2 collects top_services + pricing + years_in_business", () => {
  const src = readFileSync(ONBOARDING_HTML, "utf-8");

  it("HTML markup includes the three new input fields", () => {
    expect(src).toMatch(/id="biz-top-services"/);
    expect(src).toMatch(/id="biz-pricing-freeform"/);
    expect(src).toMatch(/id="biz-years"/);
  });

  it("buildOnboardPayload reads all three values from the DOM", () => {
    // Match each `const ... = v('biz-<id>').trim();` capture inside
    // the buildOnboardPayload body. If a future refactor drops one,
    // this test catches it before the regression reaches the editor.
    expect(src).toMatch(/v\(['"]biz-top-services['"]\)/);
    expect(src).toMatch(/v\(['"]biz-pricing-freeform['"]\)/);
    expect(src).toMatch(/v\(['"]biz-years['"]\)/);
  });

  it("buildOnboardPayload assigns each value to its schema key on profile", () => {
    // Schema keys must match TenantRecord.profile.* in
    // worker/src/routes/onboard.ts:107-138. The Business Profile
    // editor's template reads from these exact keys; renaming any of
    // them re-introduces the redundancy gap.
    expect(src).toMatch(/profile\.top_services\s*=/);
    expect(src).toMatch(/profile\.pricing\s*=/);
    expect(src).toMatch(/profile\.years_in_business\s*=/);
  });

  it("review step echoes all three new fields back to the customer for confirmation", () => {
    // The wizard's final review screen lets customers verify what they
    // typed before submitting. New fields must surface there too —
    // otherwise the customer might be surprised by a field they don't
    // remember entering.
    expect(src).toMatch(/id="rv-top-services"/);
    expect(src).toMatch(/id="rv-pricing-freeform"/);
    expect(src).toMatch(/id="rv-years"/);
  });
});
