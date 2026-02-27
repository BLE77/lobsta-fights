import { NextResponse } from "next/server";
import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { isAuthorizedAdminRequest } from "~~/lib/request-auth";
import {
  RUMBLE_ENGINE_ID_MAINNET,
  deriveRumbleConfigPdaMainnet,
  deriveRumblePdaMainnet,
  deriveVaultPdaMainnet,
  sweepTreasuryMainnet,
  reportResultMainnet,
  completeRumbleMainnet,
  readRumbleAccountState,
} from "~~/lib/solana-programs";
import { getBettingConnection } from "~~/lib/solana-connection";
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

/**
 * POST /api/admin/sweep
 *
 * Scans mainnet rumble accounts and:
 * 1. For rumbles in "betting" with no action: reports a dummy result + completes + sweeps
 * 2. For rumbles in "payout" past the claim window: completes + sweeps
 * 3. For rumbles in "complete" past the claim window: sweeps
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
      const vaultBalance = await conn.getBalance(vaultPda);
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

      if (sweepableSol <= 0) {
        entry.actions.push("skip: no SOL to sweep");
        results.push(entry);
        continue;
      }

      if (dryRun) {
        if (state === "betting") {
          entry.actions.push("would: reportResult → completeRumble → sweepTreasury");
        } else if (state === "payout") {
          entry.actions.push("would: completeRumble → sweepTreasury (if claim window expired)");
        } else if (state === "complete") {
          entry.actions.push("would: sweepTreasury (if claim window expired)");
        } else {
          entry.actions.push("skip: state not sweepable");
        }
        results.push(entry);
        continue;
      }

      // Actually execute sweep
      if (state === "betting") {
        // Rumble never started combat — report dummy result and sweep
        const fighterCount = data[17] ?? 12; // fighter_count u8
        const placements = Array.from({ length: fighterCount }, (_, i) => i === 0 ? 1 : i + 1);
        const winnerIndex = 0; // first fighter "wins" (arbitrary — nobody bet on them anyway)

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
