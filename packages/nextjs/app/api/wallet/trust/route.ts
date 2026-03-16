import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit, getRateLimitKey, rateLimitResponse } from "~~/lib/rate-limit";
import { getWalletTrustSnapshot } from "~~/lib/wallet-trust-status";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const rlKey = getRateLimitKey(request);
  const rl = checkRateLimit("PUBLIC_READ", rlKey, "/api/wallet/trust");
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

  const { searchParams } = new URL(request.url);
  const walletAddress = String(searchParams.get("wallet") ?? "").trim();

  if (!walletAddress) {
    return NextResponse.json({
      endpoint: "GET /api/wallet/trust?wallet=<SOLANA_WALLET>",
      description: "Check whether a wallet is trusted for fighter auto-approval before registration.",
      returns: {
        walletAddress: "Normalized wallet address",
        trust: {
          approved: "Whether this wallet auto-qualifies for fighter verification",
          source: "env_allowlist | manual_allowlist | seeker_genesis | null",
          label: "Human-friendly trust label",
          reason: "Why the wallet was or was not trusted",
          sgtAssetId: "Detected Seeker Genesis asset mint when applicable",
        },
        delegate: {
          configured: "Whether the server can derive the default SeekerClaw delegate for this wallet",
          authorized: "Whether an active on-chain fighter delegate is already authorized",
          revoked: "Whether a delegate exists but is revoked",
          expectedAuthority: "Default SeekerClaw delegate authority for this wallet",
          onchainAuthority: "Currently authorized on-chain delegate authority",
          matchesExpectedAuthority: "Whether the current delegate matches the trusted SeekerClaw delegate",
          nextAction: "authorize_delegate | rebind_delegate | ready_for_seekerclaw",
        },
        fighter: "Existing fighter for this wallet, if any",
        canRegister: "Whether the wallet can create a new fighter now",
        canQueue: "Whether the current fighter is verified and queue-ready",
        canAutoVerifyExistingFighter: "Whether a signed registration retry would auto-verify an existing pending fighter",
        nextAction: "register_fighter_now | queue_existing_fighter | retry_signed_registration | manual_allowlist_required",
      },
    });
  }

  const snapshot = await getWalletTrustSnapshot(walletAddress);
  if (!snapshot) {
    return NextResponse.json({ error: "Invalid wallet address" }, { status: 400 });
  }

  return NextResponse.json(snapshot);
}
