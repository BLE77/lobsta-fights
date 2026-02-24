// @ts-nocheck
import { NextResponse } from "next/server";
import { freshSupabase } from "../../../lib/supabase";
import { checkRateLimit, getRateLimitKey, rateLimitResponse } from "~~/lib/rate-limit";

export const dynamic = "force-dynamic";

export interface MatchTiming {
  match_started_at: string | null;
  match_duration_seconds: number;
  current_deadline: string | null;
  seconds_remaining: number | null;
  phase_timeout_seconds: number;
}

export interface MatchWithFighters {
  id: string;
  state: "WAITING" | "COMMIT_PHASE" | "REVEAL_PHASE" | "FINISHED";
  fighter_a_id: string;
  fighter_b_id: string;
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
  result_image_url: string | null;
  result_image_prediction_id: string | null;
  commit_deadline: string | null;
  reveal_deadline: string | null;
  timing?: MatchTiming;
  fighter_a: {
    id: string;
    name: string;
    image_url: string | null;
    points: number;
    wins: number;
    losses: number;
    rank: number;
  } | null;
  fighter_b: {
    id: string;
    name: string;
    image_url: string | null;
    points: number;
    wins: number;
    losses: number;
    rank: number;
  } | null;
}

/**
 * Compute timing info for a match
 */
function computeTiming(match: any): MatchTiming {
  const now = Date.now();
  const startedAt = match.started_at ? new Date(match.started_at).getTime() : null;
  const currentDeadline = match.state === "COMMIT_PHASE"
    ? match.commit_deadline
    : match.state === "REVEAL_PHASE"
    ? match.reveal_deadline
    : null;

  let secondsRemaining: number | null = null;
  if (currentDeadline) {
    const remaining = Math.floor((new Date(currentDeadline).getTime() - now) / 1000);
    secondsRemaining = Math.max(0, remaining);
  }

  return {
    match_started_at: match.started_at,
    match_duration_seconds: startedAt ? Math.floor((now - startedAt) / 1000) : 0,
    current_deadline: currentDeadline,
    seconds_remaining: secondsRemaining,
    phase_timeout_seconds: 60,
  };
}

export async function GET(request: Request) {
  const rlKey = getRateLimitKey(request);
  const rl = checkRateLimit("PUBLIC_READ", rlKey);
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

  const supabase = freshSupabase();
  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status") || "all"; // active, finished, all
  const limit = parseInt(searchParams.get("limit") || "50");
  const matchId = searchParams.get("id"); // For fetching a single match

  // Single match fetch
  if (matchId) {
    const { data: match, error } = await supabase
      .from("ucf_matches")
      .select("id, fighter_a_id, fighter_b_id, state, points_wager, agent_a_state, agent_b_state, current_round, current_turn, max_rounds, commit_deadline, reveal_deadline, winner_id, turn_history, created_at, started_at, finished_at, result_image_url, on_chain_wager, points_transferred, missed_turns_a, missed_turns_b, forfeit_reason")
      .eq("id", matchId)
      .single();

    if (error || !match) {
      return NextResponse.json({ error: "Match not found" }, { status: 404 });
    }

    // Fetch fighters with rank
    const { data: fighters } = await supabase
      .from("ucf_leaderboard")
      .select("id, name, image_url, points, wins, losses, rank")
      .in("id", [match.fighter_a_id, match.fighter_b_id]);

    const fighterA = fighters?.find((f) => f.id === match.fighter_a_id) || null;
    const fighterB = fighters?.find((f) => f.id === match.fighter_b_id) || null;

    const resp = NextResponse.json({
      match: {
        ...match,
        fighter_a: fighterA,
        fighter_b: fighterB,
        timing: computeTiming(match),
      } as MatchWithFighters,
    });
    resp.headers.set("Cache-Control", "no-store, no-cache, max-age=0, s-maxage=0");
    return resp;
  }

  // Always use explicit state filters to avoid PostgREST query caching.
  // An unfiltered SELECT * query can return stale cached results from PostgREST.
  // By splitting into two filtered queries we ensure fresh data for both.
  let matches: any[] = [];

  if (status === "active") {
    const { data, error } = await supabase
      .from("ucf_matches")
      .select("id, fighter_a_id, fighter_b_id, state, points_wager, agent_a_state, agent_b_state, current_round, current_turn, max_rounds, commit_deadline, reveal_deadline, winner_id, turn_history, created_at, started_at, finished_at, result_image_url, on_chain_wager, points_transferred, missed_turns_a, missed_turns_b, forfeit_reason")
      .neq("state", "FINISHED")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) {
      return NextResponse.json({ error: "An error occurred while fetching matches" }, { status: 500 });
    }
    matches = data || [];
  } else if (status === "finished") {
    const { data, error } = await supabase
      .from("ucf_matches")
      .select("id, fighter_a_id, fighter_b_id, state, points_wager, agent_a_state, agent_b_state, current_round, current_turn, max_rounds, commit_deadline, reveal_deadline, winner_id, turn_history, created_at, started_at, finished_at, result_image_url, on_chain_wager, points_transferred, missed_turns_a, missed_turns_b, forfeit_reason")
      .eq("state", "FINISHED")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) {
      return NextResponse.json({ error: "An error occurred while fetching matches" }, { status: 500 });
    }
    matches = data || [];
  } else {
    // "all" - fetch active and finished separately then merge
    const [activeResult, finishedResult] = await Promise.all([
      supabase
        .from("ucf_matches")
        .select("id, fighter_a_id, fighter_b_id, state, points_wager, agent_a_state, agent_b_state, current_round, current_turn, max_rounds, commit_deadline, reveal_deadline, winner_id, turn_history, created_at, started_at, finished_at, result_image_url, on_chain_wager, points_transferred, missed_turns_a, missed_turns_b, forfeit_reason")
        .neq("state", "FINISHED")
        .order("created_at", { ascending: false })
        .limit(limit),
      supabase
        .from("ucf_matches")
        .select("id, fighter_a_id, fighter_b_id, state, points_wager, agent_a_state, agent_b_state, current_round, current_turn, max_rounds, commit_deadline, reveal_deadline, winner_id, turn_history, created_at, started_at, finished_at, result_image_url, on_chain_wager, points_transferred, missed_turns_a, missed_turns_b, forfeit_reason")
        .eq("state", "FINISHED")
        .order("created_at", { ascending: false })
        .limit(limit),
    ]);

    if (activeResult.error) {
      return NextResponse.json({ error: "An error occurred while fetching matches" }, { status: 500 });
    }
    if (finishedResult.error) {
      return NextResponse.json({ error: "An error occurred while fetching matches" }, { status: 500 });
    }

    // Merge: active first, then finished, respecting total limit
    const activeMatches = activeResult.data || [];
    const finishedMatches = finishedResult.data || [];
    matches = [...activeMatches, ...finishedMatches].slice(0, limit);
  }

  if (matches.length === 0) {
    const emptyResp = NextResponse.json({ matches: [], count: 0 });
    emptyResp.headers.set("Cache-Control", "no-store, no-cache, max-age=0, s-maxage=0");
    return emptyResp;
  }

  // Get unique fighter IDs
  const fighterIds = new Set<string>();
  matches.forEach((m) => {
    if (m.fighter_a_id) fighterIds.add(m.fighter_a_id);
    if (m.fighter_b_id) fighterIds.add(m.fighter_b_id);
  });

  // Fetch all fighters with rank from leaderboard
  const { data: fighters } = await supabase
    .from("ucf_leaderboard")
    .select("id, name, image_url, points, wins, losses, rank")
    .in("id", Array.from(fighterIds));

  const fighterMap = new Map(fighters?.map((f) => [f.id, f]) || []);

  // Join fighters to matches and add timing info
  const matchesWithFighters: MatchWithFighters[] = matches.map((m) => ({
    ...m,
    fighter_a: fighterMap.get(m.fighter_a_id) || null,
    fighter_b: fighterMap.get(m.fighter_b_id) || null,
    timing: computeTiming(m),
  }));

  const response = NextResponse.json({
    matches: matchesWithFighters,
    count: matchesWithFighters.length,
  });
  response.headers.set("Cache-Control", "no-store, no-cache, max-age=0, s-maxage=0");
  return response;
}
