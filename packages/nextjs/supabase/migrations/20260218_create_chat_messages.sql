-- Live chat for rumble spectators
-- Users identified by Solana wallet address (truncated as username)

CREATE TABLE chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  username text NOT NULL,
  message text NOT NULL CHECK (char_length(message) <= 500),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Index for ordering by time
CREATE INDEX idx_chat_messages_created_at ON chat_messages (created_at DESC);

-- Enable RLS
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;

-- Anon can read all messages (needed for Realtime subscriptions)
CREATE POLICY "anon_read_chat" ON chat_messages
  FOR SELECT TO anon USING (true);

-- Service role bypasses RLS, so no INSERT policy needed for API routes.
-- No direct inserts from anon key — all writes go through the API route.

-- Enable Realtime for this table
ALTER PUBLICATION supabase_realtime ADD TABLE chat_messages;

-- Auto-cleanup: keep only the last 200 messages.
-- This function runs after each INSERT and deletes older rows.
CREATE OR REPLACE FUNCTION prune_chat_messages() RETURNS trigger AS $$
BEGIN
  DELETE FROM chat_messages
  WHERE id NOT IN (
    SELECT id FROM chat_messages ORDER BY created_at DESC LIMIT 200
  );
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_prune_chat_messages
  AFTER INSERT ON chat_messages
  FOR EACH STATEMENT
  EXECUTE FUNCTION prune_chat_messages();
