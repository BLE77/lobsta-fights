import { NextResponse } from "next/server";
import { supabase } from "../../../lib/supabase";

export const dynamic = "force-dynamic";

export async function GET() {
  // Get counts for dashboard stats
  const [
    { count: fighterCount },
    { count: activeMatchCount },
    { data: lobbyData },
    { data: topFighters },
    { data: allMatches },
  ] = await Promise.all([
    supabase.from("ucf_fighters").select("*", { count: "exact", head: true }).eq("verified", true),
    supabase.from("ucf_matches").select("*", { count: "exact", head: true }).neq("state", "FINISHED"),
    supabase.from("ucf_lobby").select("points_wager"),
    supabase.from("ucf_leaderboard").select("*").limit(3),
    supabase.from("ucf_matches").select("points_wager"),
  ]);

  // Total points wagered across ALL matches (each match wager counts for both fighters)
  const totalMatchWagered = allMatches?.reduce((sum, m) => sum + (m.points_wager || 0) * 2, 0) || 0;
  // Plus points currently wagered in lobby
  const totalLobbyWagered = lobbyData?.reduce((sum, ticket) => sum + (ticket.points_wager || 0), 0) || 0;

  return NextResponse.json({
    registered_fighters: fighterCount || 0,
    active_matches: activeMatchCount || 0,
    waiting_in_lobby: lobbyData?.length || 0,
    total_points_wagered: totalMatchWagered + totalLobbyWagered,
    top_fighters: topFighters || [],
  });
}
