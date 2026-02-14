import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { isAuthorizedAdminRequest } from "~~/lib/request-auth";
import { resetOrchestrator } from "~~/lib/rumble-orchestrator";
import { resetQueueManager } from "~~/lib/queue-manager";
import { resetRecoveryFlag } from "~~/lib/rumble-state-recovery";
import { setRumbleSessionNow } from "~~/lib/rumble-session";

export const dynamic = "force-dynamic";

function serviceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing Supabase service-role env");
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: (input, init) => fetch(input, { ...init, cache: "no-store" }) },
  });
}

export async function POST(request: Request) {
  if (!isAuthorizedAdminRequest(request.headers)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json().catch(() => ({}));
    const resetSessionFloor = body?.reset_session_floor !== false;
    const resetDb = body?.reset_db !== false;

    // Reset in-memory lifecycle first.
    resetOrchestrator();
    resetQueueManager();
    resetRecoveryFlag();

    let deleted = {
      bets: 0,
      rumbles: 0,
      queue: 0,
      tx_signatures: 0,
    };
    if (resetDb) {
      const sb = serviceClient();

      const [
        { data: betRows, error: betsErr },
        { data: rumbleRows, error: rumblesErr },
        { data: queueRows, error: queueErr },
        { data: txSigRows, error: txSigErr },
      ] = await Promise.all([
        sb.from("ucf_bets").delete().gte("placed_at", "1970-01-01").select("id"),
        sb.from("ucf_rumbles").delete().gte("created_at", "1970-01-01").select("id"),
        sb.from("ucf_rumble_queue").delete().gte("joined_at", "1970-01-01").select("id"),
        sb.from("ucf_used_tx_signatures").delete().gte("created_at", "1970-01-01").select("tx_signature"),
      ]);
      if (betsErr) throw betsErr;
      if (rumblesErr) throw rumblesErr;
      if (queueErr) throw queueErr;
      if (txSigErr) throw txSigErr;

      deleted = {
        bets: betRows?.length ?? 0,
        rumbles: rumbleRows?.length ?? 0,
        queue: queueRows?.length ?? 0,
        tx_signatures: txSigRows?.length ?? 0,
      };

      await Promise.all([
        sb
          .from("ucf_ichor_shower")
          .update({
            pool_amount: 0,
            last_trigger_rumble_id: null,
            last_winner_wallet: null,
            last_payout: null,
            updated_at: new Date().toISOString(),
          })
          .gte("updated_at", "1970-01-01"),
        sb
          .from("ucf_rumble_stats")
          .update({
            total_rumbles: 0,
            total_sol_wagered: 0,
            total_ichor_minted: 0,
            total_ichor_burned: 0,
            updated_at: new Date().toISOString(),
          })
          .gte("updated_at", "1970-01-01"),
      ]);
    }

    const session = resetSessionFloor ? setRumbleSessionNow() : null;

    return NextResponse.json({
      success: true,
      reset_db: resetDb,
      deleted,
      session_floor_enabled: resetSessionFloor,
      session_min_timestamp_ms: session?.minRumbleTimestampMs ?? null,
      session_reset_at: session?.resetAtIso ?? null,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[AdminRumbleReset]", error);
    return NextResponse.json({ error: "Failed to reset rumble system" }, { status: 500 });
  }
}
