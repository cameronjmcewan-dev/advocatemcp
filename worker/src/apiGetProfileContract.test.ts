/**
 * Static contract test for apiGetProfile's KV merge behavior
 * (worker/src/routes/portal.ts).
 *
 * Why this test exists
 * --------------------
 * Onboarding wizard data lands in TENANT_DATA KV (via
 * worker/src/routes/onboard.ts). Pre-fix, the /api/client/profile
 * endpoint that powers the Business Profile editor was a pure Railway
 * proxy — it never read the KV — so the editor saw empty inputs for
 * every wizard-collected field, asking the customer to re-enter
 * everything they just typed.
 *
 * Fix: apiGetProfile now merges TENANT_DATA's profile fields onto the
 * Railway response, with KV winning for any non-empty value. Plus a
 * legacy-key normalization that mirrors `differentiators_text` →
 * `differentiator` so the editor template surfaces it without
 * requiring a wizard rename + backfill.
 *
 * This contract pins the merge behavior so a future refactor can't
 * silently revert to the "pure Railway proxy" shape and silently
 * reintroduce the onboarding-redundancy bug.
 *
 * Static-grep mirrors PRs #249/#250/#251 + PR-A/B contract tests.
 */

/// <reference types="node" />
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const PORTAL_TS = "src/routes/portal.ts";

describe("apiGetProfile: merges TENANT_DATA KV onto Railway response", () => {
  const src = readFileSync(PORTAL_TS, "utf-8");
  const fnMatch = src.match(/async function apiGetProfile[\s\S]*?\n}\n/);

  it("apiGetProfile function exists", () => {
    expect(fnMatch).not.toBeNull();
  });

  it("calls getTenant(env, biz.domain) for the KV lookup", () => {
    // The KV record is keyed by domain; biz.domain is the canonical
    // accessor used elsewhere in portal.ts (line ~762).
    const body = fnMatch![0];
    expect(body).toMatch(/getTenant\s*\(\s*env\s*,\s*biz\.domain\s*\)/);
  });

  it("merge loop iterates Object.entries(kvProfile) and writes back to the response", () => {
    const body = fnMatch![0];
    expect(body).toMatch(/Object\.entries\s*\(\s*kvProfile\s*\)/);
  });

  it("skips empty values during merge (preserves Railway non-empty fields)", () => {
    // The empty-skip rules are: null/undefined, empty string after
    // trim, empty array. Without these the merge could blank out a
    // populated Railway field with a stale KV record.
    const body = fnMatch![0];
    expect(body).toMatch(/v\s*===\s*null\s*\|\|\s*v\s*===\s*undefined/);
    expect(body).toMatch(/typeof\s+v\s*===\s*"string"\s*&&\s*v\.trim\(\)\s*===\s*""/);
    expect(body).toMatch(/Array\.isArray\s*\(\s*v\s*\)\s*&&\s*v\.length\s*===\s*0/);
  });

  it("normalizes the legacy differentiators_text key to differentiator", () => {
    // Editor template reads p.differentiator; wizard historically wrote
    // p.differentiators_text. The merge mirrors the value across keys
    // so existing tenants surface correctly without a backfill.
    const body = fnMatch![0];
    expect(body).toMatch(/m\.differentiators_text/);
    expect(body).toMatch(/m\.differentiator\s*=\s*m\.differentiators_text/);
  });

  it("wraps the KV read in try/catch (best-effort, never breaks the response)", () => {
    // A KV miss or transient error must NOT 500 the editor — leaving
    // it on the Railway-only response is the graceful fallback.
    const body = fnMatch![0];
    // Looser regex: catch block exists somewhere in the function body.
    expect(body).toMatch(/}\s*catch\s*[\{\(]/);
  });
});
