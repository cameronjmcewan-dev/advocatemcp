# Self-Healing Custom Hostname Activation — Design Spec

**Date:** 2026-04-14
**Status:** Approved for implementation
**Supersedes:** `docs/followups.md` → "DNS custom hostname routing" blocker

## Problem

Custom tenant hostnames (e.g. `www.workmancopyco.com`) registered through Cloudflare for SaaS return 522 for AI crawler traffic. The Worker script is ready to handle them (KV lookup, `cf-custom-hostname` header, `getTenant` proxy), but Cloudflare's edge never routes traffic *to* the Worker because the custom hostname records were created without a `custom_origin_server` field. Cloudflare has no target to forward the traffic to.

A prior fix attempt (commit `bbbf572`, 2026-04-12) added a zone-wide `*/*` Workers Route to catch custom hostname traffic. It also captured traffic for the `advocatemcp.com` marketing Pages site — breaking the marketing site for ~15 minutes until revert. `wrangler rollback` does not revert Workers Routes, only the Worker script. That attempt is not retryable.

## Goal

Every Cloudflare custom hostname managed by AdvocateMCP should have a `custom_origin_server` field pointing at `customers.advocatemcp.com` (the Worker's route-bound hostname), plus consistent SSL settings. The fix must be robust against partial-failure and future Cloudflare SaaS field additions.

## Architecture

Introduce a **declared spec** for what every tenant's Cloudflare custom hostname should look like. On every `POST /admin/domains/activate` call, compare the declared spec to the current CF record and PATCH any drift. New hostnames are created with the spec; existing hostnames are reconciled toward it. Same code path, same endpoint.

This is a reconciliation pattern (desired state → converge): Kubernetes-style, not event-sourced. The hostname spec is a declarative target, not a sequence of imperative fix commands. If Cloudflare for SaaS changes tomorrow, you edit the spec and every tenant converges on next activate touch.

## Components

### 1. Hostname spec (new file: `worker/src/lib/hostnameSpec.ts`)

A single pure function returning the desired Cloudflare custom hostname configuration:

```ts
export interface CustomHostnameSpec {
  hostname: string;
  custom_origin_server: string;
  ssl: {
    method: "txt";
    type: "dv";
    settings: { min_tls_version: "1.2" };
  };
}

export function desiredHostnameSpec(hostname: string): CustomHostnameSpec {
  return {
    hostname,
    custom_origin_server: CNAME_TARGET,  // imported from domains.ts
    ssl: {
      method: "txt",
      type: "dv",
      settings: { min_tls_version: "1.2" },
    },
  };
}
```

Single source of truth. If a new required field appears, it goes here — every tenant converges on next activate. `CNAME_TARGET` (`"customers.advocatemcp.com"`) is the existing constant in `domains.ts` line 16 — reused here, not hardcoded twice.

### 2. Reconciliation (new file: `worker/src/lib/reconcileHostname.ts`)

```ts
export interface ReconcileResult {
  ok: boolean;
  patched: boolean;
  drift: string[];          // field paths that differed; empty if no PATCH needed
  cfResult: Record<string, unknown>; // updated CF record (or input if no drift)
  error?: string;
}

export async function reconcileHostname(
  env: Env,
  cfResult: Record<string, unknown>,
  desired: CustomHostnameSpec,
): Promise<ReconcileResult>;
```

Only three fields compared:
- `custom_origin_server`
- `ssl.method`
- `ssl.settings.min_tls_version`

`ssl.type` is effectively constant. Verification status, provisioning status, `created_at` are CF-owned and excluded from reconciliation.

If `drift.length > 0`, PATCH `/custom_hostnames/:id` with only the drifting fields. Log `hostname_reconciled` event with before/after. Return updated `cfResult`.

### 3. Activation flow integration (modify: `worker/src/routes/domains.ts`)

Two touch points in `activateDomain`:

- **POST body** (line 336): build from `desiredHostnameSpec(domain)` instead of inline literal. New hostnames are correct from creation.
- **"Already exists" branch** (line 380–392): after fetching the existing record, call `reconcileHostname(env, existing, desiredHostnameSpec(domain))` before `buildActivateSuccess`. Pass the reconciled `cfResult` forward.

`buildActivateSuccess` is unchanged — it receives a reconciled record transparently.

### 4. Response shape extension

On reconcile-triggered PATCH, the 200 response body gains an optional field:

```json
{
  "ok": true,
  "slug": "...",
  "domain": "...",
  "status": "already_exists",
  "reconcile_summary": {
    "patched": true,
    "drift": ["custom_origin_server", "ssl.settings.min_tls_version"]
  }
}
```

When no drift is detected, `reconcile_summary` is omitted entirely (existing response shape preserved — backward compatible). New hostnames (the POST-create branch) also omit it, since the spec is applied at creation.

### 5. New failure mode

Add to `ActivateFailReason`:
- `cf_reconcile_error` — PATCH failed. Distinct from `cf_api_error` (create failed) so operators can tell them apart.

## Data flow

```
admin → POST /admin/domains/activate
     → activateDomain()
        → desiredHostnameSpec(domain)                    [new]
        → cfRequest POST (with custom_origin_server)
        → if exists: fetch existing
          → reconcileHostname(existing, desired)         [new]
          → if drift: PATCH, log event
        → buildActivateSuccess (reconciled cfResult)
        → persist KV, D1, TENANT_DATA
     ← response (with reconcile_summary if drift was fixed)
```

## Error handling

- Reconcile PATCH fails → return `502 cf_reconcile_error` with detail. Hostname state is unchanged vs. before the call. Safe to retry.
- Origin discovery / slug validation / create POST paths unchanged.
- CF credentials missing (`CF_API_TOKEN`/`CF_ZONE_ID` unset) → existing KV-only fallback unchanged, reconcile is skipped along with the CF call.

## Testing

### Unit tests (new)

- `worker/src/lib/hostnameSpec.test.ts` — pure function, one assertion of the full returned object shape.
- `worker/src/lib/reconcileHostname.test.ts` — four cases:
  1. No drift → returns `{ patched: false, drift: [] }`, no PATCH fired
  2. Missing `custom_origin_server` → PATCH includes it, drift array reports `"custom_origin_server"`
  3. Wrong `min_tls_version` → PATCH, drift reports `"ssl.settings.min_tls_version"`
  4. PATCH fails → returns `{ ok: false, error }`, cfResult unchanged

### Integration tests (extend `worker/src/routes/domains.test.ts`)

- New hostname POST body includes `custom_origin_server: "customers.advocatemcp.com"`
- Existing hostname with missing `custom_origin_server` triggers one PATCH call
- Existing hostname already matching spec triggers **zero** PATCH calls
- PATCH failure surfaces as `502 cf_reconcile_error` on the endpoint

Mock CF via the existing `fetch` mock pattern used in the current `domains.test.ts`.

## Production rollout

1. Deploy Worker (`cd worker && npx wrangler deploy`).
2. Call `POST /admin/domains/activate` for Workman Copy Co's hostname with no body changes. The "already exists" branch fires, reconcile PATCHes `custom_origin_server`, response includes `reconcile_summary`.
3. Verify `www.workmancopyco.com` with a PerplexityBot UA returns 200 with an advocate response (not 522).
4. `wrangler tail` confirms the Worker is receiving the request.
5. Optional: backfill-curl any other tenant hostnames through the same activate endpoint (they'll self-heal if any drift exists, no-op otherwise).

## Files

### Create
- `worker/src/lib/hostnameSpec.ts` — declared spec function
- `worker/src/lib/hostnameSpec.test.ts`
- `worker/src/lib/reconcileHostname.ts` — diff + PATCH logic
- `worker/src/lib/reconcileHostname.test.ts`
- `docs/dns-routing.md` — operator-facing documentation of the spec + reconcile model

### Modify
- `worker/src/routes/domains.ts` — use spec in POST body + reconcile on "already exists" branch; add `cf_reconcile_error` to `ActivateFailReason`
- `worker/src/routes/domains.test.ts` — four new assertions
- `docs/followups.md` — mark "DNS custom hostname routing" blocker resolved

### Do not touch
- `AI_CRAWLERS` array in `worker/src/index.ts`
- `wrangler.toml` routes (no zone-wide wildcard — the existing warning comment stays)
- `worker/src/routes/activate.ts` — reconcile is transparent to the customer-facing wrapper
- Any portal / auth / Stripe / onboarding code outside the `domains.*` path

## Out of scope

- Scheduled cron-based reconciliation of all hostnames (no such cron exists today; activate-call-triggered reconciliation is sufficient for one paying customer)
- Repair endpoint `POST /admin/domains/:slug/repair` (considered and rejected — same code path as activate, one less surface)
- Bulk backfill script (only one hostname affected today)
- Workers for Platforms migration (architecturally stronger long-term, but Cloudflare for SaaS + `custom_origin_server` is sufficient and doesn't require rearchitecture)
- Changes to origin URL discovery, slug validation, SSL verification polling, or the admin status endpoint

## Acceptance criteria

1. `cd worker && npx vitest run && npx tsc --noEmit` — green
2. `cd worker && ./scripts/smoke-test.sh` — 18/18 pass (no regression in portal/auth)
3. Manually activated WCC hostname returns 200 with advocate response for a PerplexityBot UA hitting `www.workmancopyco.com`
4. `wrangler tail` shows the Worker receiving the request (not a 522 at CF edge)
5. `docs/followups.md` "DNS custom hostname routing" entry marked RESOLVED with commit SHA
