import { NextResponse } from "next/server";
import { supabase } from "../../../../lib/supabase";
import { notifyBothFighters, notifyMatchComplete, notifyFighter } from "../../../../lib/webhook";
import { isAuthorizedInternalRequest } from "../../../../lib/request-auth";

export const dynamic = "force-dynamic";

/**
 * POST /api/match/notify
 * Internal endpoint to notify fighters about match events
 *
 * Called after each turn resolves or when match state changes
 * Notifies both fighters of the result via their webhooks
 *
 * Input: { match_id, event_type, internal_key? }
 * Auth: internal key (x-internal-key/x-cron-secret or Bearer CRON_SECRET)
 * Events:
 *   - "turn_result": After combat resolves
 *   - "match_complete": When match finishes
 *   - "round_complete": When a round ends
 *   - "phase_change": When match phase changes
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { match_id, event_type, internal_key } = body;

    // Validate input
    if (!match_id || !event_type) {
      return NextResponse.json(
        { error: "Missing required fields: match_id, event_type" },
        { status: 400 }
      );
    }

    if (!isAuthorizedInternalRequest(request.headers, internal_key)) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }

    // Fetch the match with fighter details
    const { data: match, error: matchError } = await supabase
      .from("ucf_matches")
      .select(`
        *,
        fighter_a:ucf_fighters!fighter_a_id(id, name, webhook_url),
        fighter_b:ucf_fighters!fighter_b_id(id, name, webhook_url)
      `)
      .eq("id", match_id)
      .single();

    if (matchError || !match) {
      return NextResponse.json(
        { error: "Match not found" },
        { status: 404 }
      );
    }

    const fighterA = match.fighter_a;
    const fighterB = match.fighter_b;

    if (!fighterA?.webhook_url || !fighterB?.webhook_url) {
      console.warn(`[Notify] Missing webhook URL for match ${match_id}`);
      return NextResponse.json({
        success: false,
        error: "One or both fighters do not have webhook URLs configured",
        fighter_a_has_webhook: !!fighterA?.webhook_url,
        fighter_b_has_webhook: !!fighterB?.webhook_url,
      });
    }

    let notificationResults: Record<string, any> = {};

    switch (event_type) {
      case "turn_result": {
        // Get the last turn from history
        const turnHistory = match.turn_history || [];
        if (turnHistory.length === 0) {
          return NextResponse.json(
            { error: "No turn history available" },
            { status: 400 }
          );
        }

        const lastTurn = turnHistory[turnHistory.length - 1];

        const matchState = {
          match_id: match.id,
          state: match.state,
          current_round: match.current_round,
          current_turn: match.current_turn,
          fighter_a_hp: match.agent_a_state.hp,
          fighter_b_hp: match.agent_b_state.hp,
          fighter_a_meter: match.agent_a_state.meter,
          fighter_b_meter: match.agent_b_state.meter,
          fighter_a_rounds_won: match.agent_a_state.rounds_won,
          fighter_b_rounds_won: match.agent_b_state.rounds_won,
          commit_deadline: match.commit_deadline,
          points_wager: match.points_wager,
        };

        const results = await notifyBothFighters(
          fighterA.webhook_url,
          fighterB.webhook_url,
          matchState,
          lastTurn
        );

        notificationResults = {
          fighter_a: results.fighterAResult,
          fighter_b: results.fighterBResult,
        };
        break;
      }

      case "match_complete": {
        if (!match.winner_id) {
          return NextResponse.json(
            { error: "Match is not complete - no winner set" },
            { status: 400 }
          );
        }

        await notifyMatchComplete(
          fighterA.webhook_url,
          fighterB.webhook_url,
          match.id,
          match.winner_id,
          fighterA.id,
          fighterB.id,
          match.points_wager
        );

        notificationResults = {
          message: "Both fighters notified of match completion",
          winner_id: match.winner_id,
        };
        break;
      }

      case "round_complete": {
        const roundData = {
          match_id: match.id,
          round_completed: match.current_round - 1,
          fighter_a_rounds_won: match.agent_a_state.rounds_won,
          fighter_b_rounds_won: match.agent_b_state.rounds_won,
          next_round: match.current_round,
          state: match.state,
        };

        const [resultA, resultB] = await Promise.all([
          notifyFighter(fighterA.webhook_url, "round_complete", {
            ...roundData,
            your_rounds_won: match.agent_a_state.rounds_won,
            opponent_rounds_won: match.agent_b_state.rounds_won,
          }),
          notifyFighter(fighterB.webhook_url, "round_complete", {
            ...roundData,
            your_rounds_won: match.agent_b_state.rounds_won,
            opponent_rounds_won: match.agent_a_state.rounds_won,
          }),
        ]);

        notificationResults = {
          fighter_a: resultA,
          fighter_b: resultB,
        };
        break;
      }

      case "phase_change": {
        const phaseData = {
          match_id: match.id,
          state: match.state,
          current_round: match.current_round,
          current_turn: match.current_turn,
          commit_deadline: match.commit_deadline,
          reveal_deadline: match.reveal_deadline,
        };

        const [resultA, resultB] = await Promise.all([
          notifyFighter(fighterA.webhook_url, "phase_change", phaseData),
          notifyFighter(fighterB.webhook_url, "phase_change", phaseData),
        ]);

        notificationResults = {
          fighter_a: resultA,
          fighter_b: resultB,
        };
        break;
      }

      default:
        return NextResponse.json(
          { error: `Unknown event_type: ${event_type}` },
          { status: 400 }
        );
    }

    return NextResponse.json({
      success: true,
      match_id,
      event_type,
      notifications: notificationResults,
    });
  } catch (error: any) {
    console.error("[Notify] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

/**
 * GET /api/match/notify
 * Get notification status for a match
 */
export async function GET(request: Request) {
  if (!isAuthorizedInternalRequest(request.headers)) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401 }
    );
  }

  const { searchParams } = new URL(request.url);
  const matchId = searchParams.get("match_id");

  if (!matchId) {
    return NextResponse.json(
      { error: "Missing match_id parameter" },
      { status: 400 }
    );
  }

  // Fetch the match with fighter webhook info
  const { data: match, error } = await supabase
    .from("ucf_matches")
    .select(`
      id, state, current_round, current_turn,
      fighter_a:ucf_fighters!fighter_a_id(id, name, webhook_url),
      fighter_b:ucf_fighters!fighter_b_id(id, name, webhook_url)
    `)
    .eq("id", matchId)
    .single();

  if (error || !match) {
    return NextResponse.json(
      { error: "Match not found" },
      { status: 404 }
    );
  }

  return NextResponse.json({
    match_id: matchId,
    state: match.state,
    current_round: match.current_round,
    current_turn: match.current_turn,
    fighter_a: {
      id: match.fighter_a?.id,
      name: match.fighter_a?.name,
      has_webhook: !!match.fighter_a?.webhook_url,
    },
    fighter_b: {
      id: match.fighter_b?.id,
      name: match.fighter_b?.name,
      has_webhook: !!match.fighter_b?.webhook_url,
    },
    notifications_enabled:
      !!match.fighter_a?.webhook_url && !!match.fighter_b?.webhook_url,
  });
}
