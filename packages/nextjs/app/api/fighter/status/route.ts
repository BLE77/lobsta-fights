import { NextRequest, NextResponse } from "next/server";
import { supabase } from "../../../../lib/supabase";

export const dynamic = "force-dynamic";

/**
 * GET /api/fighter/status?fighter_id=X&api_key=Y
 *
 * Polling endpoint for bots that can't receive webhooks.
 * Returns current status: in match? your turn? game state?
 *
 * Poll this every 3-5 seconds during a match.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const fighterId = searchParams.get("fighter_id");
  const apiKey = searchParams.get("api_key");

  if (!fighterId || !apiKey) {
    return NextResponse.json(
      {
        error: "Missing fighter_id or api_key",
        usage: "GET /api/fighter/status?fighter_id=YOUR_ID&api_key=YOUR_KEY",
      },
      { status: 400 }
    );
  }

  // Verify credentials
  const { data: fighter, error: fighterError } = await supabase
    .from("ucf_fighters")
    .select("id, name, points, wins, losses")
    .eq("id", fighterId)
    .eq("api_key", apiKey)
    .single();

  if (fighterError || !fighter) {
    return NextResponse.json(
      { error: "Invalid credentials" },
      { status: 401 }
    );
  }

  // Check if in lobby
  const { data: lobbyEntry } = await supabase
    .from("ucf_lobby")
    .select("*")
    .eq("fighter_id", fighterId)
    .single();

  // Find active match (where this fighter is participating and match isn't finished)
  // First, find the match with a simpler query
  const { data: matches, error: matchError } = await supabase
    .from("ucf_matches")
    .select("*")
    .or(`fighter_a_id.eq.${fighterId},fighter_b_id.eq.${fighterId}`)
    .neq("state", "FINISHED")
    .order("created_at", { ascending: false })
    .limit(1);

  if (matchError) {
    console.error("Match query error:", matchError);
  }

  const activeMatch = matches?.[0];

  // If we found a match, fetch the fighter details separately
  let fighterA = null;
  let fighterB = null;
  if (activeMatch) {
    const [aResult, bResult] = await Promise.all([
      supabase
        .from("ucf_fighters")
        .select("id, name, image_url")
        .eq("id", activeMatch.fighter_a_id)
        .single(),
      supabase
        .from("ucf_fighters")
        .select("id, name, image_url")
        .eq("id", activeMatch.fighter_b_id)
        .single(),
    ]);
    fighterA = aResult.data;
    fighterB = bResult.data;
  }

  // No active match - check for recently finished matches (last 2 minutes)
  if (!activeMatch) {
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();

    const { data: recentMatches } = await supabase
      .from("ucf_matches")
      .select("*")
      .or(`fighter_a_id.eq.${fighterId},fighter_b_id.eq.${fighterId}`)
      .eq("state", "FINISHED")
      .gte("finished_at", twoMinutesAgo)
      .order("finished_at", { ascending: false })
      .limit(1);

    const recentMatch = recentMatches?.[0];

    if (recentMatch) {
      // Return match_ended status with results
      const isPlayerA = recentMatch.fighter_a_id === fighterId;
      const youWon = recentMatch.winner_id === fighterId;
      const lastTurn = recentMatch.turn_history?.[recentMatch.turn_history.length - 1];

      // Fetch opponent info
      const opponentId = isPlayerA ? recentMatch.fighter_b_id : recentMatch.fighter_a_id;
      const { data: opponent } = await supabase
        .from("ucf_fighters")
        .select("id, name, image_url")
        .eq("id", opponentId)
        .single();

      return NextResponse.json({
        status: "match_ended",
        in_match: false,
        in_lobby: !!lobbyEntry,
        your_turn: false,

        match_result: {
          match_id: recentMatch.id,
          you_won: youWon,
          winner_id: recentMatch.winner_id,
          your_final_hp: isPlayerA ? lastTurn?.hp_a_after : lastTurn?.hp_b_after,
          opponent_final_hp: isPlayerA ? lastTurn?.hp_b_after : lastTurn?.hp_a_after,
          your_rounds_won: isPlayerA ? recentMatch.agent_a_state?.rounds_won : recentMatch.agent_b_state?.rounds_won,
          opponent_rounds_won: isPlayerA ? recentMatch.agent_b_state?.rounds_won : recentMatch.agent_a_state?.rounds_won,
          total_turns: recentMatch.turn_history?.length || 0,
          points_wagered: recentMatch.points_wager,
          points_change: youWon ? recentMatch.points_wager : -recentMatch.points_wager,
          finished_at: recentMatch.finished_at,
          result_image_url: recentMatch.result_image_url,
          expires_at: new Date(new Date(recentMatch.finished_at).getTime() + 2 * 60 * 1000).toISOString(),
        },

        opponent: {
          id: opponent?.id,
          name: opponent?.name,
          image_url: opponent?.image_url,
        },

        fighter: {
          id: fighter.id,
          name: fighter.name,
          points: fighter.points,
          wins: fighter.wins,
          losses: fighter.losses,
        },

        message: youWon ? "You won the match!" : "You lost the match.",
        next_action: "POST /api/lobby to find another opponent",
      });
    }

    // Truly idle - no active or recent match
    return NextResponse.json({
      status: "idle",
      in_match: false,
      in_lobby: !!lobbyEntry,
      your_turn: false,
      fighter: {
        id: fighter.id,
        name: fighter.name,
        points: fighter.points,
        wins: fighter.wins,
        losses: fighter.losses,
      },
      message: lobbyEntry
        ? "You are in the lobby waiting for an opponent"
        : "You are not in a match. Join the lobby or challenge someone!",
      next_action: lobbyEntry
        ? "Wait for opponent or check back later"
        : "POST /api/lobby to find an opponent, or POST /api/match/challenge to challenge someone",
    });
  }

  // Determine if this fighter is A or B
  const isPlayerA = activeMatch.fighter_a_id === fighterId;
  const myState = isPlayerA ? activeMatch.agent_a_state : activeMatch.agent_b_state;
  const opponentState = isPlayerA ? activeMatch.agent_b_state : activeMatch.agent_a_state;
  const opponent = isPlayerA ? fighterB : fighterA;
  const myCommitted = isPlayerA ? !!activeMatch.commit_a : !!activeMatch.commit_b;
  const myRevealed = isPlayerA ? !!activeMatch.move_a : !!activeMatch.move_b;
  const opponentCommitted = isPlayerA ? !!activeMatch.commit_b : !!activeMatch.commit_a;
  const opponentRevealed = isPlayerA ? !!activeMatch.move_b : !!activeMatch.move_a;

  // Determine what action is needed
  let yourTurn = false;
  let needsAction = "";
  let nextAction = "";

  if (activeMatch.state === "WAITING") {
    needsAction = "waiting_for_opponent";
    nextAction = "Wait for opponent to accept the challenge";
  } else if (activeMatch.state === "COMMIT_PHASE") {
    if (!myCommitted) {
      yourTurn = true;
      needsAction = "commit_move";
      nextAction = "POST /api/match/submit-move with your move";
    } else if (!opponentCommitted) {
      needsAction = "waiting_for_opponent_commit";
      nextAction = "Wait for opponent to commit their move";
    }
  } else if (activeMatch.state === "REVEAL_PHASE") {
    if (!myRevealed) {
      yourTurn = true;
      needsAction = "reveal_move";
      nextAction = "Your move will be auto-revealed (submit-move handles this)";
    } else if (!opponentRevealed) {
      needsAction = "waiting_for_opponent_reveal";
      nextAction = "Wait for opponent to reveal their move";
    }
  }

  // Build turn history from perspective of this fighter
  const turnHistory = (activeMatch.turn_history || []).map((turn: any) => ({
    round: turn.round,
    turn: turn.turn,
    your_move: isPlayerA ? turn.move_a : turn.move_b,
    opponent_move: isPlayerA ? turn.move_b : turn.move_a,
    your_hp_after: isPlayerA ? turn.hp_a_after : turn.hp_b_after,
    opponent_hp_after: isPlayerA ? turn.hp_b_after : turn.hp_a_after,
    result: turn.result,
  }));

  return NextResponse.json({
    status: activeMatch.state.toLowerCase(),
    in_match: true,
    in_lobby: false,
    your_turn: yourTurn,
    needs_action: needsAction,
    next_action: nextAction,

    match: {
      id: activeMatch.id,
      state: activeMatch.state,
      round: activeMatch.current_round,
      turn: activeMatch.current_turn,
      points_wagered: activeMatch.points_wager,
    },

    your_state: {
      hp: myState?.hp ?? 100,
      meter: myState?.meter ?? 0,
      rounds_won: myState?.rounds_won ?? 0,
      committed: myCommitted,
      revealed: myRevealed,
    },

    opponent: {
      id: opponent?.id,
      name: opponent?.name,
      image_url: opponent?.image_url,
      hp: opponentState?.hp ?? 100,
      meter: opponentState?.meter ?? 0,
      rounds_won: opponentState?.rounds_won ?? 0,
      committed: opponentCommitted,
      revealed: opponentRevealed,
    },

    // Timing info
    timing: {
      match_started_at: activeMatch.started_at,
      match_duration_seconds: activeMatch.started_at
        ? Math.floor((Date.now() - new Date(activeMatch.started_at).getTime()) / 1000)
        : 0,
      current_deadline: activeMatch.state === "COMMIT_PHASE"
        ? activeMatch.commit_deadline
        : activeMatch.reveal_deadline,
      seconds_remaining: (() => {
        const deadline = activeMatch.state === "COMMIT_PHASE"
          ? activeMatch.commit_deadline
          : activeMatch.reveal_deadline;
        if (!deadline) return null;
        const remaining = Math.floor((new Date(deadline).getTime() - Date.now()) / 1000);
        return Math.max(0, remaining);
      })(),
      phase_timeout_seconds: 60,
      missed_turns: isPlayerA ? (activeMatch.missed_turns_a || 0) : (activeMatch.missed_turns_b || 0),
      max_missed_turns_before_forfeit: 3,
    },

    // Legacy deadlines format for backwards compatibility
    deadlines: {
      commit: activeMatch.commit_deadline,
      reveal: activeMatch.reveal_deadline,
    },

    turn_history: turnHistory,

    fighter: {
      id: fighter.id,
      name: fighter.name,
      points: fighter.points,
    },
  });
}
