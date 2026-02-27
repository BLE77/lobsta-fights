import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { checkRateLimit, getRateLimitKey, rateLimitResponse } from "~~/lib/rate-limit";
import { getRumblePayoutMode } from "~~/lib/rumble-payout-mode";
import {
  discoverOnchainWalletPayoutSnapshot,
  type OnchainWalletPayoutSnapshot,
} from "~~/lib/rumble-onchain-claims";
import { getBettingRpcEndpoint } from "~~/lib/solana-connection";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Server-side cache for wallet payout snapshots.
// getProgramAccounts is VERY expensive on Helius (~100-500 credits per call).
// Caching for 10 seconds avoids burning credits on rapid re-polls.
// ---------------------------------------------------------------------------
const CACHE_TTL_MS = 10_000;
const snapshotCache = new Map<
  string,
  { snapshot: OnchainWalletPayoutSnapshot; fetchedAt: number }
>();

// Evict stale entries periodically (avoid unbounded growth)
function evictStale() {
  const now = Date.now();
  for (const [key, entry] of snapshotCache) {
    if (now - entry.fetchedAt > CACHE_TTL_MS * 3) snapshotCache.delete(key);
  }
}

async function getCachedSnapshot(
  walletPk: PublicKey,
  limit: number,
): Promise<OnchainWalletPayoutSnapshot> {
  const key = walletPk.toBase58();
  const cached = snapshotCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.snapshot;
  }
  const snapshot = await discoverOnchainWalletPayoutSnapshot(walletPk, limit);
  snapshotCache.set(key, { snapshot, fetchedAt: Date.now() });
  if (snapshotCache.size > 200) evictStale();
  return snapshot;
}

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

    const debug = searchParams.get("debug") === "1";
    const payoutMode = getRumblePayoutMode();
    const snapshot = await getCachedSnapshot(walletPk, 80);

    // The snapshot already validates on-chain state: payout ready, not claimed,
    // winner deployment > 0. No simulation needed — claim tx is built at claim time.
    const pendingRumbles = snapshot.claimableRumbles.map((row) => ({
      rumble_id: row.rumbleId,
      claimable_sol: row.onchainClaimableSol > 0 ? row.onchainClaimableSol : row.inferredClaimableSol,
      onchain_claimable_sol: row.onchainClaimableSol > 0 ? row.onchainClaimableSol : null,
      onchain_claimed_sol: null,
      onchain_rumble_exists: true,
      onchain_rumble_state: row.onchainState,
      onchain_payout_ready: true,
      onchain_bettor_exists: true,
      claim_method: "onchain" as const,
    }));

    const onchainClaimableSolTotal = pendingRumbles.reduce(
      (sum, row) => sum + row.claimable_sol,
      0,
    );
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
      ...(debug ? {
        _debug: {
          rpc_endpoint: getBettingRpcEndpoint().replace(/api[_-]key=[^&]+/, "api-key=REDACTED"),
          snapshot_claimable_count: snapshot.claimableRumbles.length,
          cached: !!snapshotCache.get(walletPk.toBase58()),
        },
      } : {}),
    });
  } catch (error) {
    console.error("[RumbleBalanceAPI]", error);
    return NextResponse.json({ error: "Failed to fetch payout balance" }, { status: 500 });
  }
}
