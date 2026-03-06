import { NextResponse } from "next/server";
import { isAuthorizedAdminRequest } from "~~/lib/request-auth";
import { getOrchestrator } from "~~/lib/rumble-orchestrator";
import { queueWorkerCommand, type WorkerCommand } from "~~/lib/worker-commands";
import { getAdminConfig } from "~~/lib/rumble-persistence";

export const dynamic = "force-dynamic";

type HouseBotAction = "pause" | "resume" | "restart" | "set_target" | "clear_target_override";

const ACTION_TO_COMMAND: Record<HouseBotAction, WorkerCommand> = {
  pause: "stop_bots",
  resume: "start_bots",
  restart: "restart_bots",
  set_target: "set_bot_target",
  clear_target_override: "clear_bot_target",
};

export async function GET(request: Request) {
  if (!isAuthorizedAdminRequest(request.headers)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // On Railway: read live orchestrator state
  if (process.env.RUMBLE_WORKER_MODE === "true") {
    const orchestrator = getOrchestrator();
    await orchestrator.waitForHouseBotControlReady();
    const status = orchestrator.getHouseBotControlStatus();
    return NextResponse.json({ success: true, ...status, timestamp: new Date().toISOString() });
  }

  // On Vercel: read persisted state from Supabase (actual Railway state)
  const paused = (await getAdminConfig("house_bots_paused")) === true;
  const configuredIds = String(process.env.RUMBLE_HOUSE_BOT_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const configuredCount = configuredIds.length || Number(process.env.HOUSE_BOT_COUNT) || 0;
  const targetPop =
    Number(
      process.env.RUMBLE_HOUSE_BOT_TARGET_POPULATION ??
      process.env.HOUSE_BOT_TARGET_POPULATION ??
      0,
    ) || 0;
  return NextResponse.json({
    success: true,
    configuredEnabled: configuredCount > 0,
    configuredHouseBotCount: configuredCount,
    paused,
    targetPopulation: targetPop,
    targetPopulationSource: "persisted",
    source: "supabase",
    timestamp: new Date().toISOString(),
  });
}

export async function POST(request: Request) {
  if (!isAuthorizedAdminRequest(request.headers)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json().catch(() => ({}));
    const action = String(body?.action ?? "").trim() as HouseBotAction;

    if (!action || !ACTION_TO_COMMAND[action]) {
      return NextResponse.json(
        { error: "Unsupported action", supported_actions: Object.keys(ACTION_TO_COMMAND) },
        { status: 400 },
      );
    }

    if (action === "set_target") {
      const requested = Number(body?.target_population);
      if (!Number.isFinite(requested)) {
        return NextResponse.json(
          { error: "Missing or invalid target_population" },
          { status: 400 },
        );
      }
    }

    // On Railway: execute directly for instant response
    if (process.env.RUMBLE_WORKER_MODE === "true") {
      const orchestrator = getOrchestrator();
      await orchestrator.waitForHouseBotControlReady();
      if (action === "pause") {
        const result = await orchestrator.pauseHouseBots();
        return NextResponse.json({ success: true, action, ...result, status: orchestrator.getHouseBotControlStatus() });
      }
      if (action === "resume") {
        await orchestrator.resumeHouseBots();
        return NextResponse.json({ success: true, action, status: orchestrator.getHouseBotControlStatus() });
      }
      if (action === "restart") {
        const result = await orchestrator.restartHouseBots();
        return NextResponse.json({ success: true, action, ...result, status: orchestrator.getHouseBotControlStatus() });
      }
      if (action === "set_target") {
        const applied = orchestrator.setHouseBotTargetPopulation(Number(body.target_population));
        return NextResponse.json({ success: true, action, target_population: applied, status: orchestrator.getHouseBotControlStatus() });
      }
      if (action === "clear_target_override") {
        const applied = orchestrator.setHouseBotTargetPopulation(null);
        return NextResponse.json({ success: true, action, target_population: applied, status: orchestrator.getHouseBotControlStatus() });
      }
    }

    // On Vercel: queue command for Railway worker to pick up
    const command = ACTION_TO_COMMAND[action];
    const payload: Record<string, unknown> = {};
    if (action === "set_target") payload.target_population = Number(body.target_population);

    const queued = await queueWorkerCommand(command, payload);
    if (!queued) {
      return NextResponse.json({ error: "Failed to queue command" }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      action,
      queued: true,
      command_id: queued.id,
      message: "Command queued for Railway worker (executes within ~2s)",
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("[AdminHouseBots]", error);
    return NextResponse.json({ error: "Failed to apply house bot action" }, { status: 500 });
  }
}
