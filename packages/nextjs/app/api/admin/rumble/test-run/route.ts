import { NextResponse } from "next/server";
import { isAuthorizedAdminRequest } from "~~/lib/request-auth";
import { getOrchestrator } from "~~/lib/rumble-orchestrator";
import { hasRecovered, recoverOrchestratorState } from "~~/lib/rumble-state-recovery";

export const dynamic = "force-dynamic";

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(num)));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * POST /api/admin/rumble/test-run
 *
 * Manually queues house bots and bursts ticks to start a rumble.
 * Body: { fighter_count?: number }  (default 8, min 4, max 16)
 */
export async function POST(request: Request) {
  if (!isAuthorizedAdminRequest(request.headers)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    if (!hasRecovered()) {
      await recoverOrchestratorState().catch((err) => {
        console.warn("[TestRun] state recovery failed", err);
      });
    }

    const body = await request.json().catch(() => ({}));
    const fighterCount = clampInt(body?.fighter_count, 8, 4, 16);

    const orchestrator = getOrchestrator();

    // Queue house bots manually
    const { queued, skipped } = await orchestrator.queueHouseBotsManually(fighterCount);

    if (queued.length === 0) {
      return NextResponse.json({
        success: false,
        error: "No bots could be queued. Check RUMBLE_HOUSE_BOT_IDS and that bots aren't already active.",
        skipped,
        timestamp: new Date().toISOString(),
      }, { status: 400 });
    }

    // Burst 3 ticks to advance slots and start the rumble
    for (let i = 0; i < 3; i++) {
      await orchestrator.tick();
      if (i < 2) await sleep(500);
    }

    const slots = orchestrator.getStatus().map((slot) => ({
      slotIndex: slot.slotIndex,
      state: slot.state,
      rumbleId: slot.rumbleId,
      fighters: slot.fighters.length,
      turnCount: slot.turnCount,
      remainingFighters: slot.remainingFighters,
    }));

    return NextResponse.json({
      success: true,
      queued,
      queuedCount: queued.length,
      skipped,
      slots,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[TestRun]", error);
    return NextResponse.json({ error: "Test run failed" }, { status: 500 });
  }
}
