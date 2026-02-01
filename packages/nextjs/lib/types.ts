// UCF Types - Points-Based Fighting System

export type MoveType =
  | "HIGH_STRIKE"
  | "MID_STRIKE"
  | "LOW_STRIKE"
  | "GUARD_HIGH"
  | "GUARD_MID"
  | "GUARD_LOW"
  | "DODGE"
  | "CATCH"
  | "SPECIAL";

export type MatchState =
  | "WAITING"      // In lobby, waiting for opponent
  | "COMMIT_PHASE" // Both players commit moves
  | "REVEAL_PHASE" // Both players reveal moves
  | "FINISHED";    // Match complete

export type TurnResult =
  | "TRADE"
  | "A_HIT"
  | "B_HIT"
  | "A_BLOCKED"
  | "B_BLOCKED"
  | "A_DODGED"
  | "B_DODGED"
  | "BOTH_DEFEND";

export interface Fighter {
  id: string;
  api_key: string;
  name: string;
  description: string;
  special_move: string;
  webhook_url: string;
  points: number;
  wins: number;
  losses: number;
  matches_played: number;
  created_at: number;
  verified: boolean;
}

export interface FighterAgent {
  hp: number;
  meter: number;
  rounds_won: number;
  committed_move: MoveType | null;
  revealed_move: MoveType | null;
  move_salt: string | null;
}

export interface Match {
  id: string;
  state: MatchState;
  fighter_a_id: string;
  fighter_b_id: string;
  agent_a: FighterAgent;
  agent_b: FighterAgent;
  current_round: number;
  current_turn: number;
  points_wager: number;
  commit_deadline: number;
  reveal_deadline: number;
  winner_id: string | null;
  turn_history: TurnResult[];
  created_at: number;
}

export interface LobbyTicket {
  id: string;
  fighter_id: string;
  points_wager: number;
  created_at: number;
}

export interface WebhookEvent {
  event: string;
  match_id?: string;
  [key: string]: any;
}

// API Response types
export interface RegisterResponse {
  api_key: string;
  fighter_id: string;
  message: string;
}

export interface MatchResponse {
  match_id: string;
  state: MatchState;
  round: number;
  turn: number;
  your_hp: number;
  opponent_hp: number;
  your_meter: number;
  opponent_meter: number;
  commit_deadline?: string;
  reveal_deadline?: string;
  your_committed: boolean;
  opponent_committed: boolean;
  your_revealed: boolean;
  opponent_revealed: boolean;
}
