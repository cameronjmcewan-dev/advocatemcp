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
