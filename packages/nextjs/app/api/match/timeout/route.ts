// @ts-nocheck
import { NextResponse } from "next/server";
import crypto from "crypto";
import { supabase, freshSupabase } from "../../../../lib/supabase";
import { MoveType } from "../../../../lib/types";
import { VALID_MOVES, generateSalt, createMoveHash } from "../../../../lib/combat";
import { isAuthorizedInternalRequest } from "../../../../lib/request-auth";

export const dynamic = "force-dynamic";

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
 * Get a cryptographically-random move for a timed-out fighter.
 * Uses crypto.getRandomValues for fairness.
 */
function getRandomMove(): MoveType {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return MOVES_FOR_RANDOM[arr[0] % MOVES_FOR_RANDOM.length];
}

/**
 * POST /api/match/timeout
 * Process timed-out matches and assign random moves
 * Auth: internal key (x-internal-key/x-cron-secret or Bearer CRON_SECRET)
 */
export async function POST(request: Request) {
  try {
    if (!isAuthorizedInternalRequest(request.headers)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

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
    return NextResponse.json({ error: "Timeout processing error" }, { status: 500 });
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

  const { data: updated, error: updateError } = await freshSupabase()
    .from("ucf_matches")
    .update(updateData)
    .eq("id", match.id)
    .select();

  if (updateError) {
    console.error(`[Timeout] COMMIT update failed for match ${match.id}:`, updateError);
    throw new Error(`Failed to update match: ${updateError.message}`);
  }

  if (!updated || updated.length === 0) {
    console.error(`[Timeout] COMMIT update returned no rows for match ${match.id}`);
    throw new Error(`Update returned no rows - match may have been modified concurrently`);
  }

  console.log(`[Timeout] Match ${match.id}: commit timeout handled, transitioned to REVEAL_PHASE`);

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
  const { data: updated, error: updateError } = await freshSupabase()
    .from("ucf_matches")
    .update(updateData)
    .eq("id", match.id)
    .select();

  if (updateError) {
    console.error(`[Timeout] REVEAL update failed for match ${match.id}:`, updateError);
    throw new Error(`Failed to update match moves: ${updateError.message}`);
  }

  if (!updated || updated.length === 0) {
    console.error(`[Timeout] REVEAL update returned no rows for match ${match.id}`);
    throw new Error(`Update returned no rows - match may have been modified concurrently`);
  }

  console.log(`[Timeout] Match ${match.id}: reveal timeout handled, moves set: move_a=${updated[0].move_a}, move_b=${updated[0].move_b}`);

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

  // ATOMIC: Only update if match hasn't been processed yet
  const { data: updated, error: updateErr } = await freshSupabase()
    .from("ucf_matches")
    .update({
      state: "FINISHED",
      winner_id: winnerId,
      finished_at: new Date().toISOString(),
      forfeit_reason: reason,
    })
    .eq("id", match.id)
    .is("winner_id", null)
    .is("points_transferred", false)
    .select();

  // If no rows updated, match was already processed
  if (!updated || updated.length === 0) {
    console.log(`[Timeout] Match ${match.id} already processed, skipping forfeit`);
    return {
      match_id: match.id,
      action: "skipped",
      reason: "already_processed",
    };
  }

  // Call the complete_ucf_match function to handle points transfer
  const { data: completeResult } = await freshSupabase().rpc("complete_ucf_match", {
    p_match_id: match.id,
    p_winner_id: winnerId,
  });

  if (completeResult?.already_processed) {
    console.log(`[Timeout] Match ${match.id} points already transferred`);
  }

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
 * Uses the shared resolveTurn function which has proper idempotency checks
 */
async function triggerCombatResolution(matchId: string): Promise<boolean> {
  try {
    // Use the shared, idempotent turn resolution function
    const { resolveTurn } = await import("../../../../lib/turn-resolution");

    const result = await resolveTurn(matchId);

    if (result.success) {
      console.log(`[Timeout] Combat resolved for match ${matchId} via shared resolveTurn`);
      return true;
    } else {
      // Not an error - match may have already been processed
      console.log(`[Timeout] resolveTurn for ${matchId}: ${result.error}`);
      return false;
    }
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
export async function GET(request: Request) {
  if (!isAuthorizedInternalRequest(request.headers)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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
