// @ts-nocheck
import { NextResponse } from "next/server";
import { supabase, UCFLeaderboardEntry } from "../../../lib/supabase";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const limit = Math.min(Math.max(1, parseInt(searchParams.get("limit") || "50") || 50), 100);
  const offset = Math.max(0, parseInt(searchParams.get("offset") || "0") || 0);

  const { data, error } = await supabase
    .from("ucf_leaderboard")
    .select("*")
    .range(offset, offset + limit - 1);

  if (error) {
    return NextResponse.json({ error: "Failed to fetch leaderboard" }, { status: 500 });
  }

  return NextResponse.json({
    fighters: data as UCFLeaderboardEntry[],
    count: data?.length || 0,
  });
}
