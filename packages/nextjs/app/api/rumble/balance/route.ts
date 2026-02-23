import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { checkRateLimit, getRateLimitKey, rateLimitResponse } from "~~/lib/rate-limit";
import { getRumblePayoutMode } from "~~/lib/rumble-payout-mode";
import {
  discoverOnchainWalletPayoutSnapshot,
  type OnchainClaimableRumble,
} from "~~/lib/rumble-onchain-claims";
import { getConnection, getRpcEndpoint } from "~~/lib/solana-connection";
import { buildClaimPayoutTx } from "~~/lib/solana-programs";

export const dynamic = "force-dynamic";
const MAX_EXECUTABLE_CHECKS = 80;

interface SimDebugEntry {
  rumbleId: string;
  error?: string;
  simErr?: unknown;
  logs?: string[];
}

async function filterExecutableClaims(
  wallet: PublicKey,
  rows: OnchainClaimableRumble[],
  debugLog?: SimDebugEntry[],
): Promise<OnchainClaimableRumble[]> {
  if (rows.length === 0) return [];

  const connection = getConnection();
  const executable: OnchainClaimableRumble[] = [];

  for (const row of rows.slice(0, MAX_EXECUTABLE_CHECKS)) {
    try {
      const tx = await buildClaimPayoutTx(wallet, row.rumbleIdNum, connection);
      const sim = await (connection as any).simulateTransaction(tx, {
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: "processed",
      });
      if (!sim.value.err) {
        executable.push(row);
      } else {
        debugLog?.push({ rumbleId: row.rumbleId, simErr: sim.value.err, logs: sim.value.logs?.slice(-5) });
      }
    } catch (e: any) {
      debugLog?.push({ rumbleId: row.rumbleId, error: e?.message ?? String(e) });
    }
  }

  return executable;
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
    const snapshot = await discoverOnchainWalletPayoutSnapshot(walletPk, 80);
    const simDebug: SimDebugEntry[] = [];
    const executableClaims = await filterExecutableClaims(walletPk, snapshot.claimableRumbles, debug ? simDebug : undefined);
    const pendingRumbles = executableClaims.map((row) => ({
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
          rpc_endpoint: getRpcEndpoint().replace(/api[_-]key=[^&]+/, "api-key=REDACTED"),
          snapshot_claimable_count: snapshot.claimableRumbles.length,
          snapshot_claimable_rumbles: snapshot.claimableRumbles.map(r => ({
            id: r.rumbleId,
            state: r.onchainState,
            claimable: r.onchainClaimableSol,
            inferred: r.inferredClaimableSol,
          })),
          executable_count: executableClaims.length,
          sim_failures: simDebug,
        },
      } : {}),
    });
  } catch (error) {
    console.error("[RumbleBalanceAPI]", error);
    return NextResponse.json({ error: "Failed to fetch payout balance" }, { status: 500 });
  }
}
