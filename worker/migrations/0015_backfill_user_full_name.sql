-- Backfill bug: prior to commit 1d4a4ef, worker/src/routes/activate.ts passed
-- the business name as the user's full_name during hosted-tenant activation.
-- This polluted users.full_name with strings like "The Bamboo Brace" for every
-- customer onboarded via the hosted flow. Symptom: dashboard greeting reads
-- "Welcome back, The." (first word of the polluted name).
--
-- Fix: replace any users.full_name that exactly matches a business_name with
-- the email local-part. Idempotent — re-running this returns 0 rows changed.

UPDATE users
SET full_name = SUBSTR(email, 1, INSTR(email, '@') - 1)
WHERE full_name IN (SELECT business_name FROM businesses WHERE business_name IS NOT NULL)
  AND email LIKE '%@%';
