-- ICHOR Rumble System Tables
-- Migration: create_rumble_tables

-- 1. Fighter Queue
CREATE TABLE IF NOT EXISTS ucf_rumble_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fighter_id TEXT NOT NULL,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  auto_requeue BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'matched', 'in_combat')),
  UNIQUE (fighter_id)
);

-- 2. Rumble Instances
CREATE TABLE IF NOT EXISTS ucf_rumbles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_index INT NOT NULL,
  status TEXT NOT NULL DEFAULT 'betting' CHECK (status IN ('betting', 'combat', 'payout', 'complete')),
  fighters JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  winner_id TEXT,
  placements JSONB,
  turn_log JSONB NOT NULL DEFAULT '[]'::jsonb,
  total_turns INT NOT NULL DEFAULT 0
);

-- 3. Bets
CREATE TABLE IF NOT EXISTS ucf_bets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rumble_id UUID NOT NULL REFERENCES ucf_rumbles(id) ON DELETE CASCADE,
  wallet_address TEXT NOT NULL,
  fighter_id TEXT NOT NULL,
  gross_amount NUMERIC NOT NULL,
  net_amount NUMERIC NOT NULL,
  admin_fee NUMERIC NOT NULL DEFAULT 0,
  sponsor_fee NUMERIC NOT NULL DEFAULT 0,
  placed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payout_amount NUMERIC,
  payout_status TEXT NOT NULL DEFAULT 'pending' CHECK (payout_status IN ('pending', 'paid', 'lost'))
);

-- 4. Ichor Shower Jackpot
CREATE TABLE IF NOT EXISTS ucf_ichor_shower (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_amount NUMERIC NOT NULL DEFAULT 0,
  last_trigger_rumble_id UUID REFERENCES ucf_rumbles(id),
  last_winner_wallet TEXT,
  last_payout NUMERIC,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 5. Aggregate Stats
CREATE TABLE IF NOT EXISTS ucf_rumble_stats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  total_rumbles INT NOT NULL DEFAULT 0,
  total_sol_wagered NUMERIC NOT NULL DEFAULT 0,
  total_ichor_minted NUMERIC NOT NULL DEFAULT 0,
  total_ichor_burned NUMERIC NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX idx_rumble_queue_status ON ucf_rumble_queue(status);
CREATE INDEX idx_rumbles_status ON ucf_rumbles(status);
CREATE INDEX idx_bets_rumble_id ON ucf_bets(rumble_id);
CREATE INDEX idx_bets_wallet ON ucf_bets(wallet_address);
CREATE INDEX idx_bets_fighter ON ucf_bets(fighter_id);

-- Enable RLS
ALTER TABLE ucf_rumble_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE ucf_rumbles ENABLE ROW LEVEL SECURITY;
ALTER TABLE ucf_bets ENABLE ROW LEVEL SECURITY;
ALTER TABLE ucf_ichor_shower ENABLE ROW LEVEL SECURITY;
ALTER TABLE ucf_rumble_stats ENABLE ROW LEVEL SECURITY;

-- Service role full access (all tables)
CREATE POLICY "service_role_all_rumble_queue" ON ucf_rumble_queue FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all_rumbles" ON ucf_rumbles FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all_bets" ON ucf_bets FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all_ichor_shower" ON ucf_ichor_shower FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all_rumble_stats" ON ucf_rumble_stats FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Anon read access (public data)
CREATE POLICY "anon_read_rumbles" ON ucf_rumbles FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read_ichor_shower" ON ucf_ichor_shower FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read_rumble_stats" ON ucf_rumble_stats FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read_bets" ON ucf_bets FOR SELECT TO anon USING (true);

-- Authenticated users can read everything public + their own bets
CREATE POLICY "auth_read_rumbles" ON ucf_rumbles FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_read_bets" ON ucf_bets FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_read_ichor_shower" ON ucf_ichor_shower FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_read_rumble_stats" ON ucf_rumble_stats FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_read_queue" ON ucf_rumble_queue FOR SELECT TO authenticated USING (true);

-- Initialize singleton rows
INSERT INTO ucf_rumble_stats (total_rumbles, total_sol_wagered, total_ichor_minted, total_ichor_burned)
VALUES (0, 0, 0, 0);

INSERT INTO ucf_ichor_shower (pool_amount)
VALUES (0);
