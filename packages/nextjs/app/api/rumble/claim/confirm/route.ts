import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { utils as anchorUtils } from "@coral-xyz/anchor";
import { checkRateLimit, getRateLimitKey, rateLimitResponse } from "~~/lib/rate-limit";
import { isAccrueClaimMode } from "~~/lib/rumble-payout-mode";
import { getBettingConnection } from "~~/lib/solana-connection";
import { RUMBLE_ENGINE_ID_MAINNET, deriveRumblePdaMainnet } from "~~/lib/solana-programs";
import { parseOnchainRumbleIdNumber } from "~~/lib/rumble-id";
import { requireJsonContentType, sanitizeErrorResponse } from "~~/lib/api-middleware";

export const dynamic = "force-dynamic";
const CLAIM_PAYOUT_DISCRIMINATOR = createHash("sha256")
  .update("global:claim_payout")
  .digest()
  .subarray(0, 8);

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
    const rumbleId = body.rumble_id ?? body.rumbleId;
    const rumbleIdsRaw = body.rumble_ids ?? body.rumbleIds;
    const txSignature = body.tx_signature ?? body.txSignature;

    if (!walletAddress || typeof walletAddress !== "string") {
      return NextResponse.json({ error: "Missing wallet_address" }, { status: 400 });
    }
    const requestedRumbleIds = Array.isArray(rumbleIdsRaw)
      ? [...new Set(rumbleIdsRaw
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim())
          .filter((value) => value.length > 0))]
      : typeof rumbleId === "string" && rumbleId.trim().length > 0
        ? [rumbleId.trim()]
        : [];
    if (requestedRumbleIds.length === 0) {
      return NextResponse.json({ error: "Missing rumble_id or rumble_ids" }, { status: 400 });
    }
    if (requestedRumbleIds.length > 20) {
      return NextResponse.json({ error: "Maximum 20 rumble claims per batch" }, { status: 400 });
    }
    if (!txSignature || typeof txSignature !== "string") {
      return NextResponse.json({ error: "Missing tx_signature" }, { status: 400 });
    }

    let walletPk: PublicKey;
    try {
      walletPk = new PublicKey(walletAddress);
    } catch {
      return NextResponse.json({ error: "Invalid wallet address" }, { status: 400 });
    }

    const requestedRumbleMeta = requestedRumbleIds.map((id) => {
      const rumbleIdNum = parseOnchainRumbleIdNumber(id);
      return {
        rumbleId: id,
        rumbleIdNum,
        rumblePda: rumbleIdNum === null ? null : deriveRumblePdaMainnet(rumbleIdNum)[0],
      };
    });
    const invalidRumble = requestedRumbleMeta.find((entry) => entry.rumbleIdNum === null);
    if (invalidRumble) {
      return NextResponse.json(
        { error: `Invalid rumble_id format: ${invalidRumble.rumbleId}` },
        { status: 400 },
      );
    }

    const connection = getBettingConnection();
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
      const errDetail = typeof tx.meta.err === "object" ? JSON.stringify(tx.meta.err) : String(tx.meta.err);
      return NextResponse.json(
        { error: `Transaction failed on-chain: ${errDetail}`, onchain_error: tx.meta.err },
        { status: 400 },
      );
    }

    const walletBase58 = walletPk.toBase58();
    const engineBase58 = RUMBLE_ENGINE_ID_MAINNET.toBase58();

    // getParsedTransaction may return pubkey as PublicKey object or string
    const toBase58Safe = (val: any): string | null => {
      if (typeof val?.toBase58 === "function") return val.toBase58();
      if (typeof val === "string" && val.length > 0) return val;
      return null;
    };

    const signerMatch = tx.transaction.message.accountKeys.some(
      (k: any) => k.signer && toBase58Safe(k.pubkey) === walletBase58,
    );
    if (!signerMatch) {
      return NextResponse.json(
        { error: "Claim transaction signer does not match wallet_address." },
        { status: 400 },
      );
    }

    const claimedRumblePdas = new Set<string>();
    const hasClaimInstruction = tx.transaction.message.instructions.some((ix: any) => {
      try {
        if (toBase58Safe(ix.programId) !== engineBase58) return false;
        if (typeof ix.data !== "string") return false;
        const raw = anchorUtils.bytes.bs58.decode(ix.data);
        if (raw.length < 8) return false;
        const isClaim = Buffer.from(raw.subarray(0, 8)).equals(CLAIM_PAYOUT_DISCRIMINATOR);
        if (!isClaim) return false;
        const rumbleAccount = Array.isArray(ix.accounts) ? ix.accounts[1] : null;
        const rumblePda = toBase58Safe(rumbleAccount);
        if (rumblePda) {
          claimedRumblePdas.add(rumblePda);
        }
        return true;
      } catch {
        return false;
      }
    });
    if (!hasClaimInstruction) {
      return NextResponse.json(
        { error: "Transaction does not include a claim_payout rumble instruction." },
        { status: 400 },
      );
    }

    const missingRumbleClaims = requestedRumbleMeta.filter(
      (entry) => entry.rumblePda && !claimedRumblePdas.has(entry.rumblePda.toBase58()),
    );
    if (missingRumbleClaims.length > 0) {
      return NextResponse.json(
        {
          error: "Transaction does not include claim_payout for all requested rumbles.",
          missing_rumble_ids: missingRumbleClaims.map((entry) => entry.rumbleId),
        },
        { status: 400 },
      );
    }

    return NextResponse.json({
      wallet: walletPk.toBase58(),
      rumble_id: requestedRumbleIds[0],
      rumble_ids: requestedRumbleIds,
      tx_signature: txSignature,
      claims_confirmed: requestedRumbleIds.length,
      claim_source: "onchain",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[RumbleClaimConfirmAPI]", error);
    return NextResponse.json(sanitizeErrorResponse(error, "Failed to confirm claim transaction"), { status: 500 });
  }
}
