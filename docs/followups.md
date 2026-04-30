# AdvocateMCP Followups

Items captured from development sessions that need attention in future focused work.
Sorted by urgency: blockers first, then real bugs, then polish, then research.

Last updated: 2026-04-26

## Pre-outreach push required

### Push `feat/design-rollout` to deploy Pages changes
**Added 2026-04-26.** Three commits ahead of origin, worker is already
deployed via `wrangler deploy` for each, but Pages won't pick up the
site/ changes until the branch is pushed. The most user-visible item
is `site/activate.html` gaining `<meta name="robots" content="noindex, nofollow">`
— without push, the activation page is still indexable by search engines,
and any leaked share-link including the single-use `?t=` activation
token becomes discoverable.

Commits awaiting push:
- `89e117d` chore(security): pre-launch audit cleanup
- `e1aef03` fix(beta): read coupon from discounts[] array
- `5e64a60` fix(stripe): allow_promotion_codes on public onboard

```bash
git push origin feat/design-rollout
```

## Pre-outreach security audit (2026-04-26)

Ran 4 parallel audits (worker / server / frontend / dead-code) with focused
investigation agents. 0 CRITICAL, all real findings fixed, 5 deferred with
documented rationale. Worth keeping a few notes from this exercise:

- **Audit agent caveat:** the dead-code agent reported `handleRetryRailwayRegistration`,
  `handleActivationToken`, and `handleSaveDraft`/`handleLoadDraft` as dead because
  it searched only `worker/src/index.ts`. The actual route dispatch table is in
  `worker/src/routes/portal.ts` (lines 102, 140, 236, 239) — these handlers are
  all live. Future audits: tell agents that the route dispatch entrypoint is
  `portal.ts`, not `index.ts`.
- **Deferred (not security blockers):** timing-safe admin-key compare (high-entropy
  random secret over CF edge — network jitter dwarfs timing differential),
  activation-token replay (CF custom hostname creation is idempotent so impact
  is "wastes API quota"), SRI on Lucide / Chart.js CDNs (auth-gated dashboards
  limit blast radius), email-loop rate-limiting (Resend handles it at our scale).

## Operator action required

### `PER_TENANT_DAILY_BUDGET_USD` env var (Railway, optional)
**Added 2026-04-25, default lowered $5 → $2 same day.** Per-tenant daily
AI-spend cap on customer-facing endpoints (profile-score + verify-rating).
Default $2/tenant/day to keep gross-margin headroom against Base-tier
pricing ($149/mo ÷ 30 = $4.96/day revenue per tenant). Override via env
to raise for trusted tenants or tighten during incident. A tenant who
exceeds gets 503 with `scope: "tenant"` and a "contact support to raise"
message; global cap stays untouched and other tenants unaffected. See
`server/src/middleware/tenantBudget.ts`. Ops view via `GET /admin/budget`
(now returns `top_spenders_today`) and `GET /admin/budget/tenant/:slug`.

## Operator action required

### Backfill apex/www variants for existing tenants
**Added 2026-04-26.** Before today every tenant onboarded with one
hostname (whichever they typed in — usually www). AI bots crawling the
OTHER variant (apex if they registered www, or vice versa) hit the
customer's underlying origin directly with no Advocate intercept,
silently leaking ~half of bot traffic for every tenant.

Today's commit makes new signups register both apex and www
automatically. Existing tenants need a one-shot backfill:

```bash
# WCC specifically:
curl -X POST https://customers.advocatemcp.com/admin/domains/backfill-variants \
  -H "X-Admin-Secret: <ADMIN_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"slug":"workman-copy-co"}'

# All existing tenants in one shot:
curl -X POST https://customers.advocatemcp.com/admin/domains/backfill-variants \
  -H "X-Admin-Secret: <ADMIN_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"all":true}'
```

The endpoint is idempotent — the underlying CF custom_hostname,
Worker Routes, and KV writes all have "already exists" reuse paths.
Returns a per-tenant outcome list so you can see which variants got
created vs. reused.

After the backfill, the customer still needs to point their apex's
DNS at us. For most providers that's an ANAME/ALIAS to
`customers.advocatemcp.com`; for providers without ANAME support
they'll need to switch their apex to Cloudflare nameservers.
The activate page now emits per-variant DNS instructions.

## Real bugs / known gaps

### Profile-score partial-failure visibility
**Tracked 2026-04-25.** Bug 3 made `parseJudgeOutput` throw on bad
judge output instead of returning a silent zero. The `runTrials`
all-trials-failed guard catches the case where every trial errors,
but a partial-failure case is still silent: if 3 of 4 variants throw
parse errors and 1 succeeds, the user gets a "score" derived from
that single trial with no indication their result is low-confidence.

Fix candidates: surface `failed_trial_count` on `VariantSummary` and
have `profileScore.ts` flag the response (e.g. `{ confidence: "low",
failed_count: 3 }`) when failures cross some threshold. Or threshold
the all-failed guard at e.g. `trials.length < attempted * 0.5` so
high-failure batches throw rather than serve thin data. Decision
deferred — current behavior is strictly better than the pre-Bug-3
silent zero, just not yet ideal.

### Bot-query graceful-degrade (deferred design call)
**Tracked 2026-04-25.** `POST /agents/:slug/query` (the production
hot-path that fires every time an AI bot crawls a tenant's site) is
now wired through the GLOBAL $25/day kill-switch — fail-closed at
fleet level. But it intentionally is NOT wired through the per-tenant
cap, because applying that cap would 503 individual tenants who get
viral traffic at exactly the worst time.

The proper answer is graceful degrade: when a tenant exceeds their
budget, instead of 503'ing the bot, serve a static/cached response
(generic "see <website> for more info" or last-successful-similar-query
cache) so the citation still happens but no Claude call fires. That's
a real product call — not shipped today; bot queries currently rely
solely on the global cap to bound spend. Per-tenant *visibility* on
bot-query spend IS tracked (recordForSlug fires after each call) so
ops can see which tenant is driving spend in `/admin/budget`.

Tracking this separately from "shipped" since the right design needs
explicit decisions on:
  - What to serve when over cap (cached, generic, redirect-only?)
  - Whether to per-cap bot queries or rely on global cap forever
  - How to communicate over-cap state to the tenant in their dashboard

### `GOOGLE_PLACES_API_KEY` env var (Railway)
**Added 2026-04-25.** The new Verify-with-Google button on the BusinessProfile
Verified Ratings card hits Places API (New) to pull live rating, count, and the
top 5 review snippets so tenants can replace self-reported ratings with verified
ones. The endpoint `POST /agents/:slug/profile/verify-rating` returns a graceful
503 with `reason: "no_api_key"` when the env var is missing — no crash, just no
verify capability — so the deploy is safe to ship without it.

**To enable:** Provision a Google Maps Platform key with **Places API (New)**
turned on at https://console.cloud.google.com/google/maps-apis/, then
`railway variables set GOOGLE_PLACES_API_KEY=<key>` from the `server/` directory.

**Cost:** Atomic field mask SKU is ~$0.005 per call. Per-slug rate limit
(3/min, 24/day) + daily budget kill-switch reservation ($0.05/call, 5x headroom)
already in place. Pay-as-you-go credit on Google's free tier covers thousands
of verifications/month.

## Blockers — ship before the next real paying customer

### ~~DNS custom hostname routing~~ RESOLVED
**Resolved Apr 14 2026.** Root cause was not the `custom_origin_server` field alone — CF SaaS needs BOTH the per-hostname record AND a Worker Route pattern `{tenant-hostname}/*` on our zone. Without the route, CF's edge has no Worker to dispatch to and returns a fast 522 pre-origin.

The self-healing reconcile on `POST /admin/domains/activate` handles piece 1. Piece 2 (the Worker Route) is currently manual via the CF dashboard until the `CF_API_TOKEN` scope gets `Workers Routes: Edit`; `POST /admin/domains/ensure-worker-route` is already wired and ready for that day. See `docs/dns-routing.md` for the full design or `docs/superpowers/specs/2026-04-14-dns-self-healing-activation-design.md` for the original spec.

### ~~CF_API_TOKEN needs Workers Routes: Edit scope~~ RESOLVED (pending token upgrade)
**Code resolved Apr 16 2026.** The Stripe webhook now calls `ensureWorkerRouteForHostname` automatically for every paying tenant (both `skipDns=true` public-wizard flow and custom-domain flow). `createCfHostnameForTenant` is also now called in the skipDns branch so wizard-signup subdomains (`{slug}.hosted.advocatemcp.com`) get their CF SaaS custom hostname provisioned. Both CF calls are non-fatal — if the token is under-scoped or CF is transiently unavailable, the tenant still activates and the failure is logged for manual recovery.

**Remaining operator step:** upgrade `CF_API_TOKEN` at dash.cloudflare.com/profile/api-tokens to include `Account > Workers Routes > Edit` on the `advocatemcp.com` zone. Once that scope lands, every new paying signup (custom-domain or wizard) auto-gets both pieces (CF hostname + Workers Route).

**One-shot backfill for WCC:** after the token upgrade, run:
```
curl -X POST https://customers.advocatemcp.com/admin/domains/ensure-worker-route \
  -H "X-Admin-Secret: <ADMIN_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"hostname":"www.workmancopyco.com"}'
```
This creates the missing `www.workmancopyco.com/*` route and fixes the 522s.

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

### ~~Post-checkout redirect~~ RESOLVED
**Resolved Apr 15 2026.** Root cause: `worker/src/routes/stripe.ts:526` set the public-wizard
`success_url` to `https://advocatemcp.com/onboarding/complete.html?session_id=...`, but
`site/onboarding/complete.html` did not exist on the marketing Pages site. The 404 fell through
to the marketing index, so customers saw the home page. Fix: created the missing page as a
single-file static asset that polls `GET /api/onboard/session/:session_id` (already exposed
publicly for skipDns wizard tenants), shows a spinner while the Stripe webhook is in flight,
then renders confirmation with the customer's plan + slug + a "Sign in to your dashboard"
CTA pointing at `customers.advocatemcp.com/login`. Falls through to a graceful "payment
received — finishing setup" state if the webhook hasn't fired within 60s, and to an explicit
error state if the API is unreachable.

### ~~Eight hosted test tenants stuck in pending state~~ RESOLVED
Apr 12 — cleaned 12 pending test tenants from D1, removed orphaned test user cameronjmcewan@gmail.com.

## Polish — affects customer experience but not blocking

### ~~Activation page styling~~ RESOLVED
**Resolved 2026-04-26.** `site/activate.html` and `site/login.html` migrated
to the warm-paper design system (`/assets/styles.css`, `prefers-color-scheme`
auto-toggle, maroon accent, serif headings). Both pages preserve every
element ID so `/js/dashboard-activate.js` and `/js/dashboard-auth.js`
continue working unchanged. Customer's first three screens after Stripe
checkout — activation email link → activate.html → login.html → dashboard
— all share one visual system now.

### ~~Dashboard domains section for hosted tenants~~ RESOLVED
**Resolved 2026-04-24.** v2 Settings → Connection card now detects hosted tenants
(domain ends with `.hosted.advocatemcp.com`) and replaces the "Open DNS wizard"
button with a friendly "Your subdomain is automatically managed — no DNS setup
required" note. Pending status chip re-labels from "Pending DNS" → "Provisioning…"
for hosted tenants so the in-flight state isn't misleading.

### Dashboard sidebar and breadcrumb
Max's logo fix (commit 19c73c2) addressed the shared marketing header but not the dashboard
sidebar and breadcrumb. Dashboard.html still has placeholder treatment.

### ~~Dead js file~~ FALSE ALARM
**Audited 2026-04-24.** `site/js/dashboard-activate.js` IS loaded — by `site/activate.html`
(the email-link account activation flow), not `dashboard.html`. The original followup
note was looking in the wrong file. No action needed.

## Research / investigate

### Max's account role origin
Max's user record was created on 2026-04-08 with role=admin, by a code path that isn't
`/admin/create-client` (that endpoint correctly defaults to client role). Figure out what
created the account four days ago. Probably harmless historical test data, but worth knowing.

### users.tenant_id field
Field exists on the users table, refresh handler reads it, but nothing uses it for authorization
per earlier Claude Code investigation. Is it dead? Can it be removed?

### /demo/:slug architectural concerns
- ~~Rate limiting missing~~ **PARTIALLY RESOLVED 2026-04-26.** Worker
  now forwards the visitor IP via X-Forwarded-For so Railway's
  per-IP cost-rate-limit slots the visitor (was bucketing every
  visitor on the Worker IP, blocking everyone when one abuser hit).
- ~~Paid Claude API calls on every public GET~~ **RESOLVED 2026-04-26.**
  Edge cache (`caches.default`) holds the rendered `/demo/:slug` HTML
  for 600s so the second-and-later visitor inside the window hits a
  pre-rendered response — no Railway round-trip, no Claude call.
  Only cache when the agent query actually succeeded so a transient
  Railway error doesn't poison the cache and starve the next visitor
  of a live agent answer. Cache-Control max-age + X-Demo-Cache
  HIT/MISS header for ops visibility.
- Hardcoded crawler user agent (GPTBot only) — still open. Demo
  always shows GPTBot-flavored output regardless of which engine the
  visitor cares about. Could let the visitor pick (chip row above
  the JSON?) or rotate randomly.
- 8 open questions from the rearchitecture plan §10 — still open.

## Infrastructure / hygiene

### Wrangler 4.x upgrade
Currently on 3.114.17. Wrangler warns on every command. Upgrade via
`npm install --save-dev wrangler@4`. Test carefully — wrangler is the deploy tool.

### ~~Admin retry endpoint~~ RESOLVED
**Resolved earlier.** `POST /admin/onboard/retry-railway` (worker/src/routes/stripe.ts:1339)
exists and replays `registerBusinessOnRailway` using the tenant profile already in KV.
Body: `{ slug }`. Auth via `X-Admin-Secret` header. Updates D1 `api_key` on success
the same way the Stripe webhook would.

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

---

## Vitest baseline cleanup (added Apr 30 2026)

The server vitest suite carries 43 baseline failures across ~12 test files:
- `src/jobs/weeklyDigest.test.ts` (6 failures)
- `src/routes/admin/tenants.test.ts` (multiple)
- `src/routes/admin/audits.test.ts`, `auditBatch.test.ts`, `agents.test.ts`
- `src/db/migrations.test.ts`, `006_reservations.test.ts`, `002_partial_apply.test.ts`
- `src/lib/requestId.test.ts`
- `src/middleware/rateLimit.tier.test.ts`
- `src/agent/query.test.ts` (1: brittle prepare-mock assertion)

These predate the AMC-001..012 security work and the AI Insights feature; none
were caused by recent changes. The CI workflow `.github/workflows/server-ci.yml`
currently runs vitest with `continue-on-error: true` because the boot-smoke step
is the load-bearing gate (catches ESM/CJS interop crashes that would take Railway
down). When the baseline drops to zero, flip `continue-on-error: false` so vitest
becomes a hard gate again.

Owner: triage one test file at a time. Most are mock-shape drift after route
middleware changes.
