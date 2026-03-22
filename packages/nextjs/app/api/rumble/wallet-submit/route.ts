import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { ComputeBudgetProgram, SystemProgram, Transaction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { checkRateLimit, getRateLimitKey, rateLimitResponse } from "~~/lib/rate-limit";
import { requireJsonContentType, sanitizeErrorResponse } from "~~/lib/api-middleware";
import { getBettingConnection, getCombatConnectionAuto, isErEnabled } from "~~/lib/solana-connection";
import { freshSupabase } from "~~/lib/supabase";
import {
  RUMBLE_ENGINE_ID,
  RUMBLE_ENGINE_ID_MAINNET,
} from "~~/lib/solana-programs";
import { isAuthorizedAdminRequest, isAuthorizedInternalRequest } from "~~/lib/request-auth";

export const dynamic = "force-dynamic";

type WalletSubmitNetwork = "betting" | "combat";

function isWalletSubmitNetwork(value: unknown): value is WalletSubmitNetwork {
  return value === "betting" || value === "combat";
}

function anchorInstructionDiscriminator(name: string): string {
  return createHash("sha256")
    .update(`global:${name}`)
    .digest("hex")
    .slice(0, 16);
}

const COMMON_ALLOWED_PROGRAMS = new Set([
  ComputeBudgetProgram.programId.toBase58(),
  SystemProgram.programId.toBase58(),
  TOKEN_PROGRAM_ID.toBase58(),
  ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
]);

const ALLOWED_PROGRAMS_BY_NETWORK: Record<WalletSubmitNetwork, Set<string>> = {
  betting: new Set([
    ComputeBudgetProgram.programId.toBase58(),
    RUMBLE_ENGINE_ID_MAINNET.toBase58(),
  ]),
  combat: new Set([
    ...COMMON_ALLOWED_PROGRAMS,
    RUMBLE_ENGINE_ID.toBase58(),
  ]),
};

const ALLOWED_BETTING_DISCRIMINATORS = new Set([
  anchorInstructionDiscriminator("place_bet"),
  anchorInstructionDiscriminator("claim_payout"),
]);

function getInstructionProgramIds(transaction: Transaction): string[] {
  return transaction.instructions.map((instruction) => instruction.programId.toBase58());
}

function hasInstructionForProgram(transaction: Transaction, programId: string): boolean {
  return getInstructionProgramIds(transaction).includes(programId);
}

function findUnexpectedProgramId(
  transaction: Transaction,
  network: WalletSubmitNetwork,
): string | null {
  const allowedPrograms = ALLOWED_PROGRAMS_BY_NETWORK[network];
  for (const programId of getInstructionProgramIds(transaction)) {
    if (!allowedPrograms.has(programId)) return programId;
  }
  return null;
}

function findUnexpectedBettingInstruction(transaction: Transaction): string | null {
  for (const instruction of transaction.instructions) {
    if (!instruction.programId.equals(RUMBLE_ENGINE_ID_MAINNET)) continue;
    const discriminator = instruction.data.subarray(0, 8).toString("hex");
    if (!ALLOWED_BETTING_DISCRIMINATORS.has(discriminator)) {
      return discriminator;
    }
  }
  return null;
}

async function persistPendingBetRelay(
  body: Record<string, unknown>,
  signature: string,
): Promise<void> {
  const idempotencyKeyRaw = body.idempotency_key ?? body.idempotencyKey;
  const walletAddressRaw = body.wallet_address ?? body.walletAddress;
  if (typeof idempotencyKeyRaw !== "string" || idempotencyKeyRaw.trim().length === 0) return;
  if (typeof walletAddressRaw !== "string" || walletAddressRaw.trim().length === 0) return;

  const slotIndexRaw = body.slot_index ?? body.slotIndex;
  const slotIndex = Number.isInteger(Number(slotIndexRaw)) ? Number(slotIndexRaw) : null;
  const rumbleIdRaw = body.rumble_id ?? body.rumbleId;
  const txKindRaw = body.tx_kind ?? body.txKind;
  const payload = {
    source: "wallet_submit",
    tx_kind: typeof txKindRaw === "string" ? txKindRaw : null,
    fighter_id: typeof body.fighter_id === "string" ? body.fighter_id : null,
    fighter_index: Number.isInteger(Number(body.fighter_index ?? body.fighterIndex))
      ? Number(body.fighter_index ?? body.fighterIndex)
      : null,
    sol_amount:
      Number.isFinite(Number(body.sol_amount ?? body.solAmount))
        ? Number(body.sol_amount ?? body.solAmount)
        : null,
    bets: Array.isArray(body.bets) ? body.bets : null,
    expected_odds_version:
      Number.isInteger(Number(body.expected_odds_version ?? body.expectedOddsVersion))
        ? Number(body.expected_odds_version ?? body.expectedOddsVersion)
        : null,
  };

  try {
    const sb = freshSupabase();
    const row = {
      tx_signature: signature,
      kind: "rumble_bet",
      wallet_address: walletAddressRaw.trim(),
      rumble_id: typeof rumbleIdRaw === "string" && rumbleIdRaw.trim().length > 0 ? rumbleIdRaw.trim() : null,
      slot_index: slotIndex,
      idempotency_key: idempotencyKeyRaw.trim(),
      payload,
    };
    const { error } = await sb
      .from("ucf_used_tx_signatures")
      .upsert(row, { onConflict: "tx_signature" });
    if (error && (error as { code?: string }).code !== "23505") {
      console.warn("[wallet-submit] Failed to persist pending bet relay:", error);
    }
  } catch (error) {
    console.warn("[wallet-submit] Pending bet relay persistence threw:", error);
  }
}

export async function POST(request: Request) {
  const rlKey = getRateLimitKey(request);
  const rl = checkRateLimit("PUBLIC_WRITE", rlKey, "/api/rumble/wallet-submit");
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);
  const contentTypeError = requireJsonContentType(request);
  if (contentTypeError) return contentTypeError;

  try {
    const body = await request.json().catch(() => ({}));
    const signedTx = body.signed_tx ?? body.signedTx;
    const network = isWalletSubmitNetwork(body.network) ? body.network : "betting";

    if (
      network === "combat" &&
      !isAuthorizedInternalRequest(request.headers) &&
      !isAuthorizedAdminRequest(request.headers)
    ) {
      return NextResponse.json({ error: "Combat transaction relay is not public." }, { status: 403 });
    }

    if (!signedTx || typeof signedTx !== "string") {
      return NextResponse.json({ error: "Missing signed_tx" }, { status: 400 });
    }

    let txBuffer: Buffer;
    try {
      txBuffer = Buffer.from(signedTx, "base64");
    } catch {
      return NextResponse.json({ error: "signed_tx is not valid base64" }, { status: 400 });
    }

    let transaction: Transaction;
    try {
      transaction = Transaction.from(txBuffer);
    } catch (err) {
      return NextResponse.json(sanitizeErrorResponse(err, "Failed to deserialize signed transaction"), {
        status: 400,
      });
    }

    if (!transaction.signatures || transaction.signatures.length === 0) {
      return NextResponse.json(
        { error: "Transaction has no signatures. Sign the transaction before submitting." },
        { status: 400 },
      );
    }

    const unexpectedProgramId = findUnexpectedProgramId(transaction, network);
    if (unexpectedProgramId) {
      return NextResponse.json(
        {
          error: "Transaction includes a program that is not allowed for this relay.",
          program_id: unexpectedProgramId,
        },
        { status: 400 },
      );
    }

    if (
      network === "betting" &&
      !hasInstructionForProgram(transaction, RUMBLE_ENGINE_ID_MAINNET.toBase58())
    ) {
      return NextResponse.json(
        {
          error: "Betting relay requires a mainnet rumble program instruction.",
          required_program_id: RUMBLE_ENGINE_ID_MAINNET.toBase58(),
          found_program_ids: getInstructionProgramIds(transaction),
        },
        { status: 400 },
      );
    }

    if (network === "betting") {
      const unexpectedDiscriminator = findUnexpectedBettingInstruction(transaction);
      if (unexpectedDiscriminator) {
        return NextResponse.json(
          {
            error: "Betting relay only accepts wallet-signed bet and claim instructions.",
            discriminator: unexpectedDiscriminator,
          },
          { status: 400 },
        );
      }
    }

    const connection = network === "combat" ? getCombatConnectionAuto() : getBettingConnection();
    const erEnabled = network === "combat" && isErEnabled();

    const signature = await connection.sendRawTransaction(txBuffer, {
      skipPreflight: erEnabled,
      preflightCommitment: erEnabled ? undefined : "processed",
      maxRetries: 3,
    });

    if (network === "betting") {
      await persistPendingBetRelay(body, signature);
    }

    return NextResponse.json({
      signature,
      submitted_to: network === "combat" ? (erEnabled ? "ephemeral_rollup" : "solana_l1") : "betting_rpc",
    });
  } catch (error) {
    return NextResponse.json(sanitizeErrorResponse(error, "Failed to submit signed transaction"), {
      status: 500,
    });
  }
}
