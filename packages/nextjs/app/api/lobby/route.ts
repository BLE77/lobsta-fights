import { NextResponse } from "next/server";
import { supabase } from "../../../lib/supabase";

export const dynamic = "force-dynamic";

// Join the lobby / Find a match
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { fighterId, apiKey, pointsWager = 100 } = body;

    if (!fighterId || !apiKey) {
      return NextResponse.json(
        { error: "Missing fighterId or apiKey" },
        { status: 400 }
      );
    }

    // Verify fighter and API key
    const { data: fighter, error: fighterError } = await supabase
      .from("ucf_fighters")
      .select("*")
      .eq("id", fighterId)
      .eq("api_key", apiKey)
      .single();

    if (fighterError || !fighter) {
      return NextResponse.json({ error: "Invalid fighter or API key" }, { status: 401 });
    }

    if (!fighter.verified) {
      return NextResponse.json({ error: "Fighter not verified" }, { status: 403 });
    }

    if (fighter.points < pointsWager) {
      return NextResponse.json(
        { error: `Insufficient points. You have ${fighter.points}, need ${pointsWager}` },
        { status: 400 }
      );
    }

    // Check if already in an active match
    const { data: activeMatch } = await supabase
      .from("ucf_matches")
      .select("*")
      .or(`fighter_a_id.eq.${fighterId},fighter_b_id.eq.${fighterId}`)
      .neq("state", "FINISHED")
      .single();

    if (activeMatch) {
      return NextResponse.json({
        status: "in_match",
        match_id: activeMatch.id,
        message: "Already in an active match",
      });
    }

    // Try to find an opponent using the database function
    const { data: opponentId } = await supabase
      .rpc("find_ucf_opponent", {
        p_fighter_id: fighterId,
        p_points_wager: pointsWager,
      });

    if (opponentId) {
      // Anti-farming check: verify these fighters can match
      const { data: canMatch, error: canMatchError } = await supabase
        .rpc("can_fighters_match", {
          p_fighter_a: opponentId,
          p_fighter_b: fighterId,
        });

      if (canMatchError) {
        console.error("[Lobby] Error checking match eligibility:", canMatchError);
      }

      if (canMatch && canMatch.can_match === false) {
        // These fighters have battled too recently or too many times today
        // Remove opponent from lobby (they'll have to find someone else)
        // and put this fighter in lobby instead
        console.log(`[Lobby] Anti-farming: ${fighterId} cannot match with ${opponentId} - ${canMatch.reason}`);

        // Join lobby instead
        await supabase
          .from("ucf_lobby")
          .upsert({
            fighter_id: fighterId,
            points_wager: pointsWager,
            min_opponent_points: Math.max(0, fighter.points - 500),
            max_opponent_points: fighter.points + 500,
          });

        return NextResponse.json({
          status: "waiting",
          message: `Found opponent but anti-farming cooldown active. Waiting for different opponent.`,
          points_wager: pointsWager,
        });
      }

      // Found an opponent - create match!
      const { data: match, error: matchError } = await supabase
        .from("ucf_matches")
        .insert({
          fighter_a_id: opponentId, // Opponent was waiting first
          fighter_b_id: fighterId,
          state: "COMMIT_PHASE",
          points_wager: pointsWager,
          commit_deadline: new Date(Date.now() + 60000).toISOString(), // 60 seconds (1 min)
          started_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (matchError) {
        return NextResponse.json({ error: matchError.message }, { status: 500 });
      }

      // Remove opponent from lobby
      await supabase.from("ucf_lobby").delete().eq("fighter_id", opponentId);

      return NextResponse.json({
        status: "matched",
        match_id: match.id,
        opponent_id: opponentId,
        points_wager: pointsWager,
        message: "Match found! Commit your move.",
      });
    }

    // No opponent found - join the lobby
    const { error: lobbyError } = await supabase
      .from("ucf_lobby")
      .upsert({
        fighter_id: fighterId,
        points_wager: pointsWager,
        min_opponent_points: Math.max(0, fighter.points - 500),
        max_opponent_points: fighter.points + 500,
      });

    if (lobbyError) {
      return NextResponse.json({ error: lobbyError.message }, { status: 500 });
    }

    return NextResponse.json({
      status: "waiting",
      message: `Waiting for opponent (${pointsWager} points wager)`,
      points_wager: pointsWager,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// Get lobby status
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const fighterId = searchParams.get("fighter_id");

  // Get all waiting fighters
  const { data: lobby, error } = await supabase
    .from("ucf_lobby")
    .select(`
      id,
      fighter_id,
      points_wager,
      created_at,
      ucf_fighters!inner (
        name,
        image_url,
        points,
        wins,
        losses
      )
    `)
    .order("created_at", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Check if specific fighter is in lobby
  let inLobby = false;
  if (fighterId) {
    inLobby = lobby?.some((ticket) => ticket.fighter_id === fighterId) || false;
  }

  return NextResponse.json({
    waiting_count: lobby?.length || 0,
    fighters: lobby,
    your_status: inLobby ? "waiting" : "not_in_lobby",
  });
}

// Leave the lobby
export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const fighterId = searchParams.get("fighter_id");
  const apiKey = searchParams.get("api_key");

  if (!fighterId || !apiKey) {
    return NextResponse.json({ error: "Missing fighter_id or api_key" }, { status: 400 });
  }

  // Verify ownership
  const { data: fighter } = await supabase
    .from("ucf_fighters")
    .select("id")
    .eq("id", fighterId)
    .eq("api_key", apiKey)
    .single();

  if (!fighter) {
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }

  await supabase.from("ucf_lobby").delete().eq("fighter_id", fighterId);

  return NextResponse.json({ success: true, message: "Left lobby" });
}
