# Overnight handoff — Apr 18, 2026

Cameron stepped away around 10 PM CT and gave me the prompt:
> Formulate a plan and execute what you think is best for the company.
> I want the highest quality product.

This doc is the morning brief: what shipped, what needs deploying, how
to use it, and what I deliberately didn't do.

---

## TL;DR

The acquisition pipeline is now complete end-to-end. A prospect can go
from cold-email click to signed-up customer in three clicks, with every
step pre-filled from the previous one. Cameron has operator endpoints to
run audits in batches and pull leads on demand.

**Shipped tonight (5 PRs, all merged to main):**

| PR | What | Value |
|---|---|---|
| #67 | Lead Capture & Outreach Pack | Parallelized audit (20s → 7s), email capture, shareable URLs, admin leads endpoint |
| #68 | Competitor leaderboard | Top-5 winners aggregated client-side from existing data — most actionable single insight in the audit |
| #69 | Batch endpoint + ops docs | `POST /admin/audits/batch` runs 5 prospects in one operator request; full operator guide at `docs/audit-funnel.md` |
| #70 | URL-param prefill + auto-run | `/audit?domain=X&category=Y&auto=1` fires the audit on page load — zero-friction outbound landing |

Server suite: **513/513 passing**. Worker suite: **166/166 passing**. Typecheck clean both sides.

---

## What needs to deploy (in your terminal, ~2 min)

Two deploys cover everything:

```bash
# 1. Pull all the merges
cd ~/Desktop/advocate/advocatemcp
git checkout main
git pull origin main

# 2. Deploy Cloudflare Pages (audit page, /r/:id shareable, prefill, etc.)
npx wrangler pages deploy site --project-name=advocatemcp-site
```

Railway auto-deploys on merge — server changes (parallelized audit, follow-up endpoint, admin batch + admin list, `runAudit` refactor) are already live.

Worker is unchanged tonight — no `wrangler deploy` needed.

---

## End-to-end smoke test (after the Pages deploy)

```bash
# 1. Acquisition flow — prefilled + auto-run
open "https://advocatemcp.com/audit?domain=workmancopyco.com&category=email%20marketing%20agency&location=Austin,%20TX&auto=1"
# Expected: form pre-fills, audit fires in ~7s, leaderboard shows top 5
# competitors, "Claim your agent" + email capture + share URL all work.

# 2. Operator batch — runs 2 audits in one call
curl -X POST https://api.advocatemcp.com/admin/audits/batch \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prospects": [
      { "domain": "agency1.com", "category": "DTC email marketing agency", "location": "Austin, TX" },
      { "domain": "agency2.com", "category": "DTC email marketing agency", "location": "Austin, TX" }
    ]
  }' | python3 -m json.tool
# Expected: { batch_size: 2, succeeded: 2, results: [{share_url, audit, ...}] }

# 3. Pull hot leads
curl -sS "https://api.advocatemcp.com/admin/audits?cited=0&days=7" \
  -H "Authorization: Bearer $ADMIN_API_KEY" | python3 -m json.tool

# 4. Open a shareable result
open "https://advocatemcp.com/r/<one of the audit ids from step 2>"
# Expected: read-only page with leaderboard + score + CTA back to /audit
```

If anything breaks, ping me with the response/log. Most likely failure:
the Pages deploy didn't pick up new files (we hit this twice today). Re-run
`npx wrangler pages deploy` and check the version hash matches the latest.

---

## How the funnel actually works now

The cold outreach loop, in operator order:

```
1.  Cameron picks 5 prospects in a market
        ↓
2.  POST /admin/audits/batch  — gets 5 share URLs back
        ↓
3.  Sends 5 emails, each with:
       (a) the share URL → prospect sees their own report
       (b) a prefill+auto URL → "audit yourself fresh"
        ↓
4.  Prospect clicks → /audit?domain=...&auto=1 → audit fires → score
        ↓
5.  Click "Claim your agent" → /onboarding pre-filled with prospect's data
        ↓
6.  9-step wizard → live agent
```

Every URL self-cleans (`history.replaceState`) so refreshes don't re-fire
or burn rate-limit slots. The whole loop is one continuous chain of
pre-filled handoffs.

Full operator guide lives at **`docs/audit-funnel.md`** with copy-paste
curl commands and a sample outreach email template.

---

## Recommended next moves (in order)

The product side has reached a coherent stopping point. Next-highest-leverage:

**1. Run actual outreach (NON-CODE).** Pick 25 prospects in WCC's space
(DTC email marketing agencies in Austin/SF/NYC) and run the batch endpoint
on them. Send the 25 outreach emails using the template in
`docs/audit-funnel.md`. Track replies. The product is ready; the
bottleneck is now the sales motion.

**2. Outreach email composer endpoint.** If outreach gains traction, the
next code work is `POST /admin/audits/:id/send-outreach` that uses Resend
to send a templated personalized email referencing the audit. Saves the
manual email drafting step. ~1 hr to ship.

**3. Stripe Checkout direct from audit results.** Skip the wizard for
low-touch tier conversion. "Cited 0/5? $100/mo, 14-day money back, click
to start" → Stripe Checkout → done. Real conversion lever for the impatient
buyer, ~1 hr to ship.

**4. Connect Pages to Git.** Operational. Removes the manual `wrangler
pages deploy` step every time we ship. Requires CF dashboard interaction
to convert the Direct-Upload project to a Git-connected one (or to
recreate). I deliberately didn't attempt this autonomously since it
touches your CF account.

**5. Off-Site Authority Kit (Session 7).** Pro-tier retention feature.
Worth shipping when there are 3+ Pro customers; before that, premature.

---

## What I deliberately did NOT do tonight

For the record, so you know my reasoning:

- **I didn't deploy anything.** Pages and Worker deploys need your laptop's
  Cloudflare auth. I merged everything to main and Railway auto-deploys,
  but the Pages files are sitting in main waiting for one `wrangler pages
  deploy`.
- **I didn't ship the Outreach Email composer.** Bulk transactional email
  via Resend has sender-reputation implications (DKIM/SPF setup, send-rate
  pacing, bounce handling) that go beyond what I should ship without you
  reviewing the design.
- **I didn't add Stripe Checkout direct-from-audit.** Touches money flow
  + your live Stripe account. You should design that yourself.
- **I didn't ship docs marketing pages.** No new content; the existing
  marketing site copy stayed identical.
- **I didn't touch the onboarding wizard's 9-step flow.** Pre-fill via
  `?from_audit=1` is the only change that path saw.
- **I didn't write SEO meta tags or sitemap.xml.** Real value but lower
  than the funnel work.
- **I didn't pull off the directory submissions** (Smithery, PulseMCP,
  Anthropic registry). The MCP infrastructure is ready (DO rate limit +
  structured logs + manifest at `/.well-known/mcp.json`), but the
  submission forms themselves require your judgement on positioning and
  contact info.

---

## Test counts before/after

| | Before tonight | After tonight |
|---|---|---|
| Server tests | 481 | 513 (+32) |
| Worker tests | 166 | 166 (unchanged) |
| Typecheck | clean | clean |

New endpoint surface area:
- `POST /audit/:id/follow-up` — public lead capture
- `GET /audit/:id` — already existed, now backed by `/r/:id` page
- `GET /admin/audits` — operator leads dashboard
- `POST /admin/audits/batch` — operator outreach accelerator

New schema:
- Migration 017 (`public_audits` — already shipped earlier today)
- Migration 018 (`audit_followups` — shipped tonight, auto-applies on Railway boot)

---

## If something looks wrong

The likeliest source of confusion is the Pages deploy. After running
the deploy, verify the latest is live:

```bash
curl -s https://advocatemcp.com/js/audit.js | grep -c "renderLeaderboard\|prefillFromUrl"
# expected: 2+
```

If 0, the deploy didn't pick up — re-run `npx wrangler pages deploy`.

For Railway, check `https://api.advocatemcp.com/admin/audits` returns
`200` with `Authorization: Bearer $ADMIN_API_KEY`. If 404, Railway hasn't
finished its auto-deploy yet (gives ~1-2 min after merge). If `Admin API
key not configured`, ADMIN_API_KEY env var isn't set on Railway.

---

Slept on it = shipped on it. See you in the morning.
