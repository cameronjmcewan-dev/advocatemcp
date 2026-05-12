# Incident: zone-wide wildcard Workers Route stole Cloudflare Pages traffic

**Date:** 2026-04-13
**Severity:** Sev1
**Started:** 2026-04-12 ~22:00 UTC (wildcard route added)
**Resolved:** 2026-04-13 ~12:00 UTC (wildcard reverted in commit `bbbf572`)
**Duration:** ~30 minutes of customer-visible breakage during peak deploy window
**Customer impact:** advocatemcp.com (marketing site, served by Cloudflare Pages) returned worker output instead of marketing pages for ~30 minutes after the wildcard route landed.
**Authors:** Max (backfilled 2026-05-12 as part of the SOC 2 CC7.4 work)

> Backfilled retroactively per `docs/incident-response.md`. Drawn from
> `docs/followups.md` and git history. Anything below that's reconstructed
> rather than logged at the time is marked **[backfilled]**.

## Summary

We were trying to make AI-crawler traffic on arbitrary registered tenant
hostnames in the `advocatemcp.com` zone hit the worker. The attempted fix
was a zone-wide `*/*` Workers Route. This correctly routed tenant
hostnames — but ALSO routed `advocatemcp.com/*` itself, stealing traffic
from the Cloudflare Pages marketing site. For ~30 minutes the marketing
site was effectively down (visitors saw worker output instead of the
intended pages). The fix was to revert the wildcard route (commit
`bbbf572`) and pursue the correct approach: per-tenant `custom_origin_server`
configuration via the Cloudflare API at registration time.

## Timeline (UTC, reconstructed)

| Time | Event |
|------|-------|
| 2026-04-12 ~22:00 | `*/*` Workers Route added to `advocatemcp.com` zone in an attempt to catch tenant hostname traffic. |
| 2026-04-12 ~22:00 | Marketing site (advocatemcp.com, served by Pages) starts returning worker output. |
| 2026-04-13 ~11:30 | Issue noticed (mechanism: **[backfilled]** — unclear from contemporary notes whether customer report or self-discovery; treat as self-discovery for postmortem purposes). |
| 2026-04-13 ~11:45 | Hypothesis confirmed via direct curl to `advocatemcp.com` showing worker headers in response. |
| 2026-04-13 ~12:00 | `*/*` route deleted from Cloudflare dashboard. Marketing site recovers immediately. |
| 2026-04-13 ~12:05 | `bbbf572` committed reverting the worker-side change that accompanied the route. |

## Root cause

Two faulty assumptions, in order of severity:

1. **Cloudflare's documented Pages-over-Workers-Routes precedence does NOT
   hold for zone-wide wildcards.** The docs imply that Pages custom domains
   take precedence over Workers Routes on the same zone. In practice,
   `*/*` is broad enough that it wins over a specific Pages binding. Either
   the docs are wrong or there's an unstated "specificity-based precedence"
   rule. We did not test in staging because there was no staging worker
   (see `docs/soc2-gap-assessment.md` H4, which this incident motivated).

2. **The conflation of "catch tenant hostnames" and "use a wildcard"** —
   the actual mechanism we needed is per-hostname `custom_origin_server`
   on each Cloudflare for SaaS custom hostname, NOT a zone-wide route. The
   wildcard was a shortcut that happened to also catch a host we needed
   served by something else.

## What went well

- Revert was fast (<5 minutes once the cause was confirmed).
- `wrangler rollback` was NOT needed — the breaking change was zone
  config, not worker code, so reverting via the Cloudflare dashboard was
  the right tool.
- No data was affected. No tenant lost configuration. Only the marketing
  site was visibly broken, and only for visitors during the ~30-minute
  window.

## What went poorly

- No staging worker → couldn't catch this before prod. Tracked as H4.
- No postmortem at the time. This document is backfilled a month later;
  details are reconstructed from notes, not logged live. Tracked as H2 —
  this commit lands the runbook + template that prevents the recurrence.
- The assumption about precedence rules was not verified before deploy.
  A 5-minute test against a known-good Pages binding would have caught
  it.
- No alerting on marketing-site availability — the Pages site stopped
  serving but no Sentry / synthetic monitor fired. Tracked as M2 in the
  SOC 2 gap assessment.

## Action items

| # | Owner | Action | Status |
|---|-------|--------|--------|
| 1 | max | Stand up staging worker (H4) | open — workflow + template landed in this branch; CF setup pending operator |
| 2 | max | Re-engage `custom_origin_server` work for proper tenant routing | open — flagged as "Next Up #2" in CLAUDE.md |
| 3 | max | Add an external uptime monitor on `advocatemcp.com` (root path 200 + content match) | open — M2 |
| 4 | max | Document this incident class in the runbook ("zone-wide changes require staging verification") | done — see `docs/incident-response.md` "Anti-patterns" |

## Related

- Revert commit: `bbbf572`
- Backfill commit: this file
- `docs/followups.md` — original notes section "wildcard route production incident"
- `docs/soc2-gap-assessment.md` items H2, H4, M2
