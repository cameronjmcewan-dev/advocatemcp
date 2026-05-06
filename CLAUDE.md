# AdvocateMCP — Session Context

Solo founder sprint. Read this first, then `docs/followups.md`.

## Stack
- Cloudflare Worker (`worker/`) + D1 (`advocatemcp-auth`)
- Stripe billing, Cloudflare SaaS custom hostnames for tenant domains
- WordPress plugin (`../wordpress-plugin/`) is the customer-facing install

## Current State (as of Apr 12, 2026)
- Phase F Part 2 shipped
- Hosted-tenant onboarding flow live
- First real customer set up end-to-end
- Wildcard route production incident resolved
- `STRIPE_WEBHOOK_SECRET` rotated — watch for 401s on in-flight retries
- 5 test custom hostnames deleted from Cloudflare zone

## Active Task
Delete 12 pending test tenants from D1 (`businesses` where `api_key='pending'`).
Verify `user_business_access` join counts before DELETE. Use explicit id list,
not bare `WHERE api_key='pending'`.

## Critical Distinction
- `8961b467481648518431f2072bdc1ded` (slug `workman`) = test row, DELETE ok
- `biz_<first-tenant-slug>` = real customer, NEVER DELETE

## Next Up
1. Post-checkout redirect bug in wizard flow
2. DNS custom hostname routing rebuild via Cloudflare `custom_origin_server` API

## Working Style
- Never tell the user to stop or sleep — that's their call
- Efficient with tokens, no repeating
- Pass manual work to Claude Code where possible
- Followups tracked in `docs/followups.md` (main, latest commit d58b8bc as of handoff)