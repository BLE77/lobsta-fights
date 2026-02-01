import { NextResponse } from "next/server";
import crypto from "crypto";
import { supabase } from "../../../../lib/supabase";
import { MoveType } from "../../../../lib/types";
import { VALID_MOVES, generateSalt, createMoveHash } from "../../../../lib/combat";

/**
 * Anti-Grief Timeout Handler
 *
 * This endpoint handles timeouts gracefully:
 * - Assigns random moves to fighters who miss deadlines (instead of instant forfeit)
 * - Tracks consecutive missed turns per fighter
 * - Only forfeits after MAX_MISSED_TURNS consecutive misses
 * - Gives bots a chance to reconnect
 *
 * Can be triggered by:
 * - Vercel Cron (every 15 seconds)
 * - External cron service
 * - Manual call
 */

// Configuration
const MAX_MISSED_TURNS = 3; // Forfeit after 3 consecutive missed turns
const GRACE_PERIOD_MS = 5000; // 5 second grace period after deadline
const MOVES_FOR_RANDOM: MoveType[] = [
  "HIGH_STRIKE", "MID_STRIKE", "LOW_STRIKE",
  "GUARD_HIGH", "GUARD_MID", "GUARD_LOW",
  "DODGE"
]; // Exclude SPECIAL and CATCH from random moves (they're more situational)

/**
 * Get a random move for a timed-out fighter
 */
function getRandomMove(): MoveType {
  return MOVES_FOR_RANDOM[Math.floor(Math.random() * MOVES_FOR_RANDOM.length)];
}

/**
 * POST /api/match/timeout
 * Process timed-out matches and assign random moves
 */
export async function POST(request: Request) {
  try {
    const now = new Date();
    const graceDeadline = new Date(now.getTime() - GRACE_PERIOD_MS);

    // Find matches in COMMIT_PHASE past their deadline
    const { data: commitTimeouts, error: commitError } = await supabase
      .from("ucf_matches")
      .select("*")
      .eq("state", "COMMIT_PHASE")
      .lt("commit_deadline", graceDeadline.toISOString())
      .is("winner_id", null);

    if (commitError) {
      console.error("[Timeout] Error fetching commit timeouts:", commitError);
    }

    // Find matches in REVEAL_PHASE past their deadline
    const { data: revealTimeouts, error: revealError } = await supabase
      .from("ucf_matches")
      .select("*")
      .eq("state", "REVEAL_PHASE")
      .lt("reveal_deadline", graceDeadline.toISOString())
      .is("winner_id", null);

    if (revealError) {
      console.error("[Timeout] Error fetching reveal timeouts:", revealError);
    }

    const results = {
      processed: 0,
      random_moves_assigned: 0,
      forfeits: 0,
      errors: 0,
      details: [] as any[],
    };

    // Process commit phase timeouts
    for (const match of commitTimeouts || []) {
      try {
        const result = await handleCommitTimeout(match);
        results.processed++;
        results.details.push(result);

        if (result.action === "random_move") {
          results.random_moves_assigned++;
        } else if (result.action === "forfeit") {
          results.forfeits++;
        }
      } catch (err: any) {
        console.error(`[Timeout] Error processing match ${match.id}:`, err);
        results.errors++;
        results.details.push({ match_id: match.id, error: err.message });
      }
    }

    // Process reveal phase timeouts
    for (const match of revealTimeouts || []) {
      try {
        const result = await handleRevealTimeout(match);
        results.processed++;
        results.details.push(result);

        if (result.action === "random_reveal") {
          results.random_moves_assigned++;
        } else if (result.action === "forfeit") {
          results.forfeits++;
        }
      } catch (err: any) {
        console.error(`[Timeout] Error processing match ${match.id}:`, err);
        results.errors++;
        results.details.push({ match_id: match.id, error: err.message });
      }
    }

    return NextResponse.json({
      success: true,
      timestamp: now.toISOString(),
      ...results,
    });

  } catch (error: any) {
    console.error("[Timeout] Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * Handle a match where commit deadline has passed
 */
async function handleCommitTimeout(match: any): Promise<any> {
  const aCommitted = !!match.commit_a;
  const bCommitted = !!match.commit_b;

  // Get current missed turns (stored in match metadata or agent state)
  let missedTurnsA = match.missed_turns_a || 0;
  let missedTurnsB = match.missed_turns_b || 0;

  const updateData: Record<string, any> = {};
  const actions: string[] = [];

  // Check who hasn't committed
  if (!aCommitted) {
    missedTurnsA++;

    if (missedTurnsA >= MAX_MISSED_TURNS) {
      // Fighter A forfeits - too many missed turns
      return await forfeitMatch(match, match.fighter_b_id, match.fighter_a_id,
        `Fighter A forfeited after ${MAX_MISSED_TURNS} consecutive missed turns`);
    }

    // Assign random move to Fighter A
    const randomMove = getRandomMove();
    const randomSalt = generateSalt();
    const moveHash = createMoveHash(randomMove, randomSalt);

    updateData.commit_a = moveHash;
    updateData.auto_move_a = randomMove; // Store the actual move for reveal
    updateData.auto_salt_a = randomSalt;
    updateData.missed_turns_a = missedTurnsA;

    actions.push(`Fighter A: random move assigned (${randomMove}), missed ${missedTurnsA}/${MAX_MISSED_TURNS}`);
    console.log(`[Timeout] Match ${match.id}: Fighter A assigned random move ${randomMove} (miss ${missedTurnsA}/${MAX_MISSED_TURNS})`);
  } else {
    // Fighter A committed in time - reset their missed counter
    if (missedTurnsA > 0) {
      updateData.missed_turns_a = 0;
    }
  }

  if (!bCommitted) {
    missedTurnsB++;

    if (missedTurnsB >= MAX_MISSED_TURNS) {
      // Fighter B forfeits - too many missed turns
      return await forfeitMatch(match, match.fighter_a_id, match.fighter_b_id,
        `Fighter B forfeited after ${MAX_MISSED_TURNS} consecutive missed turns`);
    }

    // Assign random move to Fighter B
    const randomMove = getRandomMove();
    const randomSalt = generateSalt();
    const moveHash = createMoveHash(randomMove, randomSalt);

    updateData.commit_b = moveHash;
    updateData.auto_move_b = randomMove;
    updateData.auto_salt_b = randomSalt;
    updateData.missed_turns_b = missedTurnsB;

    actions.push(`Fighter B: random move assigned (${randomMove}), missed ${missedTurnsB}/${MAX_MISSED_TURNS}`);
    console.log(`[Timeout] Match ${match.id}: Fighter B assigned random move ${randomMove} (miss ${missedTurnsB}/${MAX_MISSED_TURNS})`);
  } else {
    // Fighter B committed in time - reset their missed counter
    if (missedTurnsB > 0) {
      updateData.missed_turns_b = 0;
    }
  }

  // Both have now committed (either manually or auto) - transition to reveal phase
  updateData.state = "REVEAL_PHASE";
  updateData.reveal_deadline = new Date(Date.now() + 60000).toISOString(); // 60 seconds (1 min)

  await supabase
    .from("ucf_matches")
    .update(updateData)
    .eq("id", match.id);

  return {
    match_id: match.id,
    action: "random_move",
    phase: "commit",
    actions,
    new_state: "REVEAL_PHASE",
  };
}

/**
 * Handle a match where reveal deadline has passed
 */
async function handleRevealTimeout(match: any): Promise<any> {
  const aRevealed = !!match.move_a;
  const bRevealed = !!match.move_b;

  const updateData: Record<string, any> = {};
  const actions: string[] = [];

  // Auto-reveal for fighters who haven't revealed
  // Use their committed move (either manual or auto-assigned)
  if (!aRevealed) {
    // Check if this was an auto-committed move
    if (match.auto_move_a && match.auto_salt_a) {
      updateData.move_a = match.auto_move_a;
      updateData.salt_a = match.auto_salt_a;
      actions.push(`Fighter A: auto-revealed ${match.auto_move_a}`);
    } else {
      // They committed manually but didn't reveal - this is worse
      // Increment missed turns and potentially forfeit
      let missedTurnsA = (match.missed_turns_a || 0) + 1;

      if (missedTurnsA >= MAX_MISSED_TURNS) {
        return await forfeitMatch(match, match.fighter_b_id, match.fighter_a_id,
          `Fighter A forfeited - failed to reveal after ${MAX_MISSED_TURNS} missed turns`);
      }

      // Assign a random reveal (they lose their committed move advantage)
      const randomMove = getRandomMove();
      const randomSalt = generateSalt();
      updateData.move_a = randomMove;
      updateData.salt_a = randomSalt;
      updateData.missed_turns_a = missedTurnsA;
      actions.push(`Fighter A: forced random reveal ${randomMove} (miss ${missedTurnsA}/${MAX_MISSED_TURNS})`);
    }
  }

  if (!bRevealed) {
    if (match.auto_move_b && match.auto_salt_b) {
      updateData.move_b = match.auto_move_b;
      updateData.salt_b = match.auto_salt_b;
      actions.push(`Fighter B: auto-revealed ${match.auto_move_b}`);
    } else {
      let missedTurnsB = (match.missed_turns_b || 0) + 1;

      if (missedTurnsB >= MAX_MISSED_TURNS) {
        return await forfeitMatch(match, match.fighter_a_id, match.fighter_b_id,
          `Fighter B forfeited - failed to reveal after ${MAX_MISSED_TURNS} missed turns`);
      }

      const randomMove = getRandomMove();
      const randomSalt = generateSalt();
      updateData.move_b = randomMove;
      updateData.salt_b = randomSalt;
      updateData.missed_turns_b = missedTurnsB;
      actions.push(`Fighter B: forced random reveal ${randomMove} (miss ${missedTurnsB}/${MAX_MISSED_TURNS})`);
    }
  }

  // Now trigger combat resolution by calling the reveal endpoint internally
  // Or we can just update and let the next poll handle it
  await supabase
    .from("ucf_matches")
    .update(updateData)
    .eq("id", match.id);

  // Trigger combat resolution
  const resolveResult = await triggerCombatResolution(match.id);

  return {
    match_id: match.id,
    action: "random_reveal",
    phase: "reveal",
    actions,
    combat_resolved: resolveResult,
  };
}

/**
 * Forfeit a match - one player loses due to too many missed turns
 */
async function forfeitMatch(
  match: any,
  winnerId: string,
  loserId: string,
  reason: string
): Promise<any> {
  console.log(`[Timeout] Match ${match.id}: ${reason}`);

  // End the match
  await supabase
    .from("ucf_matches")
    .update({
      state: "FINISHED",
      winner_id: winnerId,
      finished_at: new Date().toISOString(),
      forfeit_reason: reason,
    })
    .eq("id", match.id);

  // Call the complete_ucf_match function to handle points transfer
  await supabase.rpc("complete_ucf_match", {
    p_match_id: match.id,
    p_winner_id: winnerId,
  });

  // Notify fighters
  await notifyForfeit(match, winnerId, loserId, reason);

  return {
    match_id: match.id,
    action: "forfeit",
    winner_id: winnerId,
    loser_id: loserId,
    reason,
  };
}

/**
 * Trigger combat resolution for a match where both moves are now revealed
 */
async function triggerCombatResolution(matchId: string): Promise<boolean> {
  try {
    // Fetch the updated match
    const { data: match } = await supabase
      .from("ucf_matches")
      .select("*")
      .eq("id", matchId)
      .single();

    if (!match || !match.move_a || !match.move_b) {
      return false;
    }

    // Import combat resolution
    const { resolveCombat, METER_PER_TURN, MAX_HP, ROUNDS_TO_WIN } = await import("../../../../lib/combat");

    const moveA = match.move_a as MoveType;
    const moveB = match.move_b as MoveType;

    let agentA = { ...match.agent_a_state };
    let agentB = { ...match.agent_b_state };

    // Add meter
    agentA.meter = Math.min(agentA.meter + METER_PER_TURN, 100);
    agentB.meter = Math.min(agentB.meter + METER_PER_TURN, 100);

    // Resolve combat
    const { damageToA, damageToB, result, meterUsedA, meterUsedB } = resolveCombat(
      moveA, moveB, agentA.meter, agentB.meter
    );

    // Apply damage
    agentA.hp = Math.max(0, agentA.hp - damageToA);
    agentB.hp = Math.max(0, agentB.hp - damageToB);
    agentA.meter -= meterUsedA;
    agentB.meter -= meterUsedB;

    // Create turn history entry
    const turnEntry = {
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
      auto_resolved: true, // Flag that this was auto-resolved due to timeout
    };

    const turnHistory = [...(match.turn_history || []), turnEntry];

    // Check for round/match end
    let newRound = match.current_round;
    let newTurn = match.current_turn + 1;
    let newState = "COMMIT_PHASE";
    let matchWinner = null;

    if (agentA.hp <= 0 || agentB.hp <= 0) {
      if (agentA.hp <= 0 && agentB.hp > 0) {
        agentB.rounds_won += 1;
      } else if (agentB.hp <= 0 && agentA.hp > 0) {
        agentA.rounds_won += 1;
      }

      if (agentA.rounds_won >= ROUNDS_TO_WIN) {
        matchWinner = match.fighter_a_id;
        newState = "FINISHED";
      } else if (agentB.rounds_won >= ROUNDS_TO_WIN) {
        matchWinner = match.fighter_b_id;
        newState = "FINISHED";
      } else {
        // New round
        newRound += 1;
        newTurn = 1;
        agentA.hp = MAX_HP;
        agentB.hp = MAX_HP;
        agentA.meter = 0;
        agentB.meter = 0;
      }
    }

    // Update match
    const updateData: Record<string, any> = {
      agent_a_state: agentA,
      agent_b_state: agentB,
      current_round: newRound,
      current_turn: newTurn,
      turn_history: turnHistory,
      state: newState,
      // Clear for next turn
      commit_a: null,
      commit_b: null,
      move_a: null,
      move_b: null,
      salt_a: null,
      salt_b: null,
      auto_move_a: null,
      auto_move_b: null,
      auto_salt_a: null,
      auto_salt_b: null,
    };

    if (newState === "COMMIT_PHASE") {
      updateData.commit_deadline = new Date(Date.now() + 60000).toISOString(); // 60 seconds (1 min)
    }

    if (matchWinner) {
      updateData.winner_id = matchWinner;
      updateData.finished_at = new Date().toISOString();

      // Complete the match
      await supabase.rpc("complete_ucf_match", {
        p_match_id: matchId,
        p_winner_id: matchWinner,
      });
    }

    await supabase
      .from("ucf_matches")
      .update(updateData)
      .eq("id", matchId);

    console.log(`[Timeout] Combat resolved for match ${matchId}: ${result}`);
    return true;

  } catch (err) {
    console.error(`[Timeout] Error resolving combat for ${matchId}:`, err);
    return false;
  }
}

/**
 * Notify fighters about a forfeit
 */
async function notifyForfeit(
  match: any,
  winnerId: string,
  loserId: string,
  reason: string
): Promise<void> {
  try {
    const { data: fighters } = await supabase
      .from("ucf_fighters")
      .select("id, webhook_url")
      .in("id", [winnerId, loserId]);

    if (!fighters) return;

    for (const fighter of fighters) {
      if (!fighter.webhook_url) continue;

      const isWinner = fighter.id === winnerId;
      const payload = {
        event: "match_forfeit",
        match_id: match.id,
        you_won: isWinner,
        reason: isWinner
          ? "Opponent forfeited due to timeout"
          : reason,
        points_wager: match.points_wager,
      };

      fetch(fighter.webhook_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }).catch(() => {});
    }
  } catch (err) {
    console.error("[Timeout] Error notifying forfeit:", err);
  }
}

/**
 * GET /api/match/timeout
 * Get timeout status and configuration
 */
export async function GET() {
  const { data: pendingTimeouts } = await supabase
    .from("ucf_matches")
    .select("id, state, commit_deadline, reveal_deadline, missed_turns_a, missed_turns_b")
    .or("state.eq.COMMIT_PHASE,state.eq.REVEAL_PHASE")
    .is("winner_id", null);

  const now = new Date();

  return NextResponse.json({
    config: {
      max_missed_turns: MAX_MISSED_TURNS,
      grace_period_ms: GRACE_PERIOD_MS,
      random_moves_pool: MOVES_FOR_RANDOM,
    },
    pending_matches: pendingTimeouts?.length || 0,
    matches: pendingTimeouts?.map(m => ({
      id: m.id,
      state: m.state,
      deadline: m.state === "COMMIT_PHASE" ? m.commit_deadline : m.reveal_deadline,
      past_deadline: new Date(m.state === "COMMIT_PHASE" ? m.commit_deadline : m.reveal_deadline) < now,
      missed_turns_a: m.missed_turns_a || 0,
      missed_turns_b: m.missed_turns_b || 0,
    })),
  });
}
