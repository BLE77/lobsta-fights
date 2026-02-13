// =============================================================================
// Rumble State Recovery — Restores orchestrator in-memory state from Supabase
//
// Called once on the first tick after a cold start (Vercel serverless functions
// lose all in-memory state between invocations). Reads active rumbles, queue
// entries, and bets from Supabase, then reconstructs the orchestrator state
// so it can resume mid-rumble without data loss.
//
// CRITICAL: Betting rumbles are RESTORED (not nuked). The slot is set back to
// betting state with the original fighters and a fresh deadline. Any bets
// already placed are reloaded from Supabase into the in-memory betting pool.
//
// Uses a FRESH Supabase service-role client per call to bypass RLS and avoid
// Next.js fetch caching.
// =============================================================================

import * as persist from "./rumble-persistence";
import { getOrchestrator } from "./rumble-orchestrator";
import { getQueueManager } from "./queue-manager";

// ---------------------------------------------------------------------------
// Recovery flag — uses globalThis to survive Next.js HMR reloads in dev mode.
// Without globalThis, each route compilation gets its own `recovered` flag,
// causing recovery to run multiple times and nuke active betting slots.
// ---------------------------------------------------------------------------

const g = globalThis as unknown as { __rumbleRecovered?: boolean };

export function hasRecovered(): boolean {
  return g.__rumbleRecovered === true;
}

export function resetRecoveryFlag(): void {
  g.__rumbleRecovered = false;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Fresh betting time given to recovered rumbles (matches queue-manager)
const RECOVERED_BETTING_DURATION_MS = 60 * 1000;

// Max age of a betting rumble before we consider it stale and discard it.
// If a rumble was created > 5 minutes ago and is still in "betting", something
// went wrong — mark it complete and re-queue fighters.
const MAX_BETTING_AGE_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Main recovery function
// ---------------------------------------------------------------------------

export interface RecoveryResult {
  activeRumbles: number;
  restoredBetting: number;
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
 *     - For rumbles in "betting": RESTORE the slot state with fighters,
 *       a fresh betting deadline, and any existing bets from Supabase.
 *     - For rumbles stuck in "combat": we cannot reliably reconstruct
 *       mid-combat turn state (fighter HP, meter, elimination order).
 *       Mark these as complete with the current standings to avoid
 *       stuck matches. The fighters will be freed back to queue.
 *     - For rumbles in "payout": mark as complete.
 *  3. Mark recovery as done so subsequent ticks skip this step.
 */
export async function recoverOrchestratorState(): Promise<RecoveryResult> {
  if (g.__rumbleRecovered) {
    return { activeRumbles: 0, restoredBetting: 0, queueFighters: 0, staleMidCombat: 0, errors: [] };
  }

  const result: RecoveryResult = {
    activeRumbles: 0,
    restoredBetting: 0,
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

    const orchestrator = getOrchestrator();

    for (const rumble of activeRumbles) {
      try {
        const fighters = rumble.fighters as Array<{ id: string; name: string }>;

        if (rumble.status === "combat") {
          // Mid-combat rumbles cannot be reliably resumed because we lose
          // in-memory fighter HP/meter/turn state on cold start.
          // Mark them as complete so fighters are freed.
          console.log(
            `[StateRecovery] Rumble ${rumble.id} was mid-combat — marking complete (stale)`
          );

          const winnerId = fighters.length > 0 ? fighters[0].id : "unknown";
          const placements = fighters.map((f, i) => ({ id: f.id, placement: i + 1 }));
          await persist.completeRumbleRecord(rumble.id, winnerId, placements, [], 0);

          for (const f of fighters) {
            await persist.removeQueueFighter(f.id);
          }

          result.staleMidCombat++;

        } else if (rumble.status === "betting") {
          // ---- RESTORE betting rumble in-memory instead of nuking it ----
          const createdAt = new Date(rumble.created_at).getTime();
          const age = Date.now() - createdAt;

          if (age > MAX_BETTING_AGE_MS) {
            // Too old — something went wrong. Mark stale and re-queue.
            console.log(
              `[StateRecovery] Rumble ${rumble.id} betting is ${Math.round(age / 1000)}s old (stale) — marking complete`
            );
            await persist.updateRumbleStatus(rumble.id, "complete");
            for (const f of fighters) {
              try {
                qm.addToQueue(f.id, false);
                await persist.saveQueueFighter(f.id, "waiting", false);
                result.queueFighters++;
              } catch { /* already in queue */ }
            }
            continue;
          }

          // Restore this betting rumble into the correct slot
          const slotIndex = rumble.slot_index;
          const fighterIds = fighters.map((f) => f.id);
          const freshDeadline = new Date(Date.now() + RECOVERED_BETTING_DURATION_MS);

          // Restore the slot in the queue manager
          qm.restoreSlot(slotIndex, rumble.id, fighterIds, "betting", freshDeadline);

          // Load any existing bets from Supabase and restore the betting pool
          const existingBets = await persist.loadBetsForRumble(rumble.id);
          orchestrator.restoreBettingPool(slotIndex, rumble.id, existingBets);

          console.log(
            `[StateRecovery] RESTORED betting rumble ${rumble.id} in slot ${slotIndex} ` +
              `with ${fighterIds.length} fighters, ${existingBets.length} bets, ` +
              `fresh deadline ${freshDeadline.toISOString()}`
          );
          result.restoredBetting++;

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
      `[StateRecovery] Recovery complete: ${result.activeRumbles} active rumbles, ` +
        `${result.restoredBetting} betting restored, ` +
        `${result.staleMidCombat} stale mid-combat, ${result.queueFighters} queue fighters`
    );
  } catch (err) {
    result.errors.push(`Top-level recovery error: ${String(err)}`);
    console.error("[StateRecovery] Recovery failed:", err);
  }

  g.__rumbleRecovered = true;
  return result;
}
