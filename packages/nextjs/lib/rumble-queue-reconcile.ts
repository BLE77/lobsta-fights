/**
 * Queue Reconciliation
 *
 * Periodically syncs the Supabase ucf_rumble_queue with the in-memory
 * QueueManager. This catches fighters that joined via the API (Vercel)
 * but were never loaded into the Railway worker's in-memory queue
 * (e.g., because they joined after the worker's last cold-start recovery).
 */

import { getQueueManager } from "./queue-manager";
import { loadQueueState } from "./rumble-persistence";

/**
 * Reconcile: any fighter with status="waiting" in Supabase that is NOT
 * in the in-memory queue gets added.  Runs every reconcile interval
 * (default 60s) alongside on-chain and payout reconciliation.
 */
export async function reconcileQueueFromDb(): Promise<void> {
  const qm = getQueueManager();
  const dbEntries = await loadQueueState(); // status="waiting", ordered by joined_at

  const slots = qm.getSlots();
  const activeSet = new Set(
    slots
      .filter((s) => s.state !== "idle")
      .flatMap((s) => s.fighters),
  );
  const queuedSet = new Set(qm.getQueueEntries().map((e) => e.fighterId));

  let added = 0;
  for (const entry of dbEntries) {
    if (queuedSet.has(entry.fighter_id)) continue;
    if (activeSet.has(entry.fighter_id)) continue;

    try {
      qm.addToQueue(entry.fighter_id, entry.auto_requeue);
      added++;
    } catch {
      // Already in queue or in an active slot — safe to ignore
    }
  }

  if (added > 0) {
    console.log(`[QueueReconcile] Added ${added} missing fighter(s) to in-memory queue`);
  }
}
