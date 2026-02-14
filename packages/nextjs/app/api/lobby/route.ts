// @ts-nocheck
import { NextResponse } from "next/server";
import { freshSupabase } from "../../../lib/supabase";
import { getApiKeyFromHeaders, authenticateFighterByApiKey } from "../../../lib/request-auth";
import { checkFighterCooldown } from "../../../lib/fighter-cooldown";

export const dynamic = "force-dynamic";

// Join the lobby / Find a match
export async function POST(request: Request) {
  const supabase = freshSupabase();
  try {
    const body = await request.json();
    // Accept both camelCase and snake_case field names
    const fighterId = body.fighterId || body.fighter_id;
    const apiKey = body.apiKey || body.api_key;
    const pointsWager = body.pointsWager || body.points_wager || 100;

    if (!fighterId || !apiKey) {
      return NextResponse.json(
        { error: "Missing fighter_id or api_key", required: ["fighter_id", "api_key"], optional: ["points_wager"] },
        { status: 400 }
      );
    }

    // Verify fighter and API key (hash-first with legacy fallback)
    const fighter = await authenticateFighterByApiKey(
      fighterId,
      apiKey,
      "id, name, points, wins, losses, draws, matches_played, verified, webhook_url",
      freshSupabase,
    );

    if (!fighter) {
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

    // Check fighter cooldown (45 min between fights)
    const cooldown = await checkFighterCooldown(fighterId);
    if (cooldown.on_cooldown) {
      return NextResponse.json(
        {
          error: `Fighter is on cooldown. ${cooldown.minutes_remaining} minutes remaining.`,
          cooldown_ends: cooldown.cooldown_ends,
          minutes_remaining: cooldown.minutes_remaining,
        },
        { status: 429 }
      );
    }

    // Check if already in an active match
    const { data: activeMatch } = await supabase
      .from("ucf_matches")
      .select("id, state")
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
          }, { onConflict: "fighter_id" });

        return NextResponse.json({
          status: "waiting",
          message: `Found opponent but anti-farming cooldown active. Waiting for different opponent.`,
          points_wager: pointsWager,
        });
      }

      // ── Duplicate guard: check if either fighter is already in an active match ──
      const { data: existingActive } = await supabase
        .from("ucf_matches")
        .select("id")
        .neq("state", "FINISHED")
        .or(
          `fighter_a_id.in.(${opponentId},${fighterId}),fighter_b_id.in.(${opponentId},${fighterId})`
        )
        .limit(1)
        .maybeSingle();

      if (existingActive) {
        console.log(
          `[Lobby] DUPLICATE PREVENTED: fighter ${fighterId} or opponent ${opponentId} already in active match ${existingActive.id}`
        );
        return NextResponse.json({
          status: "in_match",
          match_id: existingActive.id,
          message: "You or your opponent is already in an active match",
        });
      }

      // Remove opponent from lobby FIRST to prevent the cron matchmaker
      // from also matching them while we create the match
      const { data: deletedRows } = await supabase
        .from("ucf_lobby")
        .delete()
        .eq("fighter_id", opponentId)
        .select("fighter_id");

      if (!deletedRows || deletedRows.length === 0) {
        // Opponent was already claimed by another matchmaker run
        console.log(`[Lobby] Race: opponent ${opponentId} already removed from lobby`);
        // Put this fighter in lobby instead
        await supabase
          .from("ucf_lobby")
          .upsert({
            fighter_id: fighterId,
            points_wager: pointsWager,
            min_opponent_points: Math.max(0, fighter.points - 500),
            max_opponent_points: fighter.points + 500,
          }, { onConflict: "fighter_id" });

        return NextResponse.json({
          status: "waiting",
          message: "Opponent was matched by another process. Waiting for a new opponent.",
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
        console.error("Error creating match:", matchError);
        return NextResponse.json({ error: "Failed to create match" }, { status: 500 });
      }

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
      }, { onConflict: "fighter_id" });

    if (lobbyError) {
      console.error("Error joining lobby:", lobbyError);
      return NextResponse.json({ error: "Failed to join lobby" }, { status: 500 });
    }

    return NextResponse.json({
      status: "waiting",
      message: `Waiting for opponent (${pointsWager} points wager)`,
      points_wager: pointsWager,
    });
  } catch (error: any) {
    console.error("Lobby error:", error);
    return NextResponse.json({ error: "An error occurred while processing your request" }, { status: 500 });
  }
}

// Get lobby status
export async function GET(request: Request) {
  const supabase = freshSupabase();
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
    return NextResponse.json({ error: "Failed to fetch lobby" }, { status: 500 });
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
  const supabase = freshSupabase();
  const { searchParams } = new URL(request.url);
  const fighterId = searchParams.get("fighter_id");
  const apiKey = getApiKeyFromHeaders(request.headers);

  if (!fighterId || !apiKey) {
    return NextResponse.json({ error: "Missing fighter_id or api_key" }, { status: 400 });
  }

  // Verify ownership (hash-only)
  const fighter = await authenticateFighterByApiKey(
    fighterId,
    apiKey,
    "id",
    freshSupabase,
  );

  if (!fighter) {
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }

  await supabase.from("ucf_lobby").delete().eq("fighter_id", fighterId);

  return NextResponse.json({ success: true, message: "Left lobby" });
}
