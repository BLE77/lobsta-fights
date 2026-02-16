// @ts-nocheck
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  loadQueueState,
  getStats,
  getIchorShowerState,
} from "~~/lib/rumble-persistence";
import { getOrchestrator } from "~~/lib/rumble-orchestrator";
import { isAuthorizedAdminRequest } from "~~/lib/request-auth";

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
    const [queue, stats, ichorShower, activeRumblesRaw, recentRumbles, fighters] =
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
            "id, name, wallet_address, wins, losses, draws, matches_played, points, verified, is_active",
          )
          .order("name", { ascending: true })
          .then(({ data }) => data ?? []),
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

    return NextResponse.json({
      queue,
      stats,
      ichorShower,
      activeRumbles,
      staleActiveRows,
      recentRumbles,
      fighters,
      runtimeHealth,
      systemWarnings,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
