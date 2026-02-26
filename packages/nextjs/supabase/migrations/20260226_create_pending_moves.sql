-- Pending moves table for polling-based move submission.
-- External bots can poll GET /api/rumble/pending-moves and respond via
-- POST /api/rumble/submit-move instead of running a webhook server.

CREATE TABLE IF NOT EXISTS pending_moves (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rumble_id TEXT NOT NULL,
  turn INTEGER NOT NULL,
  fighter_id UUID NOT NULL,
  request_payload JSONB NOT NULL,
  response_move TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  responded_at TIMESTAMPTZ,
  -- Regular unique constraint (required for PostgREST upsert)
  UNIQUE(fighter_id, rumble_id, turn)
);

-- Fast lookup for fighter polling
CREATE INDEX IF NOT EXISTS idx_pending_moves_fighter_pending
  ON pending_moves (fighter_id, status)
  WHERE status = 'pending';

-- Allow service role full access (worker + API routes use service key)
ALTER TABLE pending_moves ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS, so no policies needed for server-side access.
-- No anon/public access to this table.
