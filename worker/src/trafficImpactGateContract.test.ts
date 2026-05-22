/**
 * Static contract check: the Traffic Impact dashboard's chart-mount
 * gate MUST agree between render() and afterMount().
 *
 * Why this test exists
 * --------------------
 * PR #244 introduced sparse-data dashboards but left the afterMount
 * chart-mount gate at >= 7 days while render() emitted chart containers
 * for any non-empty daily[]. Symptom on production: every just-
 * reconnected GA4 tenant saw blank chart canvases because echarts.init
 * never ran on the mounted DOM elements. PR #248 patched the numeric
 * mismatch (afterMount gate dropped to >= 1 to match render's
 * daily.length === 0 early-return).
 *
 * But the fix lives as two independent inline expressions ~600 lines
 * apart in `site/js/v2/traffic-impact.js`. If either side gets edited
 * again without the other, the same symptom returns silently. This
 * test pins the current shape so the follow-up PR (helper extraction)
 * can flip it deterministically — and so any future re-divergence
 * fails CI loudly instead of shipping to tenants.
 *
 * This commit captures CURRENT behavior (inline patterns, no helper).
 * A follow-up commit will introduce `hasChartableData(impact)` and
 * flip these assertions to require the helper.
 *
 * Why this lives in worker/
 * -------------------------
 * The `site/` directory has no test runner; worker/ is the closest
 * package with vitest configured. Static file read from disk only —
 * no Workers runtime dependency. Mirrors the pattern in
 * `worker/src/dashboardShells.test.ts`.
 */

/// <reference types="node" />
// ^ Pulls Node typings in for THIS file only. See dashboardShells.test.ts
// for the rationale (worker/tsconfig.json scopes types to
// @cloudflare/workers-types, but this test needs node:fs).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const TRAFFIC_IMPACT_JS = "../site/js/v2/traffic-impact.js";

describe("traffic-impact chart-mount gate (characterization)", () => {
  const src = readFileSync(TRAFFIC_IMPACT_JS, "utf-8");

  it("afterMount uses the inline gate expression", () => {
    // The afterMount-side gate in current main (post-PR #248) is an
    // inline conjunction. We lock this in so the follow-up refactor's
    // diff has something to assert against.
    const inlineGate = "impact.ga4_connected && impact.daily && impact.daily.length >= 1";
    const matches = src.split(inlineGate).length - 1;
    expect(matches).toBe(1);
  });

  it("render uses the inline daily.length === 0 early-return", () => {
    // The render-side zero-data guard fires AFTER the !connected
    // early-return at line 1036, so it's a 1-condition check against
    // the local `daily` array.
    const inlineGuard = "if (daily.length === 0)";
    const matches = src.split(inlineGuard).length - 1;
    expect(matches).toBe(1);
  });

  it("no hasChartableData helper exists yet", () => {
    // Sanity: the refactor target symbol shouldn't be present in this
    // characterization commit. The follow-up commit introduces it and
    // flips this assertion.
    expect(src).not.toMatch(/\bhasChartableData\b/);
  });
});
