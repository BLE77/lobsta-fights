import { NextRequest, NextResponse } from "next/server";
import { supabase } from "../../../../lib/supabase";
import { resolveTurn } from "../../../../lib/turn-resolution";

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

    // 3. Process timeouts - call the existing timeout endpoint logic
    // CRITICAL: Only check for matches that aren't already processed
    const { data: timedOut } = await supabase
      .from("ucf_matches")
      .select("id, state, commit_deadline, reveal_deadline")
      .neq("state", "FINISHED")
      .is("winner_id", null)
      .is("points_transferred", false)
      .or(`commit_deadline.lt.${new Date().toISOString()},reveal_deadline.lt.${new Date().toISOString()}`);

    if (timedOut && timedOut.length > 0) {
      // Call the timeout endpoint
      const timeoutUrl = `${process.env.NEXT_PUBLIC_APP_URL || "https://clawfights.xyz"}/api/match/timeout`;
      try {
        const res = await fetch(timeoutUrl, { method: "POST" });
        const data = await res.json();
        results.timeouts_processed = data.processed || 0;
        results.processed += results.timeouts_processed;
      } catch (err: any) {
        results.errors.push(`Timeout processing: ${err.message}`);
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
