-- AdvocateMCP Schema v2: Cloudflare for SaaS custom hostname tracking
-- Run with:
--   wrangler d1 execute advocatemcp-auth --remote --file=migrations/0002_cf_hostname.sql

ALTER TABLE businesses ADD COLUMN cf_hostname_id TEXT;
