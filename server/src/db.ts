import Database from "better-sqlite3";
import "dotenv/config";
import fs   from "fs";
import path from "path";
import { applyMigrations } from "./db/migrations.js";

let _db: Database.Database | undefined;

export function getDb(): Database.Database {
  if (_db) return _db;

  // Read path lazily so tests can set process.env.DATABASE_PATH before first call.
  const dbPath = process.env.DATABASE_PATH ?? "/app/data/dev.db";
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  _db = new Database(dbPath);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  _initSchema(_db);
  return _db;
}

/**
 * Test-only helper: close the current handle and drop the module-level cache so
 * a subsequent `getDb()` re-reads `process.env.DATABASE_PATH`. Lets test files
 * point at different tmp DBs without the first `import` binding the cache.
 * NEVER call this from production code.
 */
export function _resetDbForTests(): void {
  if (_db) {
    try { _db.close(); } catch { /* ignore close errors in tests */ }
    _db = undefined;
  }
}

// Test-only: expose the raw better-sqlite3 handle so tests can run migrations
// inline without importing the private module state. Not for production callers.
export function __getRawForTest(): unknown {
  return getDb();
}

/**
 * Test-only helper: inject (or clear) a pre-built better-sqlite3 handle as the
 * module-level cache. Lets integration tests build an in-memory DB, run
 * migrations on it, and have route handlers (which call `getDb()`) read/write
 * the same DB without touching the filesystem. Pass `null` to clear.
 * NEVER call this from production code.
 */
export function _setDbForTesting(db: Database.Database | null): void {
  if (db === null) {
    _db = undefined;
    return;
  }
  _db = db;
}

// Retained as dead code pending full migration rollout. Once every
// environment's DB has been stamped with the schema_migrations bootstrap
// row (Task 7), this helper and its callers can be removed entirely. Until
// then it's kept in the tree so a revert to the old _initSchema path
// remains a one-line flip if the migrations runner needs to be disabled.
function _addColumnIfNotExists(
  db: Database.Database,
  table: string,
  column: string,
  type: string
): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  } catch {
    // Column already exists — safe to ignore
  }
}
// Keep the symbol alive so TS/lint won't prune it while it's dead.
void _addColumnIfNotExists;

function _initSchema(db: Database.Database): void {
  applyMigrations(db);
}

/** Type that mirrors the businesses table row. */
export interface BusinessRow {
  id: number;
  slug: string;
  name: string;
  description: string;
  services: string;      // raw JSON string
  pricing: string | null;
  location: string | null;
  phone: string | null;
  website: string | null;
  referral_url: string | null;
  tone: string;
  api_key: string;
  created_at: string;
  // Section 1: rich profile fields
  category: string | null;
  star_rating: number | null;
  review_count: number | null;
  years_in_business: number | null;
  top_services: string | null;
  availability: string | null;
  differentiator: string | null;
  service_radius_miles: number | null;
  certifications: string | null;
  pricing_tier: string | null;
  service_area_keywords: string | null;
  // 9-step wizard JSON blobs (stringified)
  hours_json: string | null;
  services_json_v2: string | null;
  pricing_json_v2: string | null;
  credentials_json: string | null;
  ratings_json: string | null;
  differentiators_text: string | null;
  customer_quotes_json: string | null;
  guarantee_text: string | null;
  case_stories_json: string | null;
  lead_routing_json: string | null;
  // Migration 023: format-judge score cache. Both fields are typed
  // as optional+nullable so existing test fixtures (which don't yet
  // populate them) keep compiling. SELECT * from production rows
  // either populated post-migration or returns null. Treat missing
  // and null as equivalent everywhere.
  last_score_json?: string | null;
  score_history_json?: string | null;
  // Migration 036 (Apr 30 2026): AI Insights cache for the Pro/Enterprise
  // /api/client/ai-recommendations surface. JSON-stringified CachedAIRecs
  // blob — see server/src/routes/aiRecommendations.ts for the shape.
  // Cache invalidation is composite: profile_hash + score_hash +
  // analytics_window_id + 7-day max staleness. NULL = cold-start.
  last_ai_recommendations_json?: string | null;
  // Migration 038 (May 11 2026): SOC 2 CC6.2/CC6.3 lifecycle gate. See
  // server/src/middleware/auth.ts BLOCKED_STATUSES and the matching
  // worker/migrations/0026_business_status.sql. Optional+nullable because
  // pre-migration test fixtures don't populate it; auth middleware treats
  // null as 'active' (the column default).
  business_status?: string | null;
  status_changed_at?: string | null;
  // Migration 039 (May 11 2026): SOC 2 CC6.1 — PBKDF2-SHA256 hash of the
  // API key plus an indexed lookup prefix. Both optional+nullable during
  // the dual-read transition; legacy rows have NULL here and validate via
  // the plaintext api_key column. See server/src/lib/apiKeyHash.ts for
  // the encoded format and server/src/middleware/auth.ts for the lookup
  // strategy + opportunistic backfill.
  api_key_hash?: string | null;
  api_key_prefix?: string | null;
  // Migration 013 (Apr 15 2026): Pro plan tier added at the same time
  // as Competitor Radar polling. 'free' | 'base' | 'pro' | 'enterprise'.
  // Optional+nullable like the other late-added columns so test fixtures
  // pre-migration-013 keep compiling.
  plan?: string | null;
  // Migration 037 (Apr 30 2026): cancellation/refund policy surfaced
  // by get_cancellation_policy MCP tool. Distinct from guarantee_text
  // (positive promise) — this is the operational rule the agent quotes
  // when a user asks "what if I need to cancel?".
  cancellation_policy_text?: string | null;
  // Migration 033 (Apr 28 2026): aggressive FAQ array — Phase 1 of
  // the grey-hat AI optimization layer. JSON-stringified array of
  // {question, answer, intent} entries; renderers parse and emit
  // as a multi-entry FAQPage. See server/src/agent/faqGenerator.ts.
  faqs_json?: string | null;
  faqs_generated_at?: number | null;
  faqs_source?: string | null;
}

export interface ReservationRow {
  id: string;
  business_slug: string;
  agent_id: string | null;
  requested_at: number;
  window_start: number;
  window_end: number;
  status: 'held' | 'confirmed' | 'rejected' | 'expired';
  confirmation_token: string;
  customer_contact_json: string;
  idempotency_key: string;
  expires_at: number;
  created_at: number;
}

export interface HandoffRow {
  id: string;
  business_slug: string;
  reservation_id: string | null;
  mode: 'human' | 'agent';
  delivered_via: 'sms' | 'email' | null;
  continuation_url: string | null;
  handshake_token: string | null;
  ticket_id: string | null;
  agent_id: string | null;
  created_at: number;
}

export interface QueryRow {
  id: number;
  business_slug: string;
  crawler_agent: string | null;
  query_text: string;
  response_text: string;
  referral_clicked: number;
  timestamp: string;
  intent: string | null;
  request_id: string | null;
  agent_id: string | null;
  stage: string | null;
}
