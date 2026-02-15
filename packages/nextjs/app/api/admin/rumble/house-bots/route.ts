import { NextResponse } from "next/server";
import { isAuthorizedAdminRequest } from "~~/lib/request-auth";
import { getOrchestrator } from "~~/lib/rumble-orchestrator";

export const dynamic = "force-dynamic";

type HouseBotAction = "pause" | "resume" | "restart" | "set_target" | "clear_target_override";

export async function GET(request: Request) {
  if (!isAuthorizedAdminRequest(request.headers)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const orchestrator = getOrchestrator();
  const status = orchestrator.getHouseBotControlStatus();
  return NextResponse.json({
    success: true,
    ...status,
    timestamp: new Date().toISOString(),
  });
}

export async function POST(request: Request) {
  if (!isAuthorizedAdminRequest(request.headers)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const orchestrator = getOrchestrator();

  try {
    const body = await request.json().catch(() => ({}));
    const action = String(body?.action ?? "").trim() as HouseBotAction;

    if (!action) {
      return NextResponse.json({ error: "Missing action" }, { status: 400 });
    }

    if (action === "pause") {
      const result = await orchestrator.pauseHouseBots();
      return NextResponse.json({
        success: true,
        action,
        ...result,
        status: orchestrator.getHouseBotControlStatus(),
      });
    }

    if (action === "resume") {
      orchestrator.resumeHouseBots();
      return NextResponse.json({
        success: true,
        action,
        status: orchestrator.getHouseBotControlStatus(),
      });
    }

    if (action === "restart") {
      const result = await orchestrator.restartHouseBots();
      return NextResponse.json({
        success: true,
        action,
        ...result,
        status: orchestrator.getHouseBotControlStatus(),
      });
    }

    if (action === "set_target") {
      const requested = Number(body?.target_population);
      if (!Number.isFinite(requested)) {
        return NextResponse.json(
          { error: "Missing or invalid target_population for set_target action" },
          { status: 400 },
        );
      }
      const applied = orchestrator.setHouseBotTargetPopulation(requested);
      return NextResponse.json({
        success: true,
        action,
        target_population: applied,
        status: orchestrator.getHouseBotControlStatus(),
      });
    }

    if (action === "clear_target_override") {
      const applied = orchestrator.setHouseBotTargetPopulation(null);
      return NextResponse.json({
        success: true,
        action,
        target_population: applied,
        status: orchestrator.getHouseBotControlStatus(),
      });
    }

    return NextResponse.json(
      {
        error: "Unsupported action",
        supported_actions: ["pause", "resume", "restart", "set_target", "clear_target_override"],
      },
      { status: 400 },
    );
  } catch (error: any) {
    console.error("[AdminHouseBots]", error);
    return NextResponse.json({ error: "Failed to apply house bot action" }, { status: 500 });
  }
}
