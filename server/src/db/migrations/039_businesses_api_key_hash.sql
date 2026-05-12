-- Migration 039 — businesses.api_key_hash + api_key_prefix
--
-- SOC 2 CC6.1: tenant API keys must not be stored in plaintext, and
-- comparisons must be constant-time. Adds two columns:
--
--   api_key_hash    TEXT — PBKDF2-SHA256 encoded hash of the API key.
--                          Format: 'pbkdf2-sha256$<iter>$<saltHex>$<hashHex>'
--                          (same encoded shape as worker/src/auth.ts password hash).
--   api_key_prefix  TEXT — First 8 chars of the API key. Indexed so the auth
--                          middleware can do an O(1) lookup, then constant-time
--                          verify only against the matching row's hash.
--
-- Migration strategy is LAZY (no forced rotation of existing keys):
--   1. After this migration, both columns are NULL on every existing row.
--   2. Auth middleware dual-reads:
--      a. Prefix lookup → constant-time verify against api_key_hash.
--      b. If no row matches by prefix, fall back to legacy plaintext lookup
--         on the existing api_key column.
--      c. On legacy-path success, opportunistically backfill api_key_hash +
--         api_key_prefix for that row. Next request hits the fast path.
--   3. New keys (POST /register, POST /agents/:slug/rotate-key) populate all
--      three columns (api_key + api_key_hash + api_key_prefix) for now to
--      preserve back-compat with anything that reads the plaintext column.
--   4. After all live rows show api_key_hash IS NOT NULL, schedule migration
--      040 to drop the plaintext api_key column. That's a separate change
--      because it needs the worker side to stop reading the plaintext column
--      first (it currently displays the key in the customer dashboard).
--
-- The prefix is not a secret — disclosed in logs already, and in URL params
-- of admin commands. It serves the same role as a username for lookup.
-- The hash format embeds salt + iterations per row so we can upgrade
-- iteration count without a schema change.

ALTER TABLE businesses ADD COLUMN api_key_hash   TEXT;
ALTER TABLE businesses ADD COLUMN api_key_prefix TEXT;

CREATE INDEX IF NOT EXISTS idx_businesses_api_key_prefix
  ON businesses(api_key_prefix);
