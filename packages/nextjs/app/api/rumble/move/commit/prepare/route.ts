import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { buildCommitMoveTx } from "~~/lib/solana-programs";
import { parseOnchainRumbleIdNumber } from "~~/lib/rumble-id";

export const dynamic = "force-dynamic";

function parseRumbleId(input: unknown): number | null {
  if (typeof input === "number" && Number.isSafeInteger(input) && input > 0) return input;
  if (typeof input === "string") return parseOnchainRumbleIdNumber(input);
  return null;
}

function parseHashBytes(input: unknown): Uint8Array | null {
  if (typeof input !== "string") return null;
  const normalized = input.trim().replace(/^0x/i, "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) return null;
  return Uint8Array.from(Buffer.from(normalized, "hex"));
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const walletAddress = String(body?.wallet_address ?? body?.walletAddress ?? "").trim();
    const rumbleIdRaw = body?.rumble_id ?? body?.rumbleId;
    const turn = Number(body?.turn ?? 0);
    const moveHashBytes = parseHashBytes(body?.move_hash ?? body?.moveHash);

    if (!walletAddress) {
      return NextResponse.json({ error: "Missing wallet_address" }, { status: 400 });
    }
    if (!moveHashBytes) {
      return NextResponse.json(
        { error: "Invalid move_hash. Must be 32-byte hex string." },
        { status: 400 },
      );
    }
    if (!Number.isInteger(turn) || turn <= 0) {
      return NextResponse.json({ error: "Invalid turn" }, { status: 400 });
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

    const tx = await buildCommitMoveTx(fighter, rumbleId, turn, moveHashBytes);
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
      move_hash_hex: Buffer.from(moveHashBytes).toString("hex"),
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message ?? "Failed to prepare commit tx" },
      { status: 500 },
    );
  }
}
