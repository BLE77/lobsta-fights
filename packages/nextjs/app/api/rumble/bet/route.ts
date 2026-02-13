import { NextResponse } from "next/server";
import { getOrchestrator } from "~~/lib/rumble-orchestrator";
import { freshSupabase } from "~~/lib/supabase";
import { getApiKeyFromHeaders } from "~~/lib/request-auth";
import { verifyBetTransaction, markSignatureUsed, MIN_BET_SOL, MAX_BET_SOL } from "~~/lib/tx-verify";
import { checkRateLimit, getRateLimitKey, rateLimitResponse } from "~~/lib/rate-limit";
import { hashApiKey } from "~~/lib/api-key";

export const dynamic = "force-dynamic";

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
    const fighterId = body.fighter_id || body.fighterId;
    const rawSolAmount = body.sol_amount ?? body.solAmount ?? body.amount;
    const solAmount = typeof rawSolAmount === "string" ? Number(rawSolAmount) : rawSolAmount;
    const apiKey = body.api_key || body.apiKey || getApiKeyFromHeaders(request.headers);
    const bettorWallet =
      body.bettor_wallet || body.bettorWallet || body.wallet_address || body.walletAddress;
    const bettorId = body.bettor_id || body.bettorId;
    const txSignature = body.tx_signature || body.txSignature;

    // Validate required fields
    if (slotIndex === undefined || slotIndex === null) {
      return NextResponse.json(
        {
          error: "Missing slot_index",
          required: ["slot_index", "fighter_id", "sol_amount"],
          auth: "Provide (api_key + bettor_id) or (wallet_address + tx_signature)",
        },
        { status: 400 },
      );
    }
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

    const parsedSlotIndex = parseInt(String(slotIndex), 10);
    if (isNaN(parsedSlotIndex) || parsedSlotIndex < 0 || parsedSlotIndex > 2) {
      return NextResponse.json(
        { error: "slot_index must be 0, 1, or 2" },
        { status: 400 },
      );
    }

    let resolvedWallet: string;

    // --- Auth mode 1: Wallet + tx_signature (spectator betting) ---
    if (bettorWallet && txSignature) {
      // Replay protection: reject reused tx signatures
      const isReplay = markSignatureUsed(txSignature);
      if (isReplay) {
        return NextResponse.json(
          { error: "This transaction signature has already been used for a bet." },
          { status: 400 },
        );
      }

      // Verify the transaction on-chain
      const verification = await verifyBetTransaction(txSignature, bettorWallet, solAmount);
      if (!verification.valid) {
        return NextResponse.json(
          { error: `TX verification failed: ${verification.error}` },
          { status: 400 },
        );
      }

      resolvedWallet = bettorWallet;
    }
    // --- Auth mode 2: API key (bot betting) ---
    else if (apiKey) {
      const hashedKey = hashApiKey(apiKey);

      // Try hashed key first (new fighters)
      let authQuery = freshSupabase()
        .from("ucf_fighters")
        .select("id, wallet_address, api_key_hash")
        .eq("api_key_hash", hashedKey);

      if (bettorId && typeof bettorId === "string") {
        authQuery = authQuery.eq("id", bettorId);
      } else if (bettorWallet && typeof bettorWallet === "string") {
        authQuery = authQuery.eq("wallet_address", bettorWallet);
      }

      let { data: authFighter } = await authQuery.maybeSingle();

      // Fallback: plaintext api_key for old fighters without api_key_hash
      if (!authFighter) {
        let legacyQuery = freshSupabase()
          .from("ucf_fighters")
          .select("id, wallet_address, api_key_hash")
          .eq("api_key", apiKey);

        if (bettorId && typeof bettorId === "string") {
          legacyQuery = legacyQuery.eq("id", bettorId);
        } else if (bettorWallet && typeof bettorWallet === "string") {
          legacyQuery = legacyQuery.eq("wallet_address", bettorWallet);
        }

        const { data: legacyFighter } = await legacyQuery.maybeSingle();
        if (legacyFighter) {
          authFighter = legacyFighter;
          // Backfill hash for this fighter
          if (!legacyFighter.api_key_hash) {
            freshSupabase()
              .from("ucf_fighters")
              .update({ api_key_hash: hashedKey })
              .eq("id", legacyFighter.id)
              .then(() => {
                console.log(`[Auth] Backfilled api_key_hash for fighter ${legacyFighter.id}`);
              });
          }
        }
      }

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
        { error: "Missing auth. Provide (wallet_address + tx_signature) or api_key." },
        { status: 400 },
      );
    }

    const orchestrator = getOrchestrator();

    console.log(`[BetAPI] slotIndex=${parsedSlotIndex} fighterId=${fighterId} amount=${solAmount} wallet=${resolvedWallet}`);

    // placeBet validates: slot exists, state is "betting", fighter is in rumble,
    // and duplicate bet prevention (one fighter per wallet per Rumble)
    const result = orchestrator.placeBet(
      parsedSlotIndex,
      resolvedWallet,
      fighterId,
      solAmount,
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
      fighter_id: fighterId,
      sol_amount: solAmount,
      bettor_wallet: resolvedWallet,
      tx_signature: txSignature ?? null,
      updated_odds: updatedOdds,
    });
  } catch (error: any) {
    return NextResponse.json({ error: "Failed to place bet" }, { status: 500 });
  }
}
