import { NextRequest, NextResponse } from "next/server";
import {
  consumeNonce,
  decodeBase64,
  MobileSiwsPayload,
  MobileSiwsResult,
  readNonce,
  toBase58Address,
  verifyEd25519Bytes,
} from "~~/lib/mobile-siws";
import { checkRateLimit, getRateLimitKey, rateLimitResponse } from "~~/lib/rate-limit";

export const dynamic = "force-dynamic";

function includesIfPresent(haystack: string, needle?: string): boolean {
  if (!needle) return true;
  return haystack.includes(needle);
}

export async function POST(request: NextRequest) {
  const rlKey = getRateLimitKey(request);
  const rl = checkRateLimit("PUBLIC_WRITE", rlKey, "/api/mobile-auth/verify");
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

  let body: {
    walletAddress?: string;
    signInPayload?: MobileSiwsPayload;
    signInResult?: MobileSiwsResult;
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const walletAddress = String(body.walletAddress ?? "").trim();
  const signInPayload = body.signInPayload;
  const signInResult = body.signInResult;

  if (!signInPayload || !signInResult) {
    return NextResponse.json({ error: "Missing signInPayload or signInResult" }, { status: 400 });
  }

  if (!signInPayload.nonce || typeof signInPayload.nonce !== "string") {
    return NextResponse.json({ error: "Missing sign-in nonce" }, { status: 400 });
  }
  const nonceRecord = await readNonce(signInPayload.nonce);
  if (!nonceRecord) {
    return NextResponse.json({ error: "Invalid or expired nonce" }, { status: 401 });
  }
  if (signInPayload.issuedAt && signInPayload.issuedAt !== nonceRecord.issuedAt) {
    return NextResponse.json({ error: "Sign-in nonce issuedAt mismatch" }, { status: 401 });
  }

  try {
    const addressBytes = decodeBase64(signInResult.address);
    const signedMessageBytes = decodeBase64(signInResult.signed_message);
    const signatureBytes = decodeBase64(signInResult.signature);
    const messageText = Buffer.from(signedMessageBytes).toString("utf8");
    const verifiedWallet = toBase58Address(signInResult.address);

    if (walletAddress && walletAddress !== verifiedWallet) {
      return NextResponse.json({ error: "Wallet mismatch" }, { status: 401 });
    }

    const signatureOk = verifyEd25519Bytes({
      publicKeyBytes: addressBytes,
      messageBytes: signedMessageBytes,
      signatureBytes,
    });
    if (!signatureOk) {
      return NextResponse.json({ error: "Invalid SIWS signature" }, { status: 401 });
    }

    if (!includesIfPresent(messageText, signInPayload.nonce)) {
      return NextResponse.json({ error: "Signed message missing nonce" }, { status: 401 });
    }
    if (!includesIfPresent(messageText, signInPayload.domain)) {
      return NextResponse.json({ error: "Signed message missing domain" }, { status: 401 });
    }
    if (!includesIfPresent(messageText, signInPayload.statement)) {
      return NextResponse.json({ error: "Signed message missing statement" }, { status: 401 });
    }
    const consumed = await consumeNonce(signInPayload.nonce);
    if (!consumed) {
      return NextResponse.json({ error: "Nonce already used or expired" }, { status: 401 });
    }

    return NextResponse.json({
      ok: true,
      walletAddress: verifiedWallet,
      domain: signInPayload.domain ?? null,
      issuedAt: nonceRecord.issuedAt,
    });
  } catch (error) {
    console.error("[Mobile Auth Verify] SIWS error:", error);
    return NextResponse.json({ error: "Verification failed" }, { status: 400 });
  }
}
