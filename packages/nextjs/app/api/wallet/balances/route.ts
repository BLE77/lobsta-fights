import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { checkRateLimit, getRateLimitKey, rateLimitResponse } from "~~/lib/rate-limit";
import { getWalletBalances } from "~~/lib/solana-wallet";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const rlKey = getRateLimitKey(request);
  const rl = checkRateLimit("PUBLIC_READ", rlKey);
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

  try {
    const { searchParams } = new URL(request.url);
    const wallet = searchParams.get("wallet") ?? searchParams.get("wallet_address");

    if (!wallet) {
      return NextResponse.json({ error: "Missing wallet query parameter" }, { status: 400 });
    }

    let walletPk: PublicKey;
    try {
      walletPk = new PublicKey(wallet);
    } catch {
      return NextResponse.json({ error: "Invalid wallet address" }, { status: 400 });
    }

    const balances = await getWalletBalances(walletPk.toBase58());
    return NextResponse.json({
      wallet: walletPk.toBase58(),
      ...balances,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[WalletBalancesAPI]", error);
    return NextResponse.json({ error: "Failed to fetch wallet balances" }, { status: 500 });
  }
}
