#!/usr/bin/env node
/**
 * Standalone rumble worker — runs the orchestrator tick loop in-process.
 *
 * This replaces the Vercel cron approach.  No cold starts, no 10-second
 * serverless budget.  Deploy on Railway / Fly.io / any long-lived host.
 *
 * Required env:
 *   NEXT_PUBLIC_SUPABASE_URL / SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Optional env:
 *   SOLANA_RPC_URL                    (default: devnet)
 *   SOLANA_DEPLOYER_KEYPAIR           (JSON array or path — needed for on-chain ops)
 *   RUMBLE_ONCHAIN_TURN_AUTHORITY     (default: "false")
 *   RUMBLE_WORKER_INTERVAL_MS         (default: 2000)
 *   RUMBLE_WORKER_RECOVERY_INTERVAL   (default: 60000 — re-check recovery every 60s)
 */

import { getOrchestrator } from "./lib/rumble-orchestrator";
import {
  recoverOrchestratorState,
  hasRecovered,
} from "./lib/rumble-state-recovery";
import { reconcileOnchainReportResults } from "./lib/rumble-onchain-reconcile";
import { reconcileStalePendingPayouts } from "./lib/rumble-payout-reconcile";
import { reconcileQueueFromDb } from "./lib/rumble-queue-reconcile";
import { retryPendingMainnetOps } from "./lib/mainnet-retry";
import {
  acquireWorkerLease,
  releaseWorkerLease,
} from "./lib/rumble-persistence";
import { createServer } from "node:http";
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TICK_INTERVAL_MS = Math.max(
  500,
  Number(process.env.RUMBLE_WORKER_INTERVAL_MS) || 2_000,
);

const WORKER_ID = `${hostname().replace(/[^a-zA-Z0-9._-]/g, "_")}-${process.pid}-${randomBytes(3).toString("hex")}`;
const WORKER_LEASE_TTL_MS = Math.max(15_000, TICK_INTERVAL_MS * 3);

const RECONCILE_INTERVAL_MS = Math.max(
  10_000,
  Number(process.env.RUMBLE_WORKER_RECONCILE_INTERVAL_MS) || 60_000,
);
const MAINNET_RETRY_INTERVAL_MS = Math.max(
  30_000,
  Number(process.env.RUMBLE_WORKER_MAINNET_RETRY_INTERVAL_MS) || 30_000,
);
const HEALTH_PORT = Math.max(1, Number(process.env.PORT) || 3001);
const HEALTH_STALE_MS = 30_000;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let running = true;
let orchestratorInstance: ReturnType<typeof getOrchestrator> | null = null;
let shutdownInProgress = false;
let tickCount = 0;
let consecutiveErrors = 0;
let lastReconcileAt = 0;
let lastMainnetRetryAt = 0;
let lastTickAt = 0;
const STOP_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ts(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizeSlots(
  status: Array<{
    slotIndex: number;
    state: string;
    fighters: string[];
    turnCount: number;
    remainingFighters: number;
  }>,
): string {
  if (status.length === 0) return "no-slots";
  return status
    .map(
      (s) =>
        `s${s.slotIndex}:${s.state}:f${s.fighters.length}:t${s.turnCount}:alive${s.remainingFighters}`,
    )
    .join(" | ");
}

function startHealthServer(orchestrator: ReturnType<typeof getOrchestrator>): void {
  const server = createServer((req, res) => {
    if (req.method !== "GET" || req.url !== "/healthz") {
      res.statusCode = 404;
      res.end("not found");
      return;
    }

    const now = Date.now();
    const stale = now - lastTickAt > HEALTH_STALE_MS;
    const status = stale ? "stale" : "ok";
    const payload = {
      status,
      lastTickAt: lastTickAt ? new Date(lastTickAt).toISOString() : null,
      uptime: process.uptime(),
      activeSlots: orchestrator.getStatus().length,
    };

    res.statusCode = stale ? 503 : 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(payload));
  });

  server.listen(HEALTH_PORT, () => {
    console.log(`[${ts()}] [worker] health server listening on :${HEALTH_PORT}/healthz`);
  });
  server.on("error", (err) => {
    console.error(`[${ts()}] [worker] health server error:`, err);
  });
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  console.log(`[${ts()}] [worker] Rumble worker starting`);
  console.log(`[${ts()}] [worker] tick interval=${TICK_INTERVAL_MS}ms  reconcile interval=${RECONCILE_INTERVAL_MS}ms`);
  console.log(`[${ts()}] [worker] workerId=${WORKER_ID} leaseTtlMs=${WORKER_LEASE_TTL_MS}`);

  const orchestrator = getOrchestrator();
  orchestratorInstance = orchestrator;
  startHealthServer(orchestrator);

  // ---- Initial recovery ---------------------------------------------------
  if (!hasRecovered()) {
    console.log(`[${ts()}] [worker] Running initial state recovery...`);
    try {
      const result = await recoverOrchestratorState();
      console.log(`[${ts()}] [worker] Recovery complete:`, JSON.stringify(result));
    } catch (err) {
      console.error(`[${ts()}] [worker] Recovery error (continuing):`, err);
    }
  }

  // ---- Tick loop ----------------------------------------------------------
  while (running) {
    const tickStart = Date.now();
    lastTickAt = tickStart;

    const leaseAcquired = await acquireWorkerLease(WORKER_ID, WORKER_LEASE_TTL_MS);
    if (!leaseAcquired) {
      if (tickCount === 0 || tickCount % 30 === 0) {
        console.log(
          `[${ts()}] [worker] lease unavailable for ${WORKER_ID}, skipping tick`,
        );
      }
      const elapsed = Date.now() - tickStart;
      const remaining = Math.max(0, TICK_INTERVAL_MS - elapsed);
      if (remaining > 0 && running) {
        await sleep(remaining);
      }
      continue;
    }

    try {
      // Periodic reconciliation (on-chain + payout)
      if (Date.now() - lastReconcileAt > RECONCILE_INTERVAL_MS) {
        await reconcileOnchainReportResults().catch((e) =>
          console.error(`[${ts()}] [worker] on-chain reconcile error:`, e),
        );
        await reconcileStalePendingPayouts().catch((e) =>
          console.error(`[${ts()}] [worker] payout reconcile error:`, e),
        );
        await reconcileQueueFromDb().catch((e) =>
          console.error(`[${ts()}] [worker] queue reconcile error:`, e),
        );
        lastReconcileAt = Date.now();
      }

      // Periodic retries for failed mainnet operations.
      if (Date.now() - lastMainnetRetryAt > MAINNET_RETRY_INTERVAL_MS) {
        await retryPendingMainnetOps().catch((e) =>
          console.error(`[${ts()}] [worker] mainnet retry error:`, e),
        );
        lastMainnetRetryAt = Date.now();
      }

      // Run one tick
      await orchestrator.tick();
      tickCount++;
      consecutiveErrors = 0;

      // Log status periodically
      if (tickCount === 1 || tickCount % 15 === 0) {
        const status = orchestrator.getStatus();
        console.log(
          `[${ts()}] [worker] tick#${tickCount} ${summarizeSlots(status)}`,
        );
      }
    } catch (err) {
      consecutiveErrors++;
      console.error(
        `[${ts()}] [worker] tick error #${consecutiveErrors}:`,
        err,
      );

      // Back off on repeated failures
      if (consecutiveErrors > 10) {
        console.error(
          `[${ts()}] [worker] Too many consecutive errors, backing off 30s`,
        );
        await sleep(30_000);
      }
    }

    // Sleep until next tick
    const elapsed = Date.now() - tickStart;
    const remaining = Math.max(0, TICK_INTERVAL_MS - elapsed);
    if (remaining > 0 && running) {
      await sleep(remaining);
    }
  }

  console.log(`[${ts()}] [worker] Stopped after ${tickCount} ticks`);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Operation timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );

    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

async function gracefulShutdown(reason: string, exitCode: 0 | 1 = 0): Promise<void> {
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  running = false;

  console.log(`[${ts()}] [worker] Shutdown requested: ${reason}`);

  try {
    if (orchestratorInstance) {
      await withTimeout(orchestratorInstance.stop(), STOP_TIMEOUT_MS);
    }
  } catch (err) {
    console.error(`[${ts()}] [worker] Shutdown error:`, err);
    exitCode = 1;
  } finally {
    try {
      await withTimeout(releaseWorkerLease(WORKER_ID), 5_000);
    } catch (leaseErr) {
      console.error(`[${ts()}] [worker] Failed to release lease:`, leaseErr);
    }
  }

  process.exit(exitCode);
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

process.on("SIGINT", () => {
  void gracefulShutdown("signal");
});
process.on("SIGTERM", () => {
  void gracefulShutdown("signal");
});

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

run().catch((err) => {
  console.error(`[${ts()}] [worker] Fatal:`, err);
  void gracefulShutdown("fatal error", 1);
});
