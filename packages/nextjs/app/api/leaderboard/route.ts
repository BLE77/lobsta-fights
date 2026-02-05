import { NextResponse } from "next/server";
import { supabase, UCFLeaderboardEntry } from "../../../lib/supabase";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const limit = parseInt(searchParams.get("limit") || "50");
  const offset = parseInt(searchParams.get("offset") || "0");

  const { data, error } = await supabase
    .from("ucf_leaderboard")
    .select("*")
    .range(offset, offset + limit - 1);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    fighters: data as UCFLeaderboardEntry[],
    count: data?.length || 0,
  });
}
