# Audit Funnel — Operator Guide

The public **GEO Audit** at [`advocatemcp.com/audit`](https://advocatemcp.com/audit) is Advocate's top-of-funnel acquisition tool. This doc covers how to operate it end-to-end: running outbound audits, pulling leads, and converting visitors into customers.

---

## What's wired

| Surface | Purpose |
|---|---|
| `advocatemcp.com/audit` | Public free audit form. Anyone can run a 30-second AI citation report. |
| `advocatemcp.com/r/:id` | Public read-only shareable audit page. Use these URLs in outreach. |
| `POST /audit/run` | Public endpoint backing the form. Rate-limited 3/IP/day, $5/day budget cap. |
| `GET /audit/:id` | Public read-only retrieval of a stored audit (used by `/r/:id`). |
| `POST /audit/:id/follow-up` | Email capture: visitor opts in to a monthly re-audit. Stored in `audit_followups`. |
| `GET /admin/audits` | **Operator** — list recent audits with filters + captured emails. |
| `GET /admin/audits/analytics` | **Operator** — aggregated funnel health: totals, by-day trend, top categories, top competitor domains, email capture rate. |
| `POST /admin/audits/batch` | **Operator** — run audits on up to 5 prospects in one request. |

All `/admin/*` endpoints require `Authorization: Bearer $ADMIN_API_KEY`.

---

## The outreach loop

This is the day-to-day workflow.

### 1. Identify prospects

Pick a market you want to break into. Examples:
- DTC email marketing agencies in NYC
- Personal injury law firms in Phoenix
- Boutique HVAC companies in Austin

Get a list of 20–50 domains. Their categories should be roughly the same (the AI queries we generate are category-driven).

### 2. Run audits in batches of 5

```bash
export ADMIN_API_KEY="..."   # from Railway

curl -sS -X POST https://api.advocatemcp.com/admin/audits/batch \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prospects": [
      { "domain": "agency1.com",  "category": "DTC email marketing agency", "location": "Austin, TX" },
      { "domain": "agency2.com",  "category": "DTC email marketing agency", "location": "Austin, TX" },
      { "domain": "agency3.com",  "category": "DTC email marketing agency", "location": "Austin, TX" },
      { "domain": "agency4.com",  "category": "DTC email marketing agency", "location": "Austin, TX" },
      { "domain": "agency5.com",  "category": "DTC email marketing agency", "location": "Austin, TX" }
    ]
  }' | python3 -m json.tool
```

Returns:
```json
{
  "batch_size": 5,
  "succeeded":  5,
  "results": [
    {
      "input":     { "domain": "agency1.com", ... },
      "ok":        true,
      "cached":    false,
      "audit":     { "id": "abc123", "cited_count": 0, "total_queries": 3, ... },
      "share_url": "https://advocatemcp.com/r/abc123"
    },
    ...
  ]
}
```

Each `share_url` is a **public read-only** version of the report — open in any browser, no login required. This is what you send the prospect.

Notes on the batch endpoint:
- Max 5 prospects per request. Submit multiple batches for larger lists.
- 24h cache: re-running the same `(domain, category, location)` returns the prior audit (`cached: true`).
- Bypasses the public per-IP rate limit (you're an authenticated operator).
- **Still respects the $5/day global budget.** Audits cost ~$0.025 (Perplexity) or ~$0.15 (OpenAI) per query × 3 queries each.

### 3. Send outreach emails

Take each `share_url` and craft a personalized email. Template:

> Subject: AI doesn't know about {agency_name}
>
> Hey {first_name} — I just ran a quick audit on how AI assistants
> answer "best DTC email marketing agency in Austin." Your firm wasn't
> cited in any of the top results.
>
> Here's the full report: {share_url}
>
> Or run a fresh one on yourself: {prefill_url}
>
> The agencies AI cited instead: {top_3_competitors}
>
> Advocate fixes this — gives every AI a structured, citation-ready
> answer about your firm. $100/mo, takes 15 minutes to set up.
>
> Worth a 10-min call?

The leaderboard on the `/r/:id` page shows the named competitors AI cited in their stead — that's the most powerful single line in the email.

#### Prefilled audit URLs (zero-friction "audit yourself" links)

The `/audit` page accepts URL parameters that pre-fill the form, so
prospects clicking the link don't have to retype anything:

```
https://advocatemcp.com/audit?domain=acme.com&category=DTC%20email%20marketing%20agency&location=Austin%2C%20TX
```

Add `&auto=1` to **immediately fire the audit on page load** — no click
required. Highest-conversion pitch is to send the auto-run URL for any
prospect where you're confident the audit will return a low score:

```
https://advocatemcp.com/audit?domain=acme.com&category=DTC%20email%20marketing%20agency&location=Austin%2C%20TX&auto=1
```

The page strips the query params from the URL bar after consuming them
so a prospect who reloads doesn't burn a fresh audit run, and a screenshot
of the result stays clean for sharing.

### 4. Pull leads from the dashboard endpoint

People who **ran the audit themselves** + opted into monthly re-audits are the warmest leads. Pull them daily:

```bash
# Hot leads: zero-citation audits with captured emails, last 7 days
curl -sS "https://api.advocatemcp.com/admin/audits?cited=0&has_email=1&days=7" \
  -H "Authorization: Bearer $ADMIN_API_KEY" | python3 -m json.tool
```

Each result includes `domain`, `category`, `share_url`, and `emails[]` — enough to email them directly with a personal pitch referencing their actual audit.

Other useful queries:
```bash
# All audits in the last 24h (visibility into who's been touching the funnel)
curl -sS "https://api.advocatemcp.com/admin/audits?days=1" -H "Authorization: Bearer $ADMIN_API_KEY"

# Audits with any captured email (anyone who showed signup intent)
curl -sS "https://api.advocatemcp.com/admin/audits?has_email=1&days=30" -H "Authorization: Bearer $ADMIN_API_KEY"

# Funnel-health dashboard — one call summary for "is the audit funnel working?"
curl -sS "https://api.advocatemcp.com/admin/audits/analytics?days=30" \
  -H "Authorization: Bearer $ADMIN_API_KEY" | python3 -m json.tool
```

The analytics endpoint returns headline counts (total audits, cost,
bucket breakdown of zero/partial/all-cited), email capture rate, a
per-day trend for sparklines, top categories, and the top 10 competitor
domains that appeared across every audit in the window — useful for
market intelligence ("the same 5 firms dominate every DTC-email audit
we run").

---

## Cost economics

| Provider | Cost per query | Audit cost (3 queries) | $5/day cap → audits/day |
|---|---|---|---|
| Perplexity | $0.005 | $0.015 | ~333 |
| OpenAI (fallback) | $0.030 | $0.090 | ~55 |

When `PERPLEXITY_API_KEY` is set, audits use Perplexity (cheaper). When only `OPENAI_API_KEY` is set, audits fall back to OpenAI (6× cost). Currently on OpenAI.

If audits-per-day exceeds the cap, the endpoint returns `503 daily_budget_exhausted`. Bump `DAILY_BUDGET_USD` in `audit.ts` or wait until UTC midnight.

---

## Safety & rate limits

| Surface | Limit |
|---|---|
| Public `POST /audit/run` | 3 audits per IP per 24h, $5/day global |
| Public `POST /audit/:id/follow-up` | 10 follow-ups per IP per 24h |
| `POST /admin/audits/batch` | 5 prospects per request, $5/day global, no per-IP |
| `GET /admin/audits` | No rate limit (admin auth gates it) |

To rotate the IP-rate-limit state (e.g. test from your own browser without burning the cap), change `AUDIT_IP_SALT` in Railway to a new value.

---

## Conversion flow

When a prospect lands on `advocatemcp.com/r/:id` and clicks **"Run my audit"**, they're sent to the live `/audit` page where they enter their own info. After running, the **"Claim your agent"** CTA pre-fills `/onboarding` with their domain, category, location, and a best-guess business name (see `from_audit=1` flow in `site/onboarding.html`).

The friction-minimized signup path is:
1. Cold email with a prefilled `/audit?domain=...&category=...&location=...&auto=1` URL
2. Page loads → audit fires automatically → prospect sees their score in ~7s
3. Click "Claim your agent" → onboarding pre-filled with the same data via `?from_audit=1`
4. 9-step wizard → agent live

Three clicks total from prospect's inbox to signed-up customer. Every URL
in this chain self-cleans (params stripped via `history.replaceState`) so
refreshes don't re-trigger and the address bar stays bookmark-friendly.

---

## Updating this doc

Update at the end of any session that touches the audit funnel:
- `server/src/routes/audit.ts`
- `server/src/routes/admin/audits.ts`
- `server/src/routes/admin/auditBatch.ts`
- `site/audit.html`, `site/r.html`, `site/js/audit.js`
- `server/src/db/migrations/017_public_audits.sql`, `018_audit_followups.sql`
