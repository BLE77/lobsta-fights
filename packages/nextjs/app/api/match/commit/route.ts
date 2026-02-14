// @ts-nocheck
import { NextResponse } from "next/server";
import { supabase, freshSupabase } from "../../../../lib/supabase";
import { authenticateFighterByApiKey } from "../../../../lib/request-auth";

export const dynamic = "force-dynamic";

/**
 * POST /api/match/commit
 * Submit an encrypted move commitment for a match turn
 *
 * Input: { match_id, fighter_id, api_key, move_hash }
 * - Validates fighter credentials
 * - Stores move_hash in commit_a or commit_b column
 * - When both fighters have committed, updates state to REVEAL_PHASE
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { match_id, fighter_id, api_key, move_hash } = body;

    // Validate input
    if (!match_id || !fighter_id || !api_key || !move_hash) {
      return NextResponse.json(
        { error: "Missing required fields: match_id, fighter_id, api_key, move_hash" },
        { status: 400 }
      );
    }

    // Validate move_hash format (must be 64-char hex SHA256)
    if (typeof move_hash !== "string" || !/^[a-f0-9]{64}$/i.test(move_hash)) {
      return NextResponse.json(
        { error: "Invalid move_hash format. Must be a 64-character hex SHA256 hash." },
        { status: 400 }
      );
    }

    // Verify fighter credentials (hash-first with legacy fallback)
    const fighter = await authenticateFighterByApiKey(
      fighter_id,
      api_key,
      "id, name",
      freshSupabase,
    );

    if (!fighter) {
      return NextResponse.json(
        { error: "Invalid fighter credentials" },
        { status: 401 }
      );
    }

    // Fetch the match (explicit safe columns - no commit/move/salt data in response)
    const { data: match, error: matchError } = await supabase
      .from("ucf_matches")
      .select("id, fighter_a_id, fighter_b_id, state, commit_a, commit_b, current_round, current_turn, commit_deadline, reveal_deadline, agent_a_state, agent_b_state, points_wager")
      .eq("id", match_id)
      .single();

    if (matchError || !match) {
      return NextResponse.json(
        { error: "Match not found" },
        { status: 404 }
      );
    }

    // Verify fighter is in this match
    const isFighterA = match.fighter_a_id === fighter_id;
    const isFighterB = match.fighter_b_id === fighter_id;

    if (!isFighterA && !isFighterB) {
      return NextResponse.json(
        { error: "Fighter is not a participant in this match" },
        { status: 403 }
      );
    }

    // Verify match is in COMMIT_PHASE
    if (match.state !== "COMMIT_PHASE") {
      return NextResponse.json(
        { error: `Cannot commit: match is in ${match.state} state` },
        { status: 400 }
      );
    }

    // Enforce commit deadline server-side
    if (match.commit_deadline && new Date() > new Date(match.commit_deadline)) {
      return NextResponse.json(
        { error: "Commit deadline has passed. Wait for timeout handler to advance the match." },
        { status: 400 }
      );
    }

    // Check if this fighter has already committed
    const commitColumn = isFighterA ? "commit_a" : "commit_b";
    const otherCommitColumn = isFighterA ? "commit_b" : "commit_a";

    if (match[commitColumn]) {
      return NextResponse.json(
        { error: "You have already committed a move for this turn" },
        { status: 400 }
      );
    }

    // Store the commitment
    const updateData: Record<string, any> = {
      [commitColumn]: move_hash,
    };

    // Check if both fighters have now committed
    const otherHasCommitted = !!match[otherCommitColumn];
    if (otherHasCommitted) {
      // Both committed - transition to REVEAL_PHASE
      updateData.state = "REVEAL_PHASE";
      updateData.reveal_deadline = new Date(Date.now() + 60000).toISOString(); // 60 seconds to reveal (1 min)
    }

    // Atomic state transition: only update if match is still in COMMIT_PHASE
    const { data: updatedMatch, error: updateError } = await freshSupabase()
      .from("ucf_matches")
      .update(updateData)
      .eq("id", match_id)
      .eq("state", "COMMIT_PHASE")
      .select("id, state, current_round, current_turn, reveal_deadline, commit_deadline")
      .single();

    if (updateError || !updatedMatch) {
      return NextResponse.json(
        { error: "Match state changed (concurrent modification). Retry." },
        { status: 409 }
      );
    }

    const response: Record<string, any> = {
      success: true,
      match_id,
      fighter_id,
      committed: true,
      current_round: match.current_round,
      current_turn: match.current_turn,
    };

    if (otherHasCommitted) {
      response.state = "REVEAL_PHASE";
      response.message = "Both fighters committed! Now reveal your moves.";
      response.reveal_deadline = updatedMatch.reveal_deadline;
    } else {
      response.state = "COMMIT_PHASE";
      response.message = "Move committed. Waiting for opponent to commit.";
      response.opponent_committed = false;
    }

    return NextResponse.json(response);
  } catch (error: any) {
    console.error("Error committing move:", error);
    return NextResponse.json(
      { error: "An error occurred while processing your request" },
      { status: 500 }
    );
  }
}

/**
 * GET /api/match/commit
 * Check commitment status for a match
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const matchId = searchParams.get("match_id");
  const fighterId = searchParams.get("fighter_id");

  if (!matchId) {
    return NextResponse.json(
      { error: "Missing match_id parameter" },
      { status: 400 }
    );
  }

  const { data: match, error } = await supabase
    .from("ucf_matches")
    .select("id, state, fighter_a_id, fighter_b_id, commit_a, commit_b, current_round, current_turn, commit_deadline")
    .eq("id", matchId)
    .single();

  if (error || !match) {
    return NextResponse.json(
      { error: "Match not found" },
      { status: 404 }
    );
  }

  const response: Record<string, any> = {
    match_id: matchId,
    state: match.state,
    current_round: match.current_round,
    current_turn: match.current_turn,
    fighter_a_committed: !!match.commit_a,
    fighter_b_committed: !!match.commit_b,
    commit_deadline: match.commit_deadline,
  };

  // If a specific fighter is querying, show their personal status
  if (fighterId) {
    if (fighterId === match.fighter_a_id) {
      response.your_committed = !!match.commit_a;
      response.opponent_committed = !!match.commit_b;
    } else if (fighterId === match.fighter_b_id) {
      response.your_committed = !!match.commit_b;
      response.opponent_committed = !!match.commit_a;
    }
  }

  return NextResponse.json(response);
}
