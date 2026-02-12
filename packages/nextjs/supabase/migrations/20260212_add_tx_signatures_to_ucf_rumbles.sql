-- Add transaction signature pipeline tracking for admin dashboard.
-- Idempotent migration.
ALTER TABLE IF EXISTS ucf_rumbles
  ADD COLUMN IF NOT EXISTS tx_signatures JSONB NOT NULL DEFAULT '{}'::jsonb;
