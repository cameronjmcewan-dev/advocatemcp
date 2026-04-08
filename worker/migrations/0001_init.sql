-- AdvocateMCP Auth Schema v1
-- Run with:
--   wrangler d1 execute advocatemcp-auth --remote --file=migrations/0001_init.sql

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  salt          TEXT NOT NULL,
  full_name     TEXT,
  role          TEXT NOT NULL DEFAULT 'client',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Stores the Railway slug + api_key so the Worker can proxy analytics on behalf of clients.
CREATE TABLE IF NOT EXISTS businesses (
  id            TEXT PRIMARY KEY,
  slug          TEXT UNIQUE NOT NULL,
  business_name TEXT NOT NULL,
  api_key       TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_business_access (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, business_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT UNIQUE NOT NULL,
  expires_at   TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Tracks failed login attempts per email for rate limiting.
CREATE TABLE IF NOT EXISTS login_attempts (
  id           TEXT PRIMARY KEY,
  identifier   TEXT NOT NULL,
  attempted_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_token    ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_expires  ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_uba_user          ON user_business_access(user_id);
CREATE INDEX IF NOT EXISTS idx_attempts_id_time  ON login_attempts(identifier, attempted_at);
