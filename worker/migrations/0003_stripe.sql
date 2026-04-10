-- Add Stripe and plan columns to businesses table
ALTER TABLE businesses ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE businesses ADD COLUMN stripe_subscription_id TEXT;
ALTER TABLE businesses ADD COLUMN plan TEXT NOT NULL DEFAULT 'free';
ALTER TABLE businesses ADD COLUMN domain TEXT;
