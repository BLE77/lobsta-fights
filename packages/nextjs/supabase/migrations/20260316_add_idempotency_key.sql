-- Add idempotency_key support to ucf_used_tx_signatures for bet replay protection.
-- Allows clients to attach a pre-generated key (from /prepare) so retries return
-- the original response instead of reprocessing.

ALTER TABLE ucf_used_tx_signatures
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS response_payload JSONB;

-- Note: CONCURRENTLY cannot be used inside a transaction block (Supabase default).
-- This will briefly lock the table during index creation. For a small table this is fine.
-- For large tables, run this manually outside a transaction: CREATE UNIQUE INDEX CONCURRENTLY ...
CREATE UNIQUE INDEX IF NOT EXISTS idx_ucf_used_tx_signatures_idempotency_key
  ON ucf_used_tx_signatures(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
