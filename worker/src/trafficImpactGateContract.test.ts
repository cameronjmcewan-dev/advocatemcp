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
 * mismatch, but left two independent inline expressions ~600 lines
 * apart — trivially desyncable on the next edit.
 *
 * This PR extracted the predicate into a single helper
 * `hasChartableData(impact)` so the desync becomes structurally
 * impossible. This test pins the new shape so any future regression
 * (one consumer drifts back to inline, a second helper sneaks in, an
 * extra callsite appears uncovered by review) fails CI loudly.
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

describe("traffic-impact chart-mount gate (hasChartableData contract)", () => {
  const src = readFileSync(TRAFFIC_IMPACT_JS, "utf-8");

  it("declares hasChartableData(impact) exactly once", () => {
    // One declaration, no duplicates. Duplicate helpers would defeat
    // the purpose by reintroducing two-sites-to-keep-in-sync.
    const declMatches = src.match(/function\s+hasChartableData\s*\(\s*impact\s*\)/g) || [];
    expect(declMatches.length).toBe(1);
  });

  it("hasChartableData body checks ga4_connected, daily array, and >= 1", () => {
    // Pin the predicate's three required clauses. If any future edit
    // weakens it (e.g. drops the Array.isArray check), this fails.
    const fnMatch = src.match(
      /function\s+hasChartableData\s*\(\s*impact\s*\)\s*\{([\s\S]*?)\n\s{0,4}\}/
    );
    expect(fnMatch).not.toBeNull();
    const body = (fnMatch && fnMatch[1]) || "";
    expect(body).toContain("impact.ga4_connected");
    expect(body).toContain("Array.isArray(impact.daily)");
    expect(body).toContain("impact.daily.length >= 1");
  });

  it("the old inline gate expression is gone", () => {
    // Forbid the exact pre-extraction conjunction. If anyone re-pastes
    // it (intentionally or by merge), this fails before review.
    const inlineGate = "impact.ga4_connected && impact.daily && impact.daily.length >= 1";
    expect(src).not.toContain(inlineGate);
  });

  it("the old render-side zero-data guard is gone", () => {
    // The bare `daily.length === 0` is the form that previously paired
    // with the afterMount inline gate. Forbid it too — the render
    // branch should go through `!hasChartableData(impact)`.
    expect(src).not.toContain("if (daily.length === 0)");
  });

  it("hasChartableData has exactly 3 invocation sites total (1 decl + 2 callsites)", () => {
    // Declaration + render call + afterMount call. Match on
    // `hasChartableData(` so prose mentions of the symbol in nearby
    // doc-comments don't count. Any extra means a third consumer crept
    // in without being covered by review, or a duplicate declaration
    // was introduced. Either case warrants a closer look before
    // merging.
    const invocationMatches = src.match(/hasChartableData\s*\(/g) || [];
    expect(invocationMatches.length).toBe(3);
  });

  it("render branch uses !hasChartableData for the State B early-return", () => {
    expect(src).toMatch(/if\s*\(\s*!\s*hasChartableData\s*\(\s*impact\s*\)\s*\)/);
  });

  it("afterMount branch uses hasChartableData(impact) for the mount gate", () => {
    // The afterMount call is the unnegated form (mount when truthy).
    expect(src).toMatch(/if\s*\(\s*hasChartableData\s*\(\s*impact\s*\)\s*\)/);
  });
});
