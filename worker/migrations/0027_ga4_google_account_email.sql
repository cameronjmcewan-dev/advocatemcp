-- 0027_ga4_google_account_email.sql — Mirror of 0026 for GA4.
--
-- Same diagnostic motivation as the GSC version: the dashboard's GA4
-- card showed "Connected" with no signal about WHICH Google account
-- held the refresh token. Adding the email here lets the GA4 OAuth
-- callback capture it from Google's id_token at connection time and
-- surface it on the GA4 card alongside the GSC equivalent shipped in
-- PR #258.
--
-- Existing tenants have NULL until they reconnect (their refresh
-- tokens were issued under analytics.readonly only — no openid+email
-- scope). New connections after this migration + the openid+email
-- scope widening in apiGA4StartLink/handleGA4Start land with the
-- email populated.
--
-- Schema-only — no data migration; nullable column on the row that
-- already exists for the tenant.

ALTER TABLE ga4_connections ADD COLUMN google_account_email TEXT;
