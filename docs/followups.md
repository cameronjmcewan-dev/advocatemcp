# AdvocateMCP Followups

Items captured from development sessions that need attention in future focused work.
Sorted by urgency: blockers first, then real bugs, then polish, then research.

Last updated: 2026-04-13 (Sunday night sprint)

## Blockers — ship before the next real paying customer

### DNS custom hostname routing
Workman Copy Co's domain (www.workmancopyco.com) currently returns 522 for AI crawler traffic.
The worker code is fully prepared to handle custom hostname requests (BUSINESS_MAP KV lookup,
cf-custom-hostname header fallback, getTenant proxy logic), but Cloudflare's Workers Routes
layer never sends the traffic to the worker because there's no route pattern that matches
arbitrary custom hostnames in the advocatemcp.com zone.

Attempted fix (2026-04-12): added a `*/*` wildcard Workers Route on the advocatemcp.com zone.
This caught custom hostname traffic correctly but ALSO stole traffic from the Cloudflare Pages
marketing site, breaking advocatemcp.com for ~30 min. The assumption that "Pages custom domains
take precedence over Workers Routes" was empirically wrong for zone-wide wildcards. Reverted
in commit bbbf572.

Correct approach: use Cloudflare's `custom_origin_server` setting on each registered custom
hostname via the Cloudflare API, pointing each one explicitly at the worker. This should happen
during the Phase F onboarding flow's custom hostname registration step, not as a zone-wide
route. Requires understanding Cloudflare for SaaS's custom_origin_server field and adding an
API call to the existing registration code.

Key architectural note: `wrangler rollback` does NOT revert Workers Routes — it only reverts
the worker script. To fully revert a deploy that changed routes, edit wrangler.toml in git and
redeploy. Learned the hard way tonight.

### Stripe webhook secret rotation
STRIPE_WEBHOOK_SECRET was accidentally leaked into shell history via printf during debugging
on 2026-04-12 afternoon. Rotate via Stripe dashboard + `wrangler secret put STRIPE_WEBHOOK_SECRET`
and verify the next webhook still fires correctly.

## Real bugs that shipped

### Post-checkout redirect
After Stripe checkout succeeds in the wizard flow, customers redirect to the marketing site
home page instead of a proper confirmation/activation page. Need to investigate where the
Stripe success_url is configured and what it should point at. Bug A from earlier today.

### Eight hosted test tenants stuck in pending state
D1 businesses table has 8 rows with api_key = 'pending' from test wizard runs that never
completed Railway registration (before tonight's hosted-tenant-onboarding-flow shipped).
Slugs: asdf, asdf1, debug-test, moreland-property-group, pro-probe, workman,
test-phase-b-v2-pro, test-free-biz. Produce DELETE statements, review carefully, run by hand.

## Polish — affects customer experience but not blocking

### Activation page styling
Activation page HTML doesn't match Phase D dashboard visual language. Bug C / Phase D follow-up.

### Dashboard domains section for hosted tenants
Dashboard should conditionally hide the DNS management UI for hosted tenants (they don't need
it — their subdomain is managed automatically). Currently shows to everyone.

### Dashboard sidebar and breadcrumb
Max's logo fix (commit 19c73c2) addressed the shared marketing header but not the dashboard
sidebar and breadcrumb. Dashboard.html still has placeholder treatment.

### Dead js file
site/js/dashboard-activate.js exists (131 lines) but is never loaded by dashboard.html. Either
wire it up or delete it.

## Research / investigate

### Max's account role origin
Max's user record was created on 2026-04-08 with role=admin, by a code path that isn't
`/admin/create-client` (that endpoint correctly defaults to client role). Figure out what
created the account four days ago. Probably harmless historical test data, but worth knowing.

### users.tenant_id field
Field exists on the users table, refresh handler reads it, but nothing uses it for authorization
per earlier Claude Code investigation. Is it dead? Can it be removed?

### /demo/:slug architectural concerns
- Rate limiting missing
- Hardcoded crawler user agent (GPTBot only)
- Paid Claude API calls on every public GET
- 8 open questions from the rearchitecture plan §10

## Infrastructure / hygiene

### Wrangler 4.x upgrade
Currently on 3.114.17. Wrangler warns on every command. Upgrade via
`npm install --save-dev wrangler@4`. Test carefully — wrangler is the deploy tool.

### Admin retry endpoint
For failed Railway registrations, currently there's no clean way to retry the Railway call
for a tenant whose Stripe webhook-time registration failed. Worker has the data, just need an
admin endpoint to trigger the retry.

### Runbooks
Before first real paying customer:
- docs/secrets-runbook.md — what secrets exist, how to rotate each one
- docs/manual-onboarding-runbook.md — step-by-step for admin-provisioned customers (this is
  the path used for Workman Copy Co tonight)

### Phase E worker HTML deprecation cleanup
Old worker-rendered HTML routes that are superseded by Phase D dashboard. Identify and delete.

### Phase F Part 3
Async retry for failed email sends. Currently Resend failures are logged but not retried.

## Brand / design

### Logo vectorization
Physical enamel pin logo exists but not as a vector file. vectorizer.ai output was unusable
(traced photo artifacts as brush strokes). Options: find the original designer/manufacturer
source file, hand-trace in Figma, or have Claude generate placeholder SVG based on geometry.

### Dark maroon background color
Use DigitalColorMeter to capture precise hex value from the velvet photo, then decide whether
to introduce as new brand color alongside existing teal or do a wholesale rebrand.

## Known architectural constraints learned this weekend

1. Workers Routes are zone-level config, not worker-script config. `wrangler rollback` reverts
   the script but not the routes.
2. Zone-wide wildcard Workers Routes (`*/*`) DO catch traffic that's otherwise served by
   Cloudflare Pages on the same zone. The documented Pages>Workers Route precedence doesn't
   hold in practice for zone-wide wildcards.
3. Custom hostname registration creates the DNS/SSL binding but does NOT wire the worker as
   the origin — that's a separate `custom_origin_server` setting.
4. The `/admin/create-client` endpoint only updates password on existing users; it does not
   change role or full_name. Consider this when reusing the endpoint.
