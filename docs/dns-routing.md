# DNS routing for tenant custom hostnames

## The problem

AI crawler traffic to tenant custom hostnames (e.g. `www.example-tenant.com`) returned 522 at Cloudflare's edge in ~67ms — too fast to be an upstream timeout. CF was refusing to route the request to our Worker, even though:

- `status: active`, `ssl_status: active` on the custom hostname record
- `fallback_origin` was set and active to `customers.advocatemcp.com` since April 9
- `custom_origin_server` was set to `customers.advocatemcp.com`, a proxied DNS record in our SaaS zone (advocatemcp.com) bound to a Worker Route pattern `customers.advocatemcp.com/*`

A prior attempt to catch this traffic with a zone-wide `*/*` Workers Route captured the marketing Pages site by mistake and was reverted in commit `bbbf572`. A second attempt (`31f84b0`) pointed `custom_origin_server` at the Worker's workers.dev URL to escape a theorized same-account-zone loopback — CF silently rejected it with `verification_errors: "The custom origin hostname you specified does not exist on Cloudflare as a DNS record in your zone: advocatemcp.com"`. CF SaaS requires `custom_origin_server` to be an A/AAAA/CNAME record inside the SaaS zone.

## The actual fix

Two pieces are needed for a tenant hostname to route through CF SaaS to our Worker:

1. **CF SaaS custom hostname record** with `custom_origin_server = "customers.advocatemcp.com"` and `ssl.settings.min_tls_version = "1.2"`. Managed declaratively via `worker/src/lib/hostnameSpec.ts` and reconciled on every `POST /admin/domains/activate` call.

2. **A Worker Route `{tenant-hostname}/*` bound to our zone `advocatemcp.com`, script `advocatemcp-worker`.** Without this, CF SaaS has no Worker target to forward to: the request's URL hostname is the tenant domain (not `customers.advocatemcp.com`), so our existing `customers.advocatemcp.com/*` route pattern never matches. CF's edge returns a fast 522 without attempting any upstream.

The Worker Route does NOT need to be `*/*` (which breaks Pages). A per-tenant pattern is fine because CF SaaS custom hostnames are delegated to our zone for routing purposes — CF accepts `www.example-tenant.com/*` as a valid route pattern on zone `advocatemcp.com` even though the domain itself is external.

## How it works now

On every `POST /admin/domains/activate` call:

1. The CF custom hostname record is created or reconciled toward `desiredHostnameSpec()`. If drift is detected (missing `custom_origin_server`, wrong TLS floor, etc.) a targeted PATCH fires. See `worker/src/lib/reconcileHostname.ts`.
2. *(Currently manual until CF_API_TOKEN is rescoped — see followups.md)* A Worker Route `{hostname}/*` is created pointing to `advocatemcp-worker`. Today this must be added via the CF dashboard: `advocatemcp.com` zone → Workers Routes → Add route.

The activate response returns `reconcile_summary` when drift was patched:

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

## Admin endpoints

All require `X-Admin-Secret` header.

- `POST /admin/domains/activate` — register/reconcile the CF SaaS hostname.
- `GET /admin/domains/:slug/status` — synthesized verification/SSL status view.
- `GET /admin/domains/:slug/raw` — raw CF custom hostname record plus zone `fallback_origin`. Use this when `/status`'s summary hides a field (e.g. `verification_errors`).
- `POST /admin/domains/saas-fallback-origin` — idempotent PUT of the zone-level SaaS fallback origin. Body `{"origin": "hostname"}` (defaults to `customers.advocatemcp.com`).
- `POST /admin/domains/ensure-worker-route` — creates the per-tenant Worker Route. Body `{"hostname": "www.example.com"}`. Currently returns `Authentication error` because `CF_API_TOKEN` lacks `Workers Routes: Edit` scope; see followups.md to re-scope.

## Failure modes

- `cf_api_error` (502) — initial CF POST or GET failed.
- `cf_reconcile_error` (502) — CF PATCH during reconciliation failed. The hostname state is unchanged; safe to retry.

Log events in `wrangler tail`:
- `hostname_reconciled` — successful PATCH with the drift array.
- `hostname_reconcile_failed` — PATCH failure with the error detail.

## Adding a new CF SaaS field to the spec

If Cloudflare introduces a new required field (e.g. bot-management class, edge cert profile):

1. Add it to `CustomHostnameSpec` in `worker/src/lib/hostnameSpec.ts`.
2. Add a drift-check branch to `reconcileHostname.ts`.
3. Add a unit test for the new drift case.
4. Deploy. Every tenant converges on the new spec on their next activate-call touch.

No migration script needed. Reconciliation is the migration.

## Backfilling a broken tenant

To fix a hostname in a broken state:

1. **CF SaaS record drift** (missing `custom_origin_server`, wrong TLS, etc.): re-call the activation endpoint. The response's `reconcile_summary.drift` will list exactly which fields were fixed.

   ```bash
   curl -X POST https://customers.advocatemcp.com/admin/domains/activate \
     -H "X-Admin-Secret: $ADMIN_SECRET" \
     -H "Content-Type: application/json" \
     -d '{"domain":"www.example.com","slug":"example-slug","origin_url":"https://www.example.com"}'
   ```

2. **Missing Worker Route** (bot traffic returns 67ms 522 despite CF record being clean): add the route via CF dashboard or POST `/admin/domains/ensure-worker-route` (once CF_API_TOKEN is re-scoped).

3. **Diagnostic first** when unsure: `GET /admin/domains/:slug/raw` exposes `verification_errors` and `fallback_origin` that the synthesized `/status` endpoint hides.
