import { NextResponse } from "next/server";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { getOrchestrator } from "~~/lib/rumble-orchestrator";
import { buildPlaceBetBatchTx, buildPlaceBetTx, readRumbleAccountState, RUMBLE_ENGINE_ID_MAINNET } from "~~/lib/solana-programs";
import { checkRateLimit, getRateLimitKey, rateLimitResponse } from "~~/lib/rate-limit";
import { MAX_BET_SOL, MIN_BET_SOL } from "~~/lib/tx-verify";
import { parseOnchainRumbleIdNumber } from "~~/lib/rumble-id";
import { hasRecovered, recoverOrchestratorState } from "~~/lib/rumble-state-recovery";
import { getBettingConnection } from "~~/lib/solana-connection";
import { ensureRumblePublicHeartbeat } from "~~/lib/rumble-public-heartbeat";
import { loadActiveRumbles } from "~~/lib/rumble-persistence";
import { requireJsonContentType, sanitizeErrorResponse } from "~~/lib/api-middleware";
import { flushRpcMetrics, runWithRpcMetrics } from "~~/lib/solana-rpc-metrics";

export const dynamic = "force-dynamic";
const BETTING_CLOSE_GUARD_MS = Math.max(1000, Number(process.env.RUMBLE_BETTING_CLOSE_GUARD_MS ?? "12000"));
const SLOT_MS_ESTIMATE = Math.max(250, Number(process.env.RUMBLE_SLOT_MS_ESTIMATE ?? "400"));
const BETTING_CLOSE_GUARD_SLOTS = Math.max(1, Math.ceil(BETTING_CLOSE_GUARD_MS / SLOT_MS_ESTIMATE));
const ONCHAIN_DEADLINE_UNIX_SLOT_GAP_THRESHOLD = 5_000_000n;
const BET_PREPARE_ACTIVE_BETTING_MAX_AGE_MS = 10 * 60 * 1000;

async function ensureRecovered(): Promise<void> {
  if (hasRecovered()) return;
  await recoverOrchestratorState();
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function loadLatestBettingRumbleForSlot(slotIndex: number): Promise<{
  rumbleId: string;
  fighterIds: string[];
} | null> {
  const active = await loadActiveRumbles();
  let best: { id: string; createdAtMs: number; fighters: unknown; status: string } | null = null;
  for (const row of active) {
    if (Number(row.slot_index) !== slotIndex) continue;
    if (String(row.status ?? "").toLowerCase() !== "betting") continue;
    const createdAtMs = new Date(row.created_at).getTime();
    if (!Number.isFinite(createdAtMs)) continue;
    if (Date.now() - createdAtMs > BET_PREPARE_ACTIVE_BETTING_MAX_AGE_MS) continue;
    if (!best || createdAtMs > best.createdAtMs) {
      best = {
        id: row.id,
        createdAtMs,
        fighters: row.fighters,
        status: row.status,
      };
    }
  }
  if (!best) return null;

  const fighterRows = Array.isArray(best.fighters)
    ? (best.fighters as Array<{ id?: string }>)
    : [];
  const fighterIds = fighterRows
    .map((row) => String(row?.id ?? "").trim())
    .filter(Boolean);
  if (fighterIds.length === 0) return null;

  return {
    rumbleId: best.id,
    fighterIds,
  };
}

export async function POST(request: Request) {
  return runWithRpcMetrics("POST /api/rumble/bet/prepare", async () => {
    const rlKey = getRateLimitKey(request);
    const rl = checkRateLimit("PUBLIC_WRITE", rlKey);
    if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);
    const contentTypeError = requireJsonContentType(request);
    if (contentTypeError) return contentTypeError;

    try {
      const body = await request.json().catch(() => ({}));
      const slotIndex = body.slot_index ?? body.slotIndex;
      const walletAddress = body.wallet_address ?? body.walletAddress;
      const rawBatch = Array.isArray(body.bets) ? body.bets : null;

    if (rawBatch && rawBatch.length > 16) {
      return NextResponse.json({ error: "Maximum 16 bets per batch" }, { status: 400 });
    }

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
    await ensureRumblePublicHeartbeat("bet_prepare");
    const orchestrator = getOrchestrator();
    const localSlot = orchestrator.getStatus().find((s) => s.slotIndex === parsedSlotIndex) ?? null;
    const persistedBetting = await loadLatestBettingRumbleForSlot(parsedSlotIndex).catch(() => null);

    const slotRumbleId = (() => {
      if (persistedBetting?.rumbleId) return persistedBetting.rumbleId;
      if (localSlot?.state === "betting" && localSlot?.rumbleId) return localSlot.rumbleId;
      return null;
    })();
    if (!slotRumbleId) {
      return NextResponse.json(
        { error: "Betting is not open for this slot right now." },
        { status: 409 },
      );
    }

    const slotFighters = (() => {
      if (persistedBetting?.fighterIds?.length) return persistedBetting.fighterIds;
      if (localSlot?.fighters?.length) return localSlot.fighters;
      return [];
    })();
    if (slotFighters.length === 0) {
      return NextResponse.json(
        {
          error: "Rumble fighter list is still syncing. Refresh and retry.",
          rumble_id: slotRumbleId,
        },
        { status: 409 },
      );
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
      if (!slotFighters.includes(fighterId)) {
        return NextResponse.json({ error: `Fighter ${fighterId} is not in this Rumble.` }, { status: 400 });
      }
      const fighterIndex = slotFighters.findIndex((f) => f === fighterId);
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

    const rumbleIdNum = parseOnchainRumbleIdNumber(slotRumbleId);
    if (rumbleIdNum === null) {
      return NextResponse.json(
        { error: `Could not derive numeric rumble id from ${slotRumbleId}` },
        { status: 400 },
      );
    }

    // Source of truth guard: do not return a signable tx unless this rumble is
    // still open on-chain. Prevents stale UI/off-chain state from producing a
    // tx that will immediately fail simulation with BettingClosed.
    const bettingConn = getBettingConnection();
    let onchainRumble = await readRumbleAccountState(rumbleIdNum, bettingConn, RUMBLE_ENGINE_ID_MAINNET).catch(() => null);
    if (!onchainRumble) {
      // Self-heal: if this slot is betting but the on-chain account is missing,
      // trigger orchestrator recovery/create once and re-read before failing.
      const recovered = await orchestrator
        .ensureOnchainRumbleForSlot(parsedSlotIndex)
        .catch(() => false);
      if (recovered) {
        await sleep(250);
        onchainRumble = await readRumbleAccountState(rumbleIdNum, bettingConn, RUMBLE_ENGINE_ID_MAINNET).catch(() => null);
      }
    }
    if (!onchainRumble) {
      return NextResponse.json(
        {
          error: "On-chain rumble is still initializing. Please retry in a few seconds.",
          rumble_id: slotRumbleId,
        },
        { status: 409 },
      );
    }
    if (onchainRumble.state !== "betting") {
      return NextResponse.json(
        {
          error: `On-chain betting is closed for this rumble (state: ${onchainRumble.state}).`,
          onchain_state: onchainRumble.state,
        },
        { status: 409 },
      );
    }

    const currentSlot = await bettingConn.getSlot("processed");
    const onchainCloseRaw = (() => {
      const compat = onchainRumble as unknown as {
        bettingCloseSlot?: bigint;
        bettingDeadlineTs?: bigint;
      };
      const slotValue = compat.bettingCloseSlot ?? compat.bettingDeadlineTs ?? 0n;
      return slotValue > 0n ? slotValue : 0n;
    })();
    const currentSlotBig = BigInt(currentSlot);
    const looksLikeUnixDeadline = onchainCloseRaw > currentSlotBig + ONCHAIN_DEADLINE_UNIX_SLOT_GAP_THRESHOLD;
    const guardSlotThreshold = currentSlotBig + BigInt(BETTING_CLOSE_GUARD_SLOTS);
    const slotsUntilCloseBig = !looksLikeUnixDeadline && onchainCloseRaw > currentSlotBig
      ? onchainCloseRaw - currentSlotBig
      : 0n;
    const slotsUntilClose = !looksLikeUnixDeadline ? Number(slotsUntilCloseBig) : Number.NaN;
    const onchainDeadlineMsEstimate =
      looksLikeUnixDeadline
        ? Number(onchainCloseRaw) * 1_000
        : Number.isFinite(slotsUntilClose) && slotsUntilClose > 0
          ? Date.now() + slotsUntilClose * SLOT_MS_ESTIMATE
          : Number.NaN;
    if (onchainCloseRaw > 0n) {
      const bettingClosingNow = (() => {
        if (looksLikeUnixDeadline) {
          const guardSec = Math.max(1, Math.ceil(BETTING_CLOSE_GUARD_MS / 1_000));
          const nowUnix = Math.floor(Date.now() / 1_000);
          return BigInt(nowUnix + guardSec) >= onchainCloseRaw;
        }
        return guardSlotThreshold >= onchainCloseRaw;
      })();
      if (bettingClosingNow) {
        return NextResponse.json(
          {
            error: "Betting is closing right now. Wait for the next rumble to avoid a failed transaction.",
            onchain_state: onchainRumble.state,
            onchain_betting_close_slot: looksLikeUnixDeadline ? null : onchainCloseRaw.toString(),
            onchain_betting_deadline_unix: looksLikeUnixDeadline ? onchainCloseRaw.toString() : null,
            current_slot: String(currentSlot),
            slots_until_close: Number.isFinite(slotsUntilClose) ? slotsUntilClose : null,
            guard_ms: BETTING_CLOSE_GUARD_MS,
            guard_slots: BETTING_CLOSE_GUARD_SLOTS,
          },
          { status: 409 },
        );
      }
    }
    const maxPreparedIndex = preparedBets.reduce(
      (max, bet) => Math.max(max, bet.fighter_index),
      -1,
    );
    if (onchainRumble.fighterCount > 0 && maxPreparedIndex >= onchainRumble.fighterCount) {
      return NextResponse.json(
        {
          error: "Rumble fighter list changed on-chain. Refresh and place the bet again.",
          onchain_fighter_count: onchainRumble.fighterCount,
        },
        { status: 409 },
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
              bettingConn,
              RUMBLE_ENGINE_ID_MAINNET,
            )
          : await buildPlaceBetBatchTx(
              wallet,
              rumbleIdNum,
              preparedBets.map(b => ({
                fighterIndex: b.fighter_index,
                lamports: b.lamports,
              })),
              bettingConn,
              RUMBLE_ENGINE_ID_MAINNET,
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
        rumble_id: slotRumbleId,
        rumble_id_num: rumbleIdNum,
        fighter_id: primary.fighter_id,
        fighter_index: primary.fighter_index,
        sol_amount: primary.sol_amount,
        lamports: primary.lamports,
        bets: preparedBets,
        total_sol_amount: preparedBets.reduce((sum, b) => sum + b.sol_amount, 0),
        total_lamports: preparedBets.reduce((sum, b) => sum + b.lamports, 0),
        wallet: wallet.toBase58(),
        onchain_state: onchainRumble.state,
        onchain_betting_close_slot:
          onchainCloseRaw > 0n && !looksLikeUnixDeadline ? onchainCloseRaw.toString() : null,
        onchain_betting_deadline_unix:
          onchainCloseRaw > 0n && looksLikeUnixDeadline ? onchainCloseRaw.toString() : null,
        current_slot: String(currentSlot),
        slots_until_close: Number.isFinite(slotsUntilClose) ? slotsUntilClose : null,
        onchain_betting_deadline:
          Number.isFinite(onchainDeadlineMsEstimate) && onchainDeadlineMsEstimate > 0
            ? new Date(onchainDeadlineMsEstimate).toISOString()
            : null,
        guard_ms: BETTING_CLOSE_GUARD_MS,
        guard_slots: BETTING_CLOSE_GUARD_SLOTS,
        tx_kind: txKind,
        transaction_base64: txBase64,
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      const errorText = String(err?.message ?? err ?? "").toLowerCase();
      const onchainNotReady =
        errorText.includes("rumble account not found") || errorText.includes("rumble config not found");
      return NextResponse.json(
        {
          error: onchainNotReady
            ? "On-chain rumble is not ready yet. Try again in a few seconds."
            : "Failed to build on-chain bet transaction.",
        },
        { status: onchainNotReady ? 409 : 500 },
      );
    }
    } catch (error) {
      console.error("[RumbleBetPrepareAPI]", error);
      return NextResponse.json(sanitizeErrorResponse(error, "Failed to prepare bet transaction"), { status: 500 });
    } finally {
      flushRpcMetrics();
    }
  });
}
