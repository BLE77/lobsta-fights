import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

export async function GET() {
  // Create a FRESH client for each request to avoid any stale connection issues
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return NextResponse.json({ error: "Missing Supabase config" }, { status: 500 });
  }

  const db = createClient(supabaseUrl, supabaseKey);

  // Run queries sequentially to avoid any parallel issues
  const { data: fighters } = await db
    .from("ucf_fighters")
    .select("id")
    .eq("verified", true);

  const { data: activeMatches } = await db
    .from("ucf_matches")
    .select("id, state")
    .neq("state", "FINISHED");

  const { data: lobby } = await db
    .from("ucf_lobby")
    .select("points_wager");

  const { data: topFighters } = await db
    .from("ucf_leaderboard")
    .select("*")
    .limit(3);

  const { data: allMatches } = await db
    .from("ucf_matches")
    .select("points_wager");

  // Total points wagered across ALL matches (each match wager counts for both fighters)
  const totalMatchWagered = allMatches?.reduce((sum, m) => sum + (m.points_wager || 0) * 2, 0) || 0;
  // Plus points currently wagered in lobby
  const totalLobbyWagered = lobby?.reduce((sum, ticket) => sum + (ticket.points_wager || 0), 0) || 0;

  return NextResponse.json({
    registered_fighters: fighters?.length || 0,
    active_matches: activeMatches?.length || 0,
    waiting_in_lobby: lobby?.length || 0,
    total_points_wagered: totalMatchWagered + totalLobbyWagered,
    top_fighters: topFighters || [],
  });
}
