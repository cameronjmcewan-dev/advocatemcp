# DNS Self-Healing Custom Hostname Activation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the "AI crawler traffic returns 522 on tenant custom hostnames" bug by making every `POST /admin/domains/activate` call declaratively reconcile each Cloudflare custom hostname toward a canonical spec that includes `custom_origin_server`.

**Architecture:** Declared hostname spec + reconcile-on-activate. New hostnames get the correct `custom_origin_server` field at creation. Existing hostnames get PATCHed to the spec on the "already exists" branch of activation. One code path, no new endpoints, no zone-wide wildcard routes.

**Tech Stack:** Cloudflare Worker (TypeScript strict), Cloudflare for SaaS API, vitest, wrangler.

**Spec:** `docs/superpowers/specs/2026-04-14-dns-self-healing-activation-design.md`

**Branch:** `feature/dns-self-healing-activation` (already created, 1 commit — spec doc only)

---

## File structure

### Create
- `worker/src/lib/hostnameSpec.ts` — pure function `desiredHostnameSpec(hostname)` returning the canonical CF custom hostname configuration. Single export.
- `worker/src/lib/hostnameSpec.test.ts` — one assertion of the returned object shape.
- `worker/src/lib/reconcileHostname.ts` — `reconcileHostname(env, cfResult, desired, cfRequest)` that diffs three fields and fires a PATCH only if drift exists.
- `worker/src/lib/reconcileHostname.test.ts` — four cases: no drift, missing field drift, wrong-value drift, PATCH failure.
- `worker/src/routes/domains.test.ts` — four integration assertions over `activateDomain` wrapping the self-heal flow.
- `docs/dns-routing.md` — operator-facing documentation of the spec + reconcile model.

### Modify
- `worker/src/routes/domains.ts` — import `desiredHostnameSpec` + `reconcileHostname`; use spec in POST body; reconcile on "already exists" branch; thread `ReconcileResult` through to `buildActivateSuccess`; add `cf_reconcile_error` to `ActivateFailReason`; extend success response with optional `reconcile_summary` field. Export `cfRequest` so reconcile tests can inject a mock.
- `docs/followups.md` — mark "DNS custom hostname routing" blocker RESOLVED with commit SHA.

### Do not touch
- `AI_CRAWLERS` array in `worker/src/index.ts`
- `wrangler.toml` routes
- `worker/src/routes/activate.ts` (customer-facing wrapper — reconcile is transparent to it)
- Any portal / auth / Stripe / onboarding code outside `domains.*`

---

## Task sequence

Six tasks. Each ends in a commit. Order is dependency-driven: pure functions first (1, 2), then the integration that uses them (3, 4), then docs (5), then production deploy (6).

---

### Task 1: Hostname spec (pure function)

**Files:**
- Create: `worker/src/lib/hostnameSpec.ts`
- Test: `worker/src/lib/hostnameSpec.test.ts`

- [ ] **Step 1: Write the failing test**

Create `worker/src/lib/hostnameSpec.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { desiredHostnameSpec } from "./hostnameSpec.js";

describe("desiredHostnameSpec", () => {
  it("returns the canonical CF custom hostname config for a given hostname", () => {
    const spec = desiredHostnameSpec("www.workmancopyco.com");
    expect(spec).toEqual({
      hostname: "www.workmancopyco.com",
      custom_origin_server: "customers.advocatemcp.com",
      ssl: {
        method: "txt",
        type: "dv",
        settings: { min_tls_version: "1.2" },
      },
    });
  });

  it("passes through the hostname verbatim without lowercasing or trimming", () => {
    const spec = desiredHostnameSpec("Foo.Example.Com");
    expect(spec.hostname).toBe("Foo.Example.Com");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd worker && npx vitest run src/lib/hostnameSpec.test.ts
```

Expected: FAIL with `Cannot find module './hostnameSpec.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `worker/src/lib/hostnameSpec.ts`:

```ts
/**
 * Canonical Cloudflare custom hostname configuration for AdvocateMCP tenants.
 *
 * This is the single source of truth for what every tenant's CF custom hostname
 * record should look like. New hostnames are created with this spec; existing
 * hostnames are reconciled toward it via reconcileHostname().
 *
 * If Cloudflare for SaaS introduces a new required field, add it here — every
 * tenant converges on next activate-call touch. No per-tenant special-casing.
 */

export interface CustomHostnameSpec {
  hostname: string;
  custom_origin_server: string;
  ssl: {
    method: "txt";
    type: "dv";
    settings: { min_tls_version: "1.2" };
  };
}

// Kept in sync with CNAME_TARGET in worker/src/routes/domains.ts.
// Duplicated literal (not imported) to keep this lib file free of route-layer
// dependencies. If this value changes, update domains.ts line 16 in the same
// commit.
const CNAME_TARGET = "customers.advocatemcp.com";

export function desiredHostnameSpec(hostname: string): CustomHostnameSpec {
  return {
    hostname,
    custom_origin_server: CNAME_TARGET,
    ssl: {
      method: "txt",
      type: "dv",
      settings: { min_tls_version: "1.2" },
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd worker && npx vitest run src/lib/hostnameSpec.test.ts && npx tsc --noEmit
```

Expected: 2/2 tests pass; typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/cameronmcewan/Desktop/advocate/advocatemcp
git add worker/src/lib/hostnameSpec.ts worker/src/lib/hostnameSpec.test.ts
git commit -m "feat(lib): add desiredHostnameSpec canonical CF custom hostname config"
```

---

### Task 2: Reconcile function (pure, dependency-injected)

**Files:**
- Create: `worker/src/lib/reconcileHostname.ts`
- Test: `worker/src/lib/reconcileHostname.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `worker/src/lib/reconcileHostname.test.ts`:

```ts
/**
 * Tests for worker/src/lib/reconcileHostname.ts
 *
 * Dependency-inject the cfRequest function to avoid stubbing globalThis.fetch
 * (matches the FetchFn pattern in origin-discovery.test.ts).
 */

import { describe, it, expect, vi } from "vitest";
import { reconcileHostname, type CfRequestFn } from "./reconcileHostname.js";
import { desiredHostnameSpec } from "./hostnameSpec.js";
import type { Env } from "../types.js";

const env = {} as Env;  // reconcileHostname only passes env through to cfRequest

function cfRequestOk(data: Record<string, unknown>): CfRequestFn {
  return vi.fn().mockResolvedValue({ ok: true, data });
}

function cfRequestFail(message = "cf_error"): CfRequestFn {
  return vi.fn().mockResolvedValue({ ok: false, data: { error: message } });
}

describe("reconcileHostname", () => {
  const desired = desiredHostnameSpec("www.example.com");

  it("returns patched=false and fires no PATCH when cfResult matches spec", async () => {
    const actual = {
      id: "abc123",
      hostname: "www.example.com",
      custom_origin_server: "customers.advocatemcp.com",
      ssl: { method: "txt", settings: { min_tls_version: "1.2" } },
    };
    const cfRequest = cfRequestOk({});
    const result = await reconcileHostname(env, actual, desired, cfRequest);

    expect(result.ok).toBe(true);
    expect(result.patched).toBe(false);
    expect(result.drift).toEqual([]);
    expect(result.cfResult).toBe(actual);
    expect(cfRequest).not.toHaveBeenCalled();
  });

  it("PATCHes only the drifting fields when custom_origin_server is missing", async () => {
    const actual = {
      id: "abc123",
      hostname: "www.example.com",
      // custom_origin_server missing entirely (legacy record)
      ssl: { method: "txt", settings: { min_tls_version: "1.2" } },
    };
    const patched = { ...actual, custom_origin_server: "customers.advocatemcp.com" };
    const cfRequest = cfRequestOk({ result: patched });
    const result = await reconcileHostname(env, actual, desired, cfRequest);

    expect(result.ok).toBe(true);
    expect(result.patched).toBe(true);
    expect(result.drift).toEqual(["custom_origin_server"]);
    expect(result.cfResult).toEqual(patched);
    expect(cfRequest).toHaveBeenCalledTimes(1);
    expect(cfRequest).toHaveBeenCalledWith(
      env,
      "PATCH",
      "/abc123",
      { custom_origin_server: "customers.advocatemcp.com" },
    );
  });

  it("PATCHes ssl.settings.min_tls_version when it drifts from spec", async () => {
    const actual = {
      id: "abc123",
      hostname: "www.example.com",
      custom_origin_server: "customers.advocatemcp.com",
      ssl: { method: "txt", settings: { min_tls_version: "1.0" } },
    };
    const cfRequest = cfRequestOk({ result: { ...actual, ssl: { method: "txt", settings: { min_tls_version: "1.2" } } } });
    const result = await reconcileHostname(env, actual, desired, cfRequest);

    expect(result.patched).toBe(true);
    expect(result.drift).toEqual(["ssl.settings.min_tls_version"]);
    expect(cfRequest).toHaveBeenCalledWith(
      env,
      "PATCH",
      "/abc123",
      { ssl: { settings: { min_tls_version: "1.2" } } },
    );
  });

  it("returns ok=false with error when the PATCH call fails", async () => {
    const actual = {
      id: "abc123",
      hostname: "www.example.com",
      ssl: { method: "txt", settings: { min_tls_version: "1.2" } },
    };
    const cfRequest = cfRequestFail("cf_unreachable");
    const result = await reconcileHostname(env, actual, desired, cfRequest);

    expect(result.ok).toBe(false);
    expect(result.patched).toBe(false);
    expect(result.error).toContain("cf_unreachable");
    expect(result.cfResult).toBe(actual);  // unchanged on failure
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd worker && npx vitest run src/lib/reconcileHostname.test.ts
```

Expected: FAIL with `Cannot find module './reconcileHostname.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `worker/src/lib/reconcileHostname.ts`:

```ts
/**
 * Reconcile an existing Cloudflare custom hostname record against the declared
 * spec. Compares three fields (custom_origin_server, ssl.method,
 * ssl.settings.min_tls_version); PATCHes only the drifting fields.
 *
 * Fields excluded from reconciliation (CF-owned state, not desired-state):
 *   - verification / ownership_verification status
 *   - ssl.status / ssl.certificate / ssl.validation_records
 *   - created_at, id
 *
 * The cfRequest fn is injected so tests can mock the CF API without stubbing
 * globalThis.fetch. In production, domains.ts passes its existing cfRequest.
 */

import type { Env } from "../types.js";
import type { CustomHostnameSpec } from "./hostnameSpec.js";

export type CfRequestFn = (
  env: Env,
  method: string,
  path: string,
  body?: unknown,
) => Promise<{ ok: boolean; data: Record<string, unknown> }>;

export interface ReconcileResult {
  /** True if reconciliation completed without error (regardless of whether a PATCH was needed). */
  ok: boolean;
  /** True if a PATCH was fired. False if no drift was detected or PATCH failed. */
  patched: boolean;
  /** Field paths (in dot notation) that differed from the spec. Empty array = no drift. */
  drift: string[];
  /** CF record after reconciliation. Equals the input cfResult if no drift or on failure. */
  cfResult: Record<string, unknown>;
  /** Populated when ok === false. */
  error?: string;
}

export async function reconcileHostname(
  env: Env,
  cfResult: Record<string, unknown>,
  desired: CustomHostnameSpec,
  cfRequest: CfRequestFn,
): Promise<ReconcileResult> {
  const drift: string[] = [];
  const patchBody: Record<string, unknown> = {};

  // Field 1: custom_origin_server
  const actualOrigin = cfResult.custom_origin_server as string | undefined;
  if (actualOrigin !== desired.custom_origin_server) {
    drift.push("custom_origin_server");
    patchBody.custom_origin_server = desired.custom_origin_server;
  }

  // Field 2: ssl.settings.min_tls_version
  const actualSsl = (cfResult.ssl ?? {}) as Record<string, unknown>;
  const actualSettings = (actualSsl.settings ?? {}) as Record<string, unknown>;
  const actualTls = actualSettings.min_tls_version as string | undefined;
  if (actualTls !== desired.ssl.settings.min_tls_version) {
    drift.push("ssl.settings.min_tls_version");
    patchBody.ssl = { settings: { min_tls_version: desired.ssl.settings.min_tls_version } };
  }

  if (drift.length === 0) {
    return { ok: true, patched: false, drift: [], cfResult };
  }

  const id = cfResult.id as string | undefined;
  if (!id) {
    return {
      ok: false,
      patched: false,
      drift,
      cfResult,
      error: "reconcile failed: cfResult missing id",
    };
  }

  const patchRes = await cfRequest(env, "PATCH", `/${id}`, patchBody);
  if (!patchRes.ok) {
    const errMsg = (patchRes.data.error as string | undefined) ?? JSON.stringify(patchRes.data);
    return {
      ok: false,
      patched: false,
      drift,
      cfResult,
      error: `reconcile PATCH failed: ${errMsg}`,
    };
  }

  const updatedResult = (patchRes.data.result as Record<string, unknown>) ?? cfResult;
  return { ok: true, patched: true, drift, cfResult: updatedResult };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd worker && npx vitest run src/lib/reconcileHostname.test.ts && npx tsc --noEmit
```

Expected: 4/4 tests pass; typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/cameronmcewan/Desktop/advocate/advocatemcp
git add worker/src/lib/reconcileHostname.ts worker/src/lib/reconcileHostname.test.ts
git commit -m "feat(lib): add reconcileHostname diff-and-PATCH for CF custom hostnames"
```

---

### Task 3: Wire spec into POST body

**Files:**
- Modify: `worker/src/routes/domains.ts` (export `cfRequest`, build POST body from spec)
- Test: `worker/src/routes/domains.test.ts` (new file)

- [ ] **Step 1: Write the failing test**

Create `worker/src/routes/domains.test.ts`:

```ts
/**
 * Integration tests for worker/src/routes/domains.ts — specifically the
 * self-healing activation flow added in the DNS self-healing change.
 *
 * Scope: focused on the new behavior (POST body includes custom_origin_server;
 * reconcile fires on the already-exists branch; cf_reconcile_error surfaces
 * correctly). Does NOT retroactively cover unrelated existing paths (slug
 * validation, origin discovery, KV writes) — those remain without unit tests
 * for now by design (out of scope for this change).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock the CF API at the module boundary ─────────────────────────────────
// activateDomain calls the internal cfRequest fn, which calls fetch().
// We stub fetch() globally to control CF API responses per-test.

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

// Mock origin discovery so we don't need to stub a full HTTP redirect chain.
vi.mock("../lib/origin-discovery.js", () => ({
  discoverOriginUrl: vi.fn(async (domain: string) => ({
    ok: true,
    originUrl: `https://${domain}.example.squarespace.com`,
    finalHostname: `${domain}.example.squarespace.com`,
  })),
}));

// Mock TENANT_DATA upsert path so we don't need to mock KV fully.
vi.mock("./onboard", async () => {
  const actual = await vi.importActual<typeof import("./onboard")>("./onboard");
  return {
    ...actual,
    getTenant: vi.fn(async () => null),
    putTenant: vi.fn(async () => undefined),
    extractCfData: vi.fn(() => undefined),
  };
});

import { activateDomain } from "./domains.js";
import type { Env } from "../types.js";

function mockEnv(): Env {
  return {
    CF_API_TOKEN: "test-token",
    CF_ZONE_ID: "test-zone-id",
    API_BASE_URL: "https://advocate-production-2887.up.railway.app",
    API_KEY: "test-api-key",
    BUSINESS_MAP: {
      put: vi.fn(async () => undefined),
      get: vi.fn(async () => null),
    } as unknown as Env["BUSINESS_MAP"],
    DB: {
      prepare: () => ({
        bind: () => ({
          run: vi.fn(async () => undefined),
          first: vi.fn(async () => null),
        }),
      }),
    } as unknown as Env["DB"],
    TENANT_DATA: {
      get: vi.fn(async () => null),
      put: vi.fn(async () => undefined),
    } as unknown as Env["TENANT_DATA"],
  } as Env;
}

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("activateDomain — self-healing spec", () => {
  it("POSTs to CF with custom_origin_server in the body for a new hostname", async () => {
    // 1st fetch: slug validation (Railway profile) — succeed
    // 2nd fetch: origin discovery HEAD — mocked above (no call)
    // 3rd fetch: CF POST /custom_hostnames — succeed
    fetchMock
      .mockResolvedValueOnce(respond({ ok: true }))  // Railway profile 200
      .mockResolvedValueOnce(respond({                 // CF POST
        success: true,
        result: {
          id: "cf-hostname-123",
          hostname: "www.example.com",
          custom_origin_server: "customers.advocatemcp.com",
          ssl: { method: "txt", settings: { min_tls_version: "1.2" }, txt_name: "_acme.example.com", txt_value: "abc" },
        },
      }));

    const env = mockEnv();
    const result = await activateDomain(env, {
      domain: "www.example.com",
      slug: "example-slug",
      originUrl: null,
    });

    expect(result.ok).toBe(true);

    // Find the CF POST call (the one hitting api.cloudflare.com with method POST)
    const cfPost = fetchMock.mock.calls.find(
      ([url, init]) => typeof url === "string" && url.includes("api.cloudflare.com") && (init as RequestInit)?.method === "POST",
    );
    expect(cfPost).toBeDefined();
    const body = JSON.parse((cfPost![1] as RequestInit).body as string);
    expect(body.custom_origin_server).toBe("customers.advocatemcp.com");
    expect(body.hostname).toBe("www.example.com");
    expect(body.ssl).toEqual({
      method: "txt",
      type: "dv",
      settings: { min_tls_version: "1.2" },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd worker && npx vitest run src/routes/domains.test.ts
```

Expected: FAIL — either because `custom_origin_server` is not in the POSTed body, or because the body structure doesn't match the spec shape.

- [ ] **Step 3: Implement — modify `worker/src/routes/domains.ts`**

Open `worker/src/routes/domains.ts`. Make these three changes:

**3a. Add import at the top (after line 14):**

```ts
import { discoverOriginUrl } from "../lib/origin-discovery.js";
import { desiredHostnameSpec } from "../lib/hostnameSpec.js";
```

**3b. Export `cfRequest` so the reconcile path can use it later (and tests can inject mocks). Change line 53 from:**

```ts
async function cfRequest(
```

to:

```ts
export async function cfRequest(
```

**3c. Replace the CF POST body (line 336–343) from:**

```ts
  const { ok, data } = await cfRequest(env, "POST", "", {
    hostname: domain,
    ssl: {
      method: "txt",
      type: "dv",
      settings: { min_tls_version: "1.2" },
    },
  });
```

to:

```ts
  const { ok, data } = await cfRequest(env, "POST", "", desiredHostnameSpec(domain));
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd worker && npx vitest run src/routes/domains.test.ts && npx tsc --noEmit
```

Expected: 1/1 test pass; typecheck clean. Also run the full worker suite to verify no regression:

```bash
cd worker && npx vitest run
```

Expected: all previously-passing tests still pass (should be 115 + 2 (hostnameSpec) + 4 (reconcile) + 1 (this task) = 122).

- [ ] **Step 5: Commit**

```bash
cd /Users/cameronmcewan/Desktop/advocate/advocatemcp
git add worker/src/routes/domains.ts worker/src/routes/domains.test.ts
git commit -m "feat(domains): build CF POST body from desiredHostnameSpec"
```

---

### Task 4: Wire reconcile into the "already exists" branch + response shape

**Files:**
- Modify: `worker/src/routes/domains.ts` (reconcile on exists branch, add cf_reconcile_error, pass ReconcileResult through to buildActivateSuccess, include reconcile_summary in body)
- Modify: `worker/src/routes/domains.test.ts` (add 3 assertions)

- [ ] **Step 1: Write the failing tests**

Append to `worker/src/routes/domains.test.ts`:

```ts
describe("activateDomain — reconcile on existing hostname", () => {
  it("PATCHes an existing hostname missing custom_origin_server", async () => {
    fetchMock
      .mockResolvedValueOnce(respond({ ok: true }))  // Railway profile 200
      .mockResolvedValueOnce(respond({                 // CF POST — returns 1406 (already exists)
        success: false,
        errors: [{ code: 1406, message: "hostname already exists" }],
      }))
      .mockResolvedValueOnce(respond({                 // CF GET ?hostname= — return the legacy record
        success: true,
        result: [{
          id: "cf-legacy-456",
          hostname: "www.legacy.com",
          // custom_origin_server MISSING — this is the broken state
          ssl: { method: "txt", settings: { min_tls_version: "1.2" } },
        }],
      }))
      .mockResolvedValueOnce(respond({                 // CF PATCH — return the reconciled record
        success: true,
        result: {
          id: "cf-legacy-456",
          hostname: "www.legacy.com",
          custom_origin_server: "customers.advocatemcp.com",
          ssl: { method: "txt", settings: { min_tls_version: "1.2" } },
        },
      }));

    const env = mockEnv();
    const result = await activateDomain(env, {
      domain: "www.legacy.com",
      slug: "legacy-slug",
      originUrl: null,
    });

    expect(result.ok).toBe(true);
    expect(result.body.reconcile_summary).toEqual({
      patched: true,
      drift: ["custom_origin_server"],
    });

    // Confirm one PATCH fired with only the drifting field
    const cfPatch = fetchMock.mock.calls.find(
      ([url, init]) => typeof url === "string" && url.includes("api.cloudflare.com") && (init as RequestInit)?.method === "PATCH",
    );
    expect(cfPatch).toBeDefined();
    expect(JSON.parse((cfPatch![1] as RequestInit).body as string)).toEqual({
      custom_origin_server: "customers.advocatemcp.com",
    });
  });

  it("fires NO PATCH when the existing hostname already matches the spec", async () => {
    fetchMock
      .mockResolvedValueOnce(respond({ ok: true }))
      .mockResolvedValueOnce(respond({
        success: false,
        errors: [{ code: 1406, message: "hostname already exists" }],
      }))
      .mockResolvedValueOnce(respond({
        success: true,
        result: [{
          id: "cf-healthy-789",
          hostname: "www.healthy.com",
          custom_origin_server: "customers.advocatemcp.com",
          ssl: { method: "txt", settings: { min_tls_version: "1.2" } },
        }],
      }));

    const env = mockEnv();
    const result = await activateDomain(env, {
      domain: "www.healthy.com",
      slug: "healthy-slug",
      originUrl: null,
    });

    expect(result.ok).toBe(true);
    expect(result.body.reconcile_summary).toBeUndefined();

    const cfPatch = fetchMock.mock.calls.find(
      ([url, init]) => typeof url === "string" && url.includes("api.cloudflare.com") && (init as RequestInit)?.method === "PATCH",
    );
    expect(cfPatch).toBeUndefined();
  });

  it("returns 502 cf_reconcile_error when the PATCH fails", async () => {
    fetchMock
      .mockResolvedValueOnce(respond({ ok: true }))
      .mockResolvedValueOnce(respond({
        success: false,
        errors: [{ code: 1406, message: "hostname already exists" }],
      }))
      .mockResolvedValueOnce(respond({
        success: true,
        result: [{
          id: "cf-broken-999",
          hostname: "www.broken.com",
          ssl: { method: "txt", settings: { min_tls_version: "1.2" } },
        }],
      }))
      .mockResolvedValueOnce(respond({
        success: false,
        errors: [{ code: 9999, message: "cf unreachable" }],
      }, 502));

    const env = mockEnv();
    const result = await activateDomain(env, {
      domain: "www.broken.com",
      slug: "broken-slug",
      originUrl: null,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(502);
    expect(result.reason).toBe("cf_reconcile_error");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd worker && npx vitest run src/routes/domains.test.ts
```

Expected: 3/4 FAIL — the reconcile wiring doesn't exist yet, `reconcile_summary` is absent from response, `cf_reconcile_error` is not a valid `ActivateFailReason`.

- [ ] **Step 3: Implement the changes in `worker/src/routes/domains.ts`**

**3a. Add import for reconcileHostname** (near the top, with the other lib imports):

```ts
import { reconcileHostname, type ReconcileResult } from "../lib/reconcileHostname.js";
```

**3b. Add `cf_reconcile_error` to `ActivateFailReason`** (line 174–185):

```ts
export type ActivateFailReason =
  | "slug_not_registered"
  | "origin_url_invalid"
  | "origin_url_http"
  | "origin_url_unreachable"
  | "fetch_failed"
  | "fetch_timeout"
  | "self_loop"
  | "worker_loop"
  | "http_scheme"
  | "origin_5xx"
  | "cf_api_error"
  | "cf_reconcile_error";
```

**3c. Change `buildActivateSuccess` signature to accept optional `ReconcileResult`**:

Replace line 399–408 from:

```ts
/** Internal helper — persists state and assembles the success body. */
async function buildActivateSuccess(
  env: Env,
  domain: string,
  slug: string,
  cfResult: Record<string, unknown>,
  validatedOriginUrl: string | null,
  originUrlSource: "explicit" | "discovered" | "none",
  alreadyExisted = false,
): Promise<ActivateDomainResult> {
```

to:

```ts
/** Internal helper — persists state and assembles the success body. */
async function buildActivateSuccess(
  env: Env,
  domain: string,
  slug: string,
  cfResult: Record<string, unknown>,
  validatedOriginUrl: string | null,
  originUrlSource: "explicit" | "discovered" | "none",
  alreadyExisted = false,
  reconcile: ReconcileResult | null = null,
): Promise<ActivateDomainResult> {
```

**3d. In the success body (inside `buildActivateSuccess`), add `reconcile_summary` conditionally.** Locate the `return { ok: true, status: 200, body: { ... } }` statement near the end of `buildActivateSuccess` (currently around line 442–463). Add one line — the conditional spread — immediately after `instructions: generateDnsInstructions(domain, verificationTxt),`. The final block should read:

```ts
  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      slug,
      domain,
      cf_hostname_id: cfHostnameId,
      origin_url: validatedOriginUrl,
      origin_url_source: originUrlSource,
      cname_record: {
        type: "CNAME",
        host: domain,
        target: CNAME_TARGET,
      },
      txt_record: verificationTxt
        ? { type: "TXT", host: verificationTxt.host, value: verificationTxt.value }
        : null,
      status: alreadyExisted ? "already_exists" : "pending_verification",
      instructions: generateDnsInstructions(domain, verificationTxt),
      ...(reconcile?.patched
        ? { reconcile_summary: { patched: true, drift: reconcile.drift } }
        : {}),
    },
  };
```

Only the final `...(reconcile?.patched ... )` spread is new — the rest is reproduced verbatim from the existing function body so the diff is unambiguous.

**3e. Wire reconcile into the "already exists" branch.** Replace lines 379–393 from:

```ts
    // hostname already exists — look it up by hostname
    const listRes = await cfRequest(env, "GET", `?hostname=${encodeURIComponent(domain)}`);
    const results = listRes.data.result as Array<Record<string, unknown>> | undefined;
    const existing = results?.[0];
    if (!existing) {
      return {
        ok: false,
        status: 502,
        reason: "cf_api_error",
        body: { error: "Hostname already exists in CF but could not be retrieved", detail: data },
      };
    }
    // Idempotent success — reuse existing CF hostname record
    return buildActivateSuccess(env, domain, slug, existing, validatedOriginUrl, originUrlSource, /* alreadyExisted */ true);
  }
```

to:

```ts
    // hostname already exists — look it up by hostname
    const listRes = await cfRequest(env, "GET", `?hostname=${encodeURIComponent(domain)}`);
    const results = listRes.data.result as Array<Record<string, unknown>> | undefined;
    const existing = results?.[0];
    if (!existing) {
      return {
        ok: false,
        status: 502,
        reason: "cf_api_error",
        body: { error: "Hostname already exists in CF but could not be retrieved", detail: data },
      };
    }

    // Reconcile existing hostname against the declared spec. Fires at most one
    // PATCH if any of { custom_origin_server, ssl.settings.min_tls_version }
    // differs. No-op when already matching.
    const reconcile = await reconcileHostname(
      env,
      existing,
      desiredHostnameSpec(domain),
      cfRequest,
    );
    if (!reconcile.ok) {
      console.error(JSON.stringify({
        domains: true,
        event: "hostname_reconcile_failed",
        domain,
        slug,
        drift: reconcile.drift,
        error: reconcile.error,
      }));
      return {
        ok: false,
        status: 502,
        reason: "cf_reconcile_error",
        body: { error: "Reconcile PATCH failed", detail: reconcile.error },
      };
    }
    if (reconcile.patched) {
      console.log(JSON.stringify({
        domains: true,
        event: "hostname_reconciled",
        domain,
        slug,
        drift: reconcile.drift,
      }));
    }

    // Idempotent success — reuse (reconciled) CF hostname record
    return buildActivateSuccess(
      env,
      domain,
      slug,
      reconcile.cfResult,
      validatedOriginUrl,
      originUrlSource,
      /* alreadyExisted */ true,
      reconcile,
    );
  }
```

- [ ] **Step 4: Run the tests**

```bash
cd worker && npx vitest run src/routes/domains.test.ts && npx tsc --noEmit
```

Expected: 4/4 tests pass; typecheck clean. Then run the full suite:

```bash
cd worker && npx vitest run
```

Expected: all 122 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/cameronmcewan/Desktop/advocate/advocatemcp
git add worker/src/routes/domains.ts worker/src/routes/domains.test.ts
git commit -m "feat(domains): reconcile existing CF hostnames against spec on activate"
```

---

### Task 5: Operator documentation + mark followup RESOLVED

**Files:**
- Create: `docs/dns-routing.md`
- Modify: `docs/followups.md`

- [ ] **Step 1: Write `docs/dns-routing.md`**

Create `docs/dns-routing.md` with this content:

```markdown
# DNS routing for tenant custom hostnames

## Problem we solved

AI crawler traffic to tenant custom hostnames (e.g. `www.workmancopyco.com`) was returning 522 at Cloudflare's edge because the CF custom hostname records were registered without a `custom_origin_server` field. Without that field, Cloudflare has no target to forward traffic to — even though the Worker itself was ready to handle it.

A prior attempt to catch this traffic with a zone-wide `*/*` Workers Route captured the marketing Pages site by mistake and was reverted in commit `bbbf572`. That approach is not retryable.

## How it works now

Every tenant's Cloudflare custom hostname is defined by a **declared spec** in `worker/src/lib/hostnameSpec.ts`. The spec says:

- `custom_origin_server = "customers.advocatemcp.com"` — the Worker's route-bound hostname
- `ssl.method = "txt"` — domain validation via TXT record
- `ssl.type = "dv"` — domain-validated certificate
- `ssl.settings.min_tls_version = "1.2"` — TLS 1.2 floor

On every `POST /admin/domains/activate` call:

1. If the hostname is new, the spec is sent directly in the POST body — the record is created correctly the first time.
2. If the hostname already exists (CF returns error code 1406 or 1407), the Worker fetches the current record, compares against the spec, and PATCHes any drifting fields. No drift = no PATCH.

The response body includes an optional `reconcile_summary` field when a PATCH fired:

```json
{
  "ok": true,
  "status": "already_exists",
  "reconcile_summary": {
    "patched": true,
    "drift": ["custom_origin_server"]
  }
}
```

Absent `reconcile_summary` = no reconciliation was needed (new hostname, or existing hostname already matched spec).

## Failure modes

- `cf_api_error` (502) — the initial CF POST or GET failed.
- `cf_reconcile_error` (502) — the CF PATCH during reconciliation failed. The hostname state is unchanged; safe to retry.

Both are logged with the full CF response for debugging. In `wrangler tail`, watch for:
- `event: "hostname_reconciled"` — successful PATCH with the drift array
- `event: "hostname_reconcile_failed"` — PATCH failure with the error detail

## Adding a new CF SaaS field

If Cloudflare introduces a new required field (e.g. bot-management class, edge cert profile):

1. Add it to `CustomHostnameSpec` in `worker/src/lib/hostnameSpec.ts`
2. Add a drift-check branch to `reconcileHostname.ts`
3. Add a unit test for the new drift case
4. Deploy. Every tenant converges on the new spec on their next activate-call touch.

No migration script needed. Reconciliation is the migration.

## Backfilling a broken tenant

To fix a hostname already in a broken state (missing `custom_origin_server`, drifted TLS setting, etc), simply re-call the activation endpoint:

```bash
curl -X POST https://customers.advocatemcp.com/admin/domains/activate \
  -H "X-Admin-Secret: $ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"domain":"www.workmancopyco.com","slug":"workman-copy-co"}'
```

The response will include `reconcile_summary.drift` listing exactly which fields were fixed.
```

- [ ] **Step 2: Update `docs/followups.md`**

Open `docs/followups.md`. Find the "DNS custom hostname routing" section (starts around line 8). Change its heading line from:

```markdown
### DNS custom hostname routing
```

to:

```markdown
### ~~DNS custom hostname routing~~ RESOLVED
```

Then prepend these two lines inside the section (immediately after the heading):

```markdown
**Resolved in feature/dns-self-healing-activation** — self-healing reconcile on `POST /admin/domains/activate`. See `docs/dns-routing.md` for the full design, or `docs/superpowers/specs/2026-04-14-dns-self-healing-activation-design.md` for the original spec.

```

(Keep the rest of the section text intact as historical context.)

- [ ] **Step 3: Verify**

No tests to run. Just eyeball-check that:

```bash
head -30 docs/followups.md
```

shows the strikethrough heading and the Resolved note at the top of that section.

- [ ] **Step 4: Commit**

```bash
cd /Users/cameronmcewan/Desktop/advocate/advocatemcp
git add docs/dns-routing.md docs/followups.md
git commit -m "docs: document DNS routing spec + mark followup RESOLVED"
```

---

### Task 6: Deploy + production self-heal for Workman Copy Co

**Files:** none (production ops)

This task deploys the Worker, fires one reconcile call for WCC, and verifies the bot traffic now reaches the Worker instead of returning 522. **Each step below requires user consent and attention — a subagent should pause here and surface the deploy decision.**

- [ ] **Step 1: Full pre-deploy verification**

```bash
cd /Users/cameronmcewan/Desktop/advocate/advocatemcp/worker
npx vitest run
npx tsc --noEmit
```

Expected: all tests pass, typecheck clean.

- [ ] **Step 2: Open PR**

```bash
cd /Users/cameronmcewan/Desktop/advocate/advocatemcp
git push -u origin feature/dns-self-healing-activation
gh pr create --title "fix(domains): self-healing CF custom hostname reconciliation" --body "$(cat <<'EOF'
## Summary

Fixes the 522 AI-crawler bug on tenant custom hostnames (e.g. `www.workmancopyco.com`). Every `POST /admin/domains/activate` call now declaratively reconciles each CF custom hostname against a canonical spec that includes `custom_origin_server`.

- `worker/src/lib/hostnameSpec.ts` — canonical spec function
- `worker/src/lib/reconcileHostname.ts` — diff + PATCH logic
- `worker/src/routes/domains.ts` — spec in POST body; reconcile on already-exists branch; `cf_reconcile_error` failure mode; `reconcile_summary` response field
- `docs/dns-routing.md` — operator docs
- `docs/followups.md` — blocker marked RESOLVED

## Test plan

- [x] `cd worker && npx vitest run` — all tests green
- [x] `cd worker && npx tsc --noEmit` — clean
- [ ] After merge + deploy: re-activate `www.workmancopyco.com`, verify `reconcile_summary.drift` includes `custom_origin_server`
- [ ] Verify PerplexityBot UA against `https://www.workmancopyco.com` returns 200 with advocate response (not 522)
- [ ] `wrangler tail` shows Worker receiving the request with `event: "hostname_reconciled"`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Merge + deploy Worker**

```bash
gh pr merge --squash --delete-branch
git checkout main && git pull
cd worker && npx wrangler deploy
```

Expected: deploy succeeds, new version ID printed.

- [ ] **Step 4: Fire the reconcile for WCC**

You'll need `ADMIN_SECRET` from wrangler secrets. If not cached in shell, get it from the team's 1Password / deployment notes (do NOT log it).

```bash
curl -X POST https://customers.advocatemcp.com/admin/domains/activate \
  -H "X-Admin-Secret: $ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"domain":"www.workmancopyco.com","slug":"workman-copy-co"}'
```

Expected response: `{"ok": true, "status": "already_exists", "reconcile_summary": {"patched": true, "drift": ["custom_origin_server"]}, ...}`.

If `reconcile_summary` is absent, the record was already healthy (unlikely given the 522 symptom — if this happens, check CF dashboard for that hostname's `custom_origin_server` field manually).

- [ ] **Step 5: Verify end-to-end bot traffic**

Start `wrangler tail` in one terminal:

```bash
cd /Users/cameronmcewan/Desktop/advocate/advocatemcp/worker && npx wrangler tail
```

In another terminal, hit WCC's hostname with a PerplexityBot UA:

```bash
curl -sS -w "\nhttp_status=%{http_code}\n" \
  -H 'User-Agent: Mozilla/5.0 (compatible; PerplexityBot/1.0)' \
  https://www.workmancopyco.com/ 2>&1 | tail -20
```

Expected:
- HTTP 200 (not 522)
- Response body is the advocate's JSON (with `powered_by: "AdvocateMCP"`)
- `wrangler tail` shows a log line from the Worker's crawler-dispatch path

- [ ] **Step 6: Monitor for 10 minutes**

Keep `wrangler tail` running. Trigger one more crawler request to confirm the fix is stable. Check the Cloudflare dashboard's Analytics tab for the tenant zone — 522s should drop to zero.

- [ ] **Step 7: Close out**

No commit needed (changes were already merged in Step 3). Update CLAUDE.md "What is shipped today" list in a follow-up commit if desired:

```bash
cd /Users/cameronmcewan/Desktop/advocate/advocatemcp
# Edit /Users/cameronmcewan/Desktop/CLAUDE.md (outside the repo) to add:
# "Self-healing CF custom hostname reconciliation — tenant hostnames like
#  www.workmancopyco.com now get custom_origin_server reconciled on every
#  activate call; fixes AI-crawler 522s at the CF edge."
```

---

## Final verification (after all tasks)

- [ ] `cd worker && npx vitest run` — green (should be ~122 tests)
- [ ] `cd worker && npx tsc --noEmit` — clean
- [ ] `cd worker && ./scripts/smoke-test.sh --email ... --password ...` — 18/18 pass (portal/auth regression guard; requires admin creds)
- [ ] `docs/followups.md` DNS blocker marked RESOLVED
- [ ] `docs/dns-routing.md` exists and is linked from followups.md
- [ ] Production WCC verification: PerplexityBot → 200 advocate response, not 522
- [ ] One `hostname_reconciled` log line visible in `wrangler tail` for the WCC activate call
- [ ] PR merged to main
