/**
 * Static contract: apiAIRecommendations MUST plainify Railway's
 * response before returning to the frontend.
 *
 * Why this test exists
 * --------------------
 * Railway's Claude emits jargon (foundingDate, customer_quotes_json,
 * "citation score", "per-engine variants", etc.) that confuses non-
 * technical business owners. The worker proxy at
 * worker/src/routes/portal.ts:apiAIRecommendations now intercepts the
 * upstream response and runs it through plainifyRecommendationsPayload
 * (worker/src/lib/insightPlainifier.ts) before forwarding to the
 * frontend.
 *
 * If a future refactor accidentally drops the plainify step (e.g.
 * "simplify the proxy", "match the apiProfileScore pure-pass-through
 * pattern"), the dashboard regresses to jargon-heavy copy with no
 * loud failure. This static-grep contract makes the regression visible
 * in CI.
 *
 * Mirror of the static-grep pattern from PR #249's
 * trafficImpactGateContract.test.ts and PR #258's gscOauth scope catcher.
 */

/// <reference types="node" />
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const PORTAL_TS = "src/routes/portal.ts";

describe("apiAIRecommendations: plainifies Railway response before returning", () => {
  const src = readFileSync(PORTAL_TS, "utf-8");
  const fnMatch = src.match(/async function apiAIRecommendations[\s\S]*?\n}\n/);

  it("apiAIRecommendations function exists", () => {
    expect(fnMatch).not.toBeNull();
  });

  it("imports plainifyRecommendationsPayload from insightPlainifier", () => {
    // Function-scope check first (regression on the import itself
    // would surface here), then verify module-scope import exists.
    expect(src).toMatch(/import\s*\{[^}]*plainifyRecommendationsPayload[^}]*\}\s*from\s*["']\.\.\/lib\/insightPlainifier["']/);
  });

  it("calls plainifyRecommendationsPayload on the upstream response", () => {
    const body = fnMatch![0];
    expect(body).toMatch(/plainifyRecommendationsPayload\s*\(/);
  });

  it("plainify is wrapped in try/catch (best-effort, never breaks the response)", () => {
    // A parse failure or malformed payload from Railway must NOT
    // 500 the frontend — the original text body should pass through
    // unchanged in that case. Loose match: the function body
    // contains a catch block somewhere.
    const body = fnMatch![0];
    expect(body).toMatch(/}\s*catch\s*[\{\(]/);
  });

  it("only plainifies on 2xx upstream responses (errors pass through untouched)", () => {
    // Error responses from Railway (402 plan_required, 5xx, etc.)
    // have no recommendations array. Plainifying them is safe but
    // wasteful; the guard prevents JSON.parse cost on every error
    // path and keeps the upstream's error shape intact.
    const body = fnMatch![0];
    expect(body).toMatch(/if\s*\(\s*r\.ok\s*\)/);
  });
});
