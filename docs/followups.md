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

## Task 8 — manual smoke test

Run these against `npx wrangler dev` from `worker/`:

```bash
# Save a draft at step 3
curl -X POST http://localhost:8787/api/onboard/draft \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","step":3,"payload":{"name":"Acme","category":"plumber"}}'
# Expected: 200 { ok: true, email: "test@example.com", step: 3, updated_at: "..." }

curl http://localhost:8787/api/onboard/draft/test@example.com
# Expected: 200 with the saved payload
```

## Task 8 — hardening followups

1. **256 KB payload cap uses string length, not UTF-8 bytes.** `TextEncoder().encode(payloadJson).byteLength` would be correct. Low severity since wizard payloads are ASCII-heavy, but adversarial clients could push ~1 MB via 4-byte emoji.

2. **No TTL/cleanup for abandoned drafts.** Rows accumulate in `onboarding_drafts` indefinitely. Add a cron to sweep rows where `updated_at < now() - 90 days`, or a DELETE endpoint.

3. **No rate limiting on POST /api/onboard/draft.** Unauthenticated, can be hammered to fill D1. Consistent with `/api/onboard/public` (also unrated) — solve together.

## Task 9 — builder followups

From code review of `server/src/agent/builder.ts` (commit `78254ed`):

- **Ratings platform gap.** `ratings_json` schema supports `facebook` and `bbb` keys (see `server/src/schemas/business.ts` RatingsSchema) but `builder.ts` only emits Google and Yelp lines. Iterate the known sources or add explicit cases so BBB/Facebook/Angi ratings surface in prompts.
- **Double-parse of JSON blobs.** `buildSystemPrompt` and `getIntentEmphasis` each call `parseJsonSafe` on the same 4 blobs. Small perf win + cleaner code to parse once in `buildSystemPrompt` and pass the parsed values into `getIntentEmphasis` as parameters.
- **Extract `formatProfileBlock(business)` helper.** `buildSystemPrompt` is ~90 lines and half is parse/push logic. Next wizard session (customer_quotes_json, case_stories_json) will push it past readable. Extract before then.
- **Duplicate "Availability" label.** When both `business.availability` and `hours_json.emergency_24_7` are set, the prompt emits two `- Availability: ...` lines. Rename the structured one to `- Emergency availability:` to disambiguate.
- **"standard hours" fallback in getIntentEmphasis emergency branch** may mislead Claude when no availability data exists. Consider neutral wording like "check the business for hours" or fall through to a shorter emphasis string.

## Task 10 — deploy + smoke checklist

Run these before and after deploying the `onboarding-schema-extension` branch to production.

### Pre-deploy smoke test (local Railway server)

Start the local Railway server (`cd server && npm run dev`) then run the full round-trip:

**Step 1 — register a test business with wizard blob fields:**

```bash
curl -X POST http://localhost:3000/register \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Apex Plumbing",
    "description": "Licensed plumber in Austin TX serving residential and commercial customers.",
    "category": "plumber",
    "location": "Austin, TX",
    "services": ["drain cleaning", "water heater repair", "leak detection"],
    "phone": "512-555-0100",
    "website": "https://apexplumbing.example.com",
    "hours_json": {
      "mon": {"open":"07:00","close":"19:00"},
      "tue": {"open":"07:00","close":"19:00"},
      "wed": {"open":"07:00","close":"19:00"},
      "thu": {"open":"07:00","close":"19:00"},
      "fri": {"open":"07:00","close":"19:00"},
      "sat": {"open":"08:00","close":"15:00"},
      "sun": null,
      "emergency_24_7": true
    },
    "credentials_json": {
      "licenses": [{"name": "Master Plumber", "number": "TX-MP-88421"}],
      "insured": true,
      "bonded": true,
      "certifications": ["Backflow Prevention"]
    },
    "pricing_json_v2": {
      "ranges": [{"service": "drain cleaning", "low": 150, "high": 400, "unit": "flat"}],
      "free_estimates": true,
      "call_for_quote": false
    },
    "ratings_json": {
      "google": {"rating": 4.8, "count": 312},
      "yelp": {"rating": 4.6, "count": 88}
    }
  }'
```

Save the returned `slug` and `api_key` for the queries below.

**Step 2 — emergency intent query (replace SLUG and API_KEY):**

```bash
curl -X POST http://localhost:3000/agents/SLUG/query \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer API_KEY" \
  -d '{"query": "I have a burst pipe emergency right now, who can help 24/7?", "crawler_agent": "PerplexityBot"}'
```

Expected assertion: response mentions 24/7 emergency availability and references the licensed/insured status.

**Step 3 — affordable intent query:**

```bash
curl -X POST http://localhost:3000/agents/SLUG/query \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer API_KEY" \
  -d '{"query": "How much does drain cleaning cost? Looking for affordable plumber.", "crawler_agent": "GPTBot"}'
```

Expected assertion: response mentions the $150–$400 range and free estimates.

### Production deploy sequence

Run from `worker/` after merging `onboarding-schema-extension` to `main`:

```bash
# 1. Apply the D1 migration for the new onboarding blob columns
npx wrangler d1 execute advocatemcp-auth --remote --file=migrations/0006_onboarding_profile.sql

# 2. Deploy the worker
npx wrangler deploy
```

Verify the deploy with the Task 7 and Task 8 smoke tests in this file (sections above), pointing at the production worker URL instead of localhost.

### Post-deploy verification

Re-run the emergency and affordable intent queries against the production Railway URL to confirm the builder is correctly reading wizard blob fields from the live SQLite database.

### Rollback

Worker rollback: `wrangler rollback` reverts the worker script but NOT Workers Routes — if routes were changed, redeploy from the prior wrangler.toml commit. Railway is additive-safe: the new D1/SQLite columns (`hours_json`, `services_json_v2`, `pricing_json_v2`, `credentials_json`, `ratings_json`, `customer_quotes_json`, `case_stories_json`, `lead_routing_json`) are all optional nullable columns, so the old handler simply ignores them — no data loss from reverting the Railway deploy. To fully roll back Railway, redeploy the prior git SHA via the Railway dashboard.

## P3 Competitor Radar — v1.1 candidates

- **Subdomain-root matching.** Strict v1 match treats `shop.tenant.com` as NOT `tenant.com`. Revisit after 30 days of production data if false-negative rate is material.
- **Owned-presence aliases.** If tenants report "Perplexity cited my Yelp/Google Biz/Facebook/BBB listing and you didn't count it," add `tenant_domain_aliases` table and widen `isCitationOfTenant`. Belongs in P4.
- **LLM-generated phrasing variants.** v1 uses 3 fixed templates. If citation rates are bimodal (consistently cited vs. never), swap in LLM-generated variants. Producer-function swap — no schema change.
- **OpenAI Responses API (P3 v1.1).** Add `bot='openai'` polling once the web-search tool-call output schema stabilizes.
- **Per-tenant budget caps.** v1 uses a single global daily cap. Add per-tenant caps keyed by plan tier if one tenant dominates spend.
- **Poll + citation outer transaction (Task 10 deferred).** `pollAll` inserts the poll row and then inserts citations in a separate transaction. A process crash between the two leaves an orphan poll row with zero citations that still counts in `citation_rate`. Wrap both in a single outer transaction.
- **Losses endpoint N+1 (Task 11 deferred).** `GET /api/competitor-radar/:slug/losses?limit=200` issues 1 + N queries (one per loss poll to fetch its top citations). Rewrite as a single `LEFT JOIN LATERAL` or window-function query when row counts grow.
- **Pro-plan gate on basket/summary/losses routes (Task 12 deferred).** The three HTTP read/write endpoints in `competitorRadarRouter` gate on API key only, not on `businesses.plan='pro'`. `seedBasketIfEmpty` and `pollAll` already enforce Pro — a base-tier tenant can still GET an empty `/summary` or POST to the basket with no effect on polling, but adding a `requirePlan('pro')` middleware would close the loop and return 403.
