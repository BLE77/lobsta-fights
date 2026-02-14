import { NextResponse } from "next/server";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { checkRateLimit, getRateLimitKey, rateLimitResponse } from "~~/lib/rate-limit";
import {
  buildClaimSponsorshipTx,
  readFighterAuthority,
  readSponsorshipClaimableLamports,
} from "~~/lib/solana-programs";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const rlKey = getRateLimitKey(request);
  const rl = checkRateLimit("PUBLIC_WRITE", rlKey);
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

  try {
    const body = await request.json().catch(() => ({}));
    const walletAddress = body.wallet_address ?? body.walletAddress;
    const fighterPubkeyRaw = body.fighter_pubkey ?? body.fighterPubkey;

    if (!walletAddress || typeof walletAddress !== "string") {
      return NextResponse.json({ error: "Missing wallet_address" }, { status: 400 });
    }
    if (!fighterPubkeyRaw || typeof fighterPubkeyRaw !== "string") {
      return NextResponse.json({ error: "Missing fighter_pubkey" }, { status: 400 });
    }

    let wallet: PublicKey;
    let fighterPubkey: PublicKey;
    try {
      wallet = new PublicKey(walletAddress);
      fighterPubkey = new PublicKey(fighterPubkeyRaw);
    } catch {
      return NextResponse.json({ error: "Invalid wallet_address or fighter_pubkey" }, { status: 400 });
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
    if (claimableLamports <= 0n) {
      return NextResponse.json(
        { error: "No sponsorship claimable balance for this fighter yet." },
        { status: 409 },
      );
    }

    const tx = await buildClaimSponsorshipTx(wallet, fighterPubkey);
    const txBytes = tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });
    const txBase64 = Buffer.from(txBytes).toString("base64");

    return NextResponse.json({
      wallet: wallet.toBase58(),
      fighter_pubkey: fighterPubkey.toBase58(),
      claimable_lamports: claimableLamports.toString(),
      claimable_sol: Number((Number(claimableLamports) / LAMPORTS_PER_SOL).toFixed(9)),
      tx_kind: "rumble_claim_sponsorship",
      transaction_base64: txBase64,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[RumbleSponsorshipClaimPrepareAPI]", error);
    return NextResponse.json({ error: "Failed to prepare sponsorship claim" }, { status: 500 });
  }
}
