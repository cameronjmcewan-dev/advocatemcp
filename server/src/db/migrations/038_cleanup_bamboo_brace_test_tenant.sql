-- Migration 038: remove the bamboo-brace pre-customer pilot tenant.
--
-- bamboo-brace was a pre-customer pilot install used between 2026-04-08
-- and 2026-05-02 to validate the worker → Railway → Claude → attribution
-- loop end to end. As of 2026-05-02 the corresponding D1 + KV records
-- are already purged on the worker side; this migration removes the
-- mirror rows from Railway prod SQLite so:
--
--   1. The slug 'bamboo-brace' (UNIQUE on businesses.slug) is free to
--      re-register if ever needed for a real customer.
--   2. ~16 stale GPTBot/PerplexityBot/mcp-client probe rows in `queries`
--      (and any related rows in derived tables) stop appearing in
--      cross-tenant aggregates.
--
-- The migration runner wraps this whole file in a transaction; if any
-- DELETE references a non-existent table or column, the entire migration
-- rolls back and is NOT recorded in `schema_migrations`. That means a
-- failure surfaces loudly on next boot rather than leaving partial
-- state. Every table named here is created by an earlier migration in
-- this directory and is verified present in prod by virtue of those
-- migrations being applied.
--
-- DELETE order:
--   1. business_id FK tables (CASCADE not guaranteed because the prod
--      `PRAGMA foreign_keys` setting is not enforced by this codebase;
--      explicit deletes for parity).
--   2. business_slug TEXT tables.
--   3. slug TEXT tables (different column convention from above).
--   4. The parent `businesses` row last so the subquery in step 1
--      still resolves while step 1 runs.

-- 1. business_id FK tables.
DELETE FROM comparison_pages WHERE business_id IN
  (SELECT id FROM businesses WHERE slug = 'bamboo-brace');
DELETE FROM competitors      WHERE business_id IN
  (SELECT id FROM businesses WHERE slug = 'bamboo-brace');
DELETE FROM synthetic_pages  WHERE business_id IN
  (SELECT id FROM businesses WHERE slug = 'bamboo-brace');

-- 2. business_slug TEXT tables.
DELETE FROM queries           WHERE business_slug = 'bamboo-brace';
DELETE FROM click_events      WHERE business_slug = 'bamboo-brace';
DELETE FROM reservations      WHERE business_slug = 'bamboo-brace';
DELETE FROM handoffs          WHERE business_slug = 'bamboo-brace';
DELETE FROM agent_requests    WHERE business_slug = 'bamboo-brace';
DELETE FROM locations         WHERE business_slug = 'bamboo-brace';
DELETE FROM callback_requests WHERE business_slug = 'bamboo-brace';
DELETE FROM subscriptions     WHERE business_slug = 'bamboo-brace';
DELETE FROM revenue_events    WHERE business_slug = 'bamboo-brace';

-- 3. slug TEXT tables.
DELETE FROM competitor_query_baskets WHERE slug = 'bamboo-brace';
DELETE FROM competitor_polls         WHERE slug = 'bamboo-brace';
DELETE FROM competitor_citations     WHERE slug = 'bamboo-brace';
DELETE FROM radar_digests            WHERE slug = 'bamboo-brace';
DELETE FROM tenant_budget_state      WHERE slug = 'bamboo-brace';
DELETE FROM monthly_review_dispatch  WHERE slug = 'bamboo-brace';

-- 4. Parent row last.
DELETE FROM businesses WHERE slug = 'bamboo-brace';
