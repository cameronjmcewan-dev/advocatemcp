/**
 * Static integration check: every dashboard shell in `site/*.html` (and
 * `site/admin/*.html`) MUST include the SPA router script.
 *
 * Why this test exists
 * --------------------
 * Commit 0b2f3a1 added `site/js/v2/router.js` (the client-side SPA
 * router) and rewired internals to call into `window.AMCP_ROUTER`,
 * but never added a `<script src="/js/v2/router.js">` tag to any
 * page shell. Result: the router has been dormant on prod since
 * April 24 2026. Every internal link click does a full page reload
 * with a visible `#boot-splash` flash, which is what tenants
 * perceive as "the page glitches and doesn't redirect anywhere"
 * when they click an AI Insights action link on the Overview tab.
 *
 * The PR that landed this test couples the router load to every
 * shell page. This test fails loudly if anyone:
 *   - Adds a new dashboard shell to `site/*.html` and forgets to
 *     wire in the router.
 *   - Removes the router script from an existing shell without
 *     deleting the shell from the SHELLS list here.
 *
 * Source of truth: NAV_MAIN + NAV_ACCOUNT + NAV_ADMIN in
 * `site/assets/dashboard-chrome.js`. Keep this list in lockstep.
 *
 * Why this lives in worker/
 * -------------------------
 * The `site/` directory has no test runner; worker/ is the closest
 * package with vitest configured. Reading the static HTML straight
 * from disk doesn't depend on any Worker runtime, just node:fs.
 */

/// <reference types="node" />
// ^ Pulls Node typings in for THIS file only. Worker's tsconfig.json
// pins `types` to ["@cloudflare/workers-types"] so production source
// code can't accidentally rely on Node APIs; the test file needs
// node:fs to read static HTML from disk and would otherwise fail
// typecheck even though vitest runs it on Node at runtime.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// Vitest's cwd when running this suite is the `worker/` package root
// (vitest is invoked as `npx vitest` from that directory). The static
// site lives one level up at `../site/`, so a simple relative path
// avoids pulling in `node:path` / `node:url` for resolve() — those
// modules' types aren't declared in worker/tsconfig.json (it only
// pulls in @cloudflare/workers-types), and adding @types/node just
// for this test would pollute the runtime type surface.
const SITE_DIR = "../site";

/**
 * Every dashboard shell that participates in SPA navigation. Each one
 * boots an `AMCP_SHELL.boot({...})` flow and links out to its siblings
 * via plain `<a href="/{Page}.html">` tags. Without the router script
 * loaded, every such click triggers a full page reload — the bug this
 * test prevents.
 */
const DASHBOARD_SHELLS = [
  // NAV_MAIN
  "app.html",
  "BusinessProfile.html",
  "Mentions.html",
  "TrafficImpact.html",
  "CompetitorRadar.html",
  "A2APipeline.html",
  "ActivityFeed.html",
  // NAV_ACCOUNT
  // NOTE: TeamAccess.html exists in production deploys but is untracked
  // in this repo (`git ls-files site/TeamAccess.html` errors). Flagged
  // separately to the maintainer; cannot be enforced here until that
  // file lands in version control.
  "Settings.html",
  "Billing.html",
  // NAV_ADMIN (rendered when user_role === 'admin')
  "admin.html",
  "admin/tenants.html",
  "admin/queries.html",
  "admin/experiments.html",
] as const;

describe("dashboard shells load the SPA router", () => {
  for (const shell of DASHBOARD_SHELLS) {
    it(`${shell} includes <script src="/js/v2/router.js">`, () => {
      const html = readFileSync(`${SITE_DIR}/${shell}`, "utf-8");
      // Tolerate whitespace + optional attrs in any order. The required
      // shape is a <script> tag whose src attribute resolves to the
      // exact router path. Other attrs (type, defer, etc.) are fine.
      expect(html).toMatch(/<script[^>]+src="\/js\/v2\/router\.js"[^>]*>\s*<\/script>/);
    });
  }
});

describe("dashboard shells: SPA router load order", () => {
  // Defensive: router.js depends on shell.js exposing
  // window.AMCP_SHELL_MOUNT_BANNER / *_RENDER_ERROR. If router.js loads
  // before shell.js, those helpers are undefined when the first
  // navigation fires and the router crashes silently in production.
  // Order must be: shell.js → router.js → module script (overview.js
  // etc). This test only enforces shell.js → router.js because the
  // module-vs-router order is enforced per-shell by where each script
  // sits in the source order.
  for (const shell of DASHBOARD_SHELLS) {
    it(`${shell} loads router.js AFTER shell.js`, () => {
      const html = readFileSync(`${SITE_DIR}/${shell}`, "utf-8");
      const shellIdx  = html.search(/<script[^>]+src="\/js\/v2\/shell\.js"/);
      const routerIdx = html.search(/<script[^>]+src="\/js\/v2\/router\.js"/);
      expect(shellIdx).toBeGreaterThan(-1);
      expect(routerIdx).toBeGreaterThan(-1);
      expect(routerIdx).toBeGreaterThan(shellIdx);
    });
  }
});
