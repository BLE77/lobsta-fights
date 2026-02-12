import { createClient } from "@supabase/supabase-js";

// Lazy-initialized admin client to avoid throwing at import time (breaks Next.js page data collection)
let _supabaseAdmin: ReturnType<typeof createClient> | null = null;

function getSupabaseUrl() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL");
  return url;
}

function getSupabaseAnonKey() {
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!key) throw new Error("Missing NEXT_PUBLIC_SUPABASE_ANON_KEY");
  return key;
}

function getServerKey() {
  // Prefer service role key (bypasses RLS) for server-side operations.
  // Falls back to anon key only if service role key is unavailable.
  return process.env.SUPABASE_SERVICE_ROLE_KEY || getSupabaseAnonKey();
}

// CRITICAL: Next.js App Router caches ALL fetch() responses by default.
// The Supabase client uses fetch internally, so without cache: 'no-store',
// queries return stale/cached data even with a new client instance.
const noStoreFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, cache: "no-store" });

// Fresh client for API routes - creates new instance per call
// with cache: 'no-store' to prevent Next.js fetch caching.
// Uses service role key to bypass RLS (all writes restricted to service_role).
export function freshSupabase() {
  return createClient(getSupabaseUrl(), getServerKey(), {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: noStoreFetch },
  });
}

// Regular client - creates a FRESH client on every .from()/.rpc() call
// with cache: 'no-store' to prevent Next.js fetch caching.
// Uses service role key to bypass RLS (all writes restricted to service_role).
// The Proxy intercepts property access and delegates to a new client each time,
// while still deferring client creation until first use (safe for Next.js build).
export const supabase = new Proxy({} as ReturnType<typeof createClient>, {
  get(_, prop) {
    const client = createClient(getSupabaseUrl(), getServerKey(), {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { fetch: noStoreFetch },
    });
    return (client as any)[prop];
  },
});

// Admin client for server-side operations like storage uploads (bypasses RLS)
// Only available on server-side where SUPABASE_SERVICE_ROLE_KEY is set
export const supabaseAdmin = new Proxy({} as ReturnType<typeof createClient> | null, {
  get(_, prop) {
    if (_supabaseAdmin === null) {
      const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (serviceRoleKey) {
        _supabaseAdmin = createClient(getSupabaseUrl(), serviceRoleKey, {
          auth: { autoRefreshToken: false, persistSession: false },
          global: { fetch: noStoreFetch },
        });
      } else {
        return undefined;
      }
    }
    return (_supabaseAdmin as any)[prop];
  },
}) as ReturnType<typeof createClient> | null;

// Types for UCF
export interface RobotMetadata {
  robot_type: string;
  chassis_description: string;
  fists_description: string;  // BARE KNUCKLE fighting - no weapons!
  fighting_style: "aggressive" | "defensive" | "balanced" | "tactical" | "berserker";
  personality: string | null;
  signature_move: string;
  victory_line: string;
  defeat_line: string;
  taunt_lines: string[];
  color_scheme: string | null;
  distinguishing_features: string | null;
}

export interface UCFFighter {
  id: string;
  wallet_address: string;
  api_key: string;
  name: string;
  description: string | null;
  special_move: string | null;
  webhook_url: string;
  image_url: string | null;
  points: number;
  wins: number;
  losses: number;
  draws: number;
  matches_played: number;
  win_streak: number;
  best_win_streak: number;
  verified: boolean;
  is_active: boolean;
  last_active_at: string | null;
  created_at: string;
  updated_at: string;
  robot_metadata: RobotMetadata | null;
  moltbook_agent_id: string | null;
}

export interface UCFLeaderboardEntry {
  id: string;
  name: string;
  image_url: string | null;
  points: number;
  wins: number;
  losses: number;
  draws: number;
  matches_played: number;
  win_streak: number;
  best_win_streak: number;
  win_rate: number;
  rank: number;
  created_at: string;
}

export interface UCFMatch {
  id: string;
  fighter_a_id: string;
  fighter_b_id: string;
  state: "WAITING" | "COMMIT_PHASE" | "REVEAL_PHASE" | "FINISHED";
  points_wager: number;
  agent_a_state: { hp: number; meter: number; rounds_won: number };
  agent_b_state: { hp: number; meter: number; rounds_won: number };
  current_round: number;
  current_turn: number;
  winner_id: string | null;
  turn_history: any[];
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface UCFLobbyTicket {
  id: string;
  fighter_id: string;
  points_wager: number;
  min_opponent_points: number;
  max_opponent_points: number;
  created_at: string;
}
