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
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

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
