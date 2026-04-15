# Database migrations

Canonical SQL migrations live in `server/src/db/migrations/` as `NNN_description.sql`,
applied by `server/src/db/migrations.ts:applyMigrations()` in filename-sort order,
each wrapped in a transaction. Applied filenames are recorded in the
`schema_migrations` bookkeeping table.

## Prod bootstrap

Production DBs that predate the migrations runner were initialized by the old
`_initSchema` code path (dropped in commit `fac89b8`). On first boot after
deploying the runner, `applyMigrations` detects this state (the
`schema_migrations` table doesn't exist but `businesses` does) and stamps
migrations 001–004 as applied so the runner doesn't try to re-apply them.

### Safety carve-out for migration 002

Migration 002 runs 21 separate `ALTER TABLE ADD COLUMN` statements. The old
`_initSchema` used a `_addColumnIfNotExists` wrapper that silently swallowed
duplicate-column errors, which means a machine that died mid-loop (say after
column 10 of 21) would on next boot appear to complete — but columns 11–21
would never exist.

If such a DB reached the migrations runner, a naive bootstrap would stamp 002
as applied and the remaining columns would be lost forever.

To prevent this, the bootstrap for 002 specifically checks that every column
in `MIGRATION_002_COLUMNS` is present on `businesses` before stamping. If any
are missing, 002 is NOT stamped — the runner then attempts to re-apply it
and fails loudly on the first duplicate ALTER, surfacing the problem for
hand-patching.

Migrations 001 (CREATE TABLE), 003 (single ADD COLUMN), and 004 (CREATE TABLE)
do not have the same partial-application risk: each is structured so a partial
application cannot leave a silently-broken table shape — 001 and 004 use
`CREATE TABLE IF NOT EXISTS` (re-running is a no-op), and 003 is a single
ALTER that either applied in full or didn't apply at all. They are stamped
unconditionally when the bootstrap triggers.

## Adding a migration

1. Create `server/src/db/migrations/NNN_short_description.sql` (N = next unused prefix).
2. If the new migration adds many `ALTER TABLE ADD COLUMN` statements, consider
   whether it needs the same bootstrap safety treatment 002 got. New migrations
   running against a DB that already has `schema_migrations` bookkeeping are
   safe by construction — the bootstrap only fires once per DB, on the first
   post-runner boot.
3. If you change migration 002, also update `MIGRATION_002_COLUMNS` in
   `server/src/db/migrations.ts`. The drift-guard test in
   `migrations.test.ts` will catch a mismatch at CI time.
4. Add tests in `server/src/db/migrations.test.ts`.
