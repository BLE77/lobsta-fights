-- Tracks durable mainnet fire-and-forget operations for retry.

CREATE TABLE IF NOT EXISTS mainnet_pending_ops (
  rumble_id TEXT NOT NULL,
  op_type TEXT NOT NULL CHECK (
    op_type IN ('completeRumble', 'sweepTreasury', 'createRumble', 'reportResult')
  ),
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'complete', 'failed')
  ) DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (rumble_id, op_type)
);

CREATE INDEX IF NOT EXISTS idx_mainnet_pending_ops_status_updated_at
  ON mainnet_pending_ops (status, updated_at);

CREATE INDEX IF NOT EXISTS idx_mainnet_pending_ops_rumble_id
  ON mainnet_pending_ops (rumble_id);

ALTER TABLE mainnet_pending_ops ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_all_mainnet_pending_ops" ON mainnet_pending_ops;
CREATE POLICY "service_role_all_mainnet_pending_ops"
  ON mainnet_pending_ops
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
