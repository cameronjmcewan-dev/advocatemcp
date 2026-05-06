# Manual Onboarding Runbook

Step-by-step for admin-provisioned customers — the "white-glove" path where
you set up a tenant directly instead of sending them through the self-serve
wizard at `advocatemcp.com/audit` / `advocatemcp.com/onboarding`.

This is the path that was used for the first real paying customer.

Last validated: 2026-04-19.

---

## When to use this

- First real customer in a new segment (you want control over the profile
  content, category, differentiators).
- Custom-domain customer (their own `www.foo.com`, not
  `foo.hosted.advocatemcp.com`).
- Prospect you closed via outbound who isn't going to self-serve through
  the wizard.

For self-serve signups, the wizard at `/audit` → `/onboarding` handles
everything automatically; this runbook doesn't apply.

---

## Prerequisites

- `$ADMIN_SECRET` — from 1Password (matches the worker's `ADMIN_SECRET`).
- `$API_KEY` — the shared worker↔server admin key (for Railway `/register`).
- Laptop access to Cloudflare dashboard (for DNS + Workers Routes).
- Access to Railway dashboard if you need to eyeball SQLite directly.

---

## The flow, end to end

```
1. Register the agent on Railway        (creates businesses row + api_key)
2. Create the D1 business row            (so the worker can route traffic)
3. Create the user + grant access        (so they can log into the dashboard)
4. Set up the custom hostname on CF      (if custom-domain tenant)
5. Ensure the Worker Route               (so CF routes their traffic to us)
6. Verify end-to-end                     (crawler interception + dashboard)
```

Each step is idempotent where possible — re-running is safe.

---

## Step 1: Register the agent on Railway

This creates the canonical business record on the Railway side. Railway
returns a `slug` and `api_key` we use everywhere else.

```bash
curl -X POST https://api.advocatemcp.com/register \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "name": "Example Tenant",
    "description": "Example business description.",
    "category": "copywriter",
    "location": "City, ST",
    "services": ["email copy", "landing page copy", "brand voice"],
    "phone": "555-555-0100",
    "website": "https://www.example-tenant.com",
    "star_rating": 4.9,
    "review_count": 18,
    "tone": "warm",
    "plan": "pro",
    "email": "owner@example-tenant.com"
  }'
```

**Save the response** — you'll paste `slug` and `api_key` in step 2 and 3.

```json
{
  "slug": "example-tenant",
  "api_key": "2a3b4c...",
  "agent_endpoint": "https://api.advocatemcp.com/agents/example-tenant/query",
  ...
}
```

### Optional — richer profile

For agency + law-firm tenants, pass the 9-step wizard blobs
(`hours_json`, `credentials_json`, `ratings_json`, `pricing_json_v2`, etc.)
in the same body. See `docs/followups.md` Task 10 for a full sample payload.

### On collision

If another tenant already has the generated base slug, Railway auto-suffixes
(`-1`, `-2`, …) — check the returned slug before pasting it into step 2.

---

## Step 2: Create the D1 business row

Railway has the profile + `api_key`; now the worker needs a pointer so it
knows to route the tenant's domain traffic to that slug.

`/admin/create-client` creates the user AND the D1 business row AND grants
the user access, in one call:

```bash
curl -X POST https://customers.advocatemcp.com/admin/create-client \
  -H "Authorization: Bearer $ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "email":         "owner@example-tenant.com",
    "password":      "<temporary-strong-password>",
    "full_name":     "<Customer Name>",
    "slug":          "example-tenant",
    "business_name": "Example Tenant",
    "api_key":       "<the api_key Railway returned>",
    "role":          "client"
  }'
```

The endpoint is idempotent: if the user already exists, the password is
updated; if the business row already exists, just the access grant is
ensured.

**Send the temporary password to the customer via a secure channel** (1Password
Send link, password-manager share, or have them reset immediately via the
forgot-password flow on `/login`).

---

## Step 3: Set up the custom hostname (custom-domain tenants only)

Skip this section for hosted tenants — `foo.hosted.advocatemcp.com` is
auto-provisioned and you don't set it up manually.

### 3a. Register the custom hostname with Cloudflare

```bash
curl -X POST https://customers.advocatemcp.com/api/onboard \
  -H "X-Admin-Secret: $ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "domain": "www.example-tenant.com",
    "slug":   "example-tenant",
    "name":   "Example Tenant",
    "email":  "owner@example-tenant.com"
  }'
```

Response includes `cloudflare.txtName`, `cloudflare.txtValue`, and
instructions for the customer.

### 3b. Tell the customer to add the DNS records

- **TXT record for ownership verification** — `txtName` / `txtValue` from the
  response.
- **CNAME record** from `www.example-tenant.com` → `customers.advocatemcp.com`.
- **TTL: `1/2 Hour`** for both records. On GoDaddy this is a dropdown preset —
  the customer should never pick Custom or leave it on the 1-Hour default.

Send those three lines via email.

### 3c. Wait for verification

CF checks the TXT + CNAME every few minutes. Monitor status:

```bash
curl https://customers.advocatemcp.com/api/onboard/www.example-tenant.com/status \
  -H "X-Admin-Secret: $ADMIN_SECRET"
```

Status transitions: `pending_verification` → `active` once CF sees the
records and issues the SSL cert (2–10 min typical).

---

## Step 4: Ensure the Worker Route

CF SaaS doesn't automatically wire new custom hostnames to our Worker. The
hostname needs a Workers Route pattern `{hostname}/*` on the
`advocatemcp.com` zone. This is the step that was missing pre-Apr 16 2026
(see `docs/followups.md`).

### 4a. Confirm `CF_API_TOKEN` has `Workers Routes: Edit` scope

Dashboard → My Profile → API Tokens → edit the token → add
`Account > Workers Routes > Edit` on the `advocatemcp.com` zone if it
isn't there. Save.

### 4b. Create the route

```bash
curl -X POST https://customers.advocatemcp.com/admin/domains/ensure-worker-route \
  -H "X-Admin-Secret: $ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"hostname":"www.example-tenant.com"}'
```

Expected `200 OK` with `{ "created": true, "pattern": "www.example-tenant.com/*", ... }`.

If this returns 502 or "not configured", the `CF_API_TOKEN` is still
under-scoped. Re-check step 4a.

---

## Step 5: Verify end-to-end

### 5a. Crawler interception (custom-domain only)

```bash
curl -I -A "PerplexityBot/1.0" https://www.example-tenant.com/
```

Expected: `200` from our Worker (not a 522 CF error, not the customer's
origin HTML). The Worker should serve a redirect or response shape
specific to AI crawler UAs.

### 5b. Public profile endpoint

```bash
curl https://api.advocatemcp.com/agents/<slug>/profile | jq .
```

Expected: structured JSON with `name`, `description`, `services`, `category`.

### 5c. Agent query

```bash
curl -X POST https://api.advocatemcp.com/agents/<slug>/query \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $THE_TENANT_API_KEY" \
  -d '{"query": "Who are the best businesses in this category in this city?",
       "crawler_agent": "PerplexityBot"}'
```

Expected: 200 with `response` mentioning the business, referral link, and
category-appropriate emphasis.

### 5d. Dashboard

Log in at `https://customers.advocatemcp.com/login` with the email +
temporary password from step 2. The Overview section should render without
errors and show the tenant's slug in the breadcrumb.

---

## Rollback

If anything in steps 1–4 wrote partial state and you need to start over:

1. **Delete the Railway row**: `DELETE FROM businesses WHERE slug='<slug>';`
   (via Railway's SQLite shell — get there from the dashboard → Data).
2. **Delete the D1 row**: `npx wrangler d1 execute advocatemcp-auth --remote
   --command="DELETE FROM businesses WHERE slug='<slug>'"` from `worker/`.
3. **Delete the user access**: `DELETE FROM user_business_access WHERE user_id='<id>'`
   same way. Keep the user row unless they asked to be removed entirely.
4. **Delete the CF custom hostname**: `DELETE /admin/onboard/<domain>/disable`
   via the admin API (or CF dashboard manually).
5. **Delete the Worker Route**: currently done by hand in the CF dashboard
   (Workers & Pages → routes for the zone).

Then start at step 1 again.

---

## Troubleshooting

### "Admin API key not configured"

`ADMIN_SECRET` isn't set on the worker. `cd worker && npx wrangler secret put
ADMIN_SECRET` from a freshly-generated `openssl rand -hex 32`.

### Railway `/register` returns 400 "validation_error"

The payload is missing a required field. Check `server/src/schemas/business.ts`
for the full zod schema. Most common misses: `star_rating`, `review_count`,
`category`.

### Railway returns 500 and Stripe webhook retried before you finished

The webhook registered a tenant with empty `profile` fields; the agent
works but gives thin responses. Use
`POST /admin/onboard/retry-railway` (see PR #75) once you've populated the
KV tenant record via `POST /api/onboard`.

### The customer's domain returns 522 after DNS propagates

Worker Route missing — re-run step 4b. If that 502s, token scope (4a).

### Dashboard shows "No business found for this account"

The user→business access grant didn't commit. Re-run step 2 — the endpoint
is idempotent for existing users and the `grantAccess` call runs
unconditionally.

---

## Related docs

- `docs/secrets-runbook.md` — secret rotation + inventory.
- `docs/dns-routing.md` — deeper architecture on DNS / Workers Routes.
- `docs/audit-funnel.md` — the self-serve onboarding path (alternative to
  this).
- `docs/followups.md` — known issues + pending operator steps.
