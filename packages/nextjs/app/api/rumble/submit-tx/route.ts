import { NextResponse } from "next/server";
import { Transaction } from "@solana/web3.js";
import { freshSupabase } from "~~/lib/supabase";
import { getApiKeyFromHeaders } from "~~/lib/request-auth";
import { checkRateLimit, getRateLimitKey, rateLimitResponse } from "~~/lib/rate-limit";
import { hashApiKey } from "~~/lib/api-key";
import { getConnection } from "~~/lib/solana-connection";

export const dynamic = "force-dynamic";

const ALLOWED_TX_TYPES = ["commit_move", "reveal_move"] as const;
type TxType = (typeof ALLOWED_TX_TYPES)[number];

/**
 * Validate that the fighter exists and the API key matches.
 * Returns true if authorized, false otherwise.
 */
async function isAuthorizedFighter(fighterId: string, apiKey: string): Promise<boolean> {
  const hashedKey = hashApiKey(apiKey);

  const { data } = await freshSupabase()
    .from("ucf_fighters")
    .select("id")
    .eq("id", fighterId)
    .eq("api_key_hash", hashedKey)
    .maybeSingle();

  return !!data;
}

/**
 * Validate that a fighter exists in the database.
 */
async function fighterExists(fighterId: string): Promise<boolean> {
  const { data } = await freshSupabase()
    .from("ucf_fighters")
    .select("id")
    .eq("id", fighterId)
    .maybeSingle();

  return !!data;
}

/**
 * GET /api/rumble/submit-tx
 *
 * Returns documentation for this endpoint so AI agents can discover it.
 */
export async function GET(request: Request) {
  const rlKey = getRateLimitKey(request);
  const rl = checkRateLimit("PUBLIC_READ", rlKey);
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

  return NextResponse.json({
    endpoint: "POST /api/rumble/submit-tx",
    description:
      "Submit a signed Solana transaction for on-chain combat (commit_move or reveal_move). Use this instead of giving your secret key to the orchestrator.",
    auth: "x-api-key header",
    body: {
      fighter_id: "Your fighter ID",
      signed_tx: "Base64-encoded signed Solana transaction",
      tx_type: "commit_move | reveal_move",
    },
    notes: [
      "Build the transaction using the UCF Anchor program IDL",
      "Sign with your fighter's wallet keypair",
      "The orchestrator will detect the on-chain state change automatically",
      "Use the tx_sign_request webhook event to receive pre-built unsigned transactions",
    ],
  });
}

/**
 * POST /api/rumble/submit-tx
 *
 * External fighters submit their own signed Solana transactions (commit_move or reveal_move)
 * without giving their secret key to the orchestrator.
 *
 * Body: { fighter_id, signed_tx, tx_type }
 * Auth: x-api-key header or api_key in body
 */
export async function POST(request: Request) {
  const rlKey = getRateLimitKey(request);
  const rl = checkRateLimit("AUTHENTICATED", rlKey);
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

  try {
    const body = await request.json();
    const fighterId = body.fighter_id || body.fighterId;
    const signedTx = body.signed_tx || body.signedTx;
    const txType = body.tx_type || body.txType;
    const apiKey = body.api_key || body.apiKey || getApiKeyFromHeaders(request.headers);

    // --- Validate required fields ---

    if (!fighterId || typeof fighterId !== "string") {
      return NextResponse.json(
        {
          error: "Missing fighter_id",
          required: ["fighter_id", "signed_tx", "tx_type"],
        },
        { status: 400 },
      );
    }

    if (!signedTx || typeof signedTx !== "string") {
      return NextResponse.json(
        {
          error: "Missing signed_tx. Provide a base64-encoded signed Solana transaction.",
          required: ["fighter_id", "signed_tx", "tx_type"],
        },
        { status: 400 },
      );
    }

    if (!txType || !ALLOWED_TX_TYPES.includes(txType as TxType)) {
      return NextResponse.json(
        {
          error: `Invalid tx_type. Must be one of: ${ALLOWED_TX_TYPES.join(", ")}`,
          required: ["fighter_id", "signed_tx", "tx_type"],
        },
        { status: 400 },
      );
    }

    if (!apiKey || typeof apiKey !== "string") {
      return NextResponse.json(
        { error: "Missing API key. Provide x-api-key header or api_key in body." },
        { status: 400 },
      );
    }

    // --- Validate fighter exists ---

    if (!(await fighterExists(fighterId))) {
      return NextResponse.json(
        { error: "Fighter not found" },
        { status: 404 },
      );
    }

    // --- Validate API key matches fighter ---

    if (!(await isAuthorizedFighter(fighterId, apiKey))) {
      return NextResponse.json(
        { error: "Invalid fighter credentials" },
        { status: 401 },
      );
    }

    // --- Deserialize the signed transaction ---

    let txBuffer: Buffer;
    try {
      txBuffer = Buffer.from(signedTx, "base64");
    } catch {
      return NextResponse.json(
        { error: "signed_tx is not valid base64" },
        { status: 400 },
      );
    }

    let transaction: Transaction;
    try {
      transaction = Transaction.from(txBuffer);
    } catch (err: any) {
      return NextResponse.json(
        { error: `Failed to deserialize transaction: ${err.message}` },
        { status: 400 },
      );
    }

    // Basic sanity check: transaction should have at least one signature
    if (!transaction.signatures || transaction.signatures.length === 0) {
      return NextResponse.json(
        { error: "Transaction has no signatures. Sign the transaction before submitting." },
        { status: 400 },
      );
    }

    // --- Submit to Solana RPC (fire-and-forget, no confirmation wait) ---

    const rawTx = transaction.serialize();
    const connection = getConnection();

    let signature: string;
    try {
      signature = await connection.sendRawTransaction(rawTx, {
        skipPreflight: false,
        preflightCommitment: "processed",
        maxRetries: 3,
      });
    } catch (err: any) {
      console.error(`[submit-tx] RPC error for fighter=${fighterId} tx_type=${txType}:`, err);
      return NextResponse.json(
        {
          error: `Solana RPC rejected the transaction: ${err.message}`,
        },
        { status: 500 },
      );
    }

    console.log(
      `[submit-tx] Submitted ${txType} for fighter=${fighterId} sig=${signature}`,
    );

    return NextResponse.json({
      status: "submitted",
      signature,
      explorer_url: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
      message: "Transaction submitted. The orchestrator will detect it via on-chain polling.",
    });
  } catch (error: any) {
    console.error("[submit-tx] Unexpected error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
