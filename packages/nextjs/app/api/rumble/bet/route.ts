import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { getOrchestrator } from "~~/lib/rumble-orchestrator";
import { freshSupabase } from "~~/lib/supabase";
import { getApiKeyFromHeaders } from "~~/lib/request-auth";
import {
  verifyRumblePlaceBetBatchTransaction,
  verifyRumblePlaceBetTransaction,
  isSignatureUsed,
  markSignatureUsed,
  unmarkSignatureUsed,
  MIN_BET_SOL,
  MAX_BET_SOL,
} from "~~/lib/tx-verify";
import { checkRateLimit, getRateLimitKey, rateLimitResponse } from "~~/lib/rate-limit";
import { requireJsonContentType, sanitizeErrorResponse } from "~~/lib/api-middleware";
import { hashApiKey } from "~~/lib/api-key";
import { parseOnchainRumbleIdNumber } from "~~/lib/rumble-id";
import { hasRecovered, recoverOrchestratorState } from "~~/lib/rumble-state-recovery";
import { ensureRumblePublicHeartbeat } from "~~/lib/rumble-public-heartbeat";
import { readMainnetRumbleAccountStateResilient } from "~~/lib/solana-programs";
import {
  MIN_ACTIVE_RUMBLE_FIGHTERS,
  loadBetsForRumble,
  saveBets,
} from "~~/lib/rumble-persistence";
import {
  type BettingRumbleCandidate,
  loadBettingRumbleCandidatesForSlot,
  reconcileOnchainFighterIds,
} from "~~/lib/betting-rumble-candidates";

export const dynamic = "force-dynamic";
const ALLOW_OFFCHAIN_BETS = String(process.env.RUMBLE_ALLOW_OFFCHAIN_BETS ?? "false").toLowerCase() === "true";

async function ensureRecovered(): Promise<void> {
  if (hasRecovered()) return;
  await recoverOrchestratorState();
}

function normalizeRumbleNumber(value: unknown): number | null {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(num) || num < 0) return null;
  return num;
}

async function resolveOnchainRumbleIdForSlot(
  slotIndex: number,
  slotRumbleId: string,
): Promise<number | null> {
  const parsed = parseOnchainRumbleIdNumber(slotRumbleId);
  if (parsed !== null) return parsed;

  const active = await loadBettingRumbleCandidatesForSlot(slotIndex).catch(() => []);
  const candidate = active.find((entry) => entry.rumbleId === slotRumbleId);
  if (candidate && candidate.rumbleNumber !== null) {
    return candidate.rumbleNumber;
  }

  const persistedRows = await freshSupabase()
    .from("ucf_rumbles")
    .select("id, fighters, rumble_number, slot_index")
    .eq("slot_index", slotIndex)
    .eq("id", slotRumbleId)
    .limit(1);
  const rows = persistedRows.data ?? [];
  const match = rows.find((row) => Number((row as any).slot_index) === slotIndex && String((row as any).id) === slotRumbleId);
  if (!match) return null;
  const fighterIds = Array.isArray((match as any).fighters)
    ? (match as any).fighters.map((fighter: any) => String(fighter?.id ?? fighter)).filter(Boolean)
    : [];
  if (fighterIds.length < MIN_ACTIVE_RUMBLE_FIGHTERS) return null;
  return normalizeRumbleNumber((match as any).rumble_number);
}

function pickLatestBettingCandidate(
  candidates: BettingRumbleCandidate[],
): { rumbleId: string; rumbleNumber: number | null; fighterIds: string[] } | null {
  const best = candidates.find((candidate) => candidate.fighterIds.length >= MIN_ACTIVE_RUMBLE_FIGHTERS) ?? null;
  if (!best) return null;
  return {
    rumbleId: best.rumbleId,
    rumbleNumber: best.rumbleNumber,
    fighterIds: best.fighterIds,
  };
}

async function loadLatestBettingRumbleForSlot(slotIndex: number): Promise<{
  rumbleId: string;
  rumbleNumber: number | null;
  fighterIds: string[];
} | null> {
  const candidates = await loadBettingRumbleCandidatesForSlot(slotIndex).catch(() => []);
  return pickLatestBettingCandidate(candidates);
}

function isMissingTxSignatureTableError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: string }).code;
  return code === "42P01" || code === "PGRST205";
}

function isRetryableVerificationError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("transaction not found after retries") ||
    lower.includes("may not be confirmed yet") ||
    lower.includes("blockhash not found")
  );
}

type BetSignatureLock = { mode: "db" | "db-retained" | "memory"; txSignature: string } | null;

type ExistingIdempotentBetRow = {
  tx_signature?: string | null;
  response_payload?: unknown;
  wallet_address?: string | null;
};

async function releaseBetSignatureLock(lock: BetSignatureLock): Promise<void> {
  if (!lock) return;
  if (lock.mode === "memory") {
    unmarkSignatureUsed(lock.txSignature);
    return;
  }
  if (lock.mode === "db-retained") {
    return;
  }
  const { error } = await freshSupabase()
    .from("ucf_used_tx_signatures")
    .delete()
    .eq("tx_signature", lock.txSignature)
    .eq("kind", "rumble_bet");
  if (error) {
    console.error("[rumble/bet] Failed to release signature lock:", error);
  }
}

/**
 * GET /api/rumble/bet?slot_index=0
 *
 * Get betting info for a Rumble slot: odds per fighter, total pool.
 */
export async function GET(request: Request) {
  const rlKey = getRateLimitKey(request);
  const rl = checkRateLimit("PUBLIC_READ", rlKey);
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

  try {
    const { searchParams } = new URL(request.url);
    const slotIndexStr = searchParams.get("slot_index") ?? searchParams.get("slotIndex");

    if (slotIndexStr === null) {
      return NextResponse.json(
        { error: "Missing slot_index query parameter" },
        { status: 400 },
      );
    }

    const slotIndex = parseInt(slotIndexStr, 10);
    if (isNaN(slotIndex) || slotIndex < 0 || slotIndex > 2) {
      return NextResponse.json(
        { error: "slot_index must be 0, 1, or 2" },
        { status: 400 },
      );
    }

    await ensureRecovered();
    await ensureRumblePublicHeartbeat("bet_get");
    const orchestrator = getOrchestrator();
    const status = orchestrator.getStatus();
    const slot = status.find((s) => s.slotIndex === slotIndex);

    if (!slot) {
      return NextResponse.json({ error: "Slot not found" }, { status: 404 });
    }

    const odds = orchestrator.getOdds(slotIndex);
    const oddsVersion = orchestrator.getOddsVersion(slotIndex);
    const totalPool = odds.reduce((sum, o) => sum + o.solDeployed, 0);
    const bettingDeadlineMs = slot.bettingDeadline ? slot.bettingDeadline.getTime() : null;
    // odds_valid_until_ms: deadline minus 15s buffer, or 30s from now if no deadline
    const oddsValidUntilMs = bettingDeadlineMs
      ? bettingDeadlineMs - 15_000
      : Date.now() + 30_000;

    return NextResponse.json({
      slot_index: slotIndex,
      rumble_id: slot.rumbleId,
      state: slot.state,
      fighters: slot.fighters,
      odds,
      odds_version: oddsVersion,
      odds_valid_until_ms: oddsValidUntilMs,
      total_pool_sol: totalPool,
      betting_open: slot.state === "betting" && !!slot.bettingDeadline,
      betting_initializing: slot.state === "betting" && !slot.bettingDeadline,
      betting_deadline: slot.bettingDeadline?.toISOString() ?? null,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return NextResponse.json(sanitizeErrorResponse(error, "Failed to fetch betting info"), { status: 500 });
  }
}

/**
 * POST /api/rumble/bet
 *
 * Place a bet on a fighter in a Rumble slot.
 *
 * Auth modes:
 *   1. API key: { ..., api_key, bettor_id } — for bot bettors
 *   2. Wallet: { ..., wallet_address, tx_signature } — for spectators with connected wallet
 *      The tx_signature proves the SOL was transferred on-chain.
 */
export async function POST(request: Request) {
  const rlKey = getRateLimitKey(request);
  const rl = checkRateLimit("PUBLIC_WRITE", rlKey, "/api/rumble/bet");
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);
  const contentTypeError = requireJsonContentType(request);
  if (contentTypeError) return contentTypeError;

  let signatureLock: BetSignatureLock = null;
  let betRegistered = false;
  let existingIdempotentRow: ExistingIdempotentBetRow | null = null;

  try {
    const body = await request.json();
    const slotIndex = body.slot_index ?? body.slotIndex ?? body.rumbleSlotIndex;
    const apiKey = body.api_key || body.apiKey || getApiKeyFromHeaders(request.headers);
    const bettorWallet =
      body.bettor_wallet || body.bettorWallet || body.wallet_address || body.walletAddress;
    const bettorId = body.bettor_id || body.bettorId;
    let txSignature = body.tx_signature || body.txSignature;
    const txKind = body.tx_kind || body.txKind;
    const expectedOddsVersionRaw = body.expected_odds_version ?? body.expectedOddsVersion;
    const expectedOddsVersion =
      typeof expectedOddsVersionRaw === "number" && Number.isInteger(expectedOddsVersionRaw)
        ? expectedOddsVersionRaw
        : null;
    const rawBatch = Array.isArray(body.bets) ? body.bets : null;
    const idempotencyKey: string =
      (typeof (body.idempotency_key ?? body.idempotencyKey) === "string" &&
        (body.idempotency_key ?? body.idempotencyKey).trim().length > 0)
        ? (body.idempotency_key ?? body.idempotencyKey).trim()
        : randomUUID();

    // --- Idempotency check: if this key was already processed, return the stored response ---
    {
      const { data: existingRow, error: idemError } = await freshSupabase()
        .from("ucf_used_tx_signatures")
        .select("tx_signature, response_payload, wallet_address")
        .eq("idempotency_key", idempotencyKey)
        .maybeSingle();
      if (!idemError && existingRow?.response_payload) {
        console.log("[rumble/bet] Idempotency hit — returning stored response for key:", idempotencyKey);
        return NextResponse.json(existingRow.response_payload);
      }
      if (!idemError && existingRow) {
        existingIdempotentRow = existingRow;
        if (
          !txSignature &&
          existingRow.tx_signature &&
          typeof bettorWallet === "string" &&
          typeof existingRow.wallet_address === "string" &&
          existingRow.wallet_address.toLowerCase() === bettorWallet.toLowerCase()
        ) {
          txSignature = existingRow.tx_signature;
        }
      }
      // If the query fails (e.g. column doesn't exist yet), just proceed normally
      if (idemError && !isMissingTxSignatureTableError(idemError)) {
        console.warn("[rumble/bet] Idempotency lookup failed, proceeding without:", idemError);
      }
    }

    if (rawBatch && rawBatch.length > 16) {
      return NextResponse.json({ error: "Maximum 16 bets per batch" }, { status: 400 });
    }

    // Validate required fields
    if (slotIndex === undefined || slotIndex === null) {
      return NextResponse.json(
        {
          error: "Missing slot_index",
          required: ["slot_index", "fighter_id|bets", "sol_amount|bets[].sol_amount"],
          auth: "Provide (api_key + bettor_id) or (wallet_address + tx_signature)",
        },
        { status: 400 },
      );
    }

    const parsedSlotIndex = parseInt(String(slotIndex), 10);
    if (isNaN(parsedSlotIndex) || parsedSlotIndex < 0 || parsedSlotIndex > 2) {
      return NextResponse.json(
        { error: "slot_index must be 0, 1, or 2" },
        { status: 400 },
      );
    }

    const parsedBets: Array<{ fighterId: string; solAmount: number; fighterIndex?: number }> = [];
    if (rawBatch && rawBatch.length > 0) {
      for (const leg of rawBatch) {
        const fighterId = leg?.fighter_id ?? leg?.fighterId;
        const rawSolAmount = leg?.sol_amount ?? leg?.solAmount ?? leg?.amount;
        const solAmount = typeof rawSolAmount === "string" ? Number(rawSolAmount) : rawSolAmount;
        const fighterIndexRaw = leg?.fighter_index ?? leg?.fighterIndex;
        if (!fighterId || typeof fighterId !== "string") {
          return NextResponse.json({ error: "Each batch leg requires fighter_id." }, { status: 400 });
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
        parsedBets.push({
          fighterId,
          solAmount,
          fighterIndex:
            Number.isFinite(Number(fighterIndexRaw)) && Number.isInteger(Number(fighterIndexRaw))
              ? Number(fighterIndexRaw)
              : undefined,
        });
      }
    } else {
      const fighterId = body.fighter_id || body.fighterId;
      const rawSolAmount = body.sol_amount ?? body.solAmount ?? body.amount;
      const solAmount = typeof rawSolAmount === "string" ? Number(rawSolAmount) : rawSolAmount;
      const fighterIndexRaw = body.fighter_index ?? body.fighterIndex;
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
      parsedBets.push({
        fighterId,
        solAmount,
        fighterIndex:
          Number.isFinite(Number(fighterIndexRaw)) && Number.isInteger(Number(fighterIndexRaw))
            ? Number(fighterIndexRaw)
            : undefined,
      });
    }

    if (parsedBets.length === 0) {
      return NextResponse.json({ error: "No valid bets provided." }, { status: 400 });
    }

    await ensureRecovered();
    await ensureRumblePublicHeartbeat("bet_post");
    const requestedRumbleIdRaw = body.rumble_id ?? body.rumbleId;
    const requestedRumbleId =
      typeof requestedRumbleIdRaw === "string" && requestedRumbleIdRaw.trim().length > 0
        ? requestedRumbleIdRaw.trim()
        : null;
    const bettingCandidates = await loadBettingRumbleCandidatesForSlot(parsedSlotIndex).catch(() => []);
    const requestedBettingCandidate =
      requestedRumbleId
        ? bettingCandidates.find((candidate) => candidate.rumbleId === requestedRumbleId) ?? null
        : null;

    let resolvedWallet: string;
    let verifiedRumbleId: string | null = null;
    let verifiedFighterIds: string[] = [];
    let useMemoryReplayGuard = false;

    // --- Auth mode 1: Wallet + tx_signature (spectator betting) ---
    if (bettorWallet && txSignature) {
      if (
        existingIdempotentRow?.tx_signature &&
        existingIdempotentRow.tx_signature !== txSignature
      ) {
        return NextResponse.json(
          {
            error: "This idempotency key is already associated with a different transaction. Rebuild and re-sign a fresh bet.",
            error_code: "IDEMPOTENCY_MISMATCH",
          },
          { status: 409 },
        );
      }
      if (
        existingIdempotentRow?.wallet_address &&
        existingIdempotentRow.wallet_address.toLowerCase() !== bettorWallet.toLowerCase()
      ) {
        return NextResponse.json(
          {
            error: "This idempotency key is already associated with a different wallet. Rebuild and re-sign a fresh bet.",
            error_code: "IDEMPOTENCY_MISMATCH",
          },
          { status: 409 },
        );
      }
      const { data: existingSignature, error: existingSignatureError } = await freshSupabase()
        .from("ucf_used_tx_signatures")
        .select("tx_signature")
        .eq("tx_signature", txSignature)
        .maybeSingle();
      if (existingSignatureError) {
        if (isMissingTxSignatureTableError(existingSignatureError)) {
          // Migration not applied yet; fall back to process-memory replay guard.
          console.warn(
            "[rumble/bet] WARNING: ucf_used_tx_signatures table query failed — falling back to in-memory replay guard. " +
            "Apply the migration to enable persistent cross-instance protection. Error:",
            existingSignatureError,
          );
          useMemoryReplayGuard = true;
          if (isSignatureUsed(txSignature)) {
            return NextResponse.json(
              { error: "This transaction signature has already been used for a bet.", error_code: "REPLAY_DETECTED" },
              { status: 400 },
            );
          }
        } else {
          return NextResponse.json({ error: "Failed to validate transaction signature usage." }, { status: 500 });
        }
      }
      const sameIdempotentRetry =
        !!existingSignature &&
        existingIdempotentRow?.tx_signature === txSignature;
      if (existingSignature && !sameIdempotentRetry) {
        return NextResponse.json(
          { error: "This transaction signature has already been used for a bet.", error_code: "REPLAY_DETECTED" },
          { status: 400 },
        );
      }

      const orchestratorForVerification = getOrchestrator();
      const slotForVerification = orchestratorForVerification
        .getStatus()
        .find((s) => s.slotIndex === parsedSlotIndex);

      // Verify the transaction on-chain.
      // For wallet+signature bets we require a rumble_engine place_bet instruction
      // and do not trust tx_kind from the request body.
      const verification = await (async () => {
        const slotRumbleId =
          requestedRumbleId ??
          requestedBettingCandidate?.rumbleId ??
          slotForVerification?.rumbleId ??
          null;
        if (!slotRumbleId || typeof slotRumbleId !== "string") {
          return {
            valid: false,
            error: "No active rumble found for the provided slot.",
          };
        }

        const rumbleIdNum =
          requestedBettingCandidate?.rumbleNumber ??
          await resolveOnchainRumbleIdForSlot(parsedSlotIndex, slotRumbleId);
        if (rumbleIdNum === null) {
          return {
            valid: false,
            error: `Could not parse slot rumble id: ${slotRumbleId}`,
          };
        }
        const onchainRumble = await readMainnetRumbleAccountStateResilient(rumbleIdNum, {
          maxPasses: 2,
          retryDelayMs: 100,
        }).catch(() => null);
        const onchainFighterIds =
          onchainRumble?.fighters?.length
            ? await reconcileOnchainFighterIds(
                requestedBettingCandidate?.fighterIds?.length
                  ? requestedBettingCandidate.fighterIds
                  : slotForVerification?.fighters ?? [],
                onchainRumble.fighters,
              )
            : null;
        const verificationFighters =
          onchainFighterIds && onchainFighterIds.length > 0
            ? onchainFighterIds
            : requestedBettingCandidate?.fighterIds?.length
            ? requestedBettingCandidate.fighterIds
            : slotForVerification?.fighters ?? [];
        const verificationLegs = parsedBets.map((bet) => {
          const fighterIndexFromBody =
            typeof bet.fighterIndex === "number"
              ? bet.fighterIndex
              : verificationFighters.findIndex((fighterId) => fighterId === bet.fighterId);
          return {
            fighterIndex: fighterIndexFromBody,
            amountSol: bet.solAmount,
          };
        });
        if (verificationLegs.some((leg) => !Number.isInteger(leg.fighterIndex) || leg.fighterIndex < 0)) {
          return {
            valid: false,
            error: "Missing fighter_index for on-chain bet verification.",
          };
        }
        if (verificationLegs.length === 1) {
          const singleLeg = await verifyRumblePlaceBetTransaction(
            txSignature,
            bettorWallet,
            rumbleIdNum,
            verificationLegs[0].fighterIndex,
            verificationLegs[0].amountSol,
          );
          if (singleLeg.valid) {
            verifiedRumbleId = slotRumbleId;
            verifiedFighterIds = verificationFighters;
          }
          return singleLeg;
        }
        const batch = await verifyRumblePlaceBetBatchTransaction(
          txSignature,
          bettorWallet,
          rumbleIdNum,
          verificationLegs,
        );
        if (batch.valid) {
          verifiedRumbleId = slotRumbleId;
          verifiedFighterIds = verificationFighters;
        }
        return batch;
      })();
      if (!verification.valid) {
        const errorMessage = `TX verification failed: ${verification.error}`;
        const retryable = isRetryableVerificationError(String(verification.error ?? ""));
        return NextResponse.json(
          {
            error: retryable
              ? "Bet transaction is still propagating on-chain. Retrying registration may succeed."
              : errorMessage,
            retryable,
            detail: errorMessage,
          },
          { status: retryable ? 503 : 400 },
        );
      }

      if (verifiedRumbleId) {
        const liveSlot = orchestratorForVerification.getStatus().find((s) => s.slotIndex === parsedSlotIndex);
        if (liveSlot && liveSlot.rumbleId !== verifiedRumbleId) {
          console.warn("[rumble/bet] verified rumble no longer matches live slot", {
            slotIndex: parsedSlotIndex,
            liveRumbleId: liveSlot.rumbleId,
            verifiedRumbleId,
          });
        }
      }

      // Persist signature lock before registration to prevent replay across instances.
      if (useMemoryReplayGuard) {
        if (markSignatureUsed(txSignature)) {
          return NextResponse.json(
            { error: "This transaction signature has already been used for a bet.", error_code: "REPLAY_DETECTED" },
            { status: 400 },
          );
        }
        signatureLock = { mode: "memory", txSignature };
      } else if (sameIdempotentRetry) {
        signatureLock = { mode: "db-retained", txSignature };
      } else {
        const { error: signatureInsertError } = await freshSupabase()
          .from("ucf_used_tx_signatures")
          .insert({
            tx_signature: txSignature,
            kind: "rumble_bet",
            wallet_address: bettorWallet,
            rumble_id: verifiedRumbleId,
            slot_index: parsedSlotIndex,
            idempotency_key: idempotencyKey,
            payload: {
              tx_kind: txKind ?? null,
              legs: parsedBets.map((bet) => ({
                fighter_id: bet.fighterId,
                fighter_index: bet.fighterIndex ?? null,
                sol_amount: bet.solAmount,
              })),
            },
          });
        if (signatureInsertError) {
          if (isMissingTxSignatureTableError(signatureInsertError)) {
            console.warn(
              "[rumble/bet] WARNING: ucf_used_tx_signatures insert failed (table missing?) — falling back to in-memory guard. " +
              "Apply the migration to enable persistent protection. Error:",
              signatureInsertError,
            );
            if (markSignatureUsed(txSignature)) {
              return NextResponse.json(
                { error: "This transaction signature has already been used for a bet.", error_code: "REPLAY_DETECTED" },
                { status: 400 },
              );
            }
            signatureLock = { mode: "memory", txSignature };
          } else if ((signatureInsertError as any).code === "23505") {
            return NextResponse.json(
              { error: "This transaction signature has already been used for a bet.", error_code: "REPLAY_DETECTED" },
              { status: 400 },
            );
          } else {
            return NextResponse.json(
              { error: "Failed to persist transaction signature usage." },
              { status: 500 },
            );
          }
        } else {
          signatureLock = { mode: "db", txSignature };
        }
      }

      resolvedWallet = bettorWallet;
    }
    // --- Auth mode 2: API key (legacy bot betting; disabled by default) ---
    else if (apiKey) {
      if (!ALLOW_OFFCHAIN_BETS) {
        return NextResponse.json(
          {
            error:
              "Off-chain API-key betting is disabled. Submit a signed on-chain bet transaction instead.",
          },
          { status: 409 },
        );
      }

      const hashedKey = hashApiKey(apiKey);

      let authQuery = freshSupabase()
        .from("ucf_fighters")
        .select("id, wallet_address")
        .eq("api_key_hash", hashedKey);

      if (bettorId && typeof bettorId === "string") {
        authQuery = authQuery.eq("id", bettorId);
      } else if (bettorWallet && typeof bettorWallet === "string") {
        authQuery = authQuery.eq("wallet_address", bettorWallet);
      }

      const { data: authFighter } = await authQuery.maybeSingle();

      if (!authFighter) {
        return NextResponse.json({ error: "Invalid bettor credentials" }, { status: 401 });
      }
      if (!authFighter.wallet_address) {
        return NextResponse.json({ error: "Fighter has no wallet address" }, { status: 403 });
      }
      resolvedWallet = authFighter.wallet_address;
    }
    // --- No auth provided ---
    else {
      return NextResponse.json(
        { error: "Missing auth. Provide wallet_address + tx_signature." },
        { status: 400 },
      );
    }

    const orchestrator = getOrchestrator();
    const liveSlot = orchestrator.getStatus().find((s) => s.slotIndex === parsedSlotIndex) ?? null;
    const persistedBetting =
      requestedBettingCandidate
        ? {
            rumbleId: requestedBettingCandidate.rumbleId,
            rumbleNumber: requestedBettingCandidate.rumbleNumber,
            fighterIds: requestedBettingCandidate.fighterIds,
          }
        : await loadLatestBettingRumbleForSlot(parsedSlotIndex).catch(() => null);
    const authoritativeRumbleId =
      verifiedRumbleId ??
      persistedBetting?.rumbleId ??
      (liveSlot?.state === "betting" ? liveSlot.rumbleId : null);
    const authoritativeFighters =
      verifiedFighterIds.length > 0
        ? verifiedFighterIds
        : persistedBetting?.fighterIds?.length
        ? persistedBetting.fighterIds
        : liveSlot?.fighters ?? [];

    if (!authoritativeRumbleId) {
      await releaseBetSignatureLock(signatureLock);
      signatureLock = null;
      return NextResponse.json({ error: "Betting is not open for this slot right now.", error_code: "BETTING_CLOSED" }, { status: 409 });
    }

    if (
      verifiedRumbleId &&
      authoritativeRumbleId !== verifiedRumbleId
    ) {
      await releaseBetSignatureLock(signatureLock);
      signatureLock = null;
      return NextResponse.json(
        { error: "Slot rumble changed while processing this bet. Rebuild and re-sign a fresh bet transaction.", error_code: "BETTING_CLOSED" },
        { status: 409 },
      );
    }

    const shouldValidateFighterMembership = !verifiedRumbleId && authoritativeFighters.length > 0;
    for (const bet of parsedBets) {
      if (shouldValidateFighterMembership && !authoritativeFighters.includes(bet.fighterId)) {
        await releaseBetSignatureLock(signatureLock);
        signatureLock = null;
        return NextResponse.json(
          { error: `Fighter ${bet.fighterId} is not in the current rumble.`, error_code: "FIGHTER_NOT_FOUND" },
          { status: 400 },
        );
      }
    }

    // Optimistic concurrency: reject if caller's odds snapshot is stale
    if (expectedOddsVersion !== null) {
      const currentOddsVersion = orchestrator.getOddsVersion(parsedSlotIndex);
      if (expectedOddsVersion !== currentOddsVersion) {
        const currentOdds = orchestrator.getOdds(parsedSlotIndex);
        await releaseBetSignatureLock(signatureLock);
        signatureLock = null;
        return NextResponse.json(
          {
            error: "Odds have changed since your last fetch. Refresh odds and retry.",
            error_code: "STALE_ODDS",
            current_odds_version: currentOddsVersion,
            odds: currentOdds,
          },
          { status: 409 },
        );
      }
    }

    const result =
      liveSlot &&
      liveSlot.state === "betting" &&
      liveSlot.rumbleId === authoritativeRumbleId
        ? await orchestrator.placeBets(
            parsedSlotIndex,
            resolvedWallet,
            parsedBets.map((b) => ({ fighterId: b.fighterId, solAmount: b.solAmount })),
          )
        : { accepted: false as const, reason: "Betting pool not available." };

    const canFallbackToPersistentRegistration =
      !result.accepted &&
      (
        result.reason === "Slot not found." ||
        result.reason === "Betting pool not available." ||
        result.reason === "Betting is not open for this slot."
      );

    if (!result.accepted && !canFallbackToPersistentRegistration) {
      await releaseBetSignatureLock(signatureLock);
      signatureLock = null;
      return NextResponse.json(
        { error: result.reason ?? "Bet rejected." },
        { status: result.reason?.includes("retry with the same signed transaction") ? 503 : 400 },
      );
    }

    if (!result.accepted) {
      const persisted = await saveBets(
        parsedBets.map((bet) => {
          const adminFee = bet.solAmount * 0.01;
          const sponsorFee = bet.solAmount * 0.01;
          const netAmount = bet.solAmount - adminFee - sponsorFee;
          return {
            rumbleId: authoritativeRumbleId,
            walletAddress: resolvedWallet,
            fighterId: bet.fighterId,
            grossAmount: bet.solAmount,
            netAmount,
            adminFee,
            sponsorFee,
          };
        }),
      );

      if (!persisted.ok) {
        await releaseBetSignatureLock(signatureLock);
        signatureLock = null;
        return NextResponse.json(
          { error: persisted.reason ?? "Bet registration failed." },
          { status: persisted.reason?.includes("retry with the same signed transaction") ? 503 : 400 },
        );
      }

      if (
        liveSlot &&
        liveSlot.state === "betting" &&
        liveSlot.rumbleId === authoritativeRumbleId
      ) {
        const existingBets = await loadBetsForRumble(authoritativeRumbleId).catch(() => []);
        orchestrator.restoreBettingPool(parsedSlotIndex, authoritativeRumbleId, existingBets);
      }
    }
    betRegistered = true;

    const updatedOdds = orchestrator.getOdds(parsedSlotIndex);
    const updatedOddsVersion = orchestrator.getOddsVersion(parsedSlotIndex);

    const responsePayload = {
      status: "accepted",
      idempotency_key: idempotencyKey,
      slot_index: parsedSlotIndex,
      fighter_id: parsedBets[0].fighterId,
      sol_amount: parsedBets[0].solAmount,
      bets: parsedBets,
      total_sol_amount: parsedBets.reduce((sum, b) => sum + b.solAmount, 0),
      bettor_wallet: resolvedWallet,
      tx_signature: txSignature ?? null,
      updated_odds: updatedOdds,
      odds_version: updatedOddsVersion,
    };

    // Store the response payload for idempotency replay (awaited to prevent race on retry)
    if (txSignature) {
      const { error: storeErr } = await freshSupabase()
        .from("ucf_used_tx_signatures")
        .update({ response_payload: responsePayload })
        .eq("tx_signature", txSignature);
      if (storeErr) console.warn("[rumble/bet] Failed to store idempotency response_payload:", storeErr);
    }

    return NextResponse.json(responsePayload);
  } catch (error: any) {
    if (!betRegistered) {
      await releaseBetSignatureLock(signatureLock);
    }
    return NextResponse.json(sanitizeErrorResponse(error, "Failed to place bet"), { status: 500 });
  }
}
