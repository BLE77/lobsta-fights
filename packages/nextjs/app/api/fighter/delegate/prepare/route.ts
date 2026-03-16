import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import {
  buildAuthorizeFighterDelegateTx,
  buildRevokeFighterDelegateTx,
  deriveFighterDelegatePda,
  deriveFighterDelegateSigner,
  readFighterDelegateState,
} from "~~/lib/solana-programs";
import { getConnection } from "~~/lib/solana-connection";
import { checkRateLimit, getRateLimitKey, rateLimitResponse } from "~~/lib/rate-limit";
import { requireJsonContentType } from "~~/lib/api-middleware";

export const dynamic = "force-dynamic";

type DelegateAction = "authorize" | "revoke" | "rotate" | "rebind";

function normalizeAction(raw: unknown): DelegateAction {
  const value = String(raw ?? "authorize").trim().toLowerCase();
  if (value === "revoke") return "revoke";
  if (value === "rotate") return "rotate";
  if (value === "rebind") return "rebind";
  return "authorize";
}

export async function GET(request: Request) {
  const rlKey = getRateLimitKey(request);
  const rl = checkRateLimit("PUBLIC_READ", rlKey);
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

  return NextResponse.json({
    endpoint: "POST /api/fighter/delegate/prepare",
    description:
      "Prepare a fighter-signed transaction that authorizes or revokes the persistent SeekerClaw move delegate for this fighter.",
    body: {
      wallet_address: "Fighter wallet public key",
      action: "authorize | revoke | rotate | rebind (default authorize)",
      authority: "Optional override delegate public key. Defaults to the trusted SeekerClaw delegate derived by the server.",
    },
    notes: [
      "Authorize once and SeekerClaw can keep choosing moves for future rumbles without per-turn wallet signatures.",
      "The server sponsors this devnet transaction so the fighter wallet does not need devnet SOL.",
      "Submit the signed transaction through POST /api/rumble/submit-tx with fighter_id, x-api-key, and tx_type matching the returned value.",
    ],
  });
}

export async function POST(req: Request) {
  const ctCheck = requireJsonContentType(req);
  if (ctCheck) return ctCheck;

  const rlKey = getRateLimitKey(req);
  const rl = checkRateLimit("PUBLIC_WRITE", rlKey, "/api/fighter/delegate/prepare");
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

  try {
    const body = await req.json();
    const walletAddress = String(body?.wallet_address ?? body?.walletAddress ?? "").trim();
    if (!walletAddress) {
      return NextResponse.json({ error: "Missing wallet_address" }, { status: 400 });
    }

    let fighter: PublicKey;
    try {
      fighter = new PublicKey(walletAddress);
    } catch {
      return NextResponse.json({ error: "Invalid wallet_address" }, { status: 400 });
    }

    const action = normalizeAction(body?.action);
    const authorityRaw = String(body?.authority ?? "").trim();
    let requestedAuthority: PublicKey | null = null;
    if (authorityRaw) {
      try {
        requestedAuthority = new PublicKey(authorityRaw);
      } catch {
        return NextResponse.json({ error: "Invalid authority" }, { status: 400 });
      }
    }

    const defaultDelegateSigner = deriveFighterDelegateSigner(fighter);
    const targetAuthority = requestedAuthority ?? defaultDelegateSigner?.publicKey ?? null;
    const connection = getConnection();
    const existing = await readFighterDelegateState(fighter, connection);
    const [fighterDelegatePda] = deriveFighterDelegatePda(fighter);

    if (action === "revoke") {
      if (!existing || existing.revoked) {
        return NextResponse.json({
          success: true,
          already_revoked: true,
          wallet_address: fighter.toBase58(),
          fighter_delegate_pda: fighterDelegatePda.toBase58(),
          delegate_authority: existing?.authority.toBase58() ?? null,
        });
      }

      const tx = await buildRevokeFighterDelegateTx(fighter, connection);
      return NextResponse.json({
        success: true,
        tx_type: "revoke_fighter_delegate",
        action,
        transaction_base64: tx
          .serialize({ requireAllSignatures: false, verifySignatures: false })
          .toString("base64"),
        wallet_address: fighter.toBase58(),
        fighter_delegate_pda: fighterDelegatePda.toBase58(),
        delegate_authority: existing.authority.toBase58(),
        submit_via: "POST /api/rumble/submit-tx with fighter_id, x-api-key, and tx_type=revoke_fighter_delegate",
      });
    }

    if (!targetAuthority) {
      return NextResponse.json(
        { error: "Persistent fighter delegate signer is not configured on this server" },
        { status: 503 },
      );
    }

    if (
      existing &&
      !existing.revoked &&
      existing.authority.equals(targetAuthority)
    ) {
      return NextResponse.json({
        success: true,
        already_authorized: true,
        wallet_address: fighter.toBase58(),
        fighter_delegate_pda: fighterDelegatePda.toBase58(),
        delegate_authority: targetAuthority.toBase58(),
        action: "authorize",
        message: "SeekerClaw is already authorized for this fighter.",
      });
    }

    const tx = await buildAuthorizeFighterDelegateTx(
      fighter,
      targetAuthority,
      connection,
    );

    return NextResponse.json({
      success: true,
      tx_type: "authorize_fighter_delegate",
      action: existing && !existing.revoked ? "rotate" : "authorize",
      transaction_base64: tx
        .serialize({ requireAllSignatures: false, verifySignatures: false })
        .toString("base64"),
      wallet_address: fighter.toBase58(),
      fighter_delegate_pda: fighterDelegatePda.toBase58(),
      delegate_authority: targetAuthority.toBase58(),
      previous_delegate_authority: existing?.authority.toBase58() ?? null,
      submit_via: "POST /api/rumble/submit-tx with fighter_id, x-api-key, and tx_type=authorize_fighter_delegate",
    });
  } catch (err: any) {
    console.error("[fighter/delegate/prepare] Error:", err);
    return NextResponse.json(
      { error: "Failed to prepare fighter delegate transaction" },
      { status: 500 },
    );
  }
}
