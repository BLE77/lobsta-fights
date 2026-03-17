import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { getOrchestrator } from "~~/lib/rumble-orchestrator";
import {
  buildPlaceBetBatchTx,
  buildPlaceBetTx,
  readMainnetRumbleAccountStateResilient,
  RUMBLE_ENGINE_ID_MAINNET,
} from "~~/lib/solana-programs";
import { checkRateLimit, getRateLimitKey, rateLimitResponse } from "~~/lib/rate-limit";
import { MAX_BET_SOL, MIN_BET_SOL } from "~~/lib/tx-verify";
import { parseOnchainRumbleIdNumber } from "~~/lib/rumble-id";
import { hasRecovered, recoverOrchestratorState } from "~~/lib/rumble-state-recovery";
import { getBettingConnection } from "~~/lib/solana-connection";
import { ensureRumblePublicHeartbeat } from "~~/lib/rumble-public-heartbeat";
import {
  MIN_ACTIVE_RUMBLE_FIGHTERS,
} from "~~/lib/rumble-persistence";
import { requireJsonContentType, sanitizeErrorResponse } from "~~/lib/api-middleware";
import { flushRpcMetrics, runWithRpcMetrics } from "~~/lib/solana-rpc-metrics";
import {
  type BettingRumbleCandidate,
  loadBettingRumbleCandidatesForSlot as loadSharedBettingRumbleCandidatesForSlot,
  prependLocalBettingCandidate as prependSharedLocalBettingCandidate,
  reconcileOnchainFighterIds,
} from "~~/lib/betting-rumble-candidates";

export const dynamic = "force-dynamic";
const BETTING_CLOSE_GUARD_MS = Math.max(1000, Number(process.env.RUMBLE_BETTING_CLOSE_GUARD_MS ?? "12000"));
const SLOT_MS_ESTIMATE = Math.max(250, Number(process.env.RUMBLE_SLOT_MS_ESTIMATE ?? "400"));
const BETTING_CLOSE_GUARD_SLOTS = Math.max(1, Math.ceil(BETTING_CLOSE_GUARD_MS / SLOT_MS_ESTIMATE));
const ONCHAIN_DEADLINE_UNIX_SLOT_GAP_THRESHOLD = 5_000_000n;

async function ensureRecovered(): Promise<void> {
  if (hasRecovered()) return;
  await recoverOrchestratorState();
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function loadBettingRumbleCandidatesForSlot(slotIndex: number): Promise<BettingRumbleCandidate[]> {
  return loadSharedBettingRumbleCandidatesForSlot(slotIndex);
}

function prependLocalBettingCandidate(
  candidates: BettingRumbleCandidate[],
  localSlot: ReturnType<ReturnType<typeof getOrchestrator>["getStatus"]> extends Array<infer T> ? T | null : any,
): BettingRumbleCandidate[] {
  return prependSharedLocalBettingCandidate(candidates, localSlot);
}

async function resolveBettableRumbleForSlot(
  slotIndex: number,
  orchestrator: ReturnType<typeof getOrchestrator>,
  requestedRumbleId?: string | null,
): Promise<{
  candidate: BettingRumbleCandidate;
  onchainRumble: Awaited<ReturnType<typeof readMainnetRumbleAccountStateResilient>>;
} | null> {
  const scanCandidates = async (): Promise<{
    match: {
      candidate: BettingRumbleCandidate;
      onchainRumble: Awaited<ReturnType<typeof readMainnetRumbleAccountStateResilient>>;
    } | null;
    sawCandidate: boolean;
    sawNonBettingOnchainState: string | null;
    }> => {
      const localSlot = orchestrator.getStatus().find((s) => s.slotIndex === slotIndex) ?? null;
      const requestedId =
        typeof requestedRumbleId === "string" && requestedRumbleId.trim().length > 0
          ? requestedRumbleId.trim()
          : null;
      const candidates = prependLocalBettingCandidate(
        await loadBettingRumbleCandidatesForSlot(slotIndex),
        localSlot,
      )
        .filter((candidate) => !requestedId || candidate.rumbleId === requestedId)
        .slice(0, 5);
    let sawCandidate = false;
    let sawNonBettingOnchainState: string | null = null;
    for (const candidate of candidates) {
      if (candidate.fighterIds.length < MIN_ACTIVE_RUMBLE_FIGHTERS) continue;
      sawCandidate = true;
      const rumbleIdNum =
        candidate.rumbleNumber ??
        parseOnchainRumbleIdNumber(candidate.rumbleId);
      if (rumbleIdNum === null) continue;
      const onchainRumble = await readMainnetRumbleAccountStateResilient(rumbleIdNum, {
        maxPasses: 2,
        retryDelayMs: 100,
      }).catch(() => null);
      if (!onchainRumble) continue;
      if (onchainRumble.state === "betting") {
        return { match: { candidate, onchainRumble }, sawCandidate, sawNonBettingOnchainState };
      }
      sawNonBettingOnchainState ||= onchainRumble.state ?? null;
    }
    return { match: null, sawCandidate, sawNonBettingOnchainState };
  };

  let scanned = await scanCandidates();
  if (scanned.match) return scanned.match;

  if (scanned.sawCandidate) {
    const recovered = await orchestrator.ensureOnchainRumbleForSlot(slotIndex).catch(() => false);
    if (recovered) {
      await sleep(250);
      scanned = await scanCandidates();
      if (scanned.match) return scanned.match;
    }
  }

  return null;
}

export async function POST(request: Request) {
  return runWithRpcMetrics("POST /api/rumble/bet/prepare", async () => {
    const rlKey = getRateLimitKey(request);
    const rl = checkRateLimit("PUBLIC_WRITE", rlKey, "/api/rumble/bet/prepare");
    if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);
    const contentTypeError = requireJsonContentType(request);
    if (contentTypeError) return contentTypeError;

    try {
      const body = await request.json().catch(() => ({}));
      const slotIndex = body.slot_index ?? body.slotIndex;
      const walletAddress = body.wallet_address ?? body.walletAddress;
      const requestedRumbleIdRaw = body.rumble_id ?? body.rumbleId;
      const requestedRumbleId =
        typeof requestedRumbleIdRaw === "string" && requestedRumbleIdRaw.trim().length > 0
          ? requestedRumbleIdRaw.trim()
          : null;
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
    const resolved = await resolveBettableRumbleForSlot(parsedSlotIndex, orchestrator, requestedRumbleId);
    if (!resolved) {
      return NextResponse.json(
        {
          error: requestedRumbleId
            ? "The requested rumble is no longer the active bettable rumble. Refresh and place the bet again."
            : "Betting is not open for this slot right now.",
          error_code: "BETTING_CLOSED",
        },
        { status: 409 },
      );
    }
    const { candidate: activeBettingRumble } = resolved;
    const onchainRumble = resolved.onchainRumble!;
    const slotRumbleId = activeBettingRumble.rumbleId;

    const onchainFighterIds = await reconcileOnchainFighterIds(
      activeBettingRumble.fighterIds,
      onchainRumble.fighters,
    );
    const slotFighters =
      onchainFighterIds && onchainFighterIds.length >= MIN_ACTIVE_RUMBLE_FIGHTERS
        ? onchainFighterIds
        : activeBettingRumble.fighterIds;
    if (onchainRumble.fighters.length >= MIN_ACTIVE_RUMBLE_FIGHTERS && !onchainFighterIds) {
      return NextResponse.json(
        {
          error: "Rumble fighter order changed on-chain. Refresh and place the bet again.",
          rumble_id: slotRumbleId,
        },
        { status: 409 },
      );
    }
    if (slotFighters.length < MIN_ACTIVE_RUMBLE_FIGHTERS) {
      return NextResponse.json(
        {
          error: "Rumble fighter list is still syncing. Refresh and retry.",
          rumble_id: slotRumbleId,
          fighters_found: slotFighters.length,
          fighters_required: MIN_ACTIVE_RUMBLE_FIGHTERS,
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
      if (solAmount > MAX_BET_SOL) {
        return NextResponse.json(
          { error: `Maximum bet is ${MAX_BET_SOL} SOL per fighter` },
          { status: 400 },
        );
      }
      if (!slotFighters.includes(fighterId)) {
        return NextResponse.json({ error: `Fighter ${fighterId} is not in this Rumble.`, error_code: "FIGHTER_NOT_FOUND" }, { status: 400 });
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

    const rumbleIdNum =
      activeBettingRumble.rumbleNumber ??
      parseOnchainRumbleIdNumber(slotRumbleId);
    if (rumbleIdNum === null) {
      return NextResponse.json(
        { error: `Could not derive numeric rumble id from ${slotRumbleId}` },
        { status: 400 },
      );
    }
    const bettingConn = getBettingConnection();

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
            error_code: "BETTING_CLOSED",
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
      const idempotencyKey = randomUUID();

      const oddsVersion = orchestrator.getOddsVersion(parsedSlotIndex);
      // recommended_sign_by_ms: deadline minus 20s, accounts for network + wallet signing time
      const recommendedSignByMs =
        Number.isFinite(onchainDeadlineMsEstimate) && onchainDeadlineMsEstimate > 0
          ? onchainDeadlineMsEstimate - 20_000
          : null;

      return NextResponse.json({
        idempotency_key: idempotencyKey,
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
        odds_version: oddsVersion,
        recommended_sign_by_ms: recommendedSignByMs,
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
