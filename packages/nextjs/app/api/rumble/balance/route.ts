import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { checkRateLimit, getRateLimitKey, rateLimitResponse } from "~~/lib/rate-limit";
import { getRumblePayoutMode } from "~~/lib/rumble-payout-mode";
import { discoverOnchainWalletPayoutSnapshot } from "~~/lib/rumble-onchain-claims";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const rlKey = getRateLimitKey(request);
  const rl = checkRateLimit("PUBLIC_READ", rlKey);
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

  try {
    const { searchParams } = new URL(request.url);
    const wallet = searchParams.get("wallet") ?? searchParams.get("wallet_address");

    if (!wallet) {
      return NextResponse.json(
        { error: "Missing wallet query parameter" },
        { status: 400 },
      );
    }

    let walletPk: PublicKey;
    try {
      walletPk = new PublicKey(wallet);
    } catch {
      return NextResponse.json({ error: "Invalid wallet address" }, { status: 400 });
    }

    const payoutMode = getRumblePayoutMode();
    const snapshot = await discoverOnchainWalletPayoutSnapshot(walletPk, 80);
    const pendingRumbles = snapshot.claimableRumbles.map((row) => ({
      rumble_id: row.rumbleId,
      claimable_sol: row.inferredClaimableSol,
      onchain_claimable_sol:
        row.onchainClaimableSol > 0 ? row.onchainClaimableSol : row.inferredClaimableSol,
      onchain_claimed_sol: null,
      onchain_rumble_exists: true,
      onchain_rumble_state: row.onchainState,
      onchain_payout_ready: true,
      onchain_bettor_exists: true,
      claim_method: "onchain" as const,
    }));

    const onchainClaimableSolTotal = snapshot.totalClaimableSol;
    const onchainPendingNotReadySol = snapshot.pendingNotReadySol;
    const onchainClaimReady = onchainClaimableSolTotal > 0;

    return NextResponse.json({
      wallet: walletPk.toBase58(),
      payout_mode: payoutMode,
      claimable_sol: onchainClaimableSolTotal,
      legacy_claimable_sol: 0,
      total_pending_claimable_sol: onchainClaimableSolTotal,
      claimed_sol: snapshot.totalClaimedSol,
      unsettled_sol: 0,
      orphaned_stale_sol: 0,
      onchain_claimable_sol_total: onchainClaimableSolTotal,
      onchain_pending_not_ready_sol: onchainPendingNotReadySol,
      onchain_active_exposure_sol: onchainPendingNotReadySol,
      onchain_claim_ready: onchainClaimReady,
      pending_rumbles: pendingRumbles,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[RumbleBalanceAPI]", error);
    return NextResponse.json({ error: "Failed to fetch payout balance" }, { status: 500 });
  }
}
