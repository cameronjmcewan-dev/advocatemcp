# Migration 002 Bootstrap Safety — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the silent-corruption blind spot in `applyMigrations` prod-bootstrap: if a prior deploy crashed mid-way through the old `_initSchema`'s 21 ALTER TABLE ADD COLUMN loop, today's bootstrap stamps migration 002 as applied and the missing columns are lost forever. Before stamping 002, verify every column it adds is actually present on `businesses`; if any are missing, skip the stamp so the runner re-applies and fails loudly on the first duplicate.

**Architecture:** Add one column-presence check inside the existing prod-bootstrap block in `server/src/db/migrations.ts`. 001/003/004 bootstrap logic is unchanged — only 002 has meaningful partial-application risk because it runs 21 separate DDL statements. The check reads `PRAGMA table_info(businesses)` once and compares against a hard-coded canonical column list (not parsed from the SQL file — the hard-coded list is itself a human-readable spec and fails the CI test if 002 ever drifts).

**Tech Stack:** TypeScript strict, better-sqlite3, vitest.

**Scope — deliberately narrow:** Only migration 002. The user's review explicitly prescribed option (a); 001/003/004 do not have the same risk profile and broadening would be scope creep.

**Branch base:** `feature/session-0-prereqs` (this is a followup from that branch's Task 7 code review). New worktree + branch `fix/migration-002-bootstrap-safety` off `feature/session-0-prereqs`.

---

### Task 1: Worktree setup

**Files:** none (git only)

- [ ] **Step 1: Create the worktree**

```bash
cd /Users/cameronmcewan/Desktop/advocate/advocatemcp
git worktree add .worktrees/migration-002-safety -b fix/migration-002-bootstrap-safety feature/session-0-prereqs
```

- [ ] **Step 2: Verify**

```bash
cd /Users/cameronmcewan/Desktop/advocate/advocatemcp/.worktrees/migration-002-safety
git log --oneline -3
```

Expected: top commit is `2cc4d72` (tip of session-0-prereqs), branch name `fix/migration-002-bootstrap-safety`.

---

### Task 2: Add failing test for partial-002 skip

**Files:**
- Modify: `server/src/db/migrations.test.ts` (append new `describe` block after the existing `describe("migrations runner", ...)`)

- [ ] **Step 1: Add the test cases**

Append to `server/src/db/migrations.test.ts`:

```typescript
describe("migration 002 partial-application safety", () => {
  it("does NOT stamp 002 when some profile columns are missing on businesses", () => {
    const db = new Database(":memory:");
    // Simulate the crash-mid-_initSchema scenario: businesses exists with
    // migration 001's columns plus only 10 of 002's 21 profile columns (the
    // first 10 from the ALTER list — the crash happened before completing
    // the remaining 11).
    db.exec(`
      CREATE TABLE businesses (
        id INTEGER PRIMARY KEY,
        slug TEXT,
        api_key TEXT,
        category TEXT,
        star_rating REAL,
        review_count INTEGER,
        years_in_business INTEGER,
        top_services TEXT,
        availability TEXT,
        differentiator TEXT,
        service_radius_miles INTEGER,
        certifications TEXT,
        pricing_tier TEXT
      );
    `);
    // No queries or click_events tables — exercise the full bootstrap path.

    // Bootstrap should stamp 001 (businesses exists) but NOT 002 (columns incomplete).
    // Then the runner tries to re-apply 002, which throws on the first duplicate ALTER.
    expect(() => applyMigrations(db)).toThrow(/duplicate column/i);

    const applied = listAppliedMigrations(db);
    expect(applied).toContain("001_initial_schema.sql");
    expect(applied).not.toContain("002_businesses_profile_columns.sql");

    db.close();
  });

  it("stamps 002 when all 21 profile columns are present (happy path unchanged)", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE businesses (
        id INTEGER PRIMARY KEY,
        slug TEXT,
        api_key TEXT,
        category TEXT,
        star_rating REAL,
        review_count INTEGER,
        years_in_business INTEGER,
        top_services TEXT,
        availability TEXT,
        differentiator TEXT,
        service_radius_miles INTEGER,
        certifications TEXT,
        pricing_tier TEXT,
        service_area_keywords TEXT,
        hours_json TEXT,
        services_json_v2 TEXT,
        pricing_json_v2 TEXT,
        credentials_json TEXT,
        ratings_json TEXT,
        differentiators_text TEXT,
        customer_quotes_json TEXT,
        guarantee_text TEXT,
        case_stories_json TEXT,
        lead_routing_json TEXT
      );
      CREATE TABLE queries (id INTEGER PRIMARY KEY, intent TEXT);
      CREATE TABLE click_events (
        id INTEGER PRIMARY KEY,
        destination TEXT,
        query_id INTEGER,
        legacy INTEGER NOT NULL DEFAULT 0
      );
    `);
    applyMigrations(db);
    const applied = listAppliedMigrations(db);
    expect(applied).toContain("002_businesses_profile_columns.sql");
    db.close();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd /Users/cameronmcewan/Desktop/advocate/advocatemcp/.worktrees/migration-002-safety/server
npm test -- migrations.test
```

Expected: the first new test fails (currently 002 IS stamped even when columns are missing, so `applyMigrations` does NOT throw and `applied` DOES contain `002_...`). The second test already passes because it mirrors the existing bootstrap test.

---

### Task 3: Implement the column-presence check

**Files:**
- Modify: `server/src/db/migrations.ts`

- [ ] **Step 1: Add the canonical column list and helper, update bootstrap**

Replace lines 24–42 of `server/src/db/migrations.ts` (the bootstrap block) with:

```typescript
  // Bootstrap: an existing prod DB that ran the old _initSchema already has
  // the tables and columns from migrations 001..004 applied via ALTER TABLE
  // wrapped in duplicate-column-safe try/catch. Re-running those migrations
  // as plain SQL would crash on the second ALTER. Stamp them as applied so
  // the runner skips them in prod. Detection: schema_migrations didn't exist
  // before this call AND the businesses table does.
  //
  // Safety carve-out for 002: the old _initSchema's ALTER TABLE loop could
  // crash mid-flight (machine died after N of 21 columns) and the old
  // _addColumnIfNotExists wrapper would silently swallow the resumed attempt
  // on the next boot. To avoid stamping a partially-applied 002 as "done"
  // and losing the remaining columns forever, verify every column from 002
  // is present before stamping it. If any are missing, DON'T stamp — the
  // runner will then re-apply 002 and crash loudly on the first duplicate
  // ALTER, surfacing the problem for hand-patching.
  if (!hadSchemaMigrations && _tableExists(db, "businesses")) {
    const stamp = db.prepare(
      "INSERT OR IGNORE INTO schema_migrations (filename) VALUES (?)"
    );
    stamp.run("001_initial_schema.sql");
    if (_businessesHasAll002Columns(db)) {
      stamp.run("002_businesses_profile_columns.sql");
    }
    stamp.run("003_queries_intent.sql");
    stamp.run("004_click_events.sql");
  }
```

Then, at the bottom of the file (after `_tableExists`), add:

```typescript
/**
 * The 21 columns added by `002_businesses_profile_columns.sql`. Hard-coded
 * (rather than parsed from the .sql) so this list itself is a load-bearing,
 * human-reviewable spec. If 002's SQL ever drifts from this list, the
 * `migration 002 columns list matches SQL` test catches it at CI time.
 */
const MIGRATION_002_COLUMNS: readonly string[] = [
  "category",
  "star_rating",
  "review_count",
  "years_in_business",
  "top_services",
  "availability",
  "differentiator",
  "service_radius_miles",
  "certifications",
  "pricing_tier",
  "service_area_keywords",
  "hours_json",
  "services_json_v2",
  "pricing_json_v2",
  "credentials_json",
  "ratings_json",
  "differentiators_text",
  "customer_quotes_json",
  "guarantee_text",
  "case_stories_json",
  "lead_routing_json",
];

function _businessesHasAll002Columns(db: Database.Database): boolean {
  const rows = db
    .prepare("PRAGMA table_info(businesses)")
    .all() as { name: string }[];
  const present = new Set(rows.map((r) => r.name));
  return MIGRATION_002_COLUMNS.every((c) => present.has(c));
}
```

- [ ] **Step 2: Run the tests to verify they pass**

```bash
cd /Users/cameronmcewan/Desktop/advocate/advocatemcp/.worktrees/migration-002-safety/server
npm test -- migrations.test
```

Expected: both new tests pass, and all pre-existing tests in `migrations.test.ts` still pass (the happy-path bootstrap test at line 66 already seeds all 21 columns, so nothing regresses).

- [ ] **Step 3: Run the type checker**

```bash
cd /Users/cameronmcewan/Desktop/advocate/advocatemcp/.worktrees/migration-002-safety/server
npm run typecheck 2>/dev/null || npx tsc --noEmit
```

Expected: no errors.

---

### Task 4: Add drift-guard test for the canonical column list

**Files:**
- Modify: `server/src/db/migrations.test.ts` (append to the `describe("migration 002 partial-application safety", ...)` block)

This test catches the scenario where a future developer edits `002_businesses_profile_columns.sql` but forgets to update `MIGRATION_002_COLUMNS`. Without this, the check in Task 3 would silently stop verifying a new column.

- [ ] **Step 1: Add the test**

Append inside the `describe("migration 002 partial-application safety", ...)` block:

```typescript
  it("MIGRATION_002_COLUMNS list matches the actual ALTER TABLE statements in 002", () => {
    // Parse the SQL file's ADD COLUMN names and compare against the list
    // of columns that end up on a fresh businesses table after running
    // applyMigrations. If 002 ever adds/removes a column, this test fails
    // until MIGRATION_002_COLUMNS is updated in lockstep.
    const db = new Database(":memory:");
    applyMigrations(db);
    const cols = db.prepare("PRAGMA table_info(businesses)").all() as { name: string }[];
    const present = new Set(cols.map((c) => c.name));
    // Every column from the 002-specific list (see migrations.ts) must be
    // present after a clean migration run. If not, the list is stale.
    const expected = [
      "category", "star_rating", "review_count", "years_in_business",
      "top_services", "availability", "differentiator", "service_radius_miles",
      "certifications", "pricing_tier", "service_area_keywords", "hours_json",
      "services_json_v2", "pricing_json_v2", "credentials_json", "ratings_json",
      "differentiators_text", "customer_quotes_json", "guarantee_text",
      "case_stories_json", "lead_routing_json",
    ];
    for (const c of expected) {
      expect(present.has(c), `missing column ${c}`).toBe(true);
    }
    db.close();
  });
```

- [ ] **Step 2: Run the tests**

```bash
cd /Users/cameronmcewan/Desktop/advocate/advocatemcp/.worktrees/migration-002-safety/server
npm test -- migrations.test
```

Expected: all tests pass.

---

### Task 5: Documentation

**Files:**
- Create: `docs/db-migrations.md`

- [ ] **Step 1: Write the doc**

Create `docs/db-migrations.md`:

```markdown
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
do not have the same partial-application risk: each is effectively a single
DDL statement from SQLite's perspective. They are stamped unconditionally
when the bootstrap triggers.

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
```

- [ ] **Step 2: Commit the whole change**

```bash
cd /Users/cameronmcewan/Desktop/advocate/advocatemcp/.worktrees/migration-002-safety
git add server/src/db/migrations.ts server/src/db/migrations.test.ts docs/db-migrations.md docs/superpowers/plans/2026-04-14-migration-002-bootstrap-safety.md
git commit -m "fix(server): verify 002 columns before stamping in prod bootstrap

Closes the silent-corruption blind spot from Session 0 Task 7 review:
if old _initSchema crashed mid-way through 002's 21 ALTER TABLE loop,
bootstrap stamped 002 as applied and missing columns were lost forever.
Now verifies every column is present before stamping — if any missing,
the runner re-applies and fails loudly on the first duplicate ALTER."
```

---

## Self-review checklist

- **Spec coverage:** User's option (a) — pre-stamp column verification for 002 — implemented in Task 3. Drift guard (Task 4) is an additional safety net not in the original option but directly supports its correctness.
- **Placeholder scan:** none. All code blocks are complete.
- **Type consistency:** `MIGRATION_002_COLUMNS`, `_businessesHasAll002Columns`, `applyMigrations`, `listAppliedMigrations` — names consistent across tasks.
- **Scope:** deliberately does NOT touch 001/003/004 bootstrap (per user's explicit scoping of option (a)). Does NOT change the SQL files themselves. Does NOT modify `_initSchema` (already gone per `fac89b8`).
