# Incident Response Runbook

**Owner:** Max (max@advocate-mcp.com) — solo on-call.
**Last reviewed:** 2026-05-12.
**Scope:** Customer-impacting incidents on the AdvocateMCP hosted service
(Worker + Railway + D1 + SQLite + Stripe billing + AI crawlers). Internal
tooling outages that don't reach customers are NOT incidents — log them in
`docs/followups.md` instead.

## Severity ladder

| Sev | Customer impact | Examples | Target response | Target resolution |
|-----|-----------------|----------|-----------------|-------------------|
| **Sev0** | Total outage OR data loss OR security breach with exfil | Worker returns 5xx for all traffic; D1 corruption; confirmed leaked API key in the wild; webhook secret compromise | within 15 min | within 4 hours |
| **Sev1** | Major degradation OR single-tenant outage OR auth broken | `/mcp` returns 5xx; admin dashboard down; Stripe webhook 401s and not retrying; one tenant's domain not routing | within 30 min | within 8 hours |
| **Sev2** | Minor degradation OR feature broken for some tenants | Reservation tool 503s; demo page renders without data; agent query latency >30s | within 4 hours (business hours) | within 48 hours |
| **Sev3** | Cosmetic / single-customer / not-yet-customer-reported | Misaligned UI element; one tenant's beta cohort flag missing; preview deploy failure | next business day | as time permits |

If unsure, **round up**. A Sev2 that turns out to be a Sev1 wastes the
on-call's time; a Sev1 logged as a Sev2 misses SLO and disappoints
customers.

## First five minutes

When an alert fires (Sentry email/SMS, customer DM, monitoring page red),
do these in order. Do not skip ahead to fixing.

1. **Acknowledge** the alert (Sentry: assign to yourself).
2. **Decide severity** using the table above.
3. **Open a working doc**: copy `docs/incidents/_template.md` to
   `docs/incidents/YYYY-MM-DD-short-name.md`. Fill the `Started at` and
   `Severity` headers. This is the live log — append to it as you go.
4. **Communicate** based on severity:
    - Sev0/Sev1: post status to https://status.advocatemcp.com (or, until
      that exists, email customers via Resend with `BCC: max@advocate-mcp.com`).
    - Sev2/Sev3: log only, communicate once resolved.
5. **Start investigating**. Hypothesise. Verify with logs/metrics BEFORE
   making changes. The Apr 13 wildcard incident (see backfilled
   postmortem) is the canonical example of what happens when a fix is
   applied based on an unverified hypothesis.

## Where to look first

| Symptom | First place to look |
|---------|---------------------|
| 5xx from `customers.advocatemcp.com` | `wrangler tail` (worker logs in real time) |
| 5xx from `api.advocatemcp.com` | Railway logs dashboard, then Sentry |
| Stripe webhook failing | Stripe Dashboard → Developers → Webhooks → recent attempts |
| Tenant routing broken | Cloudflare → Workers Routes table on the zone |
| Database error | `wrangler d1 execute advocatemcp-auth --remote --command="..."` |
| AI crawler not routed | `wrangler tail` filtered on the tenant slug |
| Boot crash on deploy | GitHub Actions logs for the relevant workflow |

## When to roll back

**Default:** if a change went out in the last 2 hours and the incident
started in that window, roll back FIRST, investigate AFTER.

```bash
# Worker
cd worker && npx wrangler rollback

# Pages
# Cloudflare dashboard → Pages → advocatemcp-site → previous deploy → "Rollback"

# Railway server
# Railway dashboard → service → deployments → previous → "Redeploy"
```

A rollback that turns out to be unnecessary is cheap. A 30-minute
investigation that ends in a rollback anyway is expensive.

## Comms templates

### Status post (Sev0/Sev1, customer-visible)
```
[INVESTIGATING] AdvocateMCP <service> is currently experiencing <impact>.
We're investigating and will update within 15 minutes. Started <time UTC>.
```

### Update
```
[UPDATE] <Time UTC>. <One-sentence status>. <Optional ETA or next-update window>.
```

### Resolution
```
[RESOLVED] <Time UTC>. <One-sentence root cause>. Postmortem to follow within
72 hours at https://github.com/cameronjmcewan-dev/advocatemcp/issues.
```

## Postmortem requirement

**Sev0 and Sev1 incidents require a written postmortem within 72 hours.**
File it at `docs/incidents/YYYY-MM-DD-short-name.md` using the template.
Sev2 incidents get a postmortem if the underlying cause could plausibly
recur as Sev1 (engineer's call).

### Postmortem template
See `docs/incidents/_template.md`.

## Anti-patterns

Things observed historically that did NOT work:

- **Bypassing the secret-verification path "just to unblock"**. The Apr 12
  STRIPE_WEBHOOK_SECRET incident escalated because the first fix attempt
  loosened signature verification. Always rotate, never disable.
- **Applying a fix without rolling back first when a recent deploy is
  suspect**. Apr 13 wildcard route — see postmortem.
- **Treating Sentry red as the source of truth without checking actual
  customer-observed behaviour.** Sentry can lie (sampling, suppressed
  errors); customer DMs cannot.

## On-call rotation

Solo founder. Secondary contact for unreachable-Max scenarios: TBD —
this is a known gap, flagged in `docs/soc2-gap-assessment.md` as part of
the SOC 2 CC9 work. Until a secondary is named, customer-visible outage
SLAs assume best-effort during US Pacific business hours and resolved by
next business day outside them.
