-- Replay-protection table for one-time transaction signature usage.
-- This prevents cross-instance/server-restart duplicate registration.

CREATE TABLE IF NOT EXISTS ucf_used_tx_signatures (
  tx_signature TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('rumble_bet', 'rumble_claim', 'rumble_sponsorship_claim')),
  wallet_address TEXT NOT NULL,
  rumble_id TEXT,
  slot_index INT,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ucf_used_tx_signatures_wallet_kind_created_at
  ON ucf_used_tx_signatures(wallet_address, kind, created_at DESC);

ALTER TABLE ucf_used_tx_signatures ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_all_used_tx_signatures" ON ucf_used_tx_signatures;
CREATE POLICY "service_role_all_used_tx_signatures"
  ON ucf_used_tx_signatures
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
