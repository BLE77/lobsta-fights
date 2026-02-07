import { supabase } from "./supabase";
import { MoveType, TurnResult } from "./types";
import {
  METER_PER_TURN,
  MAX_HP,
  ROUNDS_TO_WIN,
  resolveCombat,
} from "./combat";

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

export interface TurnResolutionResult {
  success: boolean;
  error?: string;
  turnEntry?: TurnHistoryEntry;
  agentA?: AgentState;
  agentB?: AgentState;
  newRound?: number;
  newTurn?: number;
  newState?: string;
  roundWinner?: string;
  matchWinner?: string;
}

/**
 * Resolves a turn when both fighters have revealed their moves.
 * This is shared between the reveal endpoint and the submit-move auto-reveal.
 */
export async function resolveTurn(matchId: string): Promise<TurnResolutionResult> {
  // Fetch the match with current state
  const { data: match, error: matchError } = await supabase
    .from("ucf_matches")
    .select("*")
    .eq("id", matchId)
    .single();

  if (matchError || !match) {
    return { success: false, error: "Match not found" };
  }

  // Verify both moves are revealed
  if (!match.move_a || !match.move_b) {
    return { success: false, error: "Both moves must be revealed" };
  }

  // Verify match is in REVEAL_PHASE
  if (match.state !== "REVEAL_PHASE") {
    return { success: false, error: `Match is in ${match.state} state` };
  }

  const moveA: MoveType = match.move_a;
  const moveB: MoveType = match.move_b;

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
  let roundWinner: string | undefined;
  let matchWinner: string | undefined;
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
    pending_move_a: null,
    pending_move_b: null,
    pending_salt_a: null,
    pending_salt_b: null,
  };

  if (newState === "COMMIT_PHASE") {
    matchUpdateData.commit_deadline = new Date(Date.now() + 60000).toISOString();
  }

  if (matchWinner) {
    matchUpdateData.winner_id = matchWinner;
    matchUpdateData.finished_at = new Date().toISOString();

    // Call the complete_ucf_match function to handle points transfer
    // This function is now idempotent - safe to call multiple times
    const { data: completeResult, error: completeError } = await supabase.rpc("complete_ucf_match", {
      p_match_id: matchId,
      p_winner_id: matchWinner,
    });

    if (completeError) {
      console.error("Error completing match:", completeError);
    } else if (completeResult?.already_processed) {
      console.log(`[Match] Match ${matchId} already processed - skipping duplicate points transfer`);
    } else if (completeResult?.success) {
      console.log(`[Match] Match ${matchId} completed: ${completeResult.points_transferred} points transferred`);
    }

    // Handle on-chain wager payout (non-blocking)
    if (match.on_chain_wager) {
      import("./contracts").then(({ resolveOnChainMatch, isOnChainWageringEnabled }) => {
        if (isOnChainWageringEnabled()) {
          resolveOnChainMatch(matchId, matchWinner)
            .then((txHash) => {
              console.log(`[OnChain] Match ${matchId} resolved on-chain: ${txHash}`);
              // Update match with tx hash
              supabase
                .from("ucf_matches")
                .update({ resolve_tx_hash: txHash })
                .eq("id", matchId);
            })
            .catch((err) => {
              console.error("[OnChain] Error resolving match:", err);
            });
        }
      });
    }

    // Use winner's pre-generated victory pose instead of generating new battle images
    // This saves on image generation costs - victory poses are created at registration
    // IMPORTANT: Only set image if not already set (idempotency)
    if (!match.result_image_url) {
      supabase
        .from("ucf_fighters")
        .select("victory_pose_url, image_url")
        .eq("id", matchWinner)
        .single()
        .then(({ data: winner, error: winnerError }) => {
          if (winnerError) {
            console.error("[Image] Error fetching winner's images:", winnerError);
            return;
          }

          // Priority: victory_pose_url > image_url (profile) > nothing
          const imageToUse = winner?.victory_pose_url || winner?.image_url;

          if (imageToUse) {
            // Use the pre-generated image (victory pose or profile as fallback)
            supabase
              .from("ucf_matches")
              .update({ result_image_url: imageToUse })
              .eq("id", matchId)
              .then(({ error: updateErr }) => {
                if (updateErr) {
                  console.error("[Image] Error setting result image:", updateErr);
                } else {
                  const imageType = winner?.victory_pose_url ? "victory pose" : "profile image";
                  console.log(`[Image] Match ${matchId} using winner's ${imageType}: ${imageToUse}`);
                }
              });
          } else {
            // No images at all - this shouldn't happen for properly registered fighters
            console.warn(`[Image] Winner ${matchWinner} has no images, match ${matchId} will have no result image`);
            // NOTE: We do NOT generate images here anymore to save costs
            // Victory poses should be generated at registration time
          }
        });
    } else {
      console.log(`[Image] Match ${matchId} already has result image, skipping`);
    }
  }

  // Update the match (with guard to prevent race conditions from concurrent cron runs)
  const { data: updatedRows, error: updateError } = await supabase
    .from("ucf_matches")
    .update(matchUpdateData)
    .eq("id", matchId)
    .eq("state", "REVEAL_PHASE")
    .eq("current_turn", match.current_turn)
    .select();

  if (updateError) {
    console.error("Error updating match:", updateError);
    return { success: false, error: updateError.message };
  }

  if (!updatedRows || updatedRows.length === 0) {
    console.log(`[Turn Resolution] Match ${matchId} already processed by another handler`);
    return { success: false, error: "Match already processed by another handler" };
  }

  console.log(`[Turn Resolution] Match ${matchId}: Turn ${match.current_turn} resolved. ${moveA} vs ${moveB} = ${result}`);

  return {
    success: true,
    turnEntry,
    agentA,
    agentB,
    newRound,
    newTurn,
    newState,
    roundWinner,
    matchWinner,
  };
}
