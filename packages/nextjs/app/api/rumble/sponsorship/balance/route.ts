import { NextResponse } from "next/server";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { checkRateLimit, getRateLimitKey, rateLimitResponse } from "~~/lib/rate-limit";
import {
  readFighterAuthority,
  readSponsorshipClaimableLamports,
} from "~~/lib/solana-programs";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const rlKey = getRateLimitKey(request);
  const rl = checkRateLimit("PUBLIC_READ", rlKey);
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

  try {
    const { searchParams } = new URL(request.url);
    const walletAddress = searchParams.get("wallet") ?? searchParams.get("wallet_address");
    const fighterPubkeyRaw =
      searchParams.get("fighter_pubkey") ??
      searchParams.get("fighter") ??
      searchParams.get("fighter_address");

    if (!walletAddress || !fighterPubkeyRaw) {
      return NextResponse.json(
        { error: "Missing wallet and/or fighter_pubkey query parameter" },
        { status: 400 },
      );
    }

    let wallet: PublicKey;
    let fighterPubkey: PublicKey;
    try {
      wallet = new PublicKey(walletAddress);
      fighterPubkey = new PublicKey(fighterPubkeyRaw);
    } catch {
      return NextResponse.json({ error: "Invalid wallet or fighter_pubkey" }, { status: 400 });
    }

    const authority = await readFighterAuthority(fighterPubkey);
    if (!authority) {
      return NextResponse.json({ error: "Fighter account not found on-chain." }, { status: 404 });
    }
    if (!authority.equals(wallet)) {
      return NextResponse.json(
        { error: "wallet_address is not the authority for this fighter account." },
        { status: 403 },
      );
    }

    const claimableLamports = await readSponsorshipClaimableLamports(fighterPubkey);

    return NextResponse.json({
      wallet: wallet.toBase58(),
      fighter_pubkey: fighterPubkey.toBase58(),
      claimable_lamports: claimableLamports.toString(),
      claimable_sol: Number((Number(claimableLamports) / LAMPORTS_PER_SOL).toFixed(9)),
      claim_ready: claimableLamports > 0n,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[RumbleSponsorshipBalanceAPI]", error);
    return NextResponse.json({ error: "Failed to fetch sponsorship balance" }, { status: 500 });
  }
}
