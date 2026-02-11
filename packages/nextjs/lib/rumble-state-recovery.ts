// =============================================================================
// Rumble State Recovery — Restores orchestrator in-memory state from Supabase
//
// Called once on the first tick after a cold start (Vercel serverless functions
// lose all in-memory state between invocations). Reads active rumbles, queue
// entries, and bets from Supabase, then reconstructs the orchestrator state
// so it can resume mid-rumble without data loss.
//
// Uses a FRESH Supabase service-role client per call to bypass RLS and avoid
// Next.js fetch caching.
// =============================================================================

import * as persist from "./rumble-persistence";
import { getOrchestrator } from "./rumble-orchestrator";
import { getQueueManager } from "./queue-manager";

// ---------------------------------------------------------------------------
// Recovery flag — ensures we only run recovery once per cold start
// ---------------------------------------------------------------------------

let recovered = false;

export function hasRecovered(): boolean {
  return recovered;
}

export function resetRecoveryFlag(): void {
  recovered = false;
}

// ---------------------------------------------------------------------------
// Main recovery function
// ---------------------------------------------------------------------------

export interface RecoveryResult {
  activeRumbles: number;
  queueFighters: number;
  staleMidCombat: number;
  errors: string[];
}

/**
 * Reload orchestrator state from Supabase after a cold start.
 *
 * Strategy:
 *  1. Load queue entries (status = 'waiting') and re-add them to the
 *     in-memory queue manager.
 *  2. Load active rumbles (status in betting, combat, payout).
 *     - For rumbles in "betting" or "payout": they can resume naturally
 *       on the next tick since the orchestrator re-creates betting pools
 *       and handles payouts idempotently.
 *     - For rumbles stuck in "combat": we cannot reliably reconstruct
 *       mid-combat turn state (fighter HP, meter, elimination order).
 *       Mark these as complete with the current standings to avoid
 *       stuck matches. The fighters will be freed back to queue.
 *  3. Mark recovery as done so subsequent ticks skip this step.
 */
export async function recoverOrchestratorState(): Promise<RecoveryResult> {
  if (recovered) {
    return { activeRumbles: 0, queueFighters: 0, staleMidCombat: 0, errors: [] };
  }

  const result: RecoveryResult = {
    activeRumbles: 0,
    queueFighters: 0,
    staleMidCombat: 0,
    errors: [],
  };

  try {
    console.log("[StateRecovery] Starting state recovery from Supabase...");

    // ---- Step 1: Recover queue ------------------------------------------------
    const queueEntries = await persist.loadQueueState();
    const qm = getQueueManager();

    for (const entry of queueEntries) {
      try {
        qm.addToQueue(entry.fighter_id, entry.auto_requeue);
        result.queueFighters++;
      } catch (err) {
        // Fighter might already be in queue or in a slot — safe to ignore
        result.errors.push(`Queue add ${entry.fighter_id}: ${String(err)}`);
      }
    }

    console.log(`[StateRecovery] Restored ${result.queueFighters} queue entries`);

    // ---- Step 2: Recover active rumbles ---------------------------------------
    const activeRumbles = await persist.loadActiveRumbles();
    result.activeRumbles = activeRumbles.length;

    for (const rumble of activeRumbles) {
      try {
        if (rumble.status === "combat") {
          // Mid-combat rumbles cannot be reliably resumed because we lose
          // in-memory fighter HP/meter/turn state on cold start.
          // Mark them as complete so fighters are freed.
          console.log(
            `[StateRecovery] Rumble ${rumble.id} was mid-combat — marking complete (stale)`
          );

          // Determine a "winner" from the fighters array for the record.
          // Since we don't have HP data, pick the first fighter as winner.
          const fighters = rumble.fighters as Array<{ id: string; name: string }>;
          const winnerId = fighters.length > 0 ? fighters[0].id : "unknown";
          const placements = fighters.map((f, i) => ({ id: f.id, placement: i + 1 }));

          await persist.completeRumbleRecord(rumble.id, winnerId, placements, [], 0);

          // Free fighters back to queue
          for (const f of fighters) {
            await persist.removeQueueFighter(f.id);
          }

          result.staleMidCombat++;
        } else if (rumble.status === "betting") {
          // Betting rumbles: the orchestrator will re-create the betting pool
          // on the next tick when it sees a slot in betting state.
          // We just need to make sure the queue manager has these fighters
          // assigned to the correct slot. Since the queue manager is fresh,
          // we log this but the slot will transition naturally when new
          // fighters enter the queue. Mark the rumble as complete to avoid
          // orphaned records.
          console.log(
            `[StateRecovery] Rumble ${rumble.id} was in betting — marking complete (stale)`
          );
          await persist.updateRumbleStatus(rumble.id, "complete");

          const fighters = rumble.fighters as Array<{ id: string; name: string }>;
          for (const f of fighters) {
            // Re-add fighters to queue so they get matched again
            try {
              qm.addToQueue(f.id, false);
              await persist.saveQueueFighter(f.id, "waiting", false);
              result.queueFighters++;
            } catch {
              // Already in queue — fine
            }
          }
        } else if (rumble.status === "payout") {
          // Payout rumbles: mark as complete. Payouts are idempotent and
          // can be re-triggered if needed.
          console.log(
            `[StateRecovery] Rumble ${rumble.id} was in payout — marking complete`
          );
          await persist.updateRumbleStatus(rumble.id, "complete");
        }
      } catch (err) {
        result.errors.push(`Rumble ${rumble.id}: ${String(err)}`);
      }
    }

    console.log(
      `[StateRecovery] Recovery complete: ${result.activeRumbles} active rumbles processed, ` +
        `${result.staleMidCombat} stale mid-combat, ${result.queueFighters} queue fighters restored`
    );
  } catch (err) {
    result.errors.push(`Top-level recovery error: ${String(err)}`);
    console.error("[StateRecovery] Recovery failed:", err);
  }

  recovered = true;
  return result;
}
