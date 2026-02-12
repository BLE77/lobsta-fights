import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  loadQueueState,
  getStats,
  getIchorShowerState,
} from "~~/lib/rumble-persistence";
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
    const [queue, stats, ichorShower, activeRumbles, recentRumbles, fighters] =
      await Promise.all([
        loadQueueState(),
        getStats(),
        getIchorShowerState(),
        // Active rumbles
        sb
          .from("ucf_rumbles")
          .select("id, slot_index, status, fighters, created_at, started_at, tx_signatures")
          .in("status", ["betting", "combat", "payout"])
          .order("created_at", { ascending: true })
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

    return NextResponse.json({
      queue,
      stats,
      ichorShower,
      activeRumbles,
      recentRumbles,
      fighters,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
