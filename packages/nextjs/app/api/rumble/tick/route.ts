import { NextRequest, NextResponse } from "next/server";
import { getOrchestrator } from "../../../../lib/rumble-orchestrator";
import {
  recoverOrchestratorState,
  hasRecovered,
} from "../../../../lib/rumble-state-recovery";
import { reconcileOnchainReportResults } from "../../../../lib/rumble-onchain-reconcile";
import { reconcileStalePendingPayouts } from "../../../../lib/rumble-payout-reconcile";
import { isAuthorizedCronRequest } from "../../../../lib/request-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 10; // Hobby plan limit; increase to 60 on Pro

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

function readEnvInt(
  envName: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = Number(process.env[envName] ?? "");
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(raw)));
}

// Number of ticks to run per invocation and spacing between ticks.
// Production-safe defaults are non-bursty (1 tick/call). Override via env
// only when you intentionally want burst catch-up behavior.
const TICKS_PER_INVOCATION = readEnvInt("RUMBLE_TICKS_PER_INVOCATION", 8, 1, 60);
const TICK_INTERVAL_MS = readEnvInt("RUMBLE_TICK_BURST_INTERVAL_MS", 1_000, 250, 10_000);

// ---------------------------------------------------------------------------
// Auth helper — matches existing cron pattern
// ---------------------------------------------------------------------------

function isAuthorized(req: NextRequest): boolean {
  return isAuthorizedCronRequest(req.headers);
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
  let onchainReconcileResult = null;
  let payoutReconcileResult = null;

  try {
    // ---- State recovery on cold start -----------------------------------
    if (!hasRecovered()) {
      console.log("[RumbleTick] Cold start detected — running state recovery");
      recoveryResult = await recoverOrchestratorState();
      console.log("[RumbleTick] Recovery result:", recoveryResult);
    }

    // ---- On-chain settlement reconciliation ------------------------------
    // Guards against drift where DB marks a rumble complete but on-chain
    // report_result never landed (claims would then fail as payout_not_ready).
    onchainReconcileResult = await reconcileOnchainReportResults().catch((error) => {
      console.error("[RumbleTick] On-chain reconcile error:", error);
      return null;
    });
    payoutReconcileResult = await reconcileStalePendingPayouts().catch((error) => {
      console.error("[RumbleTick] Payout reconcile error:", error);
      return null;
    });

    // ---- Burst loop: run multiple ticks ---------------------------------
    for (let i = 0; i < TICKS_PER_INVOCATION; i++) {
      await orchestrator.tick();
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
      onchainReconcile: onchainReconcileResult,
      payoutReconcile: payoutReconcileResult,
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
        error: "Tick processing error",
        ticksRun,
        recovery: recoveryResult,
        onchainReconcile: onchainReconcileResult,
        payoutReconcile: payoutReconcileResult,
        elapsedMs: Date.now() - startTime,
      },
      { status: 500 },
    );
  }
}
