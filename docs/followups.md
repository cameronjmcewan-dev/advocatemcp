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

### ~~Eight hosted test tenants stuck in pending state~~ RESOLVED
Apr 12 — cleaned 12 pending test tenants from D1, removed orphaned test user cameronjmcewan@gmail.com.

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

## Onboarding schema extension — deferred hardening (April 2026)

From code review of the Task 3 `/register` rewrite (commit `013b8d6`):

1. **Slug race condition.** `registerRouter.post("/register", ...)` does a `SELECT` for slug uniqueness then an `INSERT` — not atomic. Two concurrent requests with the same business name can both pass the check and one hits `SQLITE_CONSTRAINT_UNIQUE`, currently returning a generic 500. Fix: either wrap pick+INSERT in `db.transaction()` with bounded retries on unique violation, or append `crypto.randomBytes(2).toString('hex')` to collisions. Low practical risk today, important before onboarding scales.
2. **Error response shape inconsistency.** `/register` returns `{ error, issues[] }` on 400 and `{ error, message }` on 500; sibling routes (`agent.ts`, `analytics.ts`) return flat `{ error: string }`. Standardize across Express routes in a dedicated pass.
3. **`wellknown_url` placeholder in /register response.** Currently returns literal `"https://<your-domain>/.well-known/ai-agent.json"`. Either derive from the business's `website` or drop the field entirely.
4. **32-column INSERT fragility.** The `INSERT INTO businesses` statement in `register.ts` has three parallel lists (columns, placeholders, bind values) that must stay aligned as the schema grows. Consider a schema-driven INSERT helper (`[["col", value], ...]`) or add a parity test asserting list lengths match.

## Task 7 — manual smoke test

Run this before deploying the onboarding schema extension to production. It verifies that the
public onboard endpoint correctly writes blob columns to D1 when a full wizard payload is
submitted. Start a local wrangler dev session in one terminal, then in a second terminal:

```bash
curl -X POST http://localhost:8787/api/onboard/public \
  -H "Content-Type: application/json" \
  -d '{
    "slug":"smoke-plumbing-co",
    "name":"Smoke Test Biz",
    "email":"owner@smoke.example.com",
    "plan":"base",
    "profile":{
      "name":"Smoke Test Biz",
      "description":"smoke",
      "category":"plumber",
      "location":"Boise, ID",
      "services":["drain"],
      "star_rating":4.5,
      "review_count":10,
      "hours_json":{"mon":{"open":"08:00","close":"17:00"},"tue":null,"wed":null,"thu":null,"fri":null,"sat":null,"sun":null,"emergency_24_7":true},
      "credentials_json":{"licenses":[{"name":"ID","number":"1"}],"insured":true,"bonded":false,"certifications":[]}
    }
  }'
```

Expected: 201 response with `checkoutUrl`. Then confirm D1 received the blob columns:

```bash
npx wrangler d1 execute advocatemcp-auth --local \
  --command="SELECT slug, hours_json, credentials_json FROM businesses WHERE business_name='Smoke Test Biz'"
```

Expected: one row with populated JSON columns containing `emergency_24_7` and `insured` fields.

## Task 6 code-review followups (commit 33ffb52)

1. **Railway forward DRY / drift test** — `worker/src/routes/stripe.ts` `registerBusinessOnRailway` has ~15 repetitive `if (profile.X !== undefined) body.X = …` lines. Silent-drift hazard vs `server/src/schemas/business.ts`. Consider extracting `FORWARDED_BLOBS` + `FORWARDED_STRINGS` tuples and looping. OR lean on the new shape-assertion test to catch drift at PR time.

2. **Empty-string string handling in Railway forward** — `typeof X === "string"` accepts `""` which may violate downstream zod `.min(1)` on some fields (`description`, `category`, `tone`, etc.). Decide whether to tighten at ingress (validator) or at forward (non-empty check). Add `.trim().length > 0` guard if needed.
