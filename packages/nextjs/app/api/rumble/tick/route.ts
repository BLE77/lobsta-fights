import { NextRequest, NextResponse } from "next/server";
import { getOrchestrator } from "../../../../lib/rumble-orchestrator";
import {
  recoverOrchestratorState,
  hasRecovered,
} from "../../../../lib/rumble-state-recovery";

export const dynamic = "force-dynamic";
export const maxDuration = 10; // Hobby plan limit; increase to 60 on Pro

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Number of ticks to run per cron invocation.
// On Hobby (10s max), we run 8 ticks with ~1s spacing = ~8s total.
// On Pro (60s max), bump to 55 ticks for nearly continuous operation.
const TICKS_PER_INVOCATION = 8;
const TICK_INTERVAL_MS = 1_000; // 1 second between ticks

// ---------------------------------------------------------------------------
// Auth helper — matches existing cron pattern
// ---------------------------------------------------------------------------

function isAuthorized(req: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return true; // No secret configured = allow (testing mode)

  const authHeader = req.headers.get("authorization");
  return authHeader === `Bearer ${cronSecret}`;
}

// ---------------------------------------------------------------------------
// Sleep utility
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// GET /api/rumble/tick — Vercel Cron entry point
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return runTickBurst();
}

// ---------------------------------------------------------------------------
// POST /api/rumble/tick — Internal / manual trigger
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return runTickBurst();
}

// ---------------------------------------------------------------------------
// Core: burst loop — runs multiple ticks within a single request
// ---------------------------------------------------------------------------

async function runTickBurst(): Promise<NextResponse> {
  const startTime = Date.now();
  const orchestrator = getOrchestrator();
  let ticksRun = 0;
  let recoveryResult = null;

  try {
    // ---- State recovery on cold start -----------------------------------
    if (!hasRecovered()) {
      console.log("[RumbleTick] Cold start detected — running state recovery");
      recoveryResult = await recoverOrchestratorState();
      console.log("[RumbleTick] Recovery result:", recoveryResult);
    }

    // ---- Burst loop: run multiple ticks ---------------------------------
    for (let i = 0; i < TICKS_PER_INVOCATION; i++) {
      orchestrator.tick();
      ticksRun++;

      // Sleep between ticks (but not after the last one)
      if (i < TICKS_PER_INVOCATION - 1) {
        await sleep(TICK_INTERVAL_MS);
      }
    }

    const elapsed = Date.now() - startTime;
    const status = orchestrator.getStatus();

    return NextResponse.json({
      success: true,
      ticksRun,
      elapsedMs: elapsed,
      recovery: recoveryResult,
      slots: status.map((s) => ({
        slot: s.slotIndex,
        state: s.state,
        rumbleId: s.rumbleId,
        fighters: s.fighters.length,
        turnCount: s.turnCount,
        remainingFighters: s.remainingFighters,
      })),
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("[RumbleTick] Error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error.message,
        ticksRun,
        recovery: recoveryResult,
        elapsedMs: Date.now() - startTime,
      },
      { status: 500 },
    );
  }
}
