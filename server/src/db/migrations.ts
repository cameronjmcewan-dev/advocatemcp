import type Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "migrations");

/**
 * Apply any migration files in `migrations/` whose filename is not yet
 * recorded in `schema_migrations`. Migrations run in filename-sort order,
 * each wrapped in a transaction. Files must be named `NNN_description.sql`.
 */
export function applyMigrations(db: Database.Database): void {
  const hadSchemaMigrations = _tableExists(db, "schema_migrations");

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

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
  // ALTER, surfacing the problem for hand-patching. See docs/db-migrations.md.
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

  const applied = new Set(listAppliedMigrations(db));
  // Directory may be absent in edge cases (fresh clone before build step
  // copies .sql files, or dev environments that skipped the copy). Treat
  // as an empty migration set rather than throwing ENOENT.
  if (!fs.existsSync(MIGRATIONS_DIR)) return;
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const insertApplied = db.prepare(
    "INSERT INTO schema_migrations (filename) VALUES (?)"
  );

  for (const filename of files) {
    if (applied.has(filename)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), "utf8");
    const run = db.transaction(() => {
      db.exec(sql);
      insertApplied.run(filename);
    });
    run();
  }
}

export function listAppliedMigrations(db: Database.Database): string[] {
  const exists = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'"
    )
    .get();
  if (!exists) return [];
  const rows = db
    .prepare("SELECT filename FROM schema_migrations ORDER BY filename")
    .all() as { filename: string }[];
  return rows.map((r) => r.filename);
}

function _tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
  return Boolean(row);
}

/**
 * The 21 columns added by `002_businesses_profile_columns.sql`. Hard-coded
 * (rather than parsed from the .sql) so this list itself is a load-bearing,
 * human-reviewable spec.
 *
 * This list is INTENTIONALLY duplicated in the
 * `MIGRATION_002_COLUMNS list matches the actual ALTER TABLE statements in 002`
 * test in `migrations.test.ts`. Do not consolidate — the duplication is what
 * makes the drift-guard test able to catch edits to either source. The test
 * also parses `002_businesses_profile_columns.sql` at run time, so a change
 * to ANY of the three (this constant, the test's `expected`, or the .sql)
 * fails the test until all three are updated in lockstep.
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
