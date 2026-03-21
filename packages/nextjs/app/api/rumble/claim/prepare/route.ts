import { NextResponse } from "next/server";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { checkRateLimit, getRateLimitKey, rateLimitResponse } from "~~/lib/rate-limit";
import { isAccrueClaimMode } from "~~/lib/rumble-payout-mode";
import {
  buildClaimPayoutTx,
  buildClaimPayoutBatchTx,
  deriveVaultPdaMainnet,
  RUMBLE_ENGINE_ID_MAINNET,
} from "~~/lib/solana-programs";
import {
  discoverOnchainClaimableRumbles,
  OnchainClaimDiscoveryError,
} from "~~/lib/rumble-onchain-claims";
import { getBettingConnection, getCachedBalance } from "~~/lib/solana-connection";
import { requireJsonContentType, sanitizeErrorResponse } from "~~/lib/api-middleware";
import { parseOnchainRumbleIdNumber } from "~~/lib/rumble-id";

export const dynamic = "force-dynamic";
const SOLANA_LEGACY_TX_MAX_BYTES = 1232;

// Vault PDAs are ephemeral wager buckets that can be fully drained on-chain.
// No rent headroom needed — just ensure vault can cover estimated payout.
const VAULT_HEADROOM_LAMPORTS = 0;

function isRateLimitedRpcError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /429|too many requests|rate limit|rate-limited/i.test(msg);
}

function summarizeBuildError(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

const LEGACY_CLAIMS_RESPONSE_META = {
  claim_scope: "mainnet_onchain_current_program_only",
  legacy_claimable_sol: null,
  legacy_claims_supported: false,
  legacy_claims_excluded: true,
  legacy_claims_status: "excluded_unknown",
  legacy_claims_note:
    "Legacy betting-program claims are excluded from this endpoint. A missing current-program claim here does not rule out older claims.",
} as const;

export async function POST(request: Request) {
  const rlKey = getRateLimitKey(request);
  const rl = checkRateLimit("PUBLIC_WRITE", rlKey, "/api/rumble/claim/prepare");
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);
  const contentTypeError = requireJsonContentType(request);
  if (contentTypeError) return contentTypeError;

  try {
    if (!isAccrueClaimMode()) {
      return NextResponse.json(
        { error: "Claim flow is disabled (RUMBLE_PAYOUT_MODE is not accrue_claim).", ...LEGACY_CLAIMS_RESPONSE_META },
        { status: 409 },
      );
    }

    const body = await request.json().catch(() => ({}));
    const walletAddress = body.wallet_address ?? body.walletAddress;
    const requestedRumbleId = body.rumble_id ?? body.rumbleId;
    const requestedRumbleIdNormalized =
      typeof requestedRumbleId === "string" && requestedRumbleId.trim().length > 0
        ? requestedRumbleId.trim()
        : null;

    if (!walletAddress || typeof walletAddress !== "string") {
      return NextResponse.json({ error: "Missing wallet_address" }, { status: 400 });
    }

    let wallet: PublicKey;
    try {
      wallet = new PublicKey(walletAddress);
    } catch {
      return NextResponse.json({ error: "Invalid wallet address" }, { status: 400 });
    }

    if (requestedRumbleIdNormalized && parseOnchainRumbleIdNumber(requestedRumbleIdNormalized) === null) {
      return NextResponse.json(
        { error: "Invalid rumble_id", ...LEGACY_CLAIMS_RESPONSE_META },
        { status: 400 },
      );
    }

    let claimables;
    try {
      claimables = await discoverOnchainClaimableRumbles(wallet, {
        limit: requestedRumbleIdNormalized ? 1 : 250,
        specificRumbleId: requestedRumbleIdNormalized,
      });
    } catch (error) {
      console.error("[RumbleClaimPrepareAPI] claim discovery failed", error);
      const reason =
        error instanceof OnchainClaimDiscoveryError
          ? error.reason
          : isRateLimitedRpcError(error)
            ? "rpc_rate_limited"
            : "rpc_unavailable";
      return NextResponse.json(
        {
          error: "Live claim discovery is temporarily unavailable. Retry shortly.",
          reason,
          ...LEGACY_CLAIMS_RESPONSE_META,
        },
        { status: 503 },
      );
    }
    if (claimables.length === 0) {
      return NextResponse.json(
        {
          error: requestedRumbleIdNormalized
            ? "The requested rumble has no claimable payout for this wallet on the current betting program."
            : "No on-chain claimable rumble payouts found for this wallet on the current betting program.",
          requested_rumble_id: requestedRumbleIdNormalized,
          ...LEGACY_CLAIMS_RESPONSE_META,
        },
        { status: 404 },
      );
    }

    const requestedTarget = requestedRumbleIdNormalized
      ? claimables.find((row) => row.rumbleId === requestedRumbleIdNormalized)
      : null;
    if (requestedRumbleIdNormalized && !requestedTarget) {
      return NextResponse.json(
        {
          error: "Requested rumble has no on-chain claimable payout for this wallet.",
          requested_rumble_id: requestedRumbleIdNormalized,
          ...LEGACY_CLAIMS_RESPONSE_META,
        },
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
        {
          error: "No on-chain claimable payout found for this wallet.",
          reason: "none_ready",
          requested_rumble_id: requestedRumbleIdNormalized,
          ...LEGACY_CLAIMS_RESPONSE_META,
        },
        { status: 409 },
      );
    }

    // Check vault balances to skip underfunded vaults that would cause
    // InsufficientVaultFunds on-chain. This replaces the broken simulateTransaction.
    const connection = getBettingConnection();
    const fundedTargets: typeof selectedTargets = [];
    const skippedCount = { underfunded: 0 };
    const vaultBalances = new Map<number, number>();
    let vaultBalanceLookupReason: "rpc_rate_limited" | "rpc_unavailable" | null = null;

    try {
      const vaultPdas = selectedTargets.map((target) => deriveVaultPdaMainnet(target.rumbleIdNum)[0]);
      const infos = await connection.getMultipleAccountsInfo(vaultPdas, "confirmed");
      for (let i = 0; i < selectedTargets.length; i++) {
        vaultBalances.set(selectedTargets[i].rumbleIdNum, infos[i]?.lamports ?? 0);
      }
    } catch (err) {
      if (isRateLimitedRpcError(err)) {
        return NextResponse.json(
          {
            error: "Claim funding checks are temporarily rate-limited. Retry shortly.",
            reason: "rpc_rate_limited",
            ...LEGACY_CLAIMS_RESPONSE_META,
          },
          { status: 503 },
        );
      } else {
        // Fallback for providers that intermittently fail multi-account reads.
        for (const target of selectedTargets) {
          try {
            const [vaultPda] = deriveVaultPdaMainnet(target.rumbleIdNum);
            const vaultBalance = await getCachedBalance(connection, vaultPda, {
              commitment: "confirmed",
              ttlMs: 30_000,
            });
            vaultBalances.set(target.rumbleIdNum, vaultBalance);
          } catch (balanceError) {
            vaultBalanceLookupReason = isRateLimitedRpcError(balanceError)
              ? "rpc_rate_limited"
              : "rpc_unavailable";
            break;
          }
        }
      }
    }

    if (vaultBalanceLookupReason) {
      return NextResponse.json(
        {
          error: "Claim funding checks are temporarily unavailable. Retry shortly.",
          reason: vaultBalanceLookupReason,
          ...LEGACY_CLAIMS_RESPONSE_META,
        },
        { status: 503 },
      );
    }

    for (const target of selectedTargets) {
      try {
        const vaultBalance = vaultBalances.get(target.rumbleIdNum) ?? 0;
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
          ...LEGACY_CLAIMS_RESPONSE_META,
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
            ? await buildClaimPayoutTx(wallet, selectedTargets[0].rumbleIdNum, connection, RUMBLE_ENGINE_ID_MAINNET)
            : await buildClaimPayoutBatchTx(
                wallet,
                selectedTargets.map((target) => target.rumbleIdNum),
                connection,
                RUMBLE_ENGINE_ID_MAINNET,
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
      requested_rumble_id: requestedRumbleIdNormalized,
      claim_count: selectedTargets.length,
      claimable_sol: Number(totalClaimableSol.toFixed(9)),
      onchain_claimable_sol: Number(totalClaimableSol.toFixed(9)),
      skipped_eligible_claims: skippedEligible,
      skipped_underfunded: skippedCount.underfunded,
      tx_kind: selectedTargets.length > 1 ? "rumble_claim_payout_batch" : "rumble_claim_payout",
      transaction_base64: txBase64,
      ...LEGACY_CLAIMS_RESPONSE_META,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[RumbleClaimPrepareAPI]", error);
    return NextResponse.json(sanitizeErrorResponse(error, "Failed to prepare claim transaction"), { status: 500 });
  }
}
