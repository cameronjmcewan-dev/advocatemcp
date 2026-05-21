/// <reference types="node" />
/**
 * Static integration check: site/js/v2/aiInsights.js MUST normalize
 * rec.action_url through `normalizeActionUrl()` before dropping it
 * into an anchor href.
 *
 * Why this test exists
 * --------------------
 * Server-side `aiRecommendations.ts` runs every Claude response
 * through its own `normalizeActionUrl` (server/src/routes/
 * aiRecommendations.ts:464+) so fresh recs land in the DB with clean
 * `/BusinessProfile.html?focus=<canonical>` URLs. But the dashboard
 * also reads CACHED recs from before that server-side normalization
 * shipped, and Claude has been known to invent paths the server
 * normalizer can't pattern-match (e.g. `#settings`, bare `/profile`,
 * arbitrary anchors).
 *
 * The client-side `normalizeActionUrl` in aiInsights.js is the
 * defense-in-depth pass that catches whatever the server let through:
 * it forces every link to render as a known-good
 * `/BusinessProfile.html?focus=<canonical>` shape that the SPA
 * router's `matchRoute` regex and profile.js's `applyFocusFromUrl`
 * handler both understand.
 *
 * Pre-fix, the rendered anchor used `rec.action_url` directly:
 *
 *     <a class="ai-rec-action" href="<rec.action_url verbatim>">
 *
 * Any stale or malformed URL fell straight through to the browser,
 * SPA router missed, page did a full reload, AI Insights "fix-it"
 * links flashed-and-snapped-back instead of scrolling into the right
 * form. Tenants saw a glitch.
 *
 * This test fails if anyone deletes the client-side normalization
 * helpers OR if the rec card renderer reverts to dropping
 * `rec.action_url` straight into the anchor.
 *
 * Why this lives in worker/
 * -------------------------
 * `site/` has no test runner; worker/ is the closest package with
 * vitest configured. The triple-slash node reference is scoped to
 * this file only so production worker source still gets only
 * @cloudflare/workers-types via the tsconfig types array. Same
 * pattern as worker/src/dashboardShells.test.ts.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const SITE_DIR = "../site";
const AI_INSIGHTS_PATH = `${SITE_DIR}/js/v2/aiInsights.js`;

describe("aiInsights.js client-side action_url normalization", () => {
  it("declares the FOCUS_ALIASES map", () => {
    const js = readFileSync(AI_INSIGHTS_PATH, "utf-8");
    expect(js).toMatch(/var FOCUS_ALIASES\s*=\s*\{/);
  });

  it("declares the focusFromValue() helper", () => {
    const js = readFileSync(AI_INSIGHTS_PATH, "utf-8");
    expect(js).toMatch(/function focusFromValue\s*\(/);
  });

  it("declares the businessProfileHref() helper", () => {
    const js = readFileSync(AI_INSIGHTS_PATH, "utf-8");
    expect(js).toMatch(/function businessProfileHref\s*\(/);
  });

  it("declares the normalizeActionUrl() helper", () => {
    const js = readFileSync(AI_INSIGHTS_PATH, "utf-8");
    expect(js).toMatch(/function normalizeActionUrl\s*\(/);
  });

  it("renderRecCard wires normalizeActionUrl into the rendered anchor — not raw rec.action_url", () => {
    // The whole point of this fix: the href value must come from the
    // normalized URL, NOT from rec.action_url directly. If anyone
    // collapses these back into a single line that uses rec.action_url
    // verbatim, every malformed cached rec turns into a navigation
    // glitch on the user's dashboard.
    const js = readFileSync(AI_INSIGHTS_PATH, "utf-8");
    expect(js).toMatch(/var actionUrl\s*=\s*normalizeActionUrl\(rec\.action_url/);
    expect(js).toMatch(/href="['"\s+]*\+\s*esc\(actionUrl\)/);
    // Regression catcher: the pre-fix shape was
    //   href="' + esc(rec.action_url) + '"
    // Make sure we don't drift back to that.
    expect(js).not.toMatch(/href="['"\s+]*\+\s*esc\(rec\.action_url\)/);
  });

  it("FOCUS_ALIASES covers every focus key the server's prompt emits", () => {
    // server/src/routes/aiRecommendations.ts prompts Claude with this
    // allowlist of action_url focus values. The client-side alias map
    // must cover all six canonical keys so a fresh Claude rec always
    // resolves; missing one means the alias map degrades to 'basics'
    // and the user lands on the wrong form.
    const js = readFileSync(AI_INSIGHTS_PATH, "utf-8");
    for (const key of ["basics", "positioning", "ratings", "quotes", "credentials", "ops"]) {
      expect(js).toMatch(new RegExp(`${key}:\\s*['"]${key}['"]`));
    }
  });
});
