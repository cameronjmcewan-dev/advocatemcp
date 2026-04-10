# AdvocateMCP Tenant Onboarding System

## How It Works

```
Admin calls POST /api/onboard with tenant data
  │
  ├─ Validates input, normalizes domain
  ├─ Creates Cloudflare custom hostname (idempotent)
  ├─ Extracts TXT verification tokens from CF response
  ├─ Writes BUSINESS_MAP KV (domain → slug)
  ├─ Writes TENANT_DATA KV (domain → full JSON record)
  ├─ Creates D1 business record if needed
  └─ Returns DNS instructions + tracking object
         │
Customer adds CNAME + TXT records at their DNS provider
         │
Admin calls POST /api/onboard/:domain/verify (or wait for batch)
  │
  ├─ Polls Cloudflare custom hostname API
  ├─ If active → transitions tenant to "active"
  └─ If pending → leaves as "pending_verification"
         │
Domain goes live — Worker routes AI crawler traffic by hostname
```

## API Reference

All endpoints require authentication via `X-Admin-Secret` header or `Authorization: Bearer <ADMIN_SECRET>`.

### POST /api/onboard

Onboard a new tenant. Safe to call multiple times for the same domain.

**Request body:**
```json
{
  "domain": "www.example.com",
  "name": "Example Business",
  "slug": "example-business",
  "phone": "+15551234567",
  "email": "owner@example.com",
  "address": "123 Main St",
  "city": "Austin",
  "state": "TX",
  "postalCode": "78701",
  "country": "US",
  "services": ["consulting", "development"],
  "website": "https://example.com",
  "notes": "Referred by partner program"
}
```

**Required fields:** `domain`, `name`, `slug`, `phone`, `email`

**Response:** Returns tenant record, CF hostname data, DNS instructions, and status.

### GET /api/onboard/:domain/status

Check current onboarding status for a domain.

### POST /api/onboard/:domain/verify

Force Cloudflare verification re-check. Use when DNS has propagated but status hasn't updated.

### POST /api/onboard/:domain/disable

Disable a tenant. Removes KV routing entry so traffic stops flowing.

### GET /api/onboard/list

List all onboarded tenants with their current status.

### POST /api/onboard/verify-all

Batch re-check all `pending_verification` tenants against Cloudflare. Designed for periodic admin use or cron.

## DNS Records Required From Customer

After onboarding, the customer must add these records at their DNS provider:

| Type  | Host                          | Value                                   | Purpose                    |
|-------|-------------------------------|-----------------------------------------|----------------------------|
| CNAME | `www.example.com`             | `customers.advocatemcp.com`             | Routes traffic to platform |
| TXT   | (from CF response `txtName`)  | (from CF response `txtValue`)           | SSL certificate validation |
| TXT   | (from CF response, if present)| (ownership verification value)          | Domain ownership proof     |

The exact TXT record names and values are returned by the `/api/onboard` response under `dns.records`.

## Tenant Status Model

| Status                  | Meaning                                              |
|-------------------------|------------------------------------------------------|
| `pending_verification`  | Waiting for customer DNS records to propagate         |
| `active`                | Domain verified, SSL issued, traffic flowing          |
| `disabled`              | Manually disabled by admin                            |
| `failed`                | CF hostname deleted/moved or unrecoverable error      |
| `needs_manual_review`   | CF API error or missing credentials — admin attention |

## Environment Variables & Secrets

### Required Secrets (set via `wrangler secret put`)

| Name            | Purpose                                               |
|-----------------|-------------------------------------------------------|
| `ADMIN_SECRET`  | Protects all `/api/onboard/*` and `/admin/*` endpoints |
| `CF_API_TOKEN`  | Cloudflare API token (scopes: `custom_hostnames:edit`, `zone:read`) |
| `CF_ZONE_ID`    | Zone ID for advocatemcp.com                            |
| `API_KEY`       | Forwarded to Railway backend as X-API-Key              |

### KV Namespaces

| Binding        | Purpose                                    |
|----------------|--------------------------------------------|
| `BUSINESS_MAP` | Domain → slug routing (fast string lookup)  |
| `TENANT_DATA`  | Domain → full JSON tenant record            |

## Deployment Steps

### 1. Create the TENANT_DATA KV namespace

```bash
cd advocatemcp/worker
npx wrangler kv namespace create TENANT_DATA
```

This outputs an ID like `abcdef1234...`. Replace `PLACEHOLDER_TENANT_DATA_KV_ID` in `wrangler.toml` with it.

### 2. Set secrets (if not already set)

```bash
npx wrangler secret put ADMIN_SECRET
npx wrangler secret put CF_API_TOKEN
npx wrangler secret put CF_ZONE_ID
npx wrangler secret put API_KEY
```

### 3. Deploy

```bash
npx wrangler deploy
```

### 4. Verify deployment

```bash
curl -s https://customers.advocatemcp.com/api/onboard/list \
  -H "X-Admin-Secret: YOUR_SECRET" | jq .
```

## Sample Commands

### Onboard a new tenant

```bash
curl -s -X POST https://customers.advocatemcp.com/api/onboard \
  -H "Content-Type: application/json" \
  -H "X-Admin-Secret: YOUR_ADMIN_SECRET" \
  -d '{
    "domain": "www.clientdomain.com",
    "name": "Client Business Name",
    "slug": "client-business",
    "phone": "+15551234567",
    "email": "owner@clientdomain.com",
    "address": "456 Oak Ave",
    "city": "Austin",
    "state": "TX",
    "postalCode": "78701",
    "country": "US",
    "services": ["web design", "seo"],
    "website": "https://clientdomain.com"
  }' | jq .
```

### Check onboarding status

```bash
curl -s https://customers.advocatemcp.com/api/onboard/www.clientdomain.com/status \
  -H "X-Admin-Secret: YOUR_ADMIN_SECRET" | jq .
```

### Force verification re-check

```bash
curl -s -X POST https://customers.advocatemcp.com/api/onboard/www.clientdomain.com/verify \
  -H "X-Admin-Secret: YOUR_ADMIN_SECRET" | jq .
```

### Disable a tenant

```bash
curl -s -X POST https://customers.advocatemcp.com/api/onboard/www.clientdomain.com/disable \
  -H "X-Admin-Secret: YOUR_ADMIN_SECRET" | jq .
```

### List all tenants

```bash
curl -s https://customers.advocatemcp.com/api/onboard/list \
  -H "X-Admin-Secret: YOUR_ADMIN_SECRET" | jq .
```

### Batch verify all pending tenants

```bash
curl -s -X POST https://customers.advocatemcp.com/api/onboard/verify-all \
  -H "X-Admin-Secret: YOUR_ADMIN_SECRET" | jq .
```

## Troubleshooting

### Domain stuck in `pending_verification`

1. Verify the customer added the correct CNAME: `dig CNAME www.clientdomain.com`
2. Verify TXT records: `dig TXT <txt_name_from_response>`
3. Wait 15 minutes for propagation
4. Force re-check: `POST /api/onboard/:domain/verify`
5. If still pending after 24h, check Cloudflare dashboard for the custom hostname

### Cloudflare API returns errors

- Ensure `CF_API_TOKEN` has `custom_hostnames:edit` and `zone:read` permissions
- Ensure `CF_ZONE_ID` matches the advocatemcp.com zone
- Check that Cloudflare for SaaS is enabled on the zone (requires at least a Pro plan or SSL for SaaS add-on)

### Tenant showing `needs_manual_review`

This means the Cloudflare API call failed or credentials are missing. Check:
1. Secrets are set: `wrangler secret list`
2. Token permissions are correct
3. Re-run the onboard call to retry

### Rotating API credentials

```bash
# Rotate Cloudflare API token
npx wrangler secret put CF_API_TOKEN
# Enter new token when prompted

# Rotate admin secret
npx wrangler secret put ADMIN_SECRET
# Update any scripts/clients using the old secret
```

## KV Consistency Notes

Workers KV is eventually consistent (typically <60s globally). This means:

- After onboarding, the domain may take up to 60s to be routable worldwide
- Status reads immediately after writes may show stale data
- The `verify-all` batch endpoint is safe to run repeatedly — it's idempotent
- BUSINESS_MAP (string values) and TENANT_DATA (JSON values) are always written together for consistency

## Testing Plan

### Local development

```bash
cd advocatemcp/worker
npx wrangler dev
```

Then test against `http://localhost:8787`.

### Integration test sequence

1. **Onboard** → POST /api/onboard → expect 201, status = "pending_verification"
2. **Idempotent re-onboard** → POST /api/onboard (same domain) → expect 201, no duplicate
3. **Check status** → GET /api/onboard/:domain/status → expect tenant record
4. **List tenants** → GET /api/onboard/list → expect domain in list
5. **Force verify** → POST /api/onboard/:domain/verify → expect CF status check
6. **Test routing** → Send request with AI crawler UA to the domain → expect slug resolution
7. **Disable** → POST /api/onboard/:domain/disable → expect status = "disabled"
8. **Verify disabled routing** → Send crawler request → expect 503
9. **Re-onboard disabled domain** → POST /api/onboard → expect re-activation flow

### End-to-end Worker route test

```bash
# Simulate AI crawler hitting an onboarded domain
curl -s -H "User-Agent: GPTBot/1.1" \
  https://www.clientdomain.com/ | jq .
```

This should return the AI agent response for the mapped business slug.
