-- Tighten ucf_bets RLS: restrict anon/auth reads to completed rumbles only
-- Active bets are hidden from public view (prevents bet manipulation)
-- Post-fight bets are public (matches on-chain transparency)

-- Drop the overly permissive anon/auth read policies
DROP POLICY IF EXISTS "anon_read_bets" ON ucf_bets;
DROP POLICY IF EXISTS "auth_read_bets" ON ucf_bets;

-- Anon can only see bets for completed rumbles (spectator-friendly)
CREATE POLICY "anon_read_completed_bets" ON ucf_bets
  FOR SELECT TO anon
  USING (
    EXISTS (
      SELECT 1 FROM ucf_rumbles
      WHERE ucf_rumbles.id = ucf_bets.rumble_id
      AND ucf_rumbles.status = 'complete'
    )
  );

-- Authenticated users can see their own bets (any status) + completed rumble bets
CREATE POLICY "auth_read_own_or_completed_bets" ON ucf_bets
  FOR SELECT TO authenticated
  USING (
    wallet_address = (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')
    OR EXISTS (
      SELECT 1 FROM ucf_rumbles
      WHERE ucf_rumbles.id = ucf_bets.rumble_id
      AND ucf_rumbles.status = 'complete'
    )
  );
