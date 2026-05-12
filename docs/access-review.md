# Access Review

**Owner:** Max.
**Cadence:** Quarterly. Each cycle is a single sitting (~30 min for current
team size); the goal is provable evidence, not heroic depth.

> SOC 2 CC6.3 requires periodic review of who has access to what. This
> document is the procedure + log. The output of each review is a row in
> the table at the bottom plus any deletes / revocations done that day.

## What's in scope

Each access surface that touches customer data or production infra:

| Surface | What "access" means | Authoritative source |
|---------|---------------------|----------------------|
| AdvocateMCP admin role | `users.role = 'admin'` in D1 | `wrangler d1 execute advocatemcp-auth --remote --command="SELECT id, email, role, totp_enabled_at FROM users WHERE role='admin';"` |
| Per-tenant admin/operator access | rows in D1 `user_business_access` | `wrangler d1 execute advocatemcp-auth --remote --command="SELECT u.email, b.slug, uba.created_at FROM user_business_access uba JOIN users u ON u.id=uba.user_id JOIN businesses b ON b.id=uba.business_id;"` |
| Cloudflare account members | members listed at https://dash.cloudflare.com → Members | (manual check) |
| Railway project members | https://railway.app → project → Settings → Members | (manual) |
| Stripe team members | https://dashboard.stripe.com → Settings → Team | (manual) |
| GitHub repo collaborators | `gh api repos/cameronjmcewan-dev/advocatemcp/collaborators` | (CLI) |
| Resend team | https://resend.com → Settings → Team | (manual) |
| Twilio sub-accounts | https://console.twilio.com → Account → Sub-accounts | (manual) |

## Procedure (per cycle)

For each surface above:

1. Enumerate current members (use the command in the table or manual check).
2. For each entry, confirm:
   - Is this person still actively involved with AdvocateMCP?
   - Is the role appropriate for their current responsibilities?
   - For admin / operator roles: is TOTP enrolled
     (`totp_enabled_at IS NOT NULL`)?
3. Revoke any entry that fails ANY of the above.
4. Record the revocation in the audit log (revocations on
   `user_business_access` are NOT audit-logged today — manual entry in
   the table at bottom is the record of record until that lands).

For `users.role='admin'` specifically, also check:
- Has this admin logged in within the last 90 days?
  `SELECT actor_id, MAX(occurred_at) FROM audit_events WHERE actor_type='user' AND event_type='auth.login_success' GROUP BY actor_id;`
  Dormant admins should be downgraded to `client` or have their account
  deactivated.

## Self-review (solo founder)

Even when the only "team member" is the founder, the review still produces
useful evidence. At minimum confirm each cycle:
- The Cloudflare account has no stale invited collaborators.
- The GitHub repo has no `cameronjmcewan-dev/*` outside collaborators
  beyond the expected list.
- The D1 admin row count matches expectation (1 founder, 0 anyone else).
- All admin users have `totp_enabled_at IS NOT NULL`.

## Off-boarding checklist

When a person leaves AdvocateMCP (now or future), within 24 hours:

- [ ] Remove from Cloudflare members.
- [ ] Remove from Railway project.
- [ ] Remove from Stripe team.
- [ ] Remove as GitHub collaborator (`gh api -X DELETE repos/cameronjmcewan-dev/advocatemcp/collaborators/<user>`).
- [ ] Remove from Resend / Twilio teams.
- [ ] Remove from D1 `users` (or set `role='deactivated'` if audit history
      should be retained).
- [ ] Remove from D1 `user_business_access` for every business they had
      access to.
- [ ] Rotate every shared secret they had access to: ADMIN_SECRET,
      ACCESS_TOKEN_SIGNING_KEY, TOKEN_SIGNING_KEY, ACTIVATION_SIGNING_KEY,
      Stripe restricted keys (if any per-person), Resend keys, Twilio
      auth tokens. See `docs/secrets-runbook.md` for procedure.
- [ ] Note the off-boarding in the table below with the date.

## Review log

| Date | Reviewer | Surfaces checked | Members removed / changed | Notes |
|------|----------|------------------|--------------------------|-------|
| _no entries yet_ | | | | First scheduled review: 2026-08-12 (quarterly cadence). |

## Off-boarding log

| Date | Person | Reason | Surfaces revoked | Secrets rotated |
|------|--------|--------|------------------|-----------------|
| _no entries yet_ | | | | |
