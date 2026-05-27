/**
 * Static contract: dashboard pages MUST NOT use window.alert() or
 * window.confirm() — both are blocking modals that halt the user's
 * flow with technical copy and no inline retry. The v2 dashboard's
 * AMCP.toast component (site/js/v2/toast.js) provides a non-blocking
 * alternative; this test pins the alert / confirm count at zero so a
 * future copy-paste from legacy code can't reintroduce them quietly.
 *
 * Why this test exists
 * --------------------
 * Pre-Tier-1A audit found 40 window.alert() calls across settings.js
 * (21), team.js (8), traffic-impact.js (5), setupPage.js (2),
 * billing.js (2), trafficImpactWizard.js (1), dashboardGrid.js (1),
 * plus 12 window.confirm() calls scattered across the same files +
 * profile.js, radar.js, get-started.js. Each one was an interruption
 * point for a 60-year-old non-technical small-business owner. The
 * Tier 1A sweep replaced every one with a toast call (info / success
 * / error / confirm). Without a contract test the regression bar is
 * code review alone, which is too soft for cross-file pattern changes.
 *
 * What this catches
 * -----------------
 *   - A new feature adds `alert(...)` because it's the fastest path
 *     to a working prototype, then forgets to swap to toast before
 *     merge.
 *   - A rebase resurrects a legacy confirm() that the sweep removed.
 *   - A copy from outside site/js/v2/ (e.g. a snippet from MDN docs)
 *     brings alert() back.
 *
 * Allow-list
 * ----------
 * `site/js/v2/toast.js` legitimately mentions `window.alert` /
 * `window.confirm` in its module docstring as the thing it replaces.
 * The grep below excludes that file by name; if anyone renames it,
 * update the constant below.
 *
 * Mirror of the static-grep pattern from
 * worker/src/dashboardShells.test.ts and the contract tests landed in
 * PRs #249, #250, #251, #258, #263, and PR #264's voiceContract.
 */

/// <reference types="node" />
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";

// Vitest cwd is the worker/ package root. Site assets live one up.
const V2_DIR = "../site/js/v2";

// File whose docstring legitimately mentions alert/confirm.
const TOAST_FILE = "toast.js";

/**
 * Read every *.js in the v2 directory (except toast.js itself), strip
 * block + line comments, and return { name, source } pairs. Mirrors
 * the strip-then-check approach from voiceContract.test.ts so engineer
 * notes inside the JS modules don't false-positive the grep.
 */
function loadV2Sources(): Array<{ name: string; source: string }> {
  const files = readdirSync(V2_DIR).filter(
    (f) => f.endsWith(".js") && f !== TOAST_FILE,
  );
  return files.map((name) => {
    const raw = readFileSync(`${V2_DIR}/${name}`, "utf-8");
    // Strip block comments first (greedy newline-aware).
    let stripped = raw.replace(/\/\*[\s\S]*?\*\//g, "");
    // Then line comments. Per-line so newlines stay intact.
    stripped = stripped.replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
    return { name, source: stripped };
  });
}

describe("dashboard: no window.alert() or alert() in v2 modules", () => {
  const sources = loadV2Sources();

  for (const { name, source } of sources) {
    // The forbidden pattern: bare `alert(` not preceded by a word
    // character (so `something.alert(` — a method on an object —
    // doesn't false-positive). `window.alert(` is also caught because
    // the preceding `.` is matched as non-word context.
    //
    // The `AMCP.toast` namespace doesn't expose an `alert` method, so
    // we don't need to allow any object.alert chain.
    it(`${name} contains no alert() or window.alert() call`, () => {
      // Negative lookbehind for word char: rejects identifiers like
      // selfAlert(). Allows `window.alert(`, `alert(` at sentence
      // start, and `(alert(`.
      const match = source.match(/(^|[^\w])alert\s*\(/);
      if (match) {
        // Surface the line + nearby context for actionable failure.
        const idx = source.indexOf(match[0]);
        const line = source.slice(0, idx).split("\n").length;
        const ctx = source.slice(Math.max(0, idx - 60), idx + 60);
        throw new Error(
          `${name}:${line} contains forbidden alert() call:\n` +
          `  ...${ctx.replace(/\s+/g, " ").trim()}...\n` +
          `Use window.AMCP.toast.error / .info / .success instead.`,
        );
      }
    });
  }
});

describe("dashboard: no window.confirm() or confirm() in v2 modules", () => {
  const sources = loadV2Sources();

  for (const { name, source } of sources) {
    it(`${name} contains no confirm() or window.confirm() call`, () => {
      // Allow `AMCP.toast.confirm(` and `toast.confirm(` — these are
      // the replacement API. The contract is "no bare or window.
      // confirm()".
      // Strategy: blank out the allowed call sites first, then grep
      // for any remaining `confirm(`. This is cleaner than a complex
      // negative lookbehind.
      const blanked = source
        .replace(/\bAMCP\.toast\.confirm\s*\(/g, "ALLOWED(")
        .replace(/\btoast\.confirm\s*\(/g, "ALLOWED(");
      const match = blanked.match(/(^|[^\w])confirm\s*\(/);
      if (match) {
        const idx = blanked.indexOf(match[0]);
        const line = blanked.slice(0, idx).split("\n").length;
        const ctx = blanked.slice(Math.max(0, idx - 60), idx + 60);
        throw new Error(
          `${name}:${line} contains forbidden confirm() call:\n` +
          `  ...${ctx.replace(/\s+/g, " ").trim()}...\n` +
          `Use await window.AMCP.toast.confirm(question, opts) instead.`,
        );
      }
    });
  }
});

describe("dashboard: toast.js is the canonical home for AMCP.toast", () => {
  it("site/js/v2/toast.js exists", () => {
    const src = readFileSync(`${V2_DIR}/${TOAST_FILE}`, "utf-8");
    expect(src).toMatch(/window\.AMCP\.toast/);
    expect(src).toMatch(/function confirmInline/);
  });

  it("exposes info / success / error / confirm on the api object", () => {
    const src = readFileSync(`${V2_DIR}/${TOAST_FILE}`, "utf-8");
    expect(src).toMatch(/info:\s*function/);
    expect(src).toMatch(/success:\s*function/);
    expect(src).toMatch(/error:\s*function/);
    expect(src).toMatch(/confirm:\s*confirmInline/);
  });
});

describe("dashboard: every shell that loads page modules also loads toast.js", () => {
  // Mirrors the dashboardShells.test.ts pattern. If a future shell is
  // added but forgets the toast.js script tag, the page-module's toast
  // calls will throw at runtime ("Cannot read property 'toast' of
  // undefined"). Catch this in CI.
  const SHELLS = [
    "app.html",
    "BusinessProfile.html",
    "Mentions.html",
    "TrafficImpact.html",
    "CompetitorRadar.html",
    "A2APipeline.html",
    "ActivityFeed.html",
    "TeamAccess.html",
    "Settings.html",
    "Billing.html",
    "admin.html",
    "admin/tenants.html",
    "admin/queries.html",
    "admin/experiments.html",
    "setup/traffic-impact.html",
  ];
  for (const shell of SHELLS) {
    it(`${shell} loads /js/v2/toast.js`, () => {
      const html = readFileSync(`../site/${shell}`, "utf-8");
      expect(html).toMatch(/<script[^>]+src="\/js\/v2\/toast\.js"[^>]*>\s*<\/script>/);
    });
  }
});
