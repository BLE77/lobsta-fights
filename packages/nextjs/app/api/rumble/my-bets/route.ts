import { NextResponse } from "next/server";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { freshSupabase } from "~~/lib/supabase";
import { checkRateLimit, getRateLimitKey, rateLimitResponse } from "~~/lib/rate-limit";
import { readBettorAccount } from "~~/lib/solana-programs";
import { ADMIN_FEE_RATE, SPONSORSHIP_RATE } from "~~/lib/betting";
import { parseOnchainRumbleIdNumber } from "~~/lib/rumble-id";
import { loadActiveRumbles } from "~~/lib/rumble-persistence";
import { getBettingConnection } from "~~/lib/solana-connection";
import { flushRpcMetrics, runWithRpcMetrics } from "~~/lib/solana-rpc-metrics";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return runWithRpcMetrics("GET /api/rumble/my-bets", async () => {
    const rlKey = getRateLimitKey(request);
    const rl = checkRateLimit("PUBLIC_READ", rlKey);
    if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

    try {
      const { searchParams } = new URL(request.url);
      const wallet = searchParams.get("wallet") ?? searchParams.get("wallet_address");
      const includeOnchain = searchParams.get("include_onchain") === "1";
      if (!wallet) {
        return NextResponse.json({ error: "Missing wallet query parameter" }, { status: 400 });
      }
      try {
        new PublicKey(wallet);
      } catch {
        return NextResponse.json({ error: "Invalid wallet address" }, { status: 400 });
      }

    // Load active rumbles from Supabase instead of in-memory orchestrator
    // so this works on Vercel (which doesn't run the Railway worker).
    const activeRumbles = await loadActiveRumbles();
    const slotMap = new Map<number, string>();
    const slotFighters = new Map<number, string[]>();
    for (const r of activeRumbles) {
      slotMap.set(r.slot_index, r.id);
      const fighterRows = Array.isArray(r.fighters) ? (r.fighters as Array<{ id?: string }>) : [];
      const fighters = fighterRows.map((row) => String(row?.id ?? "").trim()).filter(Boolean);
      slotFighters.set(r.slot_index, fighters);
    }
    const rumbleIds = [...slotMap.values()];
    if (rumbleIds.length === 0) {
      return NextResponse.json({
        wallet,
        slots: [],
        total_sol: 0,
        timestamp: new Date().toISOString(),
      });
    }

    const { data, error } = await freshSupabase()
      .from("ucf_bets")
      .select("rumble_id, fighter_id, gross_amount")
      .eq("wallet_address", wallet)
      .in("rumble_id", rumbleIds);
    if (error) {
      return NextResponse.json({ error: "Failed to load wallet bets." }, { status: 500 });
    }

    const bySlot = new Map<number, Map<string, { solAmount: number; betCount: number }>>();
    const rumbleToSlot = new Map<string, number>();
    for (const [slotIndex, rumbleId] of slotMap.entries()) {
      rumbleToSlot.set(rumbleId, slotIndex);
    }

    for (const row of data ?? []) {
      const rumbleId = String((row as any).rumble_id ?? "");
      const fighterId = String((row as any).fighter_id ?? "");
      const amount = Number((row as any).gross_amount ?? 0);
      const slotIndex = rumbleToSlot.get(rumbleId);
      if (slotIndex === undefined || !fighterId || !Number.isFinite(amount) || amount <= 0) continue;

      if (!bySlot.has(slotIndex)) bySlot.set(slotIndex, new Map());
      const slotBets = bySlot.get(slotIndex)!;
      const current = slotBets.get(fighterId) ?? { solAmount: 0, betCount: 0 };
      current.solAmount += amount;
      current.betCount += 1;
      slotBets.set(fighterId, current);
    }

    // Optional on-chain reconciliation:
    // this is expensive (getAccountInfo per active slot). Keep it opt-in for
    // immediate post-bet reconciliation, not steady polling.
    if (includeOnchain) {
      const walletPubkey = new PublicKey(wallet);
      const bettingConn = getBettingConnection();
      const grossMultiplier = 1 - ADMIN_FEE_RATE - SPONSORSHIP_RATE;
      for (const [slotIndex, rumbleId] of slotMap.entries()) {
        const rumbleIdNum = parseOnchainRumbleIdNumber(rumbleId);
        if (rumbleIdNum === null) continue;

        let bettorState = null;
        try {
          bettorState = await readBettorAccount(walletPubkey, rumbleIdNum, bettingConn);
        } catch {
          continue;
        }
        if (!bettorState || !bettorState.fighterDeploymentsLamports?.length) continue;

        const fighters = slotFighters.get(slotIndex) ?? [];
        if (!bySlot.has(slotIndex)) bySlot.set(slotIndex, new Map());
        const slotBets = bySlot.get(slotIndex)!;

        for (let i = 0; i < bettorState.fighterDeploymentsLamports.length; i++) {
          const lamports = bettorState.fighterDeploymentsLamports[i] ?? 0n;
          if (lamports <= 0n) continue;
          const fighterId = fighters[i];
          if (!fighterId) continue;

          const onchainNetSol = Number(lamports) / LAMPORTS_PER_SOL;
          const onchainSol =
            grossMultiplier > 0 ? onchainNetSol / grossMultiplier : onchainNetSol;
          const current = slotBets.get(fighterId) ?? { solAmount: 0, betCount: 0 };
          // Prefer the larger amount when both DB and chain entries exist.
          current.solAmount = Math.max(current.solAmount, onchainSol);
          // Ensure at least one leg is visible for this fighter.
          current.betCount = Math.max(current.betCount, 1);
          slotBets.set(fighterId, current);
        }
      }
    }

    const slots = [...slotMap.entries()]
      .map(([slotIndex, rumbleId]) => {
        const slotBets = bySlot.get(slotIndex) ?? new Map();
        const bets = [...slotBets.entries()].map(([fighterId, v]) => ({
          fighter_id: fighterId,
          sol_amount: Number(v.solAmount.toFixed(9)),
          bet_count: v.betCount,
        }));
        bets.sort((a, b) => b.sol_amount - a.sol_amount);
        const totalSol = bets.reduce((sum, b) => sum + b.sol_amount, 0);
        return {
          slot_index: slotIndex,
          rumble_id: rumbleId,
          total_sol: Number(totalSol.toFixed(9)),
          bets,
        };
      })
      .sort((a, b) => a.slot_index - b.slot_index);

      const totalSol = slots.reduce((sum, s) => sum + s.total_sol, 0);
      return NextResponse.json({
        wallet,
        slots,
        total_sol: Number(totalSol.toFixed(9)),
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error("[RumbleMyBetsAPI]", error);
      return NextResponse.json({ error: "Failed to fetch wallet bets" }, { status: 500 });
    } finally {
      flushRpcMetrics();
    }
  });
}
