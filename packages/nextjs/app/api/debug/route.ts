import { NextRequest, NextResponse } from "next/server";
import { freshSupabase } from "../../../lib/supabase";
import { resolveTurn } from "../../../lib/turn-resolution";

export const dynamic = "force-dynamic";

/**
 * GET /api/debug?match_id=xxx
 * Direct test of resolveTurn - reads match before, calls resolveTurn, reads match after
 */
export async function GET(req: NextRequest) {
  const matchId = req.nextUrl.searchParams.get("match_id");
  if (!matchId) {
    return NextResponse.json({ error: "match_id required" }, { status: 400 });
  }

  const supabase = freshSupabase();

  // Read BEFORE
  const { data: before, error: beforeErr } = await supabase
    .from("ucf_matches")
    .select("id, state, current_turn, current_round, move_a, move_b, agent_a_state, agent_b_state, turn_history")
    .eq("id", matchId)
    .single();

  if (beforeErr || !before) {
    return NextResponse.json({ error: "Match not found", beforeErr }, { status: 404 });
  }

  // Call resolveTurn
  let resolveResult;
  try {
    resolveResult = await resolveTurn(matchId);
  } catch (err: any) {
    return NextResponse.json({
      error: "resolveTurn threw",
      message: err.message,
      stack: err.stack,
      before,
    });
  }

  // Read AFTER
  const { data: after } = await supabase
    .from("ucf_matches")
    .select("id, state, current_turn, current_round, move_a, move_b, agent_a_state, agent_b_state, turn_history")
    .eq("id", matchId)
    .single();

  return NextResponse.json({
    before: {
      state: before.state,
      turn: before.current_turn,
      round: before.current_round,
      move_a: before.move_a,
      move_b: before.move_b,
      hp_a: before.agent_a_state?.hp,
      hp_b: before.agent_b_state?.hp,
      history_len: before.turn_history?.length || 0,
    },
    resolveResult,
    after: after ? {
      state: after.state,
      turn: after.current_turn,
      round: after.current_round,
      move_a: after.move_a,
      move_b: after.move_b,
      hp_a: after.agent_a_state?.hp,
      hp_b: after.agent_b_state?.hp,
      history_len: after.turn_history?.length || 0,
    } : null,
  });
}
