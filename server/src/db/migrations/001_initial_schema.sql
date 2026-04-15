CREATE TABLE IF NOT EXISTS businesses (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  slug         TEXT UNIQUE NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL,
  services     TEXT NOT NULL,
  pricing      TEXT,
  location     TEXT,
  phone        TEXT,
  website      TEXT,
  referral_url TEXT,
  tone         TEXT DEFAULT 'friendly',
  api_key      TEXT UNIQUE NOT NULL,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS queries (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  business_slug    TEXT NOT NULL,
  crawler_agent    TEXT,
  query_text       TEXT NOT NULL,
  response_text    TEXT NOT NULL,
  referral_clicked INTEGER DEFAULT 0,
  timestamp        DATETIME DEFAULT CURRENT_TIMESTAMP
);
