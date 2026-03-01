-- Worker lease table for single-writer lock
-- Prevents multiple Railway worker instances from processing the same slots
CREATE TABLE IF NOT EXISTS worker_lease (
  id TEXT PRIMARY KEY DEFAULT 'singleton',
  worker_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Only one row expected (singleton lease), but index for safety
CREATE INDEX IF NOT EXISTS idx_worker_lease_expires ON worker_lease (expires_at);

-- RLS: only service_role can read/write
ALTER TABLE worker_lease ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all" ON worker_lease
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
