# Vendor / Sub-processor Management

**Owner:** Max.
**Last reviewed:** 2026-05-12.
**Review cadence:** Quarterly. The next review must (a) refresh expired
SOC 2 reports, (b) confirm each vendor is still in use, (c) update the
"data shared" column when integrations change.

> SOC 2 CC9.2 requires that every sub-processor with access to customer
> data be inventoried and reviewed. The published privacy policy
> (`site/privacy.html`) names the same vendors customer-facing; this
> document is the operator-facing companion that tracks evidence on file.

## Sub-processor inventory

| Vendor | Service used | Data shared | SOC 2 on file | Last verified | DPA on file |
|--------|--------------|-------------|---------------|---------------|-------------|
| **Cloudflare** | Workers, D1, KV, Pages, R2, custom hostnames | All hosted-tenant data, auth data, attribution tokens, customer dashboard sessions | Yes — Type II (downloadable from trust.cloudflare.com) | 2026-05-12 | Yes (standard Cloudflare DPA) |
| **Railway** | Application hosting for the API server, SQLite volume | Tenant queries, reservations, handoffs, PII (auto-redacted per retention policy), business profiles | Verify at next review — Railway publishes SOC 2 reports via their compliance page | 2026-05-12 (need to fetch current) | Yes |
| **Anthropic** | Claude API for response generation + agent queries | Query text, business context (NOT customer PII — handoff payloads stay on our side) | Yes — Type II (trust.anthropic.com) | 2026-05-12 | Yes (covered by Anthropic ToS + DPA) |
| **Stripe** | Subscription billing, checkout sessions, customer portal | Billing email, payment method (Stripe-side only — we never touch card data), subscription state | Yes — Type II (stripe.com/docs/security/stripe) | 2026-05-12 | Yes |
| **Resend** | Transactional email (activation, weekly digest, support replies) | Recipient email, message body | Verify at next review — Resend publishes SOC 2 status on their security page | 2026-05-12 (need to fetch current) | Yes |
| **Twilio** | SMS reservation notifications (opt-in per tenant) | Recipient phone, message body | Yes — Type II (trust.twilio.com) | 2026-05-12 | Yes |
| **GitHub** | Source code hosting, CI/CD via GitHub Actions | Source code (no customer data in the repo) | Yes — Type II (github.com/security) | 2026-05-12 | Yes (GitHub's standard DPA) |

## What "shared" means

For each vendor we name above, we share ONLY the data necessary for the
service. Examples:

- Anthropic receives the query text and the business profile fields
  needed for that query (services, hours, pricing). Anthropic does NOT
  receive customer_contact_json or any handoff payload.
- Stripe receives the customer's billing email and payment method. They
  do NOT receive reservation contents or queries.
- Resend receives the activation email, weekly digest content, etc.
  They do NOT receive query history or PII beyond the recipient address
  and the email body content.
- Twilio receives the recipient phone + message body for opt-in SMS
  reservation notifications. Tenants without SMS routing configured do
  not pass any data through Twilio.

## Onboarding a new vendor

Before integrating a new sub-processor that will touch customer data:

1. Verify the vendor has a current SOC 2 Type II report OR equivalent
   (ISO 27001 is also acceptable).
2. Read the DPA. Confirm it covers (a) data deletion on request, (b)
   sub-processor notification, (c) breach notification within 72 hours.
3. Add a row to the inventory above with all fields populated.
4. Update `site/privacy.html` sub-processor list (CUSTOMER-VISIBLE — must
   match what we tell customers).
5. Update `docs/security-controls.md` if the vendor introduces a new
   class of data sharing.

## Off-boarding a vendor

When a vendor is no longer used:

1. Confirm there is no remaining data with them. Request deletion in
   writing per their DPA.
2. Rotate any credentials they held.
3. Remove the row from the inventory (or mark "off-boarded YYYY-MM-DD").
4. Update the privacy policy.

## Quarterly review checklist

Tick each at every quarterly review:

- [ ] Fetch latest SOC 2 report for every vendor with "verify at next
      review" or with a report older than 12 months. Store the date the
      report was issued, not just the date we fetched it.
- [ ] Confirm each vendor still in use. Remove unused.
- [ ] Confirm the "data shared" column still matches what the code
      actually sends.
- [ ] Confirm the privacy policy still matches this inventory.
- [ ] Walk Cloudflare R2 (or wherever SOC 2 reports are stored locally) and
      delete reports for off-boarded vendors.

## Review log

| Date | Reviewer | Changes |
|------|----------|---------|
| 2026-05-12 | Max | Initial inventory. Need to fetch current Railway + Resend SOC 2 reports at next review. |
