-- 0026_gsc_google_account_email.sql — Surface the connected Google
-- account email on the GSC card.
--
-- Pre-fix, the dashboard's GSC card showed "Connected" with no signal
-- about WHICH Google account currently held the refresh token. When a
-- user said "I verified advocatemcp.com in Search Console" but the
-- picker was empty, we couldn't tell whether they were on the wrong
-- account (verification done under one Gmail, OAuth granted under
-- another) or had simply skipped the verify step entirely. That cost
-- a full session of back-and-forth in May 2026.
--
-- Adding the email here lets the OAuth callback (worker/src/routes/
-- gscOauth.ts) capture it from Google's id_token at connection time
-- and surface it on the GSC card. Existing tenants have NULL until
-- they reconnect; new connections land with the email populated.
--
-- Schema-only — no data migration; nullable column on the row that
-- already exists for the tenant.

ALTER TABLE gsc_connections ADD COLUMN google_account_email TEXT;
