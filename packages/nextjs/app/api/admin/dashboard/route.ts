// @ts-nocheck
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  loadQueueState,
  getStats,
  getIchorShowerState,
  getAdminConfig,
} from "~~/lib/rumble-persistence";
import { getOrchestrator } from "~~/lib/rumble-orchestrator";
import { isAuthorizedAdminRequest } from "~~/lib/request-auth";
import { RUMBLE_ENGINE_ID } from "~~/lib/solana-programs";
import { isErEnabled, getErRpcEndpoint } from "~~/lib/solana-connection";

export const dynamic = "force-dynamic";

const noStoreFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, cache: "no-store" });

function freshClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { fetch: noStoreFetch },
    },
  );
}

export async function GET(request: Request) {
  if (!isAuthorizedAdminRequest(request.headers)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const sb = freshClient();

    // Run all queries in parallel
    const [queue, stats, ichorShower, activeRumblesRaw, recentRumbles, fighters, workerRuntime, workerLease] =
      await Promise.all([
        loadQueueState(),
        getStats(),
        getIchorShowerState(),
        // Active rumbles
        sb
          .from("ucf_rumbles")
          .select("id, slot_index, status, fighters, created_at, started_at, tx_signatures")
          .in("status", ["betting", "combat", "payout"])
          .order("created_at", { ascending: false })
          .then(({ data }) => data ?? []),
        // Recent completed rumbles
        sb
          .from("ucf_rumbles")
          .select(
            "id, slot_index, status, fighters, winner_id, total_turns, created_at, started_at, completed_at, tx_signatures",
          )
          .eq("status", "complete")
          .order("completed_at", { ascending: false })
          .limit(20)
          .then(({ data }) => data ?? []),
        // Fighters
        sb
          .from("ucf_fighters")
          .select(
            "id, name, wallet_address, wins, losses, draws, matches_played, points, verified, is_active, description, special_move, image_url, robot_metadata",
          )
          .eq("is_active", true)
          .order("name", { ascending: true })
          .then(({ data }) => data ?? []),
        getAdminConfig("worker_runtime_health"),
        sb
          .from("worker_lease")
          .select("worker_id, expires_at")
          .limit(1)
          .maybeSingle()
          .then(({ data }) => data ?? null),
      ]);

    // Keep only the newest active rumble per slot for admin display.
    // Stale rows can exist after cold starts/recovery races; showing all of
    // them makes the panel look broken (e.g., multiple "Slot 0" cards).
    const activeBySlot = new Map<number, any>();
    for (const row of activeRumblesRaw) {
      const slotIndex = Number(row?.slot_index);
      if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex > 2) continue;
      if (!activeBySlot.has(slotIndex)) {
        activeBySlot.set(slotIndex, row);
      }
    }
    const activeRumbles = [...activeBySlot.values()].sort(
      (a, b) => Number(a.slot_index) - Number(b.slot_index),
    );
    const staleActiveRows = Math.max(0, activeRumblesRaw.length - activeRumbles.length);
    const runtimeHealth = getOrchestrator().getRuntimeHealth();
    const systemWarnings: string[] = [];
    const workerRuntimeFreshMs =
      typeof workerRuntime === "object" && workerRuntime && typeof (workerRuntime as any).updatedAt === "string"
        ? Date.now() - new Date((workerRuntime as any).updatedAt).getTime()
        : null;
    if (workerRuntimeFreshMs == null) {
      systemWarnings.push("Worker runtime heartbeat unavailable.");
    } else if (workerRuntimeFreshMs > 30_000) {
      systemWarnings.push(
        `Worker heartbeat stale (${Math.round(workerRuntimeFreshMs / 1000)}s old).`,
      );
    }
    if (!runtimeHealth.onchainAdmin.ready && runtimeHealth.onchainAdmin.reason) {
      systemWarnings.push(`On-chain admin unavailable: ${runtimeHealth.onchainAdmin.reason}`);
    }
    if (Array.isArray(runtimeHealth.onchainCreateFailures)) {
      for (const failure of runtimeHealth.onchainCreateFailures.slice(0, 5)) {
        const slotLabel =
          typeof failure?.slotIndex === "number" && Number.isInteger(failure.slotIndex)
            ? `slot ${failure.slotIndex}`
            : "unknown slot";
        const attempts = Number.isFinite(Number(failure?.attempts))
          ? Number(failure.attempts)
          : null;
        const attemptsSuffix = attempts ? ` (attempt ${attempts})` : "";
        const reason = typeof failure?.reason === "string" ? failure.reason : "unknown create_rumble failure";
        const rumbleId = typeof failure?.rumbleId === "string" ? failure.rumbleId : "unknown";
        systemWarnings.push(`On-chain create failed for ${slotLabel}, ${rumbleId}: ${reason}${attemptsSuffix}`);
      }
    }

    // Stuck rumble detection — server-side so UI just renders
    const STUCK_THRESHOLDS_MS: Record<string, number> = {
      betting: 600_000,    // 10 minutes
      combat: 2_700_000,   // 45 minutes
      payout: 600_000,     // 10 minutes
    };
    const now = Date.now();
    const stuckRumbles = activeRumbles
      .map((r: any) => {
        const createdMs = new Date(r.created_at).getTime();
        const phaseStartMs = r.started_at ? new Date(r.started_at).getTime() : createdMs;
        const ageMs = now - createdMs;
        const phaseAgeMs = now - phaseStartMs;
        const maxAgeMs = STUCK_THRESHOLDS_MS[r.status] ?? 600_000;
        const healthRatio = phaseAgeMs / maxAgeMs;
        const health = healthRatio < 0.5 ? "green" : healthRatio < 1.0 ? "amber" : "red";
        return { ...r, ageMs, phaseAgeMs, maxAgeMs, health, healthRatio };
      })
      .filter((r: any) => r.health === "red");

    const onchainHealth = {
      erEnabled: isErEnabled(),
      erRpcUrl: isErEnabled() ? getErRpcEndpoint() : null,
      programId: RUMBLE_ENGINE_ID.toBase58(),
    };

    return NextResponse.json({
      queue,
      stats,
      ichorShower,
      activeRumbles,
      staleActiveRows,
      recentRumbles,
      fighters,
      runtimeHealth,
      workerRuntime,
      workerLease,
      systemWarnings,
      stuckRumbles,
      onchainHealth,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
