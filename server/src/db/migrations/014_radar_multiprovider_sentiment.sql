-- P3 v1.1: multi-provider Competitor Radar + sentiment extraction.
--
-- `competitor_polls.bot` already stores arbitrary TEXT (no CHECK constraint),
-- so adding a second provider ('openai') requires no schema change. Only the
-- sentiment-descriptor column is new.
--
-- `sentiment_descriptors` holds a JSON array of lowercase descriptor strings
-- (e.g. ["reliable","affordable"]) extracted by server/src/lib/sentiment.ts
-- from the provider's answer text when our_domain_cited=1. NULL for polls
-- where the tenant was not cited, for provider errors, and for rows written
-- before this migration.
--
-- No index: the read path is per-poll (losses endpoint hydrates the column
-- on a small LIMIT-bounded result set), not aggregate.

ALTER TABLE competitor_polls ADD COLUMN sentiment_descriptors TEXT;
