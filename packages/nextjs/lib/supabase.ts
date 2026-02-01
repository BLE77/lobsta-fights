import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error("Missing Supabase environment variables: NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY");
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Types for UCF
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
