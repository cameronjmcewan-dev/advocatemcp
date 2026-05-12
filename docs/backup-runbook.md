# Backup & Disaster Recovery Runbook

**Owner:** Max.
**Last reviewed:** 2026-05-12.
**Last restore drill:** never (gap — flagged in `docs/soc2-gap-assessment.md` H3).
**Scope:** All persistent stores on the AdvocateMCP hosted service.

> SOC 2 CC7.5 / CC9.2 require documented backup procedures AND evidence
> that restoration has actually been tested. This document covers (a)
> what's backed up where, (b) RTO/RPO targets, and (c) the drill
> procedure. A quarterly drill is operator-owned; record the date below
> after each one.

## Data inventory

| Store | Content | Backed up by | Frequency | Operator action |
|-------|---------|--------------|-----------|-----------------|
| Cloudflare D1 `advocatemcp-auth` | Users, sessions, tenant lifecycle, audit_events | Cloudflare (managed) | Continuous | None — backup is automatic. See "Restore: D1" below. |
| Cloudflare KV `BUSINESS_MAP` / `TENANT_DATA` | Hostname → slug routing, tenant JSON records | Cloudflare (managed) | Continuous | None |
| Railway volume — `/app/data/dev.db` (SQLite) | Businesses, queries, reservations, handoffs, audit data, callbacks, analytics | Railway volume snapshots **if enabled** | Provider-default (verify in dashboard) | **Verify weekly that snapshots are enabled and recent**; export weekly to R2 (script below). |
| GitHub (source) | Code, migrations, secrets runbook | GitHub | Git native | None |

## RTO / RPO targets

| Store | RTO (max time to restore) | RPO (max acceptable data loss) | Notes |
|-------|---------------------------|-------------------------------|-------|
| D1 | 4 hours | 1 hour | Bounded by Cloudflare's restore SLA. |
| KV | 4 hours | 1 hour | Same. |
| Railway SQLite | 4 hours | 24 hours | RPO is the weekly export cadence; reduce to 1 hour by enabling `litestream` to R2 (see "Reducing RPO" below). |

These targets are NOT contractual SLAs to customers (we don't offer one
in v1). They are internal targets that the audit trail expects.

## Restore: D1 `advocatemcp-auth`

Cloudflare D1 supports point-in-time restore from the dashboard for the
last 30 days. The CLI path:

```bash
# 1. List restorable timestamps.
wrangler d1 time-travel info advocatemcp-auth

# 2. Restore to a chosen bookmark. THIS REPLACES THE CURRENT DB IN PLACE —
#    only do this with explicit operator confirmation. Prefer cloning to
#    a new DB for inspection, then renaming.
wrangler d1 time-travel restore advocatemcp-auth --bookmark <BOOKMARK>
```

For non-destructive inspection (recommended pre-restore step):

```bash
# Export the current state first.
wrangler d1 export advocatemcp-auth --output=/tmp/d1-pre-restore-$(date +%s).sql --remote
# Then run the restore.
```

## Restore: Railway SQLite

Two paths.

### Path A — Railway volume snapshot
1. Railway dashboard → service → Volume → Snapshots.
2. Select the snapshot closest to the desired recovery point.
3. "Restore" — this replaces the live volume. Service restarts.
4. Verify by running `sqlite3 /app/data/dev.db .tables` over `railway run`.

### Path B — manual export (recommended weekly until litestream lands)
This is the gap fill while RPO is still 24 hours. Cron this weekly on a
machine you control (laptop, Mac mini, separate VPS):

```bash
# Pull a copy via Railway CLI. Requires `railway link` to the project.
railway run sqlite3 /app/data/dev.db ".backup '/tmp/advocate-$(date +%Y%m%d).db'"
# Upload to R2 (or any off-Railway cold storage).
wrangler r2 object put advocate-backups/sqlite/$(date +%Y/%m)/advocate-$(date +%Y%m%d).db \
  --file=/tmp/advocate-$(date +%Y%m%d).db --remote
```

Retention: keep 90 days of daily backups, 12 months of monthly backups.

## Reducing RPO with litestream (deferred)

Litestream streams SQLite WAL pages to S3/R2 on every commit, getting
RPO down to seconds. Worth doing when the cost of 24-hour data loss
becomes meaningfully higher than today.

Setup outline (NOT YET DONE):
1. `npm install litestream-node` or use the standalone binary in the
   Railway image.
2. Add a Procfile process: `litestream replicate -config /etc/litestream.yml`.
3. Point at an R2 bucket with the same retention rules as above.
4. Test restore: `litestream restore -config /etc/litestream.yml /tmp/restored.db`.

## Drill procedure (quarterly)

The drill is what turns a backup from "exists" to "verified working." Do
it once per quarter; SOC 2 auditors will ask for evidence.

1. Pick a recent backup (D1 bookmark + Railway snapshot OR the latest
   weekly export).
2. Create a NON-production copy of each store:
   - D1: `wrangler d1 create advocatemcp-auth-drill` then time-travel
     restore the chosen bookmark INTO the new DB (not the prod one).
   - SQLite: `sqlite3 /tmp/drill.db ".restore /tmp/advocate-YYYYMMDD.db"`.
3. Verify integrity:
   - Row counts on the major tables: `users`, `businesses`, `sessions`,
     `audit_events`, `reservations`, `handoffs`. Compare with previous
     drill's row counts (allow growth).
   - Spot-check 3 random tenant slugs round-trip across both stores.
4. Record results in this file under "Drill log" below.
5. Delete the drill DB / file after.

## Drill log

| Date | Operator | Stores tested | Result | Notes |
|------|----------|---------------|--------|-------|
| _none yet_ | — | — | — | Track first drill before SOC 2 Type II observation starts. |

## Sub-processor notes

- **Cloudflare** provides backups for D1, KV, Workers, Pages, R2. Their
  SOC 2 Type II report covers the data-durability controls; cite it in
  `docs/vendor-management.md`.
- **Railway** provides volume snapshots on paid plans. Verify the plan
  is paid (the project is, as of 2026-05-12). Their SLA documents the
  retention window — confirm in their docs at next quarterly review.

## When this document last lied

If a procedure here failed during a real incident, note it. Stale
runbooks cause worse outages than no runbooks.

| Date | Step that failed | Fix |
|------|-----------------|-----|
| _none yet_ | | |
