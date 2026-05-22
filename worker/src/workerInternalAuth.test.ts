/**
 * Static integration test: worker-internal Railway calls must NEVER use
 * `Authorization: Bearer ${biz.api_key}`.
 *
 * Why this test exists
 * --------------------
 * `businesses.api_key` is intentionally a CUSTOMER concept — it's the
 * token a tenant uses for their own programmatic access to the public
 * `/agents/:slug/*` API surface. It is NOT the worker's identity. For
 * hosted-flow signups it stays at the literal string "pending" forever
 * (`onboard.ts:788` sets it; no later flow overwrites it for the hosted
 * cohort), so every worker→Railway call that uses it as Bearer auth
 * silently 401s.
 *
 * That bug surfaced as The Bamboo Brace's empty Business Profile (May
 * 2026): the dashboard's GET `/api/client/profile` returned `{}`,
 * every field rendered as a placeholder, and the user assumed the
 * onboarding form had asked them to re-enter data — when in fact the
 * data was present in D1 but unreachable from the worker because the
 * Bearer call to Railway failed auth.
 *
 * Correct pattern: worker-internal calls present the platform's global
 * `X-API-Key: ${env.API_KEY}` header. The worker IS the authorization
 * boundary (it checks `getUserBusinesses` before making the call);
 * Railway then trusts the worker. Mirrors the fix landed in PR #227
 * for the `/.well-known/ai-agent.json` and `/llms.txt` discovery
 * surfaces.
 *
 * Test mechanics
 * --------------
 * Reads `worker/src/routes/portal.ts` straight from disk and asserts
 * no occurrence of `Bearer ${biz.api_key}` survives. Catches drift if
 * anyone copy-pastes the old pattern into a new endpoint.
 */

/// <reference types="node" />
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const PORTAL_TS_PATH = "src/routes/portal.ts";

describe("worker-internal Railway auth: no Bearer biz.api_key (systemic invariant)", () => {
  it("portal.ts contains zero `Bearer ${biz.api_key}` occurrences", () => {
    const src = readFileSync(PORTAL_TS_PATH, "utf-8");
    // Tolerate whitespace + interpolation variants. The forbidden shape
    // is `Bearer ${biz.api_key}` inside a template string — that's the
    // only legitimate way to construct it in the file. Any future
    // refactor that introduces an alias (e.g. `const k = biz.api_key`)
    // would need its own check; for now this is the high-signal
    // single-pattern lock.
    const matches = src.match(/Bearer\s+\$\{biz\.api_key\}/g) ?? [];
    expect(matches.length).toBe(0);
  });

  it("portal.ts uses X-API-Key with env.API_KEY for worker-internal Railway calls", () => {
    // Sanity counterpart — at least ONE site should be using the
    // correct pattern. If this drops to zero, somebody backed the
    // whole fix out and the matching test above won't catch it
    // (zero forbidden + zero correct = false-positive green).
    const src = readFileSync(PORTAL_TS_PATH, "utf-8");
    const matches = src.match(/X-API-Key.*env\.API_KEY/g) ?? [];
    expect(matches.length).toBeGreaterThan(0);
  });
});
