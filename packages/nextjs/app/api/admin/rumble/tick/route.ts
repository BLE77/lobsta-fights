import { NextResponse } from "next/server";
import { isAuthorizedAdminRequest } from "~~/lib/request-auth";
import { getOrchestrator } from "~~/lib/rumble-orchestrator";

export const dynamic = "force-dynamic";

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(num)));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function POST(request: Request) {
  if (!isAuthorizedAdminRequest(request.headers)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json().catch(() => ({}));
    const ticks = clampInt(body?.ticks, 1, 1, 20);
    const intervalMs = clampInt(body?.interval_ms, 0, 0, 2_000);

    const orchestrator = getOrchestrator();
    for (let i = 0; i < ticks; i++) {
      await orchestrator.tick();
      if (intervalMs > 0 && i < ticks - 1) {
        await sleep(intervalMs);
      }
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
      ticksRun: ticks,
      slots,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[AdminRumbleTick]", error);
    return NextResponse.json({ error: "Failed to run rumble tick" }, { status: 500 });
  }
}
