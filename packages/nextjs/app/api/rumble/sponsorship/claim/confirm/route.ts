import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { utils as anchorUtils } from "@coral-xyz/anchor";
import { checkRateLimit, getRateLimitKey, rateLimitResponse } from "~~/lib/rate-limit";
import { getConnection } from "~~/lib/solana-connection";
import { RUMBLE_ENGINE_ID } from "~~/lib/solana-programs";

export const dynamic = "force-dynamic";

const CLAIM_SPONSORSHIP_DISCRIMINATOR = createHash("sha256")
  .update("global:claim_sponsorship_revenue")
  .digest()
  .subarray(0, 8);

function accountToBase58(value: any): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof value.toBase58 === "function") return value.toBase58();
  return null;
}

export async function POST(request: Request) {
  const rlKey = getRateLimitKey(request);
  const rl = checkRateLimit("PUBLIC_WRITE", rlKey);
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

  try {
    const body = await request.json().catch(() => ({}));
    const walletAddress = body.wallet_address ?? body.walletAddress;
    const fighterPubkeyRaw = body.fighter_pubkey ?? body.fighterPubkey;
    const txSignature = body.tx_signature ?? body.txSignature;

    if (!walletAddress || typeof walletAddress !== "string") {
      return NextResponse.json({ error: "Missing wallet_address" }, { status: 400 });
    }
    if (!fighterPubkeyRaw || typeof fighterPubkeyRaw !== "string") {
      return NextResponse.json({ error: "Missing fighter_pubkey" }, { status: 400 });
    }
    if (!txSignature || typeof txSignature !== "string") {
      return NextResponse.json({ error: "Missing tx_signature" }, { status: 400 });
    }

    let wallet: PublicKey;
    let fighterPubkey: PublicKey;
    try {
      wallet = new PublicKey(walletAddress);
      fighterPubkey = new PublicKey(fighterPubkeyRaw);
    } catch {
      return NextResponse.json({ error: "Invalid wallet_address or fighter_pubkey" }, { status: 400 });
    }

    const connection = getConnection();
    // Retry a few times — client uses fire-and-forget so tx may not be confirmed yet.
    let tx = await connection.getParsedTransaction(txSignature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    if (!tx) {
      for (let i = 0; i < 3; i++) {
        await new Promise(r => setTimeout(r, 2000));
        tx = await connection.getParsedTransaction(txSignature, {
          maxSupportedTransactionVersion: 0,
          commitment: "confirmed",
        });
        if (tx) break;
      }
    }
    if (!tx) {
      return NextResponse.json(
        { error: "Transaction not found after retries. Wait and retry." },
        { status: 404 },
      );
    }
    if (tx.meta?.err) {
      return NextResponse.json({ error: "Transaction failed on-chain." }, { status: 400 });
    }

    const signerMatch = tx.transaction.message.accountKeys.some(
      (k: any) => k.signer && k.pubkey.toBase58() === wallet.toBase58(),
    );
    if (!signerMatch) {
      return NextResponse.json(
        { error: "Claim transaction signer does not match wallet_address." },
        { status: 400 },
      );
    }

    let hasClaimInstruction = false;
    for (const ix of tx.transaction.message.instructions) {
      try {
        const ixAny = ix as any;
        if (ixAny.programId?.toBase58?.() !== RUMBLE_ENGINE_ID.toBase58()) continue;
        if (typeof ixAny.data !== "string") continue;

        const raw = anchorUtils.bytes.bs58.decode(ixAny.data);
        if (raw.length < 8) continue;
        if (!Buffer.from(raw.subarray(0, 8)).equals(CLAIM_SPONSORSHIP_DISCRIMINATOR)) continue;

        const fighterAccount = Array.isArray(ixAny.accounts) ? ixAny.accounts[1] : null;
        const ixFighter = accountToBase58(fighterAccount);
        if (!ixFighter) continue;
        if (ixFighter !== fighterPubkey.toBase58()) continue;

        hasClaimInstruction = true;
        break;
      } catch {
        // continue scanning
      }
    }

    if (!hasClaimInstruction) {
      return NextResponse.json(
        { error: "Transaction does not include claim_sponsorship_revenue for this fighter_pubkey." },
        { status: 400 },
      );
    }

    return NextResponse.json({
      wallet: wallet.toBase58(),
      fighter_pubkey: fighterPubkey.toBase58(),
      tx_signature: txSignature,
      claim_confirmed: true,
      claim_source: "onchain",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[RumbleSponsorshipClaimConfirmAPI]", error);
    return NextResponse.json({ error: "Failed to confirm sponsorship claim" }, { status: 500 });
  }
}
