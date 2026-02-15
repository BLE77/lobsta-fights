import { NextResponse } from "next/server";
import { isAuthorizedAdminRequest } from "~~/lib/request-auth";
import { getOrchestrator } from "~~/lib/rumble-orchestrator";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!isAuthorizedAdminRequest(request.headers)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const orchestrator = getOrchestrator();
    await orchestrator.tick();
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
      slots,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[AdminRumbleTick]", error);
    return NextResponse.json({ error: "Failed to run rumble tick" }, { status: 500 });
  }
}
