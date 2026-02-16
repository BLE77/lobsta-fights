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

// Max age of a betting rumble before we consider it stale and discard it.
// If a rumble was created > 5 minutes ago and is still in "betting", something
// went wrong — mark it complete and re-queue fighters.
const MAX_BETTING_AGE_MS = 5 * 60 * 1000;
const MAX_COMBAT_STUCK_AGE_MS = (() => {
  const raw = Number(process.env.RUMBLE_MAX_COMBAT_STUCK_AGE_MS ?? "");
  if (!Number.isFinite(raw)) return 5 * 60 * 1000;
  return Math.max(60 * 1000, Math.min(60 * 60 * 1000, Math.floor(raw)));
})();

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
 *     - For rumbles stuck in "combat": DO NOT synthesize fake results in
 *       production. Leaving these untouched avoids off-chain/on-chain payout
 *       drift that can break claim flows. A separate on-chain reconciliation
 *       pass handles completed rumbles whose report_result was missed.
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
    const newestCreatedAtBySlot = new Map<number, number>();
    for (const rumble of activeRumbles) {
      const slot = Number(rumble.slot_index);
      if (!Number.isInteger(slot)) continue;
      const createdAtMs = new Date(rumble.created_at).getTime();
      const current = newestCreatedAtBySlot.get(slot) ?? 0;
      if (createdAtMs > current) newestCreatedAtBySlot.set(slot, createdAtMs);
    }

    const orchestrator = getOrchestrator();

    for (const rumble of activeRumbles) {
      try {
        const fighters = rumble.fighters as Array<{ id: string; name: string }>;

        if (rumble.status === "combat") {
          const createdAtMs = new Date(rumble.created_at).getTime();
          const ageMs = Date.now() - createdAtMs;
          const newestForSlot = newestCreatedAtBySlot.get(Number(rumble.slot_index)) ?? createdAtMs;
          const supersededByNewerSlotRumble = createdAtMs < newestForSlot;
          const staleCombat = ageMs > MAX_COMBAT_STUCK_AGE_MS;

          // Safety valve: if this combat rumble is stale/superseded and has no bets,
          // we can close it without payout risk. This prevents old "combat" rows
          // from piling up and making the system look stuck.
          if (supersededByNewerSlotRumble || staleCombat) {
            const betCount = await persist.countBetsForRumble(rumble.id);
            if (betCount === 0) {
              console.warn(
                `[StateRecovery] Closing stale combat rumble ${rumble.id} (slot=${rumble.slot_index}, age=${Math.round(ageMs / 1000)}s, superseded=${supersededByNewerSlotRumble})`,
              );
              await persist.updateRumbleStatus(rumble.id, "complete");
              for (const f of fighters) {
                await persist.removeQueueFighter(f.id);
              }
              result.staleMidCombat++;
              continue;
            }
          }

          // Never fabricate outcomes for mid-combat rounds in production:
          // doing so can create off-chain payouts with on-chain rumbles still
          // in combat state, causing claim failures.
          const unsafeFallbackEnabled =
            process.env.RUMBLE_ALLOW_UNSAFE_COMBAT_RECOVERY === "true" &&
            process.env.NODE_ENV !== "production";

          if (unsafeFallbackEnabled) {
            console.warn(
              `[StateRecovery] UNSAFE fallback enabled; marking mid-combat rumble ${rumble.id} complete`,
            );
            const winnerId = fighters.length > 0 ? fighters[0].id : "unknown";
            const placements = fighters.map((f, i) => ({ id: f.id, placement: i + 1 }));
            await persist.completeRumbleRecord(rumble.id, winnerId, placements, [], 0);
            for (const f of fighters) {
              await persist.removeQueueFighter(f.id);
            }
          } else {
            const msg =
              `[StateRecovery] Rumble ${rumble.id} is mid-combat; preserving state for reconciliation (no synthetic completion).`;
            console.warn(msg);
            result.errors.push(msg);
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
          // Restore the slot in the queue manager
          // Do not invent a local deadline during recovery. The on-chain rumble
          // close slot is the source of truth and will arm betting in the next
          // orchestrator tick once the account is confirmed.
          qm.restoreSlot(slotIndex, rumble.id, fighterIds, "betting", null);

          // Load any existing bets from Supabase and restore the betting pool
          const existingBets = await persist.loadBetsForRumble(rumble.id);
          orchestrator.restoreBettingPool(slotIndex, rumble.id, existingBets);

          console.log(
            `[StateRecovery] RESTORED betting rumble ${rumble.id} in slot ${slotIndex} ` +
              `with ${fighterIds.length} fighters, ${existingBets.length} bets, ` +
              `deadline=unarmed (waiting on on-chain close slot)`
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
