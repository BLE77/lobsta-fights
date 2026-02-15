import { NextResponse } from "next/server";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { getOrchestrator } from "~~/lib/rumble-orchestrator";
import { buildPlaceBetBatchTx, buildPlaceBetTx } from "~~/lib/solana-programs";
import { checkRateLimit, getRateLimitKey, rateLimitResponse } from "~~/lib/rate-limit";
import { MAX_BET_SOL, MIN_BET_SOL } from "~~/lib/tx-verify";
import { parseOnchainRumbleIdNumber } from "~~/lib/rumble-id";
import { hasRecovered, recoverOrchestratorState } from "~~/lib/rumble-state-recovery";

export const dynamic = "force-dynamic";

async function ensureRecovered(): Promise<void> {
  if (hasRecovered()) return;
  await recoverOrchestratorState();
}

export async function POST(request: Request) {
  const rlKey = getRateLimitKey(request);
  const rl = checkRateLimit("PUBLIC_WRITE", rlKey);
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

  try {
    const body = await request.json().catch(() => ({}));
    const slotIndex = body.slot_index ?? body.slotIndex;
    const walletAddress = body.wallet_address ?? body.walletAddress;
    const rawBatch = Array.isArray(body.bets) ? body.bets : null;

    const parsedSlotIndex = parseInt(String(slotIndex), 10);
    if (isNaN(parsedSlotIndex) || parsedSlotIndex < 0 || parsedSlotIndex > 2) {
      return NextResponse.json({ error: "slot_index must be 0, 1, or 2" }, { status: 400 });
    }
    if (!walletAddress || typeof walletAddress !== "string") {
      return NextResponse.json({ error: "Missing wallet_address" }, { status: 400 });
    }

    let wallet: PublicKey;
    try {
      wallet = new PublicKey(walletAddress);
    } catch {
      return NextResponse.json({ error: "Invalid wallet address" }, { status: 400 });
    }

    await ensureRecovered();
    const orchestrator = getOrchestrator();
    const slot = orchestrator.getStatus().find((s) => s.slotIndex === parsedSlotIndex);
    if (!slot) {
      return NextResponse.json({ error: "Slot not found" }, { status: 404 });
    }
    if (slot.state !== "betting") {
      return NextResponse.json({ error: "Betting is not open for this slot." }, { status: 409 });
    }
    if (slot.bettingDeadline && Date.now() >= slot.bettingDeadline.getTime()) {
      return NextResponse.json({ error: "Betting window has closed." }, { status: 409 });
    }

    const normalizedBets: Array<{ fighterId: string; solAmount: number }> = [];

    if (rawBatch && rawBatch.length > 0) {
      for (const leg of rawBatch) {
        const fighterId = leg?.fighter_id ?? leg?.fighterId;
        const rawAmount = leg?.sol_amount ?? leg?.solAmount ?? leg?.amount;
        const solAmount = typeof rawAmount === "string" ? Number(rawAmount) : rawAmount;
        if (!fighterId || typeof fighterId !== "string") {
          return NextResponse.json({ error: "Each batch bet requires fighter_id." }, { status: 400 });
        }
        if (typeof solAmount !== "number" || !Number.isFinite(solAmount) || solAmount <= 0) {
          return NextResponse.json(
            { error: `Invalid sol_amount for fighter ${fighterId}` },
            { status: 400 },
          );
        }
        if (solAmount < MIN_BET_SOL) {
          return NextResponse.json({ error: `Minimum bet is ${MIN_BET_SOL} SOL` }, { status: 400 });
        }
        if (solAmount > MAX_BET_SOL) {
          return NextResponse.json({ error: `Maximum bet is ${MAX_BET_SOL} SOL` }, { status: 400 });
        }
        normalizedBets.push({ fighterId, solAmount });
      }
    } else {
      const fighterId = body.fighter_id ?? body.fighterId;
      const rawSolAmount = body.sol_amount ?? body.solAmount ?? body.amount;
      const solAmount = typeof rawSolAmount === "string" ? Number(rawSolAmount) : rawSolAmount;
      if (!fighterId || typeof fighterId !== "string") {
        return NextResponse.json({ error: "Missing fighter_id" }, { status: 400 });
      }
      if (typeof solAmount !== "number" || !Number.isFinite(solAmount) || solAmount <= 0) {
        return NextResponse.json({ error: "sol_amount must be a positive number" }, { status: 400 });
      }
      if (solAmount < MIN_BET_SOL) {
        return NextResponse.json({ error: `Minimum bet is ${MIN_BET_SOL} SOL` }, { status: 400 });
      }
      if (solAmount > MAX_BET_SOL) {
        return NextResponse.json({ error: `Maximum bet is ${MAX_BET_SOL} SOL` }, { status: 400 });
      }
      normalizedBets.push({ fighterId, solAmount });
    }

    if (normalizedBets.length === 0) {
      return NextResponse.json({ error: "No valid bets provided." }, { status: 400 });
    }

    // Aggregate duplicate fighter entries in batch so the tx has one leg per fighter.
    const aggregated = new Map<string, number>();
    for (const bet of normalizedBets) {
      aggregated.set(bet.fighterId, (aggregated.get(bet.fighterId) ?? 0) + bet.solAmount);
    }

    const preparedBets: Array<{
      fighter_id: string;
      fighter_index: number;
      sol_amount: number;
      lamports: number;
    }> = [];
    for (const [fighterId, solAmount] of aggregated.entries()) {
      if (!slot.fighters.includes(fighterId)) {
        return NextResponse.json({ error: `Fighter ${fighterId} is not in this Rumble.` }, { status: 400 });
      }
      const fighterIndex = slot.fighters.findIndex((f) => f === fighterId);
      if (fighterIndex < 0) {
        return NextResponse.json({ error: `Fighter index resolution failed for ${fighterId}` }, { status: 400 });
      }
      const lamports = Math.round(solAmount * LAMPORTS_PER_SOL);
      if (lamports <= 0) {
        return NextResponse.json(
          { error: `sol_amount too small after lamport conversion for fighter ${fighterId}` },
          { status: 400 },
        );
      }
      preparedBets.push({
        fighter_id: fighterId,
        fighter_index: fighterIndex,
        sol_amount: solAmount,
        lamports,
      });
    }

    const rumbleIdNum = parseOnchainRumbleIdNumber(slot.rumbleId);
    if (rumbleIdNum === null) {
      return NextResponse.json(
        { error: `Could not derive numeric rumble id from ${slot.rumbleId}` },
        { status: 400 },
      );
    }

    try {
      const tx =
        preparedBets.length === 1
          ? await buildPlaceBetTx(
              wallet,
              rumbleIdNum,
              preparedBets[0].fighter_index,
              preparedBets[0].lamports,
            )
          : await buildPlaceBetBatchTx(
              wallet,
              rumbleIdNum,
              preparedBets.map(b => ({
                fighterIndex: b.fighter_index,
                lamports: b.lamports,
              })),
            );
      const txBytes = tx.serialize({
        requireAllSignatures: false,
        verifySignatures: false,
      });
      const txBase64 = Buffer.from(txBytes).toString("base64");

      const primary = preparedBets[0];
      const txKind = preparedBets.length > 1 ? "rumble_place_bet_batch" : "rumble_place_bet";

      return NextResponse.json({
        slot_index: parsedSlotIndex,
        rumble_id: slot.rumbleId,
        rumble_id_num: rumbleIdNum,
        fighter_id: primary.fighter_id,
        fighter_index: primary.fighter_index,
        sol_amount: primary.sol_amount,
        lamports: primary.lamports,
        bets: preparedBets,
        total_sol_amount: preparedBets.reduce((sum, b) => sum + b.sol_amount, 0),
        total_lamports: preparedBets.reduce((sum, b) => sum + b.lamports, 0),
        wallet: wallet.toBase58(),
        tx_kind: txKind,
        transaction_base64: txBase64,
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      const onchainNotReady =
        msg.includes("Rumble account not found") || msg.includes("Rumble config not found");
      return NextResponse.json(
        {
          error: onchainNotReady
            ? "On-chain rumble is not ready yet. Try again in a few seconds."
            : "Failed to build on-chain bet transaction.",
          detail: msg,
        },
        { status: onchainNotReady ? 409 : 500 },
      );
    }
  } catch (error) {
    console.error("[RumbleBetPrepareAPI]", error);
    return NextResponse.json({ error: "Failed to prepare bet transaction" }, { status: 500 });
  }
}
