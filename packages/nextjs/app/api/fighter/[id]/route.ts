import { NextRequest, NextResponse } from "next/server";
import { supabase } from "../../../../lib/supabase";

export const dynamic = "force-dynamic";

/**
 * GET /api/fighter/[id]
 *
 * Get a fighter's public profile and match history
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Get fighter (public fields only - no api_key or webhook_url)
  const { data: fighter, error: fighterError } = await supabase
    .from("ucf_fighters")
    .select(`
      id,
      name,
      description,
      special_move,
      image_url,
      points,
      wins,
      losses,
      draws,
      matches_played,
      win_streak,
      best_win_streak,
      verified,
      robot_metadata,
      created_at
    `)
    .eq("id", id)
    .single();

  if (fighterError || !fighter) {
    return NextResponse.json(
      { error: "Fighter not found" },
      { status: 404 }
    );
  }

  // Get match history (last 20 matches)
  const { data: matches, error: matchesError } = await supabase
    .from("ucf_matches")
    .select(`
      id,
      state,
      winner_id,
      points_wager,
      result_image_url,
      created_at,
      finished_at,
      fighter_a:ucf_fighters!fighter_a_id(id, name, image_url),
      fighter_b:ucf_fighters!fighter_b_id(id, name, image_url)
    `)
    .or(`fighter_a_id.eq.${id},fighter_b_id.eq.${id}`)
    .eq("state", "FINISHED")
    .order("finished_at", { ascending: false })
    .limit(20);

  // Calculate additional stats
  const winRate = fighter.matches_played > 0
    ? Math.round((fighter.wins / fighter.matches_played) * 100)
    : 0;

  // Get rank from leaderboard
  const { data: leaderboard } = await supabase
    .from("ucf_leaderboard")
    .select("id, rank")
    .eq("id", id)
    .single();

  return NextResponse.json({
    fighter: {
      ...fighter,
      win_rate: winRate,
      rank: leaderboard?.rank || null,
    },
    matches: matches || [],
  });
}
