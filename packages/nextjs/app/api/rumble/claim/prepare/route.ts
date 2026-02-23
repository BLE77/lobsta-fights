import { NextResponse } from "next/server";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { checkRateLimit, getRateLimitKey, rateLimitResponse } from "~~/lib/rate-limit";
import { isAccrueClaimMode } from "~~/lib/rumble-payout-mode";
import {
  buildClaimPayoutTx,
  buildClaimPayoutBatchTx,
  deriveVaultPda,
} from "~~/lib/solana-programs";
import { discoverOnchainClaimableRumbles } from "~~/lib/rumble-onchain-claims";
import { getConnection } from "~~/lib/solana-connection";
import { requireJsonContentType, sanitizeErrorResponse } from "~~/lib/api-middleware";

export const dynamic = "force-dynamic";
const SOLANA_LEGACY_TX_MAX_BYTES = 1232;

// Minimum vault balance (in lamports) required above the payout estimate.
// Covers rent-exempt minimum + tx fee headroom.
const VAULT_HEADROOM_LAMPORTS = 10_000;

function summarizeBuildError(err: unknown): string {
  if (err instanceof Error) return err.message;
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
  const contentTypeError = requireJsonContentType(request);
  if (contentTypeError) return contentTypeError;

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

    // Check vault balances to skip underfunded vaults that would cause
    // InsufficientVaultFunds on-chain. This replaces the broken simulateTransaction.
    const connection = getConnection();
    const fundedTargets: typeof selectedTargets = [];
    const skippedCount = { underfunded: 0 };

    for (const target of selectedTargets) {
      try {
        const [vaultPda] = deriveVaultPda(target.rumbleIdNum);
        const vaultBalance = await connection.getBalance(vaultPda, "confirmed");
        const estimatedPayoutLamports = Math.round(
          (target.onchainClaimableSol > 0 ? target.onchainClaimableSol : target.inferredClaimableSol) * LAMPORTS_PER_SOL,
        );
        if (vaultBalance >= estimatedPayoutLamports + VAULT_HEADROOM_LAMPORTS) {
          fundedTargets.push(target);
        } else {
          skippedCount.underfunded++;
        }
      } catch {
        // Skip on RPC error — conservative approach
        skippedCount.underfunded++;
      }
    }

    selectedTargets = fundedTargets;
    if (selectedTargets.length === 0) {
      return NextResponse.json(
        {
          error: "All claimable rumble vaults are currently underfunded.",
          reason: "vaults_underfunded",
          underfunded_count: skippedCount.underfunded,
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
      } catch (err: any) {
        const errorText = summarizeBuildError(err).toLowerCase();
        const sizeError =
          errorText.includes("too large") ||
          errorText.includes("encoding overruns") ||
          errorText.includes("rangeerror");
        if (sizeError && selectedTargets.length > 1) {
          selectedTargets = selectedTargets.slice(0, -1);
          continue;
        }
        throw err;
      }

      break;
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
      skipped_underfunded: skippedCount.underfunded,
      tx_kind: selectedTargets.length > 1 ? "rumble_claim_payout_batch" : "rumble_claim_payout",
      transaction_base64: txBase64,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[RumbleClaimPrepareAPI]", error);
    return NextResponse.json(sanitizeErrorResponse(error, "Failed to prepare claim transaction"), { status: 500 });
  }
}
