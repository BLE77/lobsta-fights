import { NextResponse } from "next/server";
import {
  loadActiveRumbles,
  loadQueueState,
  getIchorShowerState,
  getStats,
  loadBetsForRumble,
} from "~~/lib/rumble-persistence";

export const dynamic = "force-dynamic";

/**
 * GET /api/rumble/status
 *
 * Returns current state of all 3 Rumble slots + queue + stats.
 * Reads directly from Supabase (source of truth) rather than in-memory
 * orchestrator state, since serverless routes don't share memory.
 */
export async function GET() {
  try {
    // Load active rumbles from Supabase
    const activeRumbles = await loadActiveRumbles();
    const queueEntries = await loadQueueState();
    const showerState = await getIchorShowerState();
    const stats = await getStats();

    // Build 3-slot view (slot 0, 1, 2)
    const slotData = [];
    for (let i = 0; i < 3; i++) {
      const rumble = activeRumbles.find((r) => r.slot_index === i);
      if (rumble) {
        const fighters = rumble.fighters as Array<{ id: string; name: string }>;
        // Load bets for odds calculation
        const bets = await loadBetsForRumble(rumble.id);
        const totalPool = bets.reduce((sum, b) => sum + Number(b.net_amount), 0);

        const odds = fighters.map((f) => {
          const fighterPool = bets
            .filter((b) => b.fighter_id === f.id)
            .reduce((sum, b) => sum + Number(b.net_amount), 0);
          return {
            fighter_id: f.id,
            fighter_name: f.name,
            pool: fighterPool,
            odds: totalPool > 0 && fighterPool > 0 ? totalPool / fighterPool : 0,
            percentage: totalPool > 0 ? (fighterPool / totalPool) * 100 : 0,
          };
        });

        slotData.push({
          slot_index: i,
          rumble_id: rumble.id,
          state: rumble.status,
          fighters: fighters.map((f) => f.id),
          fighter_count: fighters.length,
          turn_count: 0,
          remaining_fighters: fighters.length,
          betting_deadline: null,
          odds,
          combat: null,
        });
      } else {
        slotData.push({
          slot_index: i,
          rumble_id: null,
          state: "idle",
          fighters: [],
          fighter_count: 0,
          turn_count: 0,
          remaining_fighters: 0,
          betting_deadline: null,
          odds: [],
          combat: null,
        });
      }
    }

    return NextResponse.json({
      slots: slotData,
      queue_length: queueEntries.length,
      ichor_shower_pool: showerState?.pool_amount ?? 0,
      total_rumbles_completed: stats?.total_rumbles ?? 0,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
