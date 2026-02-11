import { NextResponse } from "next/server";
import { getOrchestrator } from "~~/lib/rumble-orchestrator";

export const dynamic = "force-dynamic";

/**
 * GET /api/rumble/bet?slot_index=0
 *
 * Get betting info for a Rumble slot: odds per fighter, total pool.
 */
export async function GET(request: Request) {
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
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * POST /api/rumble/bet
 *
 * Place a bet on a fighter in a Rumble slot.
 * Body: { slot_index, fighter_id, sol_amount, bettor_wallet }
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const slotIndex = body.slot_index ?? body.slotIndex ?? body.rumbleSlotIndex;
    const fighterId = body.fighter_id || body.fighterId;
    const rawSolAmount = body.sol_amount ?? body.solAmount ?? body.amount;
    const solAmount = typeof rawSolAmount === "string" ? Number(rawSolAmount) : rawSolAmount;
    const bettorWallet =
      body.bettor_wallet ||
      body.bettorWallet ||
      body.wallet_address ||
      body.walletAddress ||
      body.bettor_id ||
      body.bettorId;

    // Validate required fields
    if (slotIndex === undefined || slotIndex === null) {
      return NextResponse.json(
        { error: "Missing slot_index", required: ["slot_index", "fighter_id", "sol_amount", "bettor_wallet"] },
        { status: 400 },
      );
    }
    if (!fighterId || typeof fighterId !== "string") {
      return NextResponse.json({ error: "Missing fighter_id" }, { status: 400 });
    }
    if (typeof solAmount !== "number" || !Number.isFinite(solAmount) || solAmount <= 0) {
      return NextResponse.json({ error: "sol_amount must be a positive number" }, { status: 400 });
    }
    if (!bettorWallet || typeof bettorWallet !== "string") {
      return NextResponse.json({ error: "Missing bettor_wallet" }, { status: 400 });
    }

    const parsedSlotIndex = parseInt(String(slotIndex), 10);
    if (isNaN(parsedSlotIndex) || parsedSlotIndex < 0 || parsedSlotIndex > 2) {
      return NextResponse.json(
        { error: "slot_index must be 0, 1, or 2" },
        { status: 400 },
      );
    }

    const orchestrator = getOrchestrator();

    // placeBet validates: slot exists, state is "betting", fighter is in rumble
    const accepted = orchestrator.placeBet(parsedSlotIndex, bettorWallet, fighterId, solAmount);

    if (!accepted) {
      return NextResponse.json(
        { error: "Bet rejected. Either betting is not open for this slot, or the fighter is not in this rumble." },
        { status: 400 },
      );
    }

    const updatedOdds = orchestrator.getOdds(parsedSlotIndex);

    return NextResponse.json({
      status: "accepted",
      slot_index: parsedSlotIndex,
      fighter_id: fighterId,
      sol_amount: solAmount,
      bettor_wallet: bettorWallet,
      updated_odds: updatedOdds,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
