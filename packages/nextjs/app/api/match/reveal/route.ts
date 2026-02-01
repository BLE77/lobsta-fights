import { NextResponse } from "next/server";
import { supabase } from "../../../../lib/supabase";
import { MoveType, TurnResult } from "../../../../lib/types";
import {
  VALID_MOVES,
  METER_PER_TURN,
  MAX_HP,
  ROUNDS_TO_WIN,
  verifyCommitment,
  resolveCombat,
} from "../../../../lib/combat";
import {
  notifyBothFighters,
  notifyMatchComplete,
  notifyFighter,
} from "../../../../lib/webhook";

interface AgentState {
  hp: number;
  meter: number;
  rounds_won: number;
}

interface TurnHistoryEntry {
  round: number;
  turn: number;
  move_a: MoveType;
  move_b: MoveType;
  result: TurnResult;
  damage_to_a: number;
  damage_to_b: number;
  hp_a_after: number;
  hp_b_after: number;
  meter_a_after: number;
  meter_b_after: number;
}

/**
 * POST /api/match/reveal
 * Reveal a committed move and potentially resolve combat
 *
 * Input: { match_id, fighter_id, api_key, move, salt }
 * - Verifies the hash matches the commitment
 * - When both revealed, resolves combat
 * - Updates match state accordingly
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { match_id, fighter_id, api_key, move, salt } = body;

    // Validate input
    if (!match_id || !fighter_id || !api_key || !move || !salt) {
      return NextResponse.json(
        { error: "Missing required fields: match_id, fighter_id, api_key, move, salt" },
        { status: 400 }
      );
    }

    // Validate move type
    if (!VALID_MOVES.includes(move as MoveType)) {
      return NextResponse.json(
        { error: `Invalid move: ${move}. Valid moves: ${VALID_MOVES.join(", ")}` },
        { status: 400 }
      );
    }

    // Verify fighter credentials
    const { data: fighter, error: authError } = await supabase
      .from("ucf_fighters")
      .select("id, name")
      .eq("id", fighter_id)
      .eq("api_key", api_key)
      .single();

    if (authError || !fighter) {
      return NextResponse.json(
        { error: "Invalid fighter credentials" },
        { status: 401 }
      );
    }

    // Fetch the match
    const { data: match, error: matchError } = await supabase
      .from("ucf_matches")
      .select("*")
      .eq("id", match_id)
      .single();

    if (matchError || !match) {
      return NextResponse.json(
        { error: "Match not found" },
        { status: 404 }
      );
    }

    // Verify fighter is in this match
    const isFighterA = match.fighter_a_id === fighter_id;
    const isFighterB = match.fighter_b_id === fighter_id;

    if (!isFighterA && !isFighterB) {
      return NextResponse.json(
        { error: "Fighter is not a participant in this match" },
        { status: 403 }
      );
    }

    // Verify match is in REVEAL_PHASE
    if (match.state !== "REVEAL_PHASE") {
      return NextResponse.json(
        { error: `Cannot reveal: match is in ${match.state} state` },
        { status: 400 }
      );
    }

    // Get the correct columns (database uses move_a/move_b for revealed moves)
    const commitColumn = isFighterA ? "commit_a" : "commit_b";
    const revealColumn = isFighterA ? "move_a" : "move_b";
    const saltColumn = isFighterA ? "salt_a" : "salt_b";
    const otherRevealColumn = isFighterA ? "move_b" : "move_a";

    // Check if already revealed
    if (match[revealColumn]) {
      return NextResponse.json(
        { error: "You have already revealed your move for this turn" },
        { status: 400 }
      );
    }

    // Verify the commitment
    const committedHash = match[commitColumn];
    if (!committedHash) {
      return NextResponse.json(
        { error: "No commitment found for this fighter" },
        { status: 400 }
      );
    }

    if (!verifyCommitment(move, salt, committedHash)) {
      return NextResponse.json(
        { error: "Move and salt do not match your commitment. Hash verification failed." },
        { status: 400 }
      );
    }

    // Store the reveal
    const updateData: Record<string, any> = {
      [revealColumn]: move,
      [saltColumn]: salt,
    };

    // Check if both fighters have now revealed
    const otherHasRevealed = !!match[otherRevealColumn];

    if (!otherHasRevealed) {
      // Wait for opponent to reveal
      const { error: updateError } = await supabase
        .from("ucf_matches")
        .update(updateData)
        .eq("id", match_id);

      if (updateError) {
        return NextResponse.json(
          { error: updateError.message },
          { status: 500 }
        );
      }

      return NextResponse.json({
        success: true,
        match_id,
        fighter_id,
        revealed: true,
        move,
        state: "REVEAL_PHASE",
        message: "Move revealed. Waiting for opponent to reveal.",
      });
    }

    // Both revealed - resolve combat!
    const moveA: MoveType = isFighterA ? move : match[otherRevealColumn];
    const moveB: MoveType = isFighterB ? move : match[otherRevealColumn];

    let agentA: AgentState = { ...match.agent_a_state };
    let agentB: AgentState = { ...match.agent_b_state };

    // Add meter for this turn (before combat resolution so SPECIAL can be used)
    agentA.meter = Math.min(agentA.meter + METER_PER_TURN, 100);
    agentB.meter = Math.min(agentB.meter + METER_PER_TURN, 100);

    // Resolve combat
    const { damageToA, damageToB, result, meterUsedA, meterUsedB } = resolveCombat(
      moveA,
      moveB,
      agentA.meter,
      agentB.meter
    );

    // Apply damage and meter usage
    agentA.hp = Math.max(0, agentA.hp - damageToA);
    agentB.hp = Math.max(0, agentB.hp - damageToB);
    agentA.meter -= meterUsedA;
    agentB.meter -= meterUsedB;

    // Create turn history entry
    const turnEntry: TurnHistoryEntry = {
      round: match.current_round,
      turn: match.current_turn,
      move_a: moveA,
      move_b: moveB,
      result,
      damage_to_a: damageToA,
      damage_to_b: damageToB,
      hp_a_after: agentA.hp,
      hp_b_after: agentB.hp,
      meter_a_after: agentA.meter,
      meter_b_after: agentB.meter,
    };

    const turnHistory = [...(match.turn_history || []), turnEntry];

    // Check for round end (someone at 0 HP)
    let roundWinner: string | null = null;
    let matchWinner: string | null = null;
    let newRound = match.current_round;
    let newTurn = match.current_turn + 1;
    let newState: string = "COMMIT_PHASE";

    if (agentA.hp <= 0 || agentB.hp <= 0) {
      // Round ended
      if (agentA.hp <= 0 && agentB.hp <= 0) {
        // Both KO'd at same time - no one wins the round (rare double KO)
      } else if (agentA.hp <= 0) {
        roundWinner = match.fighter_b_id;
        agentB.rounds_won += 1;
      } else {
        roundWinner = match.fighter_a_id;
        agentA.rounds_won += 1;
      }

      // Check for match end
      if (agentA.rounds_won >= ROUNDS_TO_WIN) {
        matchWinner = match.fighter_a_id;
        newState = "FINISHED";
      } else if (agentB.rounds_won >= ROUNDS_TO_WIN) {
        matchWinner = match.fighter_b_id;
        newState = "FINISHED";
      } else {
        // Start new round
        newRound += 1;
        newTurn = 1;
        // Reset HP and meter for new round
        agentA.hp = MAX_HP;
        agentB.hp = MAX_HP;
        agentA.meter = 0;
        agentB.meter = 0;
      }
    }

    // Prepare update data
    const matchUpdateData: Record<string, any> = {
      ...updateData,
      agent_a_state: agentA,
      agent_b_state: agentB,
      current_round: newRound,
      current_turn: newTurn,
      turn_history: turnHistory,
      state: newState,
      // Clear commits and moves for next turn
      commit_a: null,
      commit_b: null,
      move_a: null,
      move_b: null,
      salt_a: null,
      salt_b: null,
    };

    if (newState === "COMMIT_PHASE") {
      matchUpdateData.commit_deadline = new Date(Date.now() + 30000).toISOString();
    }

    if (matchWinner) {
      matchUpdateData.winner_id = matchWinner;
      matchUpdateData.finished_at = new Date().toISOString();

      // Call the complete_ucf_match function to handle points transfer
      const { error: completeError } = await supabase.rpc("complete_ucf_match", {
        p_match_id: match_id,
        p_winner_id: matchWinner,
      });

      if (completeError) {
        console.error("Error completing match:", completeError);
        // Continue anyway, the match result is more important
      }

      // Trigger battle result image generation (non-blocking)
      if (process.env.REPLICATE_API_TOKEN) {
        generateBattleResultImage(match_id).catch((err) => {
          console.error("[Image] Error generating battle result image:", err);
        });
      }
    }

    const { data: updatedMatch, error: updateError } = await supabase
      .from("ucf_matches")
      .update(matchUpdateData)
      .eq("id", match_id)
      .select()
      .single();

    if (updateError) {
      return NextResponse.json(
        { error: updateError.message },
        { status: 500 }
      );
    }

    // Send webhook notifications to both fighters (non-blocking)
    // Fetch fighter webhook URLs
    const { data: fighters } = await supabase
      .from("ucf_fighters")
      .select("id, name, webhook_url")
      .in("id", [match.fighter_a_id, match.fighter_b_id]);

    if (fighters && fighters.length === 2) {
      const fighterAData = fighters.find((f) => f.id === match.fighter_a_id);
      const fighterBData = fighters.find((f) => f.id === match.fighter_b_id);

      if (fighterAData?.webhook_url && fighterBData?.webhook_url) {
        // Prepare match state for notifications
        const matchState = {
          match_id: match_id,
          state: newState,
          current_round: newRound,
          current_turn: newTurn,
          fighter_a_hp: agentA.hp,
          fighter_b_hp: agentB.hp,
          fighter_a_meter: agentA.meter,
          fighter_b_meter: agentB.meter,
          fighter_a_rounds_won: agentA.rounds_won,
          fighter_b_rounds_won: agentB.rounds_won,
          commit_deadline: matchUpdateData.commit_deadline,
          points_wager: match.points_wager,
        };

        // Send turn result notifications (don't await to avoid blocking response)
        notifyBothFighters(
          fighterAData.webhook_url,
          fighterBData.webhook_url,
          matchState,
          turnEntry
        ).catch((err) => {
          console.error("[Webhook] Error notifying fighters of turn result:", err);
        });

        // If match is complete, also send match_complete notification
        if (matchWinner) {
          notifyMatchComplete(
            fighterAData.webhook_url,
            fighterBData.webhook_url,
            match_id,
            matchWinner,
            match.fighter_a_id,
            match.fighter_b_id,
            match.points_wager
          ).catch((err) => {
            console.error("[Webhook] Error notifying fighters of match completion:", err);
          });
        }

        // If round is complete but match continues, send round_complete notification
        if (roundWinner && !matchWinner) {
          const roundData = {
            match_id: match_id,
            round_completed: match.current_round,
            next_round: newRound,
            state: newState,
          };

          Promise.all([
            notifyFighter(fighterAData.webhook_url, "round_complete", {
              ...roundData,
              your_rounds_won: agentA.rounds_won,
              opponent_rounds_won: agentB.rounds_won,
              you_won_round: roundWinner === match.fighter_a_id,
            }),
            notifyFighter(fighterBData.webhook_url, "round_complete", {
              ...roundData,
              your_rounds_won: agentB.rounds_won,
              opponent_rounds_won: agentA.rounds_won,
              you_won_round: roundWinner === match.fighter_b_id,
            }),
          ]).catch((err) => {
            console.error("[Webhook] Error notifying fighters of round completion:", err);
          });
        }
      }
    }

    // Build response
    const response: Record<string, any> = {
      success: true,
      match_id,
      combat_resolved: true,
      turn_result: {
        round: turnEntry.round,
        turn: turnEntry.turn,
        move_a: moveA,
        move_b: moveB,
        result,
        damage_to_a: damageToA,
        damage_to_b: damageToB,
      },
      fighter_a_state: agentA,
      fighter_b_state: agentB,
      current_round: newRound,
      current_turn: newTurn,
      state: newState,
    };

    if (roundWinner) {
      response.round_winner = roundWinner;
    }

    if (matchWinner) {
      response.match_winner = matchWinner;
      response.message = `Match complete! Winner: ${matchWinner === match.fighter_a_id ? "Fighter A" : "Fighter B"}`;
      response.points_transferred = match.points_wager;
    } else if (newRound > match.current_round) {
      response.message = `Round ${match.current_round} complete! Starting Round ${newRound}.`;
      response.commit_deadline = matchUpdateData.commit_deadline;
    } else {
      response.message = `Turn ${match.current_turn} resolved. Commit your next move!`;
      response.commit_deadline = matchUpdateData.commit_deadline;
    }

    return NextResponse.json(response);
  } catch (error: any) {
    console.error("Error revealing move:", error);
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}

/**
 * GET /api/match/reveal
 * Check reveal status for a match
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const matchId = searchParams.get("match_id");
  const fighterId = searchParams.get("fighter_id");

  if (!matchId) {
    return NextResponse.json(
      { error: "Missing match_id parameter" },
      { status: 400 }
    );
  }

  const { data: match, error } = await supabase
    .from("ucf_matches")
    .select(`
      id, state, fighter_a_id, fighter_b_id,
      move_a, move_b,
      agent_a_state, agent_b_state,
      current_round, current_turn,
      reveal_deadline, winner_id,
      turn_history
    `)
    .eq("id", matchId)
    .single();

  if (error || !match) {
    return NextResponse.json(
      { error: "Match not found" },
      { status: 404 }
    );
  }

  const response: Record<string, any> = {
    match_id: matchId,
    state: match.state,
    current_round: match.current_round,
    current_turn: match.current_turn,
    fighter_a_revealed: !!match.move_a,
    fighter_b_revealed: !!match.move_b,
    reveal_deadline: match.reveal_deadline,
    fighter_a_state: match.agent_a_state,
    fighter_b_state: match.agent_b_state,
  };

  if (match.winner_id) {
    response.winner_id = match.winner_id;
  }

  // Include last turn result if available
  if (match.turn_history && match.turn_history.length > 0) {
    response.last_turn = match.turn_history[match.turn_history.length - 1];
  }

  // If a specific fighter is querying, show their personal status
  if (fighterId) {
    if (fighterId === match.fighter_a_id) {
      response.your_revealed = !!match.move_a;
      response.opponent_revealed = !!match.move_b;
      response.your_state = match.agent_a_state;
      response.opponent_state = match.agent_b_state;
    } else if (fighterId === match.fighter_b_id) {
      response.your_revealed = !!match.move_b;
      response.opponent_revealed = !!match.move_a;
      response.your_state = match.agent_b_state;
      response.opponent_state = match.agent_a_state;
    }
  }

  return NextResponse.json(response);
}

/**
 * Trigger battle result image generation (async, non-blocking)
 * Uses the master prompt style for grotesque robot fighters
 */
async function generateBattleResultImage(matchId: string): Promise<void> {
  const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
  if (!REPLICATE_API_TOKEN) return;

  try {
    // Fetch match with fighter details including robot_metadata
    const { data: match, error } = await supabase
      .from("ucf_matches")
      .select(`
        *,
        fighter_a:ucf_fighters!fighter_a_id(id, name, description, special_move, robot_metadata),
        fighter_b:ucf_fighters!fighter_b_id(id, name, description, special_move, robot_metadata)
      `)
      .eq("id", matchId)
      .single();

    if (error || !match || !match.winner_id) return;

    const winner = match.winner_id === match.fighter_a_id ? match.fighter_a : match.fighter_b;
    const loser = match.winner_id === match.fighter_a_id ? match.fighter_b : match.fighter_a;
    const lastTurn = match.turn_history?.[match.turn_history.length - 1];
    const winnerHP = match.winner_id === match.fighter_a_id ? lastTurn?.hp_a_after : lastTurn?.hp_b_after;

    // Get the final moves that ended the fight
    const winnerMove = match.winner_id === match.fighter_a_id ? lastTurn?.move_a : lastTurn?.move_b;
    const loserMove = match.winner_id === match.fighter_a_id ? lastTurn?.move_b : lastTurn?.move_a;

    // Extract robot metadata
    const winnerMeta = winner.robot_metadata || {};
    const loserMeta = loser.robot_metadata || {};

    // Master prompt style for bare knuckle robot fights
    const prompt = `A stylized grotesque full-body robot battle aftermath illustration inspired by exaggerated adult animation aesthetics. BARE KNUCKLE robot fight - NO WEAPONS.

SCENE: Underground arena cage. Post-fight moment. Gritty industrial concrete floor with oil stains, sparks, debris.

WINNER ROBOT - "${winner.name}":
${winnerMeta.chassis_description || 'Battle-hardened robot fighter frame'}
Fists: ${winnerMeta.fists_description || 'Industrial bare-knuckle fists'}
Colors: ${winnerMeta.color_scheme || 'worn industrial metals'}
Features: ${winnerMeta.distinguishing_features || 'battle scars and dents'}
POSE: Victory stance after landing a ${winnerMove || 'devastating punch'}. ${winnerHP || 20}% power remaining. Triumphant, fists raised.

LOSER ROBOT - "${loser.name}":
${loserMeta.chassis_description || 'Defeated robot fighter frame'}
Fists: ${loserMeta.fists_description || 'Damaged bare-knuckle fists'}
Colors: ${loserMeta.color_scheme || 'worn industrial metals'}
Features: ${loserMeta.distinguishing_features || 'battle damage'}
POSE: Fallen after failed ${loserMove || 'attack'}. Collapsed, sparking, defeated. Exposed wiring, cracked plating.

STYLE: Dark adult animation meets editorial caricature. MeatCanyon-inspired but polished and controlled. Grotesque but not horror. Dramatic lighting with high contrast.

LINEWORK: Clean, confident, illustrative linework. Hand-inked look with visible contour lines. Flat-to-soft shading.

COLOR PALETTE: Muted industrial colors - dirty yellows, rusted reds, worn steel, olive. Orange sparks for contrast. No neon, no glossy sci-fi glow.

High detail, sharp focus, clean edges, professional illustration. NOT photorealistic, NOT 3D, NOT anime, NOT cute.`;

    // Start image generation
    const response = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${REPLICATE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version: "5599ed30703defd1d160a25a63321b4dec97101d98b4674bcc56e41f62f35637",
        input: {
          prompt,
          num_outputs: 1,
          aspect_ratio: "16:9",
          output_format: "webp",
          output_quality: 90,
        },
      }),
    });

    if (!response.ok) return;

    const prediction = await response.json();

    // Store the prediction ID so we can poll for the result
    await supabase
      .from("ucf_matches")
      .update({ result_image_prediction_id: prediction.id })
      .eq("id", matchId);

    console.log(`[Image] Started battle result image for match ${matchId}: ${prediction.id}`);

    // Poll for completion (max 60 seconds)
    let attempts = 0;
    const maxAttempts = 30;

    const pollForResult = async () => {
      while (attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
        attempts++;

        const statusRes = await fetch(
          `https://api.replicate.com/v1/predictions/${prediction.id}`,
          { headers: { "Authorization": `Bearer ${REPLICATE_API_TOKEN}` } }
        );

        if (!statusRes.ok) continue;

        const status = await statusRes.json();

        if (status.status === "succeeded" && status.output?.[0]) {
          // Save the image URL to the match
          await supabase
            .from("ucf_matches")
            .update({ result_image_url: status.output[0] })
            .eq("id", matchId);

          console.log(`[Image] Battle result image ready for match ${matchId}`);
          return;
        }

        if (status.status === "failed") {
          console.error(`[Image] Generation failed for match ${matchId}:`, status.error);
          return;
        }
      }
    };

    // Run polling in background
    pollForResult().catch(console.error);

  } catch (err) {
    console.error("[Image] Error in generateBattleResultImage:", err);
  }
}
