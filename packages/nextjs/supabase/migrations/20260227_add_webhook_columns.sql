-- Add columns for Helius webhook bet confirmation tracking.
-- tx_confirmed_at is set when the webhook confirms the on-chain tx.
-- Supabase Realtime picks up the UPDATE and pushes to the client.
ALTER TABLE ucf_bets ADD COLUMN IF NOT EXISTS tx_confirmed_at TIMESTAMPTZ;
ALTER TABLE ucf_bets ADD COLUMN IF NOT EXISTS tx_confirmed_slot BIGINT;

-- Enable Realtime for ucf_bets so Supabase pushes row-level changes
-- (needed for useBetConfirmation.ts Realtime subscription)
ALTER PUBLICATION supabase_realtime ADD TABLE ucf_bets;
