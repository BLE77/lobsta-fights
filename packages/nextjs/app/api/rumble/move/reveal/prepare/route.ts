import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { buildRevealMoveTx } from "~~/lib/solana-programs";
import { parseOnchainRumbleIdNumber } from "~~/lib/rumble-id";

export const dynamic = "force-dynamic";

const MOVE_NAME_TO_CODE: Record<string, number> = {
  HIGH_STRIKE: 0,
  MID_STRIKE: 1,
  LOW_STRIKE: 2,
  GUARD_HIGH: 3,
  GUARD_MID: 4,
  GUARD_LOW: 5,
  DODGE: 6,
  CATCH: 7,
  SPECIAL: 8,
};

function parseRumbleId(input: unknown): number | null {
  if (typeof input === "number" && Number.isSafeInteger(input) && input > 0) return input;
  if (typeof input === "string") return parseOnchainRumbleIdNumber(input);
  return null;
}

function parseSalt32(input: unknown): Uint8Array | null {
  if (typeof input !== "string") return null;
  const normalized = input.trim().replace(/^0x/i, "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) return null;
  return Uint8Array.from(Buffer.from(normalized, "hex"));
}

function parseMoveCode(moveCodeRaw: unknown, moveRaw: unknown): number | null {
  if (Number.isInteger(moveCodeRaw)) {
    const code = Number(moveCodeRaw);
    return code >= 0 && code <= 8 ? code : null;
  }
  if (typeof moveRaw === "string") {
    const normalized = moveRaw.trim().toUpperCase();
    return Object.prototype.hasOwnProperty.call(MOVE_NAME_TO_CODE, normalized)
      ? MOVE_NAME_TO_CODE[normalized]
      : null;
  }
  return null;
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const walletAddress = String(body?.wallet_address ?? body?.walletAddress ?? "").trim();
    const rumbleIdRaw = body?.rumble_id ?? body?.rumbleId;
    const turn = Number(body?.turn ?? 0);
    const moveCode = parseMoveCode(body?.move_code ?? body?.moveCode, body?.move);
    const salt32 = parseSalt32(body?.salt ?? body?.salt_hex ?? body?.saltHex);

    if (!walletAddress) {
      return NextResponse.json({ error: "Missing wallet_address" }, { status: 400 });
    }
    if (!Number.isInteger(turn) || turn <= 0) {
      return NextResponse.json({ error: "Invalid turn" }, { status: 400 });
    }
    if (moveCode === null) {
      return NextResponse.json(
        { error: "Invalid move_code/move. Expected 0..8 or known move name." },
        { status: 400 },
      );
    }
    if (!salt32) {
      return NextResponse.json(
        { error: "Invalid salt. Must be 32-byte hex string." },
        { status: 400 },
      );
    }

    let fighter: PublicKey;
    try {
      fighter = new PublicKey(walletAddress);
    } catch {
      return NextResponse.json({ error: "Invalid wallet_address" }, { status: 400 });
    }

    const rumbleId = parseRumbleId(rumbleIdRaw);
    if (!rumbleId) {
      return NextResponse.json({ error: "Invalid rumble_id" }, { status: 400 });
    }

    const tx = await buildRevealMoveTx(fighter, rumbleId, turn, moveCode, salt32);
    const txBase64 = tx
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString("base64");

    return NextResponse.json({
      success: true,
      transaction_base64: txBase64,
      wallet_address: fighter.toBase58(),
      rumble_id: String(rumbleIdRaw ?? rumbleId),
      onchain_rumble_id: rumbleId,
      turn,
      move_code: moveCode,
      salt_hex: Buffer.from(salt32).toString("hex"),
    });
  } catch (err: any) {
    console.error("[Reveal Prepare] Error:", err);
    return NextResponse.json(
      { error: "Failed to prepare reveal transaction" },
      { status: 500 },
    );
  }
}
