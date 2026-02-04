import { NextRequest, NextResponse } from "next/server";
import { supabase } from "../../../../lib/supabase";

/**
 * GET /api/fighter/matches?fighter_id=X&api_key=Y&limit=10
 *
 * Returns recent match history for a fighter.
 * Useful for bots to track their win/loss history and retrieve missed results.
 *
 * This is a static route - takes priority over the [id] dynamic route.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const fighterId = searchParams.get("fighter_id");
  const apiKey = searchParams.get("api_key");
  const limit = Math.min(parseInt(searchParams.get("limit") || "10"), 50);

  if (!fighterId || !apiKey) {
    return NextResponse.json(
      {
        error: "Missing fighter_id or api_key",
        usage: "GET /api/fighter/matches?fighter_id=YOUR_ID&api_key=YOUR_KEY&limit=10",
      },
      { status: 400 }
    );
  }

  // Verify credentials
  const { data: fighter, error: fighterError } = await supabase
    .from("ucf_fighters")
    .select("id, name")
    .eq("id", fighterId)
    .eq("api_key", apiKey)
    .single();

  if (fighterError || !fighter) {
    return NextResponse.json(
      { error: "Invalid credentials" },
      { status: 401 }
    );
  }

  // Fetch recent matches
  const { data: matches, error: matchError } = await supabase
    .from("ucf_matches")
    .select("*")
    .or(`fighter_a_id.eq.${fighterId},fighter_b_id.eq.${fighterId}`)
    .eq("state", "FINISHED")
    .order("finished_at", { ascending: false })
    .limit(limit);

  if (matchError) {
    return NextResponse.json(
      { error: matchError.message },
      { status: 500 }
    );
  }

  if (!matches || matches.length === 0) {
    return NextResponse.json({
      matches: [],
      count: 0,
      message: "No match history found",
    });
  }

  // Get all opponent IDs
  const opponentIds = new Set<string>();
  matches.forEach((m) => {
    const opponentId = m.fighter_a_id === fighterId ? m.fighter_b_id : m.fighter_a_id;
    opponentIds.add(opponentId);
  });

  // Fetch opponent info
  const { data: opponents } = await supabase
    .from("ucf_fighters")
    .select("id, name, image_url")
    .in("id", Array.from(opponentIds));

  const opponentMap = new Map(opponents?.map((o) => [o.id, o]) || []);

  // Format matches from fighter's perspective
  const formattedMatches = matches.map((match) => {
    const isPlayerA = match.fighter_a_id === fighterId;
    const youWon = match.winner_id === fighterId;
    const opponentId = isPlayerA ? match.fighter_b_id : match.fighter_a_id;
    const opponent = opponentMap.get(opponentId);
    const lastTurn = match.turn_history?.[match.turn_history.length - 1];

    return {
      match_id: match.id,
      you_won: youWon,
      result: youWon ? "WIN" : (match.winner_id ? "LOSS" : "DRAW"),

      opponent: {
        id: opponent?.id,
        name: opponent?.name,
        image_url: opponent?.image_url,
      },

      your_final_hp: isPlayerA ? lastTurn?.hp_a_after : lastTurn?.hp_b_after,
      opponent_final_hp: isPlayerA ? lastTurn?.hp_b_after : lastTurn?.hp_a_after,
      your_rounds_won: isPlayerA ? match.agent_a_state?.rounds_won : match.agent_b_state?.rounds_won,
      opponent_rounds_won: isPlayerA ? match.agent_b_state?.rounds_won : match.agent_a_state?.rounds_won,

      total_turns: match.turn_history?.length || 0,
      total_rounds: match.current_round,
      points_wagered: match.points_wager,
      points_change: youWon ? match.points_wager : -match.points_wager,

      started_at: match.started_at,
      finished_at: match.finished_at,
      duration_seconds: match.started_at && match.finished_at
        ? Math.floor((new Date(match.finished_at).getTime() - new Date(match.started_at).getTime()) / 1000)
        : null,

      result_image_url: match.result_image_url,
      forfeit_reason: match.forfeit_reason || null,
    };
  });

  return NextResponse.json({
    matches: formattedMatches,
    count: formattedMatches.length,
    fighter: {
      id: fighter.id,
      name: fighter.name,
    },
  });
}
