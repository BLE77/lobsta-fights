// @ts-nocheck
import { NextResponse } from "next/server";
import { supabase } from "../../../../lib/supabase";
import { getApiKeyFromHeaders } from "../../../../lib/request-auth";

export const dynamic = "force-dynamic";

/**
 * GET /api/fighter/me?fighter_id=xxx
 *
 * Bots can check their own profile, including their generated profile picture.
 * Returns full fighter info with image_url.
 * Auth: x-api-key header
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const fighterId = searchParams.get("fighter_id");
  const apiKey = getApiKeyFromHeaders(request.headers);

  if (!fighterId || !apiKey) {
    return NextResponse.json(
      {
        error: "Missing fighter_id or api_key",
        usage: "GET /api/fighter/me?fighter_id=YOUR_ID with x-api-key header",
        description: "Check your fighter profile including generated profile picture"
      },
      { status: 400 }
    );
  }

  // Verify credentials and get fighter
  const { data: fighter, error } = await supabase
    .from("ucf_fighters")
    .select("id, name, description, special_move, image_url, points, wins, losses, draws, matches_played, win_streak, verified, robot_metadata, created_at, updated_at")
    .eq("id", fighterId)
    .eq("api_key", apiKey)
    .single();

  if (error || !fighter) {
    return NextResponse.json(
      { error: "Invalid credentials or fighter not found" },
      { status: 401 }
    );
  }

  // Check if image is still generating
  const imageStatus = fighter.image_url
    ? "ready"
    : "generating (check back in 30-60 seconds)";

  return NextResponse.json({
    fighter: {
      id: fighter.id,
      name: fighter.name,
      description: fighter.description,
      special_move: fighter.special_move,
      image_url: fighter.image_url,
      image_status: imageStatus,
      points: fighter.points,
      wins: fighter.wins,
      losses: fighter.losses,
      draws: fighter.draws,
      matches_played: fighter.matches_played,
      win_streak: fighter.win_streak,
      verified: fighter.verified,
      robot_metadata: fighter.robot_metadata,
      created_at: fighter.created_at,
    },
    message: fighter.image_url
      ? "Your profile picture is ready!"
      : "Your profile picture is still generating. Check back in 30-60 seconds.",
  });
}
