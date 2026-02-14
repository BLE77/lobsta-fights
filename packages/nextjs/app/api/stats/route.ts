// @ts-nocheck
import { NextResponse } from "next/server";
import { freshSupabase } from "../../../lib/supabase";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = freshSupabase();

  const [
    fightersResult,
    activeResult,
    lobbyResult,
    topResult,
    matchWagerResult,
  ] = await Promise.all([
    supabase.from("ucf_fighters").select("id").eq("verified", true),
    supabase.from("ucf_matches").select("id").neq("state", "FINISHED"),
    supabase.from("ucf_lobby").select("points_wager"),
    supabase.from("ucf_leaderboard").select("*").limit(3),
    supabase.from("ucf_matches").select("points_wager").in("state", ["WAITING", "COMMIT_PHASE", "REVEAL_PHASE", "FINISHED"]),
  ]);

  const lobbyData = lobbyResult.data;
  const allMatches = matchWagerResult.data;

  // Total points wagered across ALL matches (each match wager counts for both fighters)
  const totalMatchWagered = allMatches?.reduce((sum, m) => sum + (m.points_wager || 0) * 2, 0) || 0;
  // Plus points currently wagered in lobby
  const totalLobbyWagered = lobbyData?.reduce((sum, ticket) => sum + (ticket.points_wager || 0), 0) || 0;

  return NextResponse.json({
    registered_fighters: fightersResult.data?.length || 0,
    active_matches: activeResult.data?.length || 0,
    waiting_in_lobby: lobbyData?.length || 0,
    total_points_wagered: totalMatchWagered + totalLobbyWagered,
    top_fighters: topResult.data || [],
  });
}
