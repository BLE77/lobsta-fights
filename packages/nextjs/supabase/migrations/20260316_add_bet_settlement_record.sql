-- Add bet_settlement_record JSONB column to ucf_rumbles for idempotent payout settlement.
-- On first settlement call the computed payout amounts are stored here; subsequent calls
-- re-use the stored record so payout amounts never drift across retries.

ALTER TABLE ucf_rumbles
  ADD COLUMN IF NOT EXISTS bet_settlement_record JSONB;
