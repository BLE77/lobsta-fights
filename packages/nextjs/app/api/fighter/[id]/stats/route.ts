// @ts-nocheck
import { NextRequest, NextResponse } from "next/server";
import { freshSupabase } from "../../../../../lib/supabase";
import { isValidUUID } from "../../../../../lib/request-auth";

export const dynamic = "force-dynamic";

const MOVE_TYPES = [
  "HIGH_STRIKE", "MID_STRIKE", "LOW_STRIKE",
  "GUARD_HIGH", "GUARD_MID", "GUARD_LOW",
  "DODGE", "CATCH", "SPECIAL",
] as const;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: fighterId } = await params;
  const { searchParams } = new URL(req.url);
  const opponentId = searchParams.get("opponent_id");

  // Validate UUID format to prevent filter injection via .or() template literals
  if (!isValidUUID(fighterId)) {
    return NextResponse.json({ error: "Invalid fighter ID format" }, { status: 400 });
  }
  if (opponentId && !isValidUUID(opponentId)) {
    return NextResponse.json({ error: "Invalid opponent_id format" }, { status: 400 });
  }

  const supabase = freshSupabase();

  // Get all finished matches for this fighter
  const { data: matches, error } = await supabase
    .from("ucf_matches")
    .select("id, fighter_a_id, fighter_b_id, winner_id, turn_history, finished_at, points_wager")
    .eq("state", "FINISHED")
    .or(`fighter_a_id.eq.${fighterId},fighter_b_id.eq.${fighterId}`)
    .order("finished_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: "Failed to fetch fighter stats" }, { status: 500 });
  }

  if (!matches || matches.length === 0) {
    return NextResponse.json({
      move_analytics: null,
      top_rivals: [],
      head_to_head: null,
      message: "No finished matches found",
    });
  }

  // Analyze moves across all matches
  const moveCounts: Record<string, number> = {};
  let totalMoves = 0;
  let totalDamageDealt = 0;
  let totalDamageTaken = 0;
  let totalTurns = 0;

  // Track rivals
  const rivalStats: Record<string, { wins: number; losses: number; draws: number }> = {};

  for (const match of matches) {
    const isA = match.fighter_a_id === fighterId;
    const opId = isA ? match.fighter_b_id : match.fighter_a_id;

    // Rivalry tracking
    if (!rivalStats[opId]) rivalStats[opId] = { wins: 0, losses: 0, draws: 0 };
    if (match.winner_id === fighterId) {
      rivalStats[opId].wins++;
    } else if (match.winner_id === null) {
      rivalStats[opId].draws++;
    } else {
      rivalStats[opId].losses++;
    }

    // Parse turn history for move analytics
    const history = match.turn_history || [];
    for (const turn of history) {
      const myMove = isA ? turn.move_a : turn.move_b;
      if (myMove) {
        moveCounts[myMove] = (moveCounts[myMove] || 0) + 1;
        totalMoves++;
      }

      // Damage tracking
      const dmgDealt = isA ? (turn.damage_to_b || 0) : (turn.damage_to_a || 0);
      const dmgTaken = isA ? (turn.damage_to_a || 0) : (turn.damage_to_b || 0);
      totalDamageDealt += dmgDealt;
      totalDamageTaken += dmgTaken;
      totalTurns++;
    }
  }

  // Build move distribution
  const moveDistribution: Record<string, { count: number; percentage: number }> = {};
  for (const move of MOVE_TYPES) {
    const count = moveCounts[move] || 0;
    moveDistribution[move] = {
      count,
      percentage: totalMoves > 0 ? Math.round((count / totalMoves) * 100) : 0,
    };
  }

  // Compute category frequencies
  const strikes = (moveCounts["HIGH_STRIKE"] || 0) + (moveCounts["MID_STRIKE"] || 0) + (moveCounts["LOW_STRIKE"] || 0);
  const guards = (moveCounts["GUARD_HIGH"] || 0) + (moveCounts["GUARD_MID"] || 0) + (moveCounts["GUARD_LOW"] || 0);
  const dodges = moveCounts["DODGE"] || 0;

  // Find favorite move
  let favMove = "HIGH_STRIKE";
  let favCount = 0;
  for (const [move, count] of Object.entries(moveCounts)) {
    if (count > favCount) {
      favMove = move;
      favCount = count;
    }
  }

  const moveAnalytics = {
    total_moves: totalMoves,
    move_distribution: moveDistribution,
    favorite_move: favMove,
    strike_frequency: totalMoves > 0 ? Math.round((strikes / totalMoves) * 100) : 0,
    guard_frequency: totalMoves > 0 ? Math.round((guards / totalMoves) * 100) : 0,
    dodge_frequency: totalMoves > 0 ? Math.round((dodges / totalMoves) * 100) : 0,
    special_frequency: totalMoves > 0 ? Math.round(((moveCounts["SPECIAL"] || 0) / totalMoves) * 100) : 0,
    catch_frequency: totalMoves > 0 ? Math.round(((moveCounts["CATCH"] || 0) / totalMoves) * 100) : 0,
    avg_damage_dealt: totalTurns > 0 ? Math.round((totalDamageDealt / totalTurns) * 10) / 10 : 0,
    avg_damage_taken: totalTurns > 0 ? Math.round((totalDamageTaken / totalTurns) * 10) / 10 : 0,
  };

  // Build top rivals list (most-fought opponents, top 5)
  const rivalEntries = Object.entries(rivalStats)
    .map(([id, stats]) => ({ opponent_id: id, ...stats, total: stats.wins + stats.losses + stats.draws }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);

  // Fetch rival fighter details
  const rivalIds = rivalEntries.map((r) => r.opponent_id);
  let rivalDetails: Record<string, { name: string; image_url: string | null }> = {};
  if (rivalIds.length > 0) {
    const { data: rivalFighters } = await supabase
      .from("ucf_fighters")
      .select("id, name, image_url")
      .in("id", rivalIds);

    for (const f of rivalFighters || []) {
      rivalDetails[f.id] = { name: f.name, image_url: f.image_url };
    }
  }

  const topRivals = rivalEntries.map((r) => ({
    ...r,
    opponent_name: rivalDetails[r.opponent_id]?.name || "Unknown",
    opponent_image_url: rivalDetails[r.opponent_id]?.image_url || null,
  }));

  // Head-to-head (if opponent_id provided)
  let headToHead = null;
  if (opponentId) {
    const h2hMatches = matches.filter(
      (m) =>
        (m.fighter_a_id === opponentId || m.fighter_b_id === opponentId)
    );

    const h2hStats = { wins: 0, losses: 0, draws: 0 };
    for (const m of h2hMatches) {
      if (m.winner_id === fighterId) h2hStats.wins++;
      else if (m.winner_id === null) h2hStats.draws++;
      else h2hStats.losses++;
    }

    const opInfo = rivalDetails[opponentId];

    headToHead = {
      opponent_id: opponentId,
      opponent_name: opInfo?.name || "Unknown",
      ...h2hStats,
      total_matches: h2hMatches.length,
      matches: h2hMatches.slice(0, 10).map((m) => ({
        id: m.id,
        winner_id: m.winner_id,
        finished_at: m.finished_at,
        points_wager: m.points_wager,
      })),
    };
  }

  return NextResponse.json({
    move_analytics: moveAnalytics,
    top_rivals: topRivals,
    head_to_head: headToHead,
    total_matches: matches.length,
  });
}
