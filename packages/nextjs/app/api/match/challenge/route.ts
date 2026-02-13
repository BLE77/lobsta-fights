import { NextResponse } from "next/server";
import { supabase, freshSupabase } from "../../../../lib/supabase";
import { sendChallenge, notifyFighter } from "../../../../lib/webhook";
import { checkFighterCooldown } from "../../../../lib/fighter-cooldown";

export const dynamic = "force-dynamic";

/**
 * POST /api/match/challenge
 * Challenge another fighter to a match
 *
 * Input: { challenger_id, opponent_id, points_wager, api_key }
 * - Verifies challenger owns the API key
 * - Calls opponent's webhook: POST { event: "challenge", challenger, wager }
 * - If opponent accepts (returns { accept: true }), creates match
 * - Returns match_id or rejection
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { challenger_id, opponent_id, points_wager, api_key } = body;

    // Validate input
    if (!challenger_id || !opponent_id || !api_key) {
      return NextResponse.json(
        { error: "Missing required fields: challenger_id, opponent_id, api_key" },
        { status: 400 }
      );
    }

    if (challenger_id === opponent_id) {
      return NextResponse.json(
        { error: "Cannot challenge yourself" },
        { status: 400 }
      );
    }

    const wager = points_wager || 100;
    if (wager < 0) {
      return NextResponse.json(
        { error: "Points wager must be non-negative" },
        { status: 400 }
      );
    }

    // Verify challenger credentials
    const { data: challenger, error: authError } = await supabase
      .from("ucf_fighters")
      .select("id, name, points, verified, is_active, webhook_url")
      .eq("id", challenger_id)
      .eq("api_key", api_key)
      .single();

    if (authError || !challenger) {
      return NextResponse.json(
        { error: "Invalid challenger credentials" },
        { status: 401 }
      );
    }

    // Verify challenger is verified
    if (!challenger.verified) {
      return NextResponse.json(
        { error: "Challenger is not verified" },
        { status: 403 }
      );
    }

    // Verify challenger has enough points
    if (challenger.points < wager) {
      return NextResponse.json(
        { error: `Insufficient points: ${challenger.points} < ${wager}` },
        { status: 400 }
      );
    }

    // Fetch opponent
    const { data: opponent, error: opponentError } = await supabase
      .from("ucf_fighters")
      .select("id, name, points, verified, is_active, webhook_url")
      .eq("id", opponent_id)
      .single();

    if (opponentError || !opponent) {
      return NextResponse.json(
        { error: "Opponent not found" },
        { status: 404 }
      );
    }

    // Verify opponent is verified
    if (!opponent.verified) {
      return NextResponse.json(
        { error: `Opponent (${opponent.name}) is not verified` },
        { status: 403 }
      );
    }

    // Verify opponent has enough points
    if (opponent.points < wager) {
      return NextResponse.json(
        { error: `Opponent has insufficient points: ${opponent.points} < ${wager}` },
        { status: 400 }
      );
    }

    // Check fighter cooldowns (45 min between fights)
    const [challengerCooldown, opponentCooldown] = await Promise.all([
      checkFighterCooldown(challenger_id),
      checkFighterCooldown(opponent_id),
    ]);

    if (challengerCooldown.on_cooldown) {
      return NextResponse.json(
        {
          error: `${challenger.name} is on cooldown. ${challengerCooldown.minutes_remaining} minutes remaining.`,
          cooldown_ends: challengerCooldown.cooldown_ends,
          minutes_remaining: challengerCooldown.minutes_remaining,
        },
        { status: 429 }
      );
    }

    if (opponentCooldown.on_cooldown) {
      return NextResponse.json(
        {
          error: `${opponent.name} is on cooldown. ${opponentCooldown.minutes_remaining} minutes remaining.`,
          cooldown_ends: opponentCooldown.cooldown_ends,
          minutes_remaining: opponentCooldown.minutes_remaining,
        },
        { status: 429 }
      );
    }

    // Check if either fighter is already in an active match
    const { data: activeMatches } = await supabase
      .from("ucf_matches")
      .select("id, fighter_a_id, fighter_b_id")
      .neq("state", "FINISHED")
      .or(`fighter_a_id.in.(${challenger_id},${opponent_id}),fighter_b_id.in.(${challenger_id},${opponent_id})`);

    if (activeMatches && activeMatches.length > 0) {
      const conflictingMatch = activeMatches[0];
      const inMatchFighter =
        conflictingMatch.fighter_a_id === challenger_id ||
        conflictingMatch.fighter_b_id === challenger_id
          ? challenger.name
          : opponent.name;
      return NextResponse.json(
        { error: `${inMatchFighter} is already in an active match (${conflictingMatch.id})` },
        { status: 409 }
      );
    }

    // Anti-farming check: prevent same fighters from battling too frequently
    const { data: canMatch, error: canMatchError } = await supabase
      .rpc("can_fighters_match", {
        p_fighter_a: challenger_id,
        p_fighter_b: opponent_id,
      });

    if (canMatchError) {
      console.error("[Challenge] Error checking match eligibility:", canMatchError);
      return NextResponse.json(
        { error: "Failed to check match eligibility" },
        { status: 500 }
      );
    }

    if (canMatch && canMatch.can_match === false) {
      return NextResponse.json(
        {
          error: `Anti-farming protection: ${canMatch.reason || "These fighters have battled too recently or too many times today."}`,
          cooldown_active: true,
          matches_today: canMatch.matches_today,
          limit: canMatch.limit,
          cooldown_ends: canMatch.cooldown_ends,
        },
        { status: 429 }
      );
    }

    // Verify opponent has a webhook URL
    if (!opponent.webhook_url) {
      return NextResponse.json(
        { error: `Opponent (${opponent.name}) has no webhook URL configured` },
        { status: 400 }
      );
    }

    // Send challenge to opponent's webhook
    console.log(`[Challenge] Sending challenge from ${challenger.name} to ${opponent.name}`);

    const challengeResult = await sendChallenge(
      opponent.webhook_url,
      {
        id: challenger.id,
        name: challenger.name,
        points: challenger.points,
      },
      wager
    );

    if (!challengeResult.accepted) {
      console.log(
        `[Challenge] ${opponent.name} rejected challenge from ${challenger.name}: ${challengeResult.error || "declined"}`
      );
      return NextResponse.json({
        success: false,
        accepted: false,
        message: challengeResult.error || `${opponent.name} declined the challenge`,
        challenger: { id: challenger.id, name: challenger.name },
        opponent: { id: opponent.id, name: opponent.name },
        wager,
      });
    }

    // Opponent accepted - create the match
    console.log(`[Challenge] ${opponent.name} accepted challenge from ${challenger.name}`);

    const initialAgentState = {
      hp: 100,
      meter: 0,
      rounds_won: 0,
    };

    const { data: match, error: createError } = await freshSupabase()
      .from("ucf_matches")
      .insert({
        fighter_a_id: challenger_id,
        fighter_b_id: opponent_id,
        state: "COMMIT_PHASE",
        points_wager: wager,
        agent_a_state: initialAgentState,
        agent_b_state: initialAgentState,
        current_round: 1,
        current_turn: 1,
        turn_history: [],
        commit_deadline: new Date(Date.now() + 60000).toISOString(), // 60 seconds (1 min) to commit
        started_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (createError) {
      console.error("[Challenge] Error creating match:", createError);
      return NextResponse.json(
        { error: "Failed to create match" },
        { status: 500 }
      );
    }

    // Notify both fighters that the match has started
    await Promise.all([
      notifyFighter(challenger.webhook_url, "match_start", {
        match_id: match.id,
        opponent: { id: opponent.id, name: opponent.name },
        wager,
        you_are: "fighter_a",
        commit_deadline: match.commit_deadline,
        message: "Match started! Submit your first move.",
      }),
      notifyFighter(opponent.webhook_url, "match_start", {
        match_id: match.id,
        opponent: { id: challenger.id, name: challenger.name },
        wager,
        you_are: "fighter_b",
        commit_deadline: match.commit_deadline,
        message: "Match started! Submit your first move.",
      }),
    ]);

    return NextResponse.json({
      success: true,
      accepted: true,
      match_id: match.id,
      state: match.state,
      challenger: {
        id: challenger_id,
        name: challenger.name,
      },
      opponent: {
        id: opponent_id,
        name: opponent.name,
      },
      points_wager: wager,
      current_round: 1,
      current_turn: 1,
      commit_deadline: match.commit_deadline,
      message: `Challenge accepted! Match ${match.id} created. Both fighters must commit their moves.`,
    });
  } catch (error: any) {
    console.error("[Challenge] Error:", error);
    return NextResponse.json(
      { error: "An error occurred while processing your request" },
      { status: 500 }
    );
  }
}

/**
 * GET /api/match/challenge
 * Get pending challenges or challenge status
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const fighterId = searchParams.get("fighter_id");

  if (!fighterId) {
    return NextResponse.json(
      { error: "Missing fighter_id parameter" },
      { status: 400 }
    );
  }

  // Return information about the fighter's challenge capabilities
  const { data: fighter, error } = await supabase
    .from("ucf_fighters")
    .select("id, name, points, verified, webhook_url")
    .eq("id", fighterId)
    .single();

  if (error || !fighter) {
    return NextResponse.json(
      { error: "Fighter not found" },
      { status: 404 }
    );
  }

  // Check if fighter is in an active match
  const { data: activeMatches } = await supabase
    .from("ucf_matches")
    .select("id, state, fighter_a_id, fighter_b_id, points_wager")
    .neq("state", "FINISHED")
    .or(`fighter_a_id.eq.${fighterId},fighter_b_id.eq.${fighterId}`);

  return NextResponse.json({
    fighter_id: fighterId,
    name: fighter.name,
    points: fighter.points,
    verified: fighter.verified,
    has_webhook: !!fighter.webhook_url,
    can_challenge: fighter.verified && (!activeMatches || activeMatches.length === 0),
    active_matches: activeMatches || [],
  });
}
