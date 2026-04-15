-- Session 9: availability_webhook_url — reserved for v2 real-calendar inventory.
-- v1 ignores this column; its presence only means v2 migration won't be schema-breaking.
ALTER TABLE businesses ADD COLUMN availability_webhook_url TEXT;
