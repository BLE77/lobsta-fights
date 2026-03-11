import { NextResponse } from "next/server";
import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { isAuthorizedAdminRequest } from "~~/lib/request-auth";
import {
  RUMBLE_ENGINE_ID_MAINNET,
  deriveVaultPdaMainnet,
  sweepTreasuryMainnet,
  reportResultMainnet,
  completeRumbleMainnet,
  readMainnetRumbleAccountStateResilient,
} from "~~/lib/solana-programs";
import { getBettingConnection, getCachedBalance } from "~~/lib/solana-connection";
import { freshSupabase } from "~~/lib/supabase";
import { createHash } from "node:crypto";

export const dynamic = "force-dynamic";

const RUMBLE_DISCRIMINATOR = createHash("sha256")
  .update("account:Rumble")
  .digest()
  .subarray(0, 8);

function readU64LE(data: Uint8Array, offset: number): bigint {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return view.getBigUint64(offset, true);
}

type BettingSweepSafety = {
  safe: boolean;
  reason: string;
  dbBetCount: number | null;
  onchainTotalDeployedLamports: bigint | null;
};

async function getBettingSweepSafety(rumbleId: number): Promise<BettingSweepSafety> {
  let dbBetCount: number | null = null;
  try {
    const sb = freshSupabase();
    const { count, error } = await sb
      .from("ucf_bets")
      .select("id", { count: "exact", head: true })
      .eq("rumble_id", String(rumbleId));
    if (error) throw error;
    dbBetCount = count ?? 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      safe: false,
      reason: `manual review required: failed to verify DB bets (${message.slice(0, 120)})`,
      dbBetCount: null,
      onchainTotalDeployedLamports: null,
    };
  }

  const onchainState = await readMainnetRumbleAccountStateResilient(rumbleId).catch(() => null);
  if (!onchainState) {
    return {
      safe: false,
      reason: "manual review required: failed to read mainnet betting state",
      dbBetCount,
      onchainTotalDeployedLamports: null,
    };
  }

  const onchainTotalDeployedLamports = onchainState.totalDeployedLamports ?? 0n;
  if (dbBetCount > 0 || onchainTotalDeployedLamports > 0n) {
    return {
      safe: false,
      reason:
        `manual review required: bets exist ` +
        `(db=${dbBetCount}, onchain=${Number(onchainTotalDeployedLamports) / LAMPORTS_PER_SOL} SOL)`,
      dbBetCount,
      onchainTotalDeployedLamports,
    };
  }

  return {
    safe: true,
    reason: "verified no-bet betting-state rumble",
    dbBetCount,
    onchainTotalDeployedLamports,
  };
}

/**
 * POST /api/admin/sweep
 *
 * Scans mainnet rumble accounts and:
 * 1. For rumbles in "betting" with no action: reports a dummy result + completes + sweeps
 * 2. For rumbles in "payout" past the claim window: completes, then only sweeps if no one bet on the winner
 * 3. For rumbles in "complete": only sweeps no-winner-bet rumbles
 *
 * Body (optional):
 *   { "rumble_id": 12345 }  — sweep a specific rumble
 *   { "dry_run": true }     — scan only, don't execute
 *
 * Auth: x-admin-secret header
 */
export async function POST(request: Request) {
  if (!isAuthorizedAdminRequest(request.headers)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json().catch(() => ({}));
    const dryRun = body.dry_run === true;
    const targetRumbleId = body.rumble_id ? Number(body.rumble_id) : null;

    const conn = getBettingConnection();
    const results: any[] = [];

    // Find rumble accounts on mainnet
    const rumbleAccounts = await conn.getProgramAccounts(RUMBLE_ENGINE_ID_MAINNET, {
      filters: [
        {
          memcmp: {
            offset: 0,
            bytes: anchor.utils.bytes.bs58.encode(Buffer.from(RUMBLE_DISCRIMINATOR)),
          },
        },
      ],
    });

    for (const acct of rumbleAccounts) {
      const data = acct.account.data;
      if (data.length < 40) continue;

      const rumbleId = Number(readU64LE(data, 8));
      if (targetRumbleId && rumbleId !== targetRumbleId) continue;

      const stateVal = data[16];
      const stateNames: Record<number, string> = { 0: "betting", 1: "combat", 2: "payout", 3: "complete" };
      const state = stateNames[stateVal] ?? `unknown(${stateVal})`;

      // Read completed_at timestamp (i64 at a specific offset)
      // We need to find the completed_at field offset in the Rumble struct
      // For now, read it from the on-chain account state

      const [vaultPda] = deriveVaultPdaMainnet(rumbleId);
      const vaultBalance = await getCachedBalance(conn, vaultPda, {
        ttlMs: 30_000,
      });
      const vaultSol = vaultBalance / LAMPORTS_PER_SOL;
      const rentExemptMin = 890_880; // ~0.00089 SOL
      const sweepableSol = Math.max(0, (vaultBalance - rentExemptMin) / LAMPORTS_PER_SOL);

      const entry: any = {
        rumble_id: rumbleId,
        state,
        vault_sol: vaultSol,
        sweepable_sol: sweepableSol,
        pda: acct.pubkey.toBase58(),
        actions: [] as string[],
      };

      const payoutState =
        state === "payout" || state === "complete"
          ? await readMainnetRumbleAccountStateResilient(rumbleId).catch(() => null)
          : null;
      const payoutWinnerIndex = payoutState?.winnerIndex ?? null;
      const winnerPoolLamports =
        payoutWinnerIndex === null ? null : Number(payoutState?.bettingPools[payoutWinnerIndex] ?? 0n);
      const hasWinningBets = winnerPoolLamports !== null && winnerPoolLamports > 0;
      if (winnerPoolLamports !== null) {
        entry.winner_pool_sol = winnerPoolLamports / LAMPORTS_PER_SOL;
      }

      if (sweepableSol <= 0) {
        entry.actions.push("skip: no SOL to sweep");
        results.push(entry);
        continue;
      }

      if (dryRun) {
        if (state === "betting") {
          const safety = await getBettingSweepSafety(rumbleId);
          entry.db_bet_count = safety.dbBetCount;
          entry.onchain_total_deployed_sol =
            safety.onchainTotalDeployedLamports === null
              ? null
              : Number(safety.onchainTotalDeployedLamports) / LAMPORTS_PER_SOL;
          if (safety.safe) {
            entry.actions.push("would: reportResult → completeRumble → sweepTreasury");
          } else {
            entry.actions.push(`BLOCKED: ${safety.reason}`);
          }
        } else if (state === "payout") {
          if (hasWinningBets) {
            entry.actions.push("would: completeRumble only after 24h buffer; winner claims remain open");
          } else {
            entry.actions.push("would: completeRumble → sweepTreasury (no winning bets)");
          }
        } else if (state === "complete") {
          if (hasWinningBets) {
            entry.actions.push("skip: winner claims remain open; treasury sweep disabled");
          } else {
            entry.actions.push("would: sweepTreasury (no winning bets)");
          }
        } else {
          entry.actions.push("skip: state not sweepable");
        }
        results.push(entry);
        continue;
      }

      // Actually execute sweep
      if (state === "betting") {
        const safety = await getBettingSweepSafety(rumbleId);
        entry.db_bet_count = safety.dbBetCount;
        entry.onchain_total_deployed_sol =
          safety.onchainTotalDeployedLamports === null
            ? null
            : Number(safety.onchainTotalDeployedLamports) / LAMPORTS_PER_SOL;
        if (!safety.safe) {
          entry.actions.push(`BLOCKED: ${safety.reason}`);
          results.push(entry);
          continue;
        }

        // Rumble never started combat — report dummy result and sweep
        const fighterCount = data[17] ?? 12; // fighter_count u8
        const placements = Array.from({ length: fighterCount }, (_, i) => i === 0 ? 1 : i + 1);
        const winnerIndex = 0; // safe only after verifying no bets exist anywhere

        try {
          const sig = await reportResultMainnet(rumbleId, placements, winnerIndex);
          entry.actions.push(`reportResult: ${sig ?? "null"}`);
        } catch (err: any) {
          entry.actions.push(`reportResult FAILED: ${err.message?.slice(0, 100)}`);
          results.push(entry);
          continue;
        }

        // Wait a moment for state to settle
        await new Promise(r => setTimeout(r, 2000));

        try {
          const sig = await completeRumbleMainnet(rumbleId);
          entry.actions.push(`completeRumble: ${sig ?? "null"}`);
        } catch (err: any) {
          entry.actions.push(`completeRumble FAILED: ${err.message?.slice(0, 100)}`);
          // Still try sweep in case it went through
        }
      }

      if (state === "payout" || state === "complete") {
        if (state === "payout") {
          try {
            const sig = await completeRumbleMainnet(rumbleId);
            entry.actions.push(`completeRumble: ${sig ?? "null"}`);
          } catch (err: any) {
            const msg = err.message ?? "";
            if (msg.includes("ClaimWindowActive")) {
              entry.actions.push("completeRumble BLOCKED: claim window still active (24h)");
            } else {
              entry.actions.push(`completeRumble FAILED: ${msg.slice(0, 100)}`);
            }
            results.push(entry);
            continue;
          }
        }

        if (hasWinningBets) {
          entry.actions.push("skip: winner claims remain open; treasury sweep disabled");
          results.push(entry);
          continue;
        }

        // Sweep
        try {
          const sig = await sweepTreasuryMainnet(rumbleId);
          entry.actions.push(`sweepTreasury: ${sig ?? "null"}`);
        } catch (err: any) {
          const msg = err.message ?? "";
          if (msg.includes("ClaimWindowActive")) {
            entry.actions.push("sweepTreasury BLOCKED: claim window still active (24h)");
          } else {
            entry.actions.push(`sweepTreasury FAILED: ${msg.slice(0, 100)}`);
          }
        }
      }

      results.push(entry);
    }

    const totalSweepable = results.reduce((sum, r) => sum + (r.sweepable_sol ?? 0), 0);

    return NextResponse.json({
      dry_run: dryRun,
      total_rumbles: rumbleAccounts.length,
      results,
      total_sweepable_sol: totalSweepable,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("[AdminSweep]", error);
    return NextResponse.json({ error: error.message ?? "Sweep failed" }, { status: 500 });
  }
}
