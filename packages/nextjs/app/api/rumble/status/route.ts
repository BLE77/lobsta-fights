import { NextResponse } from "next/server";
import { getOrchestrator } from "~~/lib/rumble-orchestrator";
import { getQueueManager } from "~~/lib/queue-manager";

export const dynamic = "force-dynamic";

/**
 * GET /api/rumble/status
 *
 * Returns current state of all 3 Rumble slots:
 * - Which slot is betting/combat/payout/idle
 * - Fighter lineups for each active Rumble
 * - Current betting pools and odds
 * - Queue length and estimated wait
 */
export async function GET() {
  try {
    const orchestrator = getOrchestrator();
    const qm = getQueueManager();

    const slots = orchestrator.getStatus();

    const slotData = slots.map((slot) => {
      const odds = orchestrator.getOdds(slot.slotIndex);
      const combatState = orchestrator.getCombatState(slot.slotIndex);

      return {
        slot_index: slot.slotIndex,
        rumble_id: slot.rumbleId,
        state: slot.state,
        fighters: slot.fighters,
        fighter_count: slot.fighters.length,
        turn_count: slot.turnCount,
        remaining_fighters: slot.remainingFighters,
        betting_deadline: slot.bettingDeadline?.toISOString() ?? null,
        odds,
        combat: combatState
          ? {
              fighters: combatState.fighters.map((f) => ({
                id: f.id,
                hp: f.hp,
                meter: f.meter,
                total_damage_dealt: f.totalDamageDealt,
                total_damage_taken: f.totalDamageTaken,
                eliminated_on_turn: f.eliminatedOnTurn,
              })),
              turn_count: combatState.turns.length,
            }
          : null,
      };
    });

    return NextResponse.json({
      slots: slotData,
      queue_length: qm.getQueueLength(),
      ichor_shower_pool: orchestrator.getIchorShowerPool(),
      total_rumbles_completed: orchestrator.getTotalRumblesCompleted(),
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
