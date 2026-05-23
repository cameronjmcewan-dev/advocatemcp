/**
 * Static contract: apiUpdateProfile must forward Railway's error body so
 * the frontend can surface the real reason for a failed save.
 *
 * Why this test exists
 * --------------------
 * The original `apiUpdateProfile` swallowed Railway's response on
 * failure and returned the literal string "Profile update failed" with
 * no error_code / message / details. Users hit "Save" on the Business
 * Profile editor, the save failed for a real reason (validation,
 * plan-gate, etc.), and the dashboard showed nothing actionable. We
 * had no way to diagnose customer-reported "save doesn't work" without
 * direct DB or Railway-log inspection.
 *
 * The 2026-05-23 fix: forward the upstream payload AND set the
 * user-facing `error` string from whichever Railway field is populated
 * (error / message / customer_message). The frontend's widened probe
 * (matching PR #251's pattern) then surfaces whichever field is most
 * informative.
 *
 * This contract pins the new shape so a future refactor can't silently
 * regress to "swallow + return generic literal."
 *
 * Mirror of the static-grep pattern from PR #251's
 * gscStartLinkContract.test.ts and PR #258's gscOauth scope catcher.
 */

/// <reference types="node" />
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const PORTAL_TS = "src/routes/portal.ts";
const PROFILE_JS = "../site/js/v2/profile.js";

describe("apiUpdateProfile: error path forwards Railway's response body", () => {
  const src = readFileSync(PORTAL_TS, "utf-8");
  const fnMatch = src.match(/async function apiUpdateProfile[\s\S]*?\n}\n/);

  it("apiUpdateProfile function exists", () => {
    expect(fnMatch).not.toBeNull();
  });

  it("probes upstream data.error / data.message / data.customer_message for the user-facing string", () => {
    // The pre-fix shape was a literal `jsonErr(res.status, "Profile
    // update failed")` with no upstream forwarding. The new shape
    // pulls a real error string from Railway's response before
    // composing the user-facing message.
    const body = fnMatch![0];
    expect(body).toMatch(/data\.error/);
    expect(body).toMatch(/data\.message/);
    expect(body).toMatch(/data\.customer_message/);
  });

  it("spreads upstream `data` into the error response (frontend probe sees the full payload)", () => {
    // The new shape constructs the response inline (rather than via
    // jsonErr, which would only carry the literal `error` field).
    // Spreading `data` makes any structured fields (fieldErrors,
    // error_code, etc.) reach the frontend so it can surface them.
    const body = fnMatch![0];
    expect(body).toMatch(/\.\.\.data/);
  });

  it("does NOT use the legacy literal-only error path", () => {
    // Forbid the exact pre-fix expression to prevent a careless
    // revert.
    const body = fnMatch![0];
    expect(body).not.toMatch(/jsonErr\(res\.status,\s*["']Profile update failed["']\)/);
  });
});

describe("profile.js: save error probe uses the 4-field chain", () => {
  const src = readFileSync(PROFILE_JS, "utf-8");

  it("probes customer_message / error_code / message / error in canonical order", () => {
    // Matches the PR #251 pattern from settings.js:1231. The chain
    // ensures the real Railway error surfaces regardless of which
    // field name the upstream uses.
    expect(src).toMatch(/data\.customer_message\s*\|\|\s*data\.error_code\s*\|\|\s*data\.message\s*\|\|\s*data\.error/);
  });

  it("does NOT use the legacy narrow probe (data && data.error only)", () => {
    // Pre-fix pattern: `data && data.error ? data.error : ...`. The
    // 4-field chain replaces it. If this pattern reappears, the
    // probe regressed.
    expect(src).not.toMatch(/data && data\.error \? data\.error : `HTTP/);
  });
});
