/**
 * Static contract test for apiTrafficImpactGeography
 * (worker/src/routes/portal.ts).
 *
 * Why this test exists
 * --------------------
 * The handler used to sort `rows` independently by AI and by Human and
 * slice the top-10 of each side without filtering. That meant a city
 * could rank top-10 by ai_sessions (e.g. 0 AI, 0 human absolute, but
 * top-10 by ai because every other row was also zero) and still get
 * mapped into the response with `sessions: r.ai || 0` — i.e. a literal
 * zero row in the "FROM AI SEARCH" column. Users reported the dashboard
 * showed Recife, Tel Aviv, Frankfurt, etc. as random international
 * noise with zero sessions next to each.
 *
 * Fix: filter `r.ai > 0` (and symmetric on the human side) BEFORE the
 * sort+slice. This contract test pins the new shape so a future edit
 * can't reintroduce the unfiltered slice.
 *
 * Mirrors the static-grep pattern from
 * worker/src/discoveryDispatchContract.test.ts (PR #250) and
 * worker/src/gscStartLinkContract.test.ts (PR #251).
 */

/// <reference types="node" />
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const PORTAL_TS = "src/routes/portal.ts";

describe("apiTrafficImpactGeography: filter zero-session rows before sort/slice", () => {
  const src = readFileSync(PORTAL_TS, "utf-8");
  const fnMatch = src.match(/async function apiTrafficImpactGeography[\s\S]*?\n}\n/);

  it("apiTrafficImpactGeography function exists", () => {
    expect(fnMatch).not.toBeNull();
  });

  it("AI sort chain includes a positive-session filter before the slice", () => {
    // Pattern: somewhere in the apiTrafficImpactGeography body, a chain
    // calls .filter(...) — referencing r.ai > 0 — before .sort and
    // before .slice(0, 10). Loose match because the predicate body
    // contains its own parens.
    const body = fnMatch![0];
    expect(body).toMatch(/\.filter\([\s\S]*?r\.ai[\s\S]*?>\s*0[\s\S]*?\)[\s\S]*?\.sort[\s\S]*?\.slice\(0,\s*10\)/);
  });

  it("Human sort chain includes a positive-session filter before the slice", () => {
    const body = fnMatch![0];
    expect(body).toMatch(/\.filter\([\s\S]*?r\.human[\s\S]*?>\s*0[\s\S]*?\)[\s\S]*?\.sort[\s\S]*?\.slice\(0,\s*10\)/);
  });

  it("does NOT contain the legacy unfiltered shape", () => {
    // The legacy pattern was: [...rows].sort(...).slice(0, 10) with no
    // intervening filter. Forbid the bare spread→sort→slice chain on
    // `rows` for AI specifically.
    const body = fnMatch![0];
    // Match the legacy shape: `[...rows].sort(...).slice(0, 10)` with
    // nothing between the spread and the sort. If a future refactor
    // accidentally removes the filter, this catches it.
    expect(body).not.toMatch(/\[\.\.\.rows\]\s*\.sort\(/);
  });

  // ── service_area_keywords passthrough (added 2026-05-23) ───────────────────
  // The response includes the tenant's service_area_keywords so the
  // frontend can render an "in service area" badge on rows that match
  // (v0 fuzzy substring matching). Mirror of the KV-read pattern
  // introduced for apiGetProfile in PR #256. If a future refactor
  // drops the field, the badge silently disappears and the v0
  // service-area-highlight feature regresses to a no-op.

  it("response shape includes service_area_keywords", () => {
    const body = fnMatch![0];
    expect(body).toMatch(/service_area_keywords/);
  });

  it("reads service_area_keywords via getTenant(env, biz.domain)", () => {
    const body = fnMatch![0];
    expect(body).toMatch(/getTenant\s*\(\s*env\s*,\s*biz\.domain\s*\)/);
  });

  it("KV read is wrapped in try/catch (best-effort, never breaks the response)", () => {
    const body = fnMatch![0];
    // Function body should contain at least one try/catch — the
    // service_area_keywords lookup must not 500 the response when KV
    // misses or contains malformed data.
    expect(body).toMatch(/}\s*catch\s*[\{\(]/);
  });
});
