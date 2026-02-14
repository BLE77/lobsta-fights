import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { checkRateLimit, getRateLimitKey, rateLimitResponse } from "~~/lib/rate-limit";
import { isAccrueClaimMode } from "~~/lib/rumble-payout-mode";
import {
  buildClaimPayoutTx,
  buildClaimPayoutBatchTx,
} from "~~/lib/solana-programs";
import { discoverOnchainClaimableRumbles } from "~~/lib/rumble-onchain-claims";
import { getConnection } from "~~/lib/solana-connection";

export const dynamic = "force-dynamic";
const SOLANA_LEGACY_TX_MAX_BYTES = 1232;
const MAX_SIMULATION_CANDIDATES = 24;

function summarizeSimulationError(
  err: unknown,
  logs: string[] | null | undefined,
): string {
  if (Array.isArray(logs)) {
    const anchorLog = logs.find((line) => line.includes("Error Code:"));
    if (anchorLog) return anchorLog;
    const programLog = logs.find((line) => line.toLowerCase().includes("program log:"));
    if (programLog) return programLog;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export async function POST(request: Request) {
  const rlKey = getRateLimitKey(request);
  const rl = checkRateLimit("PUBLIC_WRITE", rlKey);
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

  try {
    if (!isAccrueClaimMode()) {
      return NextResponse.json(
        { error: "Claim flow is disabled (RUMBLE_PAYOUT_MODE is not accrue_claim)." },
        { status: 409 },
      );
    }

    const body = await request.json().catch(() => ({}));
    const walletAddress = body.wallet_address ?? body.walletAddress;
    const requestedRumbleId = body.rumble_id ?? body.rumbleId;

    if (!walletAddress || typeof walletAddress !== "string") {
      return NextResponse.json({ error: "Missing wallet_address" }, { status: 400 });
    }

    let wallet: PublicKey;
    try {
      wallet = new PublicKey(walletAddress);
    } catch {
      return NextResponse.json({ error: "Invalid wallet address" }, { status: 400 });
    }

    const claimables = await discoverOnchainClaimableRumbles(wallet, 120).catch(() => []);
    if (claimables.length === 0) {
      return NextResponse.json(
        { error: "No on-chain claimable rumble payouts found for this wallet." },
        { status: 404 },
      );
    }

    const requestedTarget = typeof requestedRumbleId === "string"
      ? claimables.find((row) => row.rumbleId === requestedRumbleId.trim())
      : null;
    if (typeof requestedRumbleId === "string" && !requestedTarget) {
      return NextResponse.json(
        { error: "Requested rumble has no on-chain claimable payout for this wallet." },
        { status: 404 },
      );
    }

    const sortedClaimables = [...claimables].sort((a, b) => {
      const av = a.onchainClaimableSol > 0 ? a.onchainClaimableSol : a.inferredClaimableSol;
      const bv = b.onchainClaimableSol > 0 ? b.onchainClaimableSol : b.inferredClaimableSol;
      return bv - av;
    });
    let selectedTargets = requestedTarget
      ? sortedClaimables.filter((row) => row.rumbleId === requestedTarget.rumbleId)
      : sortedClaimables;
    if (selectedTargets.length === 0) {
      return NextResponse.json(
        { error: "No on-chain claimable payout found for this wallet.", reason: "none_ready" },
        { status: 409 },
      );
    }

    // Vet candidates with preflight simulation so stale/not-ready claims do not
    // poison a batched claim tx.
    const connection = getConnection();
    const vettedTargets: typeof selectedTargets = [];
    const skippedBySimulation: Array<{ rumble_id: string; reason: string }> = [];
    for (const target of selectedTargets.slice(0, MAX_SIMULATION_CANDIDATES)) {
      try {
        const simTx = await buildClaimPayoutTx(wallet, target.rumbleIdNum, connection);
        const sim = await (connection as any).simulateTransaction(simTx, {
          sigVerify: false,
          replaceRecentBlockhash: true,
          commitment: "processed",
        });
        if (sim.value.err) {
          skippedBySimulation.push({
            rumble_id: target.rumbleId,
            reason: summarizeSimulationError(sim.value.err, sim.value.logs),
          });
          continue;
        }
        vettedTargets.push(target);
      } catch (err) {
        skippedBySimulation.push({
          rumble_id: target.rumbleId,
          reason: summarizeSimulationError(err, null),
        });
      }
    }

    if (requestedTarget) {
      selectedTargets = vettedTargets.filter((row) => row.rumbleId === requestedTarget.rumbleId);
      if (selectedTargets.length === 0) {
        const reason = skippedBySimulation.find((row) => row.rumble_id === requestedTarget.rumbleId)?.reason;
        return NextResponse.json(
          {
            error: "Requested rumble is not claimable right now.",
            reason: reason ?? "claim_not_ready_or_unavailable",
          },
          { status: 409 },
        );
      }
    } else {
      selectedTargets = vettedTargets;
    }

    if (selectedTargets.length === 0) {
      return NextResponse.json(
        {
          error: "No on-chain claimable payout is currently executable.",
          reason: "simulation_filtered_all",
          skipped_by_simulation: skippedBySimulation.slice(0, 5),
        },
        { status: 409 },
      );
    }

    let tx = null as Awaited<ReturnType<typeof buildClaimPayoutTx>> | null;
    let txBytes: Buffer | null = null;
    while (selectedTargets.length > 0) {
      try {
        tx =
          selectedTargets.length === 1
            ? await buildClaimPayoutTx(wallet, selectedTargets[0].rumbleIdNum)
            : await buildClaimPayoutBatchTx(
                wallet,
                selectedTargets.map((target) => target.rumbleIdNum),
              );
        const serialized = tx.serialize({
          requireAllSignatures: false,
          verifySignatures: false,
        });
        if (
          selectedTargets.length > 1 &&
          serialized.length > SOLANA_LEGACY_TX_MAX_BYTES
        ) {
          selectedTargets = selectedTargets.slice(0, -1);
          continue;
        }
        txBytes = Buffer.from(serialized);
        break;
      } catch (err: any) {
        const message = String(err?.message ?? err ?? "");
        const sizeError =
          message.toLowerCase().includes("too large") ||
          message.toLowerCase().includes("encoding overruns") ||
          message.toLowerCase().includes("rangeerror");
        if (sizeError && selectedTargets.length > 1) {
          selectedTargets = selectedTargets.slice(0, -1);
          continue;
        }
        throw err;
      }
    }
    if (!tx || !txBytes) {
      return NextResponse.json(
        { error: "Unable to build claim transaction for the selected payouts." },
        { status: 500 },
      );
    }

    const txBase64 = Buffer.from(txBytes).toString("base64");
    const totalClaimableSol = selectedTargets.reduce((sum, target) => {
      const amount = target.onchainClaimableSol > 0 ? target.onchainClaimableSol : target.inferredClaimableSol;
      return sum + amount;
    }, 0);
    const skippedEligible = Math.max(0, sortedClaimables.length - selectedTargets.length);
    const primary = selectedTargets[0];

    return NextResponse.json({
      wallet: wallet.toBase58(),
      rumble_id: primary.rumbleId,
      rumble_id_num: primary.rumbleIdNum,
      rumble_ids: selectedTargets.map((target) => target.rumbleId),
      rumble_id_nums: selectedTargets.map((target) => target.rumbleIdNum),
      claim_count: selectedTargets.length,
      claimable_sol: Number(totalClaimableSol.toFixed(9)),
      onchain_claimable_sol: Number(totalClaimableSol.toFixed(9)),
      skipped_eligible_claims: skippedEligible,
      skipped_by_simulation: skippedBySimulation.length,
      tx_kind: selectedTargets.length > 1 ? "rumble_claim_payout_batch" : "rumble_claim_payout",
      transaction_base64: txBase64,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[RumbleClaimPrepareAPI]", error);
    return NextResponse.json({ error: "Failed to prepare claim transaction" }, { status: 500 });
  }
}
