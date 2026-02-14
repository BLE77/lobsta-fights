import { NextResponse } from "next/server";
import { getOrchestrator } from "~~/lib/rumble-orchestrator";
import { freshSupabase } from "~~/lib/supabase";
import { getApiKeyFromHeaders } from "~~/lib/request-auth";
import {
  verifyBetTransaction,
  verifyRumblePlaceBetBatchTransaction,
  verifyRumblePlaceBetTransaction,
  isSignatureUsed,
  markSignatureUsed,
  MIN_BET_SOL,
  MAX_BET_SOL,
} from "~~/lib/tx-verify";
import { checkRateLimit, getRateLimitKey, rateLimitResponse } from "~~/lib/rate-limit";
import { hashApiKey } from "~~/lib/api-key";
import { parseOnchainRumbleIdNumber } from "~~/lib/rumble-id";

export const dynamic = "force-dynamic";
const ALLOW_OFFCHAIN_BETS = String(process.env.RUMBLE_ALLOW_OFFCHAIN_BETS ?? "false").toLowerCase() === "true";

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

    const orchestrator = getOrchestrator();
    const status = orchestrator.getStatus();
    const slot = status.find((s) => s.slotIndex === slotIndex);

    if (!slot) {
      return NextResponse.json({ error: "Slot not found" }, { status: 404 });
    }

    const odds = orchestrator.getOdds(slotIndex);
    const totalPool = odds.reduce((sum, o) => sum + o.solDeployed, 0);

    return NextResponse.json({
      slot_index: slotIndex,
      rumble_id: slot.rumbleId,
      state: slot.state,
      fighters: slot.fighters,
      odds,
      total_pool_sol: totalPool,
      betting_open: slot.state === "betting",
      betting_deadline: slot.bettingDeadline?.toISOString() ?? null,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return NextResponse.json({ error: "Failed to fetch betting info" }, { status: 500 });
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
  const rl = checkRateLimit("PUBLIC_WRITE", rlKey);
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

  try {
    const body = await request.json();
    const slotIndex = body.slot_index ?? body.slotIndex ?? body.rumbleSlotIndex;
    const apiKey = body.api_key || body.apiKey || getApiKeyFromHeaders(request.headers);
    const bettorWallet =
      body.bettor_wallet || body.bettorWallet || body.wallet_address || body.walletAddress;
    const bettorId = body.bettor_id || body.bettorId;
    const txSignature = body.tx_signature || body.txSignature;
    const txKind = body.tx_kind || body.txKind;
    const rawBatch = Array.isArray(body.bets) ? body.bets : null;

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

    let resolvedWallet: string;
    let verifiedRumbleId: string | null = null;
    let useMemoryReplayGuard = false;

    // --- Auth mode 1: Wallet + tx_signature (spectator betting) ---
    if (bettorWallet && txSignature) {
      const { data: existingSignature, error: existingSignatureError } = await freshSupabase()
        .from("ucf_used_tx_signatures")
        .select("tx_signature")
        .eq("tx_signature", txSignature)
        .maybeSingle();
      if (existingSignatureError) {
        if ((existingSignatureError as any).code === "42P01") {
          // Migration not applied yet; fall back to process-memory replay guard.
          useMemoryReplayGuard = true;
          if (isSignatureUsed(txSignature)) {
            return NextResponse.json(
              { error: "This transaction signature has already been used for a bet." },
              { status: 400 },
            );
          }
        } else {
          return NextResponse.json({ error: "Failed to validate transaction signature usage." }, { status: 500 });
        }
      }
      if (existingSignature) {
        return NextResponse.json(
          { error: "This transaction signature has already been used for a bet." },
          { status: 400 },
        );
      }

      const orchestratorForVerification = getOrchestrator();
      const slotForVerification = orchestratorForVerification
        .getStatus()
        .find((s) => s.slotIndex === parsedSlotIndex);

      // Verify the transaction on-chain
      const verification =
        txKind === "rumble_place_bet" || txKind === "rumble_place_bet_batch"
          ? await (async () => {
              const slotRumbleId = slotForVerification?.rumbleId;
              if (!slotRumbleId || typeof slotRumbleId !== "string") {
                return {
                  valid: false,
                  error: "No active rumble found for the provided slot.",
                };
              }
              const requestedRumbleId = body.rumble_id || body.rumbleId;
              if (requestedRumbleId && requestedRumbleId !== slotRumbleId) {
                return {
                  valid: false,
                  error: `Requested rumble_id (${requestedRumbleId}) does not match slot rumble (${slotRumbleId}).`,
                };
              }

              const rumbleIdNum = parseOnchainRumbleIdNumber(slotRumbleId);
              if (rumbleIdNum === null) {
                return {
                  valid: false,
                  error: `Could not parse slot rumble id: ${slotRumbleId}`,
                };
              }
              const verificationLegs = parsedBets.map((bet) => {
                const fighterIndexFromBody =
                  typeof bet.fighterIndex === "number"
                    ? bet.fighterIndex
                    : slotForVerification?.fighters.findIndex((f) => f === bet.fighterId) ?? -1;
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
                if (singleLeg.valid) verifiedRumbleId = slotRumbleId;
                return singleLeg;
              }
              const batch = await verifyRumblePlaceBetBatchTransaction(
                txSignature,
                bettorWallet,
                rumbleIdNum,
                verificationLegs,
              );
              if (batch.valid) verifiedRumbleId = slotRumbleId;
              return batch;
            })()
          : await verifyBetTransaction(
              txSignature,
              bettorWallet,
              parsedBets.reduce((sum, b) => sum + b.solAmount, 0),
            );
      if (!verification.valid) {
        return NextResponse.json(
          { error: `TX verification failed: ${verification.error}` },
          { status: 400 },
        );
      }

      if (verifiedRumbleId) {
        const liveSlot = orchestratorForVerification.getStatus().find((s) => s.slotIndex === parsedSlotIndex);
        if (!liveSlot || liveSlot.rumbleId !== verifiedRumbleId) {
          return NextResponse.json(
            { error: "Slot rumble changed while processing this bet. Rebuild and re-sign a fresh bet transaction." },
            { status: 409 },
          );
        }
      }

      // Persist signature lock before registration to prevent replay across instances.
      if (useMemoryReplayGuard) {
        if (markSignatureUsed(txSignature)) {
          return NextResponse.json(
            { error: "This transaction signature has already been used for a bet." },
            { status: 400 },
          );
        }
      } else {
        const { error: signatureInsertError } = await freshSupabase()
          .from("ucf_used_tx_signatures")
          .insert({
            tx_signature: txSignature,
            kind: "rumble_bet",
            wallet_address: bettorWallet,
            rumble_id: verifiedRumbleId,
            slot_index: parsedSlotIndex,
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
          if ((signatureInsertError as any).code === "23505") {
            return NextResponse.json(
              { error: "This transaction signature has already been used for a bet." },
              { status: 400 },
            );
          }
          return NextResponse.json(
            { error: "Failed to persist transaction signature usage." },
            { status: 500 },
          );
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
    if (verifiedRumbleId) {
      const liveSlot = orchestrator.getStatus().find((s) => s.slotIndex === parsedSlotIndex);
      if (!liveSlot || liveSlot.rumbleId !== verifiedRumbleId) {
        return NextResponse.json(
          { error: "Slot rumble changed while processing this bet. Rebuild and re-sign a fresh bet transaction." },
          { status: 409 },
        );
      }
    }
    const result = orchestrator.placeBets(
      parsedSlotIndex,
      resolvedWallet,
      parsedBets.map((b) => ({ fighterId: b.fighterId, solAmount: b.solAmount })),
    );

    if (!result.accepted) {
      return NextResponse.json(
        { error: result.reason ?? "Bet rejected." },
        { status: 400 },
      );
    }

    const updatedOdds = orchestrator.getOdds(parsedSlotIndex);

    return NextResponse.json({
      status: "accepted",
      slot_index: parsedSlotIndex,
      fighter_id: parsedBets[0].fighterId,
      sol_amount: parsedBets[0].solAmount,
      bets: parsedBets,
      total_sol_amount: parsedBets.reduce((sum, b) => sum + b.solAmount, 0),
      bettor_wallet: resolvedWallet,
      tx_signature: txSignature ?? null,
      updated_odds: updatedOdds,
    });
  } catch (error: any) {
    return NextResponse.json({ error: "Failed to place bet" }, { status: 500 });
  }
}
