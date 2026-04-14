import Database from "better-sqlite3";
import "dotenv/config";
import fs   from "fs";
import path from "path";

const DB_PATH = process.env.DATABASE_PATH ?? "/app/data/dev.db";

// Ensure the parent directory exists (Railway persistent volume or local)
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

let _db: Database.Database | undefined;

export function getDb(): Database.Database {
  if (_db) return _db;

  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  _initSchema(_db);
  return _db;
}

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

function _initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS businesses (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      slug         TEXT UNIQUE NOT NULL,
      name         TEXT NOT NULL,
      description  TEXT NOT NULL,
      services     TEXT NOT NULL,          -- JSON array of service strings
      pricing      TEXT,
      location     TEXT,
      phone        TEXT,
      website      TEXT,
      referral_url TEXT,                   -- the CTA link to send AI searchers to
      tone         TEXT DEFAULT 'friendly',-- friendly | professional | luxury
      api_key      TEXT UNIQUE NOT NULL,
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS queries (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      business_slug    TEXT NOT NULL,
      crawler_agent    TEXT,               -- e.g. "PerplexityBot"
      query_text       TEXT NOT NULL,
      response_text    TEXT NOT NULL,
      referral_clicked INTEGER DEFAULT 0,
      timestamp        DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // ── Section 1 migrations: rich SMB profile columns ──
  const bizCols: [string, string][] = [
    ["category", "TEXT"],
    ["star_rating", "REAL"],
    ["review_count", "INTEGER"],
    ["years_in_business", "INTEGER"],
    ["top_services", "TEXT"],
    ["availability", "TEXT"],
    ["differentiator", "TEXT"],
    ["service_radius_miles", "INTEGER"],
    ["certifications", "TEXT"],
    ["pricing_tier", "TEXT"],
    ["service_area_keywords", "TEXT"],
    // ── 9-step wizard: JSON blobs ──
    ["hours_json", "TEXT"],
    ["services_json_v2", "TEXT"],
    ["pricing_json_v2", "TEXT"],
    ["credentials_json", "TEXT"],
    ["ratings_json", "TEXT"],
    ["differentiators_text", "TEXT"],
    ["customer_quotes_json", "TEXT"],
    ["guarantee_text", "TEXT"],
    ["case_stories_json", "TEXT"],
    ["lead_routing_json", "TEXT"],
  ];
  for (const [col, type] of bizCols) {
    _addColumnIfNotExists(db, "businesses", col, type);
  }

  // ── Section 2 migration: intent column on queries ──
  _addColumnIfNotExists(db, "queries", "intent", "TEXT");

  // ── Section 3: click events log ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS click_events (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      business_slug TEXT NOT NULL,
      ref           TEXT,        -- bot name that sourced the response (e.g. "PerplexityBot")
      user_agent    TEXT,        -- UA of the human who clicked
      ip_hash       TEXT,        -- SHA-256(IP) for deduplication
      timestamp     DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // ── Session 1 migrations: attribution hardening columns on click_events ──
  _addColumnIfNotExists(db, "click_events", "destination", "TEXT");
  _addColumnIfNotExists(db, "click_events", "query_id", "INTEGER");
  _addColumnIfNotExists(db, "click_events", "legacy", "INTEGER NOT NULL DEFAULT 0");
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
}
