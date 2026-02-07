import { NextRequest, NextResponse } from "next/server";
import { supabase } from "../../../../lib/supabase";
import { resolveTurn } from "../../../../lib/turn-resolution";
import { VALID_MOVES, generateSalt, createMoveHash } from "../../../../lib/combat";
import { MoveType } from "../../../../lib/types";

/**
 * GET /api/cron/process-matches
 *
 * Cron job to automatically process stuck matches:
 * 1. Matches where both committed but stuck in COMMIT_PHASE -> advance to reveal
 * 2. Matches in REVEAL_PHASE with both moves -> resolve turn
 * 3. Matches past deadline -> assign random moves or forfeit
 *
 * Called by Vercel Cron every 30 seconds
 */

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  // Verify cron secret (optional security)
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    // Allow without auth for testing, but log it
    console.log("[Cron] No auth header, proceeding anyway");
  }

  const results = {
    processed: 0,
    advanced_to_reveal: 0,
    turns_resolved: 0,
    timeouts_processed: 0,
    errors: [] as string[],
  };

  try {
    // 1. Find matches stuck in COMMIT_PHASE where both have committed
    // CRITICAL: Filter for winner_id IS NULL to avoid processing already-finished matches
    const { data: stuckCommits } = await supabase
      .from("ucf_matches")
      .select("id, pending_move_a, pending_move_b, pending_salt_a, pending_salt_b")
      .eq("state", "COMMIT_PHASE")
      .is("winner_id", null)
      .is("points_transferred", false)
      .not("commit_a", "is", null)
      .not("commit_b", "is", null);

    for (const match of stuckCommits || []) {
      try {
        // Advance to reveal phase and set moves
        // ATOMIC: Only update if still in COMMIT_PHASE with no winner
        const { data: updated, error: updateErr } = await supabase
          .from("ucf_matches")
          .update({
            state: "REVEAL_PHASE",
            move_a: match.pending_move_a,
            move_b: match.pending_move_b,
            salt_a: match.pending_salt_a,
            salt_b: match.pending_salt_b,
            reveal_deadline: new Date(Date.now() + 60000).toISOString(),
          })
          .eq("id", match.id)
          .eq("state", "COMMIT_PHASE")
          .is("winner_id", null)
          .select();

        if (updated && updated.length > 0) {
          results.advanced_to_reveal++;
          results.processed++;
          console.log(`[Cron] Advanced match ${match.id} to REVEAL_PHASE`);
        } else {
          console.log(`[Cron] Match ${match.id} already processed by another handler`);
        }
      } catch (err: any) {
        results.errors.push(`Advance ${match.id}: ${err.message}`);
      }
    }

    // 2. Find matches in REVEAL_PHASE where both moves are set -> resolve
    // CRITICAL: Filter for winner_id IS NULL and points_transferred = false
    const { data: readyToResolve } = await supabase
      .from("ucf_matches")
      .select("id")
      .eq("state", "REVEAL_PHASE")
      .is("winner_id", null)
      .is("points_transferred", false)
      .not("move_a", "is", null)
      .not("move_b", "is", null);

    for (const match of readyToResolve || []) {
      try {
        const result = await resolveTurn(match.id);
        if (result.success) {
          results.turns_resolved++;
          results.processed++;
          console.log(`[Cron] Resolved turn for match ${match.id}`);
        } else {
          results.errors.push(`Resolve ${match.id}: ${result.error}`);
        }
      } catch (err: any) {
        results.errors.push(`Resolve ${match.id}: ${err.message}`);
      }
    }

    // 3. Process timeouts directly (no HTTP call needed)
    const GRACE_PERIOD_MS = 5000;
    const MAX_MISSED_TURNS = 3;
    const RANDOM_MOVES: MoveType[] = [
      "HIGH_STRIKE", "MID_STRIKE", "LOW_STRIKE",
      "GUARD_HIGH", "GUARD_MID", "GUARD_LOW",
      "DODGE"
    ];
    const graceDeadline = new Date(Date.now() - GRACE_PERIOD_MS).toISOString();

    // 3a. Commit phase timeouts
    const { data: commitTimeouts } = await supabase
      .from("ucf_matches")
      .select("*")
      .eq("state", "COMMIT_PHASE")
      .lt("commit_deadline", graceDeadline)
      .is("winner_id", null);

    for (const match of commitTimeouts || []) {
      try {
        const aCommitted = !!match.commit_a;
        const bCommitted = !!match.commit_b;
        let missedA = match.missed_turns_a || 0;
        let missedB = match.missed_turns_b || 0;
        const updateData: Record<string, any> = {};

        // Only count as "missed" if ONE fighter committed and the other didn't
        // If BOTH miss, it's auto-play mode — assign random moves, no penalty
        const bothMissed = !aCommitted && !bCommitted;

        if (!aCommitted) {
          if (!bothMissed) missedA++;
          if (missedA >= MAX_MISSED_TURNS) {
            await supabase.from("ucf_matches").update({
              state: "FINISHED", winner_id: match.fighter_b_id,
              finished_at: new Date().toISOString(), forfeit_reason: `Fighter A missed ${MAX_MISSED_TURNS} turns`,
            }).eq("id", match.id).is("winner_id", null);
            await supabase.rpc("complete_ucf_match", { p_match_id: match.id, p_winner_id: match.fighter_b_id });
            results.timeouts_processed++;
            results.processed++;
            continue;
          }
          const move = RANDOM_MOVES[Math.floor(Math.random() * RANDOM_MOVES.length)];
          const salt = generateSalt();
          updateData.commit_a = createMoveHash(move, salt);
          updateData.auto_move_a = move;
          updateData.auto_salt_a = salt;
          updateData.missed_turns_a = missedA;
        } else if (missedA > 0) {
          updateData.missed_turns_a = 0;
        }

        if (!bCommitted) {
          if (!bothMissed) missedB++;
          if (missedB >= MAX_MISSED_TURNS) {
            await supabase.from("ucf_matches").update({
              state: "FINISHED", winner_id: match.fighter_a_id,
              finished_at: new Date().toISOString(), forfeit_reason: `Fighter B missed ${MAX_MISSED_TURNS} turns`,
            }).eq("id", match.id).is("winner_id", null);
            await supabase.rpc("complete_ucf_match", { p_match_id: match.id, p_winner_id: match.fighter_a_id });
            results.timeouts_processed++;
            results.processed++;
            continue;
          }
          const move = RANDOM_MOVES[Math.floor(Math.random() * RANDOM_MOVES.length)];
          const salt = generateSalt();
          updateData.commit_b = createMoveHash(move, salt);
          updateData.auto_move_b = move;
          updateData.auto_salt_b = salt;
          updateData.missed_turns_b = missedB;
        } else if (missedB > 0) {
          updateData.missed_turns_b = 0;
        }

        // Advance to reveal phase (with guard to prevent race conditions)
        updateData.state = "REVEAL_PHASE";
        updateData.reveal_deadline = new Date(Date.now() + 60000).toISOString();

        const { data: updated3a } = await supabase.from("ucf_matches")
          .update(updateData)
          .eq("id", match.id)
          .eq("state", "COMMIT_PHASE")
          .eq("current_turn", match.current_turn)
          .select();
        if (updated3a && updated3a.length > 0) {
          results.timeouts_processed++;
          results.processed++;
          console.log(`[Cron] Commit timeout: match ${match.id} advanced to REVEAL_PHASE`);
        } else {
          console.log(`[Cron] Commit timeout: match ${match.id} already handled by another run`);
        }
      } catch (err: any) {
        results.errors.push(`Commit timeout ${match.id}: ${err.message}`);
      }
    }

    // 3b. Reveal phase timeouts
    const { data: revealTimeouts } = await supabase
      .from("ucf_matches")
      .select("*")
      .eq("state", "REVEAL_PHASE")
      .lt("reveal_deadline", graceDeadline)
      .is("winner_id", null);

    for (const match of revealTimeouts || []) {
      try {
        const updateData: Record<string, any> = {};

        if (!match.move_a) {
          if (match.auto_move_a) {
            updateData.move_a = match.auto_move_a;
            updateData.salt_a = match.auto_salt_a;
          } else {
            const move = RANDOM_MOVES[Math.floor(Math.random() * RANDOM_MOVES.length)];
            updateData.move_a = move;
            updateData.salt_a = generateSalt();
          }
        }
        if (!match.move_b) {
          if (match.auto_move_b) {
            updateData.move_b = match.auto_move_b;
            updateData.salt_b = match.auto_salt_b;
          } else {
            const move = RANDOM_MOVES[Math.floor(Math.random() * RANDOM_MOVES.length)];
            updateData.move_b = move;
            updateData.salt_b = generateSalt();
          }
        }

        if (Object.keys(updateData).length > 0) {
          const { data: updated3b } = await supabase.from("ucf_matches")
            .update(updateData)
            .eq("id", match.id)
            .eq("state", "REVEAL_PHASE")
            .eq("current_turn", match.current_turn)
            .select();
          if (!updated3b || updated3b.length === 0) {
            console.log(`[Cron] Reveal timeout: match ${match.id} already handled`);
            continue;
          }
        }

        // Resolve the turn
        const result = await resolveTurn(match.id);
        if (result.success) {
          results.timeouts_processed++;
          results.processed++;
          console.log(`[Cron] Reveal timeout: match ${match.id} resolved - R${result.newRound}T${result.newTurn}`);
        } else {
          results.errors.push(`Reveal resolve ${match.id}: ${result.error}`);
          console.log(`[Cron] Reveal timeout: match ${match.id} resolve FAILED: ${result.error}`);
        }
      } catch (err: any) {
        results.errors.push(`Reveal timeout ${match.id}: ${err.message}`);
      }
    }

    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
      ...results,
    });
  } catch (error: any) {
    console.error("[Cron] Error:", error);
    return NextResponse.json(
      { error: error.message, ...results },
      { status: 500 }
    );
  }
}
