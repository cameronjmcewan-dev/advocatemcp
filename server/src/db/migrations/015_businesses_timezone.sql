-- Session 12 (Apr 17 2026): per-business IANA timezone for get_availability's
-- local-clock interpretation of hours_json. Nullable; read path defaults to
-- "America/Los_Angeles" when null (majority of current + expected SMB
-- customer base in US West). Future: derive from `location` field in the
-- wizard's Step 1, or prompt explicitly in Step 3 (hours).
ALTER TABLE businesses ADD COLUMN timezone TEXT;
