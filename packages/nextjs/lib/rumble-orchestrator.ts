// =============================================================================
// Rumble Orchestrator - Coordinates queue, combat engine, and betting system
//
// The main lifecycle coordinator for the Ichor Rumble system. Manages 3
// staggered slots, each independently cycling through:
//   IDLE → BETTING → COMBAT → PAYOUT → IDLE
//
// Called on a regular tick (~1s). Emits events for live spectator updates.
// =============================================================================

import {
  RumbleQueueManager,
  getQueueManager,
  type RumbleSlot,
  type SlotState,
} from "./queue-manager";

import {
  selectMove,
  type RumbleResult,
  type RumbleFighter,
  type RumbleTurn,
} from "./rumble-engine";

import {
  createBettingPool,
  placeBet as placeBetInPool,
  calculatePayouts,
  calculateOdds,
  getBlockReward,
  summarizePayouts,
  ADMIN_FEE_RATE,
  SPONSORSHIP_RATE,
  type BettingPool,
  type PayoutResult,
  type FighterOdds,
} from "./betting";
import { METER_PER_TURN, SPECIAL_METER_COST, resolveCombat } from "./combat";

import * as persist from "./rumble-persistence";

import {
  mintRumbleReward as mintRumbleRewardOnChain,
  checkIchorShower as checkIchorShowerOnChain,
  createRumble as createRumbleOnChain,
  reportResult as reportResultOnChain,
  completeRumble as completeRumbleOnChain,
  sweepTreasury as sweepTreasuryOnChain,
  updateFighterRecord as updateFighterRecordOnChain,
  getIchorMint,
  deriveArenaConfigPda,
} from "./solana-programs";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OrchestratorEvent =
  | "turn_resolved"
  | "fighter_eliminated"
  | "rumble_complete"
  | "ichor_shower"
  | "betting_open"
  | "betting_closed"
  | "combat_started"
  | "payout_complete"
  | "slot_recycled";

export interface TurnResolvedEvent {
  slotIndex: number;
  rumbleId: string;
  turn: RumbleTurn;
  remainingFighters: number;
}

export interface FighterEliminatedEvent {
  slotIndex: number;
  rumbleId: string;
  fighterId: string;
  turnNumber: number;
  remainingFighters: number;
}

export interface RumbleCompleteEvent {
  slotIndex: number;
  rumbleId: string;
  result: RumbleResult;
}

export interface IchorShowerEvent {
  slotIndex: number;
  rumbleId: string;
  winnerId: string;
  amount: number;
}

export interface BettingOpenEvent {
  slotIndex: number;
  rumbleId: string;
  fighters: string[];
  deadline: Date;
}

export interface BettingClosedEvent {
  slotIndex: number;
  rumbleId: string;
  odds: FighterOdds[];
}

export interface CombatStartedEvent {
  slotIndex: number;
  rumbleId: string;
  fighters: string[];
}

export interface PayoutCompleteEvent {
  slotIndex: number;
  rumbleId: string;
  payout: PayoutResult;
}

export interface SlotRecycledEvent {
  slotIndex: number;
  previousFighters: string[];
}

type EventData = {
  turn_resolved: TurnResolvedEvent;
  fighter_eliminated: FighterEliminatedEvent;
  rumble_complete: RumbleCompleteEvent;
  ichor_shower: IchorShowerEvent;
  betting_open: BettingOpenEvent;
  betting_closed: BettingClosedEvent;
  combat_started: CombatStartedEvent;
  payout_complete: PayoutCompleteEvent;
  slot_recycled: SlotRecycledEvent;
};

type EventCallback<E extends OrchestratorEvent> = (data: EventData[E]) => void;

// ---------------------------------------------------------------------------
// Per-slot combat state (tracks incremental turn-by-turn execution)
// ---------------------------------------------------------------------------

interface SlotCombatState {
  rumbleId: string;
  fighters: RumbleFighter[];
  turns: RumbleTurn[];
  eliminationOrder: string[];
  previousPairings: Set<string>;
  lastTickAt: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NUM_SLOTS = 3;
const COMBAT_TICK_INTERVAL_MS = 3_000; // one turn every ~3 seconds

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export class RumbleOrchestrator {
  private queueManager: RumbleQueueManager;

  // Betting pools indexed by slot
  private bettingPools: Map<number, BettingPool> = new Map();

  // Incremental combat state indexed by slot
  private combatStates: Map<number, SlotCombatState> = new Map();

  // Auto-requeue tracking: fighters that opted in
  private autoRequeueFighters: Map<number, Set<string>> = new Map();

  // Event listeners
  private listeners: Map<OrchestratorEvent, Set<EventCallback<any>>> = new Map();

  // Global counters
  private totalRumblesCompleted = 0;
  private ichorShowerPool = 0;

  constructor(queueManager: RumbleQueueManager) {
    this.queueManager = queueManager;

    // Hook into the queue manager's slot recycling so we can handle auto-requeue
    this.queueManager.onSlotRecycled = (slotIndex, previousFighters) => {
      this.handleSlotRecycled(slotIndex, previousFighters);
    };
  }

  // ---- Event emitter -------------------------------------------------------

  on<E extends OrchestratorEvent>(event: E, callback: EventCallback<E>): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);
  }

  off<E extends OrchestratorEvent>(event: E, callback: EventCallback<E>): void {
    this.listeners.get(event)?.delete(callback);
  }

  emit<E extends OrchestratorEvent>(event: E, data: EventData[E]): void {
    const cbs = this.listeners.get(event);
    if (!cbs) return;
    for (const cb of cbs) {
      try {
        cb(data);
      } catch (err) {
        console.error(`[Orchestrator] Error in ${event} listener:`, err);
      }
    }
  }

  // ---- Main tick -----------------------------------------------------------

  /**
   * Called on a regular interval (~1 second). Drives the entire Rumble
   * lifecycle by advancing queue manager slots and running combat turns.
   */
  tick(): void {
    // Let the queue manager handle state transitions (idle→betting, betting→combat, etc.)
    this.queueManager.advanceSlots();

    const slots = this.queueManager.getSlots();
    for (const slot of slots) {
      this.processSlot(slot);
    }
  }

  // ---- Per-slot processing -------------------------------------------------

  private processSlot(slot: RumbleSlot): void {
    switch (slot.state) {
      case "betting":
        this.handleBettingPhase(slot);
        break;
      case "combat":
        this.handleCombatPhase(slot);
        break;
      case "payout":
        this.handlePayoutPhase(slot);
        break;
      // idle: nothing to do, queue manager handles transition
    }
  }

  // ---- Betting phase -------------------------------------------------------

  private handleBettingPhase(slot: RumbleSlot): void {
    const idx = slot.slotIndex;

    // Create betting pool if we don't have one for this rumble
    if (!this.bettingPools.has(idx) || this.bettingPools.get(idx)!.rumbleId !== slot.id) {
      const pool = createBettingPool(slot.id);
      this.bettingPools.set(idx, pool);

      // Persist: create rumble record and update queue fighter statuses
      persist.createRumbleRecord({
        id: slot.id,
        slotIndex: idx,
        fighters: slot.fighters.map((id) => ({ id, name: id })),
      });
      for (const fid of slot.fighters) {
        persist.saveQueueFighter(fid, "in_combat");
      }

      this.emit("betting_open", {
        slotIndex: idx,
        rumbleId: slot.id,
        fighters: [...slot.fighters],
        deadline: slot.bettingDeadline!,
      });

      // On-chain: create rumble (best-effort, fire-and-forget)
      this.createRumbleOnChain(slot).catch((err) => {
        console.error(`[Orchestrator] On-chain createRumble failed for ${slot.id}:`, err);
      });
    }
  }

  /**
   * Create a rumble on-chain when betting opens. Best-effort for devnet.
   */
  private async createRumbleOnChain(slot: RumbleSlot): Promise<void> {
    const rumbleIdNum = parseInt(slot.id.replace(/\D/g, ""), 10);
    if (isNaN(rumbleIdNum)) {
      console.warn(`[Orchestrator] Cannot parse rumbleId "${slot.id}" for on-chain create`);
      return;
    }

    // Convert fighter IDs to PublicKeys (only works if they're valid pubkeys)
    const fighterPubkeys: PublicKey[] = [];
    for (const fid of slot.fighters) {
      try {
        fighterPubkeys.push(new PublicKey(fid));
      } catch {
        // Fighter IDs are names, not pubkeys yet - skip on-chain creation
        console.log(`[Orchestrator] Fighter "${fid}" is not a pubkey, skipping on-chain createRumble`);
        return;
      }
    }

    const deadline = slot.bettingDeadline
      ? Math.floor(slot.bettingDeadline.getTime() / 1000)
      : Math.floor(Date.now() / 1000) + 60;

    try {
      const sig = await createRumbleOnChain(rumbleIdNum, fighterPubkeys, deadline);
      if (sig) {
        console.log(`[Orchestrator] On-chain createRumble tx: ${sig}`);
      }
    } catch (err) {
      console.error(`[Orchestrator] createRumbleOnChain error:`, err);
    }
  }

  /**
   * External API: place a bet on a fighter in a slot.
   */
  placeBet(slotIndex: number, bettorId: string, fighterId: string, solAmount: number): boolean {
    const slot = this.queueManager.getSlot(slotIndex);
    if (!slot || slot.state !== "betting") return false;

    // Validate fighter is in this rumble
    if (!slot.fighters.includes(fighterId)) return false;

    const pool = this.bettingPools.get(slotIndex);
    if (!pool || pool.rumbleId !== slot.id) return false;

    placeBetInPool(pool, bettorId, fighterId, solAmount);

    // Also record in the queue manager's betting pool (for its own tracking)
    this.queueManager.placeBet(slotIndex, bettorId, solAmount);

    // Persist: save bet to Supabase
    const adminFee = solAmount * ADMIN_FEE_RATE;
    const sponsorFee = solAmount * SPONSORSHIP_RATE;
    const netAmount = solAmount - adminFee - sponsorFee;
    persist.saveBet({
      rumbleId: slot.id,
      walletAddress: bettorId,
      fighterId,
      grossAmount: solAmount,
      netAmount,
      adminFee,
      sponsorFee,
    });

    return true;
  }

  /**
   * External API: get current odds for a slot.
   */
  getOdds(slotIndex: number): FighterOdds[] {
    const pool = this.bettingPools.get(slotIndex);
    if (!pool) return [];
    return calculateOdds(pool);
  }

  // ---- Combat phase --------------------------------------------------------

  private handleCombatPhase(slot: RumbleSlot): void {
    const idx = slot.slotIndex;
    const now = Date.now();

    // Initialize combat state when we first enter combat
    if (!this.combatStates.has(idx) || this.combatStates.get(idx)!.rumbleId !== slot.id) {
      this.initCombatState(slot);

      // Emit betting closed event with final odds
      const pool = this.bettingPools.get(idx);
      if (pool) {
        this.emit("betting_closed", {
          slotIndex: idx,
          rumbleId: slot.id,
          odds: calculateOdds(pool),
        });
      }

      // Persist: mark rumble as combat
      persist.updateRumbleStatus(slot.id, "combat");

      this.emit("combat_started", {
        slotIndex: idx,
        rumbleId: slot.id,
        fighters: [...slot.fighters],
      });
      return; // wait for next tick to run first turn
    }

    const state = this.combatStates.get(idx)!;

    // Throttle: only run one turn per COMBAT_TICK_INTERVAL_MS
    if (now - state.lastTickAt < COMBAT_TICK_INTERVAL_MS) return;

    // Run one turn
    this.runCombatTurn(slot, state);
    state.lastTickAt = now;
  }

  private initCombatState(slot: RumbleSlot): void {
    // Build RumbleFighter array from slot's fighter IDs
    // For now, use IDs as names (in production, look up fighter profiles)
    const MAX_HP = 100; // matches combat.ts default

    const fighters: RumbleFighter[] = slot.fighters.map((id) => ({
      id,
      name: id,
      hp: MAX_HP,
      meter: 0,
      totalDamageDealt: 0,
      totalDamageTaken: 0,
      eliminatedOnTurn: null,
      placement: 0,
    }));

    this.combatStates.set(slot.slotIndex, {
      rumbleId: slot.id,
      fighters,
      turns: [],
      eliminationOrder: [],
      previousPairings: new Set(),
      lastTickAt: Date.now(),
    });
  }

  /**
   * Execute a single combat turn for a slot. Called from tick() during
   * combat phase, throttled to one turn per COMBAT_TICK_INTERVAL_MS.
   */
  async runCombatPhase(slotIndex: number): Promise<void> {
    const slot = this.queueManager.getSlot(slotIndex);
    if (!slot || slot.state !== "combat") return;

    const state = this.combatStates.get(slotIndex);
    if (!state) return;

    this.runCombatTurn(slot, state);
  }

  private runCombatTurn(slot: RumbleSlot, state: SlotCombatState): void {
    const MAX_TURNS = 20;

    const alive = state.fighters.filter((f) => f.hp > 0);

    // If only 0-1 fighters remain, rumble is complete
    if (alive.length <= 1) {
      this.finishCombat(slot, state);
      return;
    }

    // If we've hit max turns, end the rumble
    if (state.turns.length >= MAX_TURNS) {
      this.finishCombat(slot, state);
      return;
    }

    const turnNumber = state.turns.length + 1;
    const aliveIds = alive.map((f) => f.id);

    // Create pairings (shuffle and pair)
    const { pairings, bye } = this.createPairings(aliveIds, state.previousPairings);

    const turnPairings: Array<{
      fighterA: string;
      fighterB: string;
      moveA: string;
      moveB: string;
      damageToA: number;
      damageToB: number;
    }> = [];
    const turnEliminations: string[] = [];
    const currentPairingsSet = new Set<string>();

    for (const [idA, idB] of pairings) {
      const fA = state.fighters.find((f) => f.id === idA)!;
      const fB = state.fighters.find((f) => f.id === idB)!;

      // Select moves (placeholder AI)
      const moveA = selectMove(fA, alive.filter((f) => f.id !== fA.id), state.turns as any);
      const moveB = selectMove(fB, alive.filter((f) => f.id !== fB.id), state.turns as any);

      const result = resolveCombat(moveA, moveB, fA.meter, fB.meter);

      // Apply meter usage
      fA.meter = Math.max(0, fA.meter - result.meterUsedA);
      fB.meter = Math.max(0, fB.meter - result.meterUsedB);

      // Apply damage
      fA.hp = Math.max(0, fA.hp - result.damageToA);
      fB.hp = Math.max(0, fB.hp - result.damageToB);

      // Track stats
      fA.totalDamageDealt += result.damageToB;
      fA.totalDamageTaken += result.damageToA;
      fB.totalDamageDealt += result.damageToA;
      fB.totalDamageTaken += result.damageToB;

      turnPairings.push({
        fighterA: idA,
        fighterB: idB,
        moveA,
        moveB,
        damageToA: result.damageToA,
        damageToB: result.damageToB,
      });

      const key = idA < idB ? `${idA}:${idB}` : `${idB}:${idA}`;
      currentPairingsSet.add(key);
    }

    // Grant meter only to fighters that actually participated in pairings.
    const pairedThisTurn = new Set<string>();
    for (const pairing of turnPairings) {
      pairedThisTurn.add(pairing.fighterA);
      pairedThisTurn.add(pairing.fighterB);
    }
    for (const f of state.fighters) {
      if (f.hp > 0 && pairedThisTurn.has(f.id)) {
        f.meter = Math.min(f.meter + METER_PER_TURN, SPECIAL_METER_COST);
      }
    }

    // Record eliminations
    for (const f of state.fighters) {
      if (f.hp <= 0 && f.eliminatedOnTurn === null) {
        f.eliminatedOnTurn = turnNumber;
        turnEliminations.push(f.id);
        state.eliminationOrder.push(f.id);
      }
    }

    const turn: RumbleTurn = {
      turnNumber,
      pairings: turnPairings,
      eliminations: turnEliminations,
    };
    if (bye) turn.bye = bye;

    state.turns.push(turn);
    state.previousPairings = currentPairingsSet;

    // Persist: update turn log after each turn
    persist.updateRumbleTurnLog(slot.id, state.turns, state.turns.length);

    // Emit events
    const remaining = state.fighters.filter((f) => f.hp > 0).length;

    this.emit("turn_resolved", {
      slotIndex: slot.slotIndex,
      rumbleId: slot.id,
      turn,
      remainingFighters: remaining,
    });

    for (const eliminatedId of turnEliminations) {
      this.emit("fighter_eliminated", {
        slotIndex: slot.slotIndex,
        rumbleId: slot.id,
        fighterId: eliminatedId,
        turnNumber,
        remainingFighters: remaining,
      });
    }

    // Check if combat is done
    if (remaining <= 1 || state.turns.length >= MAX_TURNS) {
      this.finishCombat(slot, state);
    }
  }

  private finishCombat(slot: RumbleSlot, state: SlotCombatState): void {
    // Determine placements
    const allFighters = [...state.fighters];
    const alive = allFighters.filter((f) => f.hp > 0);
    const eliminated = allFighters.filter((f) => f.hp <= 0);

    // Sort alive by HP desc, tiebreak by damage dealt desc
    alive.sort((a, b) => {
      if (b.hp !== a.hp) return b.hp - a.hp;
      return b.totalDamageDealt - a.totalDamageDealt;
    });

    // Sort eliminated: later elimination = better placement
    eliminated.sort((a, b) => {
      if (a.eliminatedOnTurn !== b.eliminatedOnTurn) {
        return (b.eliminatedOnTurn ?? 0) - (a.eliminatedOnTurn ?? 0);
      }
      return b.totalDamageDealt - a.totalDamageDealt;
    });

    const ranked = [...alive, ...eliminated];
    for (let i = 0; i < ranked.length; i++) {
      ranked[i].placement = i + 1;
    }

    const winner = ranked[0].id;

    const result: RumbleResult = {
      rumbleId: state.rumbleId,
      fighters: ranked,
      turns: state.turns,
      winner,
      placements: ranked.map((f) => ({ id: f.id, placement: f.placement })),
      totalTurns: state.turns.length,
    };

    // Persist: complete rumble record with winner and placements
    persist.completeRumbleRecord(
      state.rumbleId,
      winner,
      result.placements,
      state.turns,
      state.turns.length,
    );

    // Report result to queue manager (triggers payout transition on next advanceSlots)
    this.queueManager.reportResult(slot.slotIndex, {
      rumbleId: slot.id,
      fighters: state.fighters,
      turns: state.turns,
      winner,
      placements: ranked.map((f, i) => ({ id: f.id, placement: i + 1 })),
      totalTurns: state.turns.length,
    });

    this.emit("rumble_complete", {
      slotIndex: slot.slotIndex,
      rumbleId: slot.id,
      result,
    });

    // Fire-and-forget on-chain settlement (report result, ICHOR minting, shower check)
    this.settleOnChain(slot.id, winner, result.placements, state.fighters).catch((err) => {
      console.error(`[Orchestrator] On-chain settlement failed for ${slot.id}:`, err);
    });
  }

  /**
   * Settle a completed rumble on-chain:
   * 1. Report result on-chain (placements)
   * 2. Mint ICHOR reward to winner
   * 3. Check for Ichor Shower trigger
   * 4. Complete rumble on-chain
   *
   * All calls are best-effort: failures are logged but do not block the
   * off-chain payout flow. This is safe for devnet testing.
   */
  private async settleOnChain(
    rumbleId: string,
    winnerId: string,
    placements: Array<{ id: string; placement: number }>,
    fighters: RumbleFighter[],
  ): Promise<void> {
    // Parse rumble ID as number for on-chain calls
    const rumbleIdNum = parseInt(rumbleId.replace(/\D/g, ""), 10);
    if (isNaN(rumbleIdNum)) {
      console.warn(`[Orchestrator] Cannot parse rumbleId "${rumbleId}" as number, skipping on-chain`);
      return;
    }

    // 1. Report result on-chain
    try {
      // Build placements array: placements[i] = placement of fighter at index i
      const placementArray = placements.map((p) => p.placement);
      const winnerIndex = placements.findIndex((p) => p.placement === 1);
      if (winnerIndex >= 0) {
        const sig = await reportResultOnChain(rumbleIdNum, placementArray, winnerIndex);
        if (sig) {
          console.log(`[Orchestrator] On-chain reportResult tx: ${sig}`);
        }
      }
    } catch (err) {
      console.error(`[Orchestrator] On-chain reportResult failed:`, err);
    }

    // 2. Mint ICHOR reward to winner
    try {
      const ichorMint = getIchorMint();
      // The winner needs an ICHOR ATA. Derive it from winnerId as a PublicKey.
      // winnerId is a fighter name/id string - in production, look up the wallet.
      // For now, try to parse winnerId as a pubkey (if fighters are registered on-chain)
      let winnerWallet: PublicKey | null = null;
      try {
        winnerWallet = new PublicKey(winnerId);
      } catch {
        // winnerId is not a valid pubkey (it's a name); skip ICHOR minting
        console.log(`[Orchestrator] winnerId "${winnerId}" is not a pubkey, skipping ICHOR mint`);
      }

      if (winnerWallet) {
        const winnerAta = getAssociatedTokenAddressSync(ichorMint, winnerWallet);
        const [arenaConfigPda] = deriveArenaConfigPda();
        const showerVaultAta = getAssociatedTokenAddressSync(ichorMint, arenaConfigPda, true);

        const sig = await mintRumbleRewardOnChain(winnerAta, showerVaultAta);
        if (sig) {
          console.log(`[Orchestrator] On-chain mintRumbleReward tx: ${sig}`);
        }

        // 3. Check Ichor Shower (uses same accounts)
        try {
          const showerSig = await checkIchorShowerOnChain(winnerAta, showerVaultAta);
          if (showerSig) {
            console.log(`[Orchestrator] On-chain checkIchorShower tx: ${showerSig}`);
          }
        } catch (err) {
          console.error(`[Orchestrator] On-chain checkIchorShower failed:`, err);
        }
      }
    } catch (err) {
      console.error(`[Orchestrator] On-chain mintRumbleReward failed:`, err);
    }

    // 4. Complete rumble on-chain
    try {
      const sig = await completeRumbleOnChain(rumbleIdNum);
      if (sig) {
        console.log(`[Orchestrator] On-chain completeRumble tx: ${sig}`);
      }
    } catch (err) {
      console.error(`[Orchestrator] On-chain completeRumble failed:`, err);
    }

    // 5. Sweep remaining vault SOL to treasury
    try {
      const sig = await sweepTreasuryOnChain(rumbleIdNum);
      if (sig) {
        console.log(`[Orchestrator] On-chain sweepTreasury tx: ${sig}`);
      }
    } catch (err) {
      console.error(`[Orchestrator] On-chain sweepTreasury failed:`, err);
    }
  }

  // ---- Payout phase --------------------------------------------------------

  private payoutProcessed: Set<string> = new Set(); // track rumble IDs already paid out

  private handlePayoutPhase(slot: RumbleSlot): void {
    const idx = slot.slotIndex;

    // Only process payout once per rumble
    if (this.payoutProcessed.has(slot.id)) return;
    this.payoutProcessed.add(slot.id);

    this.runPayoutPhase(idx).catch((err) => {
      console.error(`[Orchestrator] Payout error for slot ${idx}:`, err);
    });
  }

  async runPayoutPhase(slotIndex: number): Promise<void> {
    const slot = this.queueManager.getSlot(slotIndex);
    if (!slot) return;

    const pool = this.bettingPools.get(slotIndex);
    const combatState = this.combatStates.get(slotIndex);

    // Build placements from the rumble result or combat state
    let placements: Array<{ id: string; placement: number }> = [];
    if (slot.rumbleResult) {
      placements = slot.rumbleResult.placements;
    } else if (combatState) {
      // Fallback: derive from combat state
      const alive = combatState.fighters.filter((f) => f.hp > 0);
      const eliminated = combatState.fighters.filter((f) => f.hp <= 0);

      alive.sort((a, b) => {
        if (b.hp !== a.hp) return b.hp - a.hp;
        return b.totalDamageDealt - a.totalDamageDealt;
      });

      eliminated.sort((a, b) => {
        if (a.eliminatedOnTurn !== b.eliminatedOnTurn) {
          return (b.eliminatedOnTurn ?? 0) - (a.eliminatedOnTurn ?? 0);
        }
        return b.totalDamageDealt - a.totalDamageDealt;
      });

      const ranked = [...alive, ...eliminated];
      placements = ranked.map((f, i) => ({ id: f.id, placement: i + 1 }));
    }

    if (placements.length < 3) {
      console.warn(`[Orchestrator] Not enough fighters for payout in slot ${slotIndex}`);
      this.cleanupSlot(slotIndex, slot.id);
      return;
    }

    // Calculate ICHOR block reward based on total rumbles completed
    const blockReward = getBlockReward(this.totalRumblesCompleted);

    // Calculate payouts if there's a betting pool with bets
    if (pool && pool.bets.length > 0) {
      const placementIds = placements.map((p) => p.id);
      const payoutResult = calculatePayouts(
        pool,
        placementIds,
        blockReward,
        this.ichorShowerPool,
      );

      // Accumulate ICHOR shower pool
      const showerPoolIncrement = payoutResult.ichorDistribution.showerPoolAccumulation;
      this.ichorShowerPool += showerPoolIncrement;

      // Persist: atomically increment ichor shower pool
      if (showerPoolIncrement > 0) {
        persist.updateIchorShowerPool(showerPoolIncrement);
      }

      // Handle Ichor Shower
      if (payoutResult.ichorShowerTriggered && payoutResult.ichorShowerWinner) {
        this.emit("ichor_shower", {
          slotIndex,
          rumbleId: slot.id,
          winnerId: payoutResult.ichorShowerWinner,
          amount: payoutResult.ichorShowerAmount ?? 0,
        });

        // Persist: trigger ichor shower
        persist.triggerIchorShower(
          slot.id,
          payoutResult.ichorShowerWinner,
          payoutResult.ichorShowerAmount ?? 0,
        );

        // Reset shower pool after payout
        this.ichorShowerPool = 0;
      }

      // Persist: mark losing bets
      const topThreeIds = new Set(placements.slice(0, 3).map((p) => p.id));
      const losingFighterIds = placements
        .filter((p) => !topThreeIds.has(p.id))
        .map((p) => p.id);
      persist.markLosingBets(slot.id, losingFighterIds);

      // Persist: increment aggregate stats
      persist.incrementStats(
        pool.totalDeployed,
        payoutResult.ichorDistribution.totalMined,
        payoutResult.totalBurned,
      );

      // Log payout summary
      const summary = summarizePayouts(payoutResult);
      console.log(`[Orchestrator] Payout for ${slot.id}:`, summary);

      this.emit("payout_complete", {
        slotIndex,
        rumbleId: slot.id,
        payout: payoutResult,
      });
    } else {
      // No bets were placed; still emit payout_complete with minimal data
      console.log(`[Orchestrator] No bets for ${slot.id}, skipping SOL payout`);

      // Persist: still increment rumble count even without bets
      persist.incrementStats(0, 0, 0);
    }

    this.totalRumblesCompleted++;

    // Requeue fighters with autoRequeue
    const requeueSet = this.autoRequeueFighters.get(slotIndex);
    for (const fighterId of slot.fighters) {
      if (requeueSet?.has(fighterId)) {
        try {
          this.queueManager.addToQueue(fighterId, true);
          // Persist: re-add to queue as waiting
          persist.saveQueueFighter(fighterId, "waiting", true);
        } catch {
          // Fighter might already be in queue or another slot; ignore
        }
      } else {
        // Persist: remove from queue
        persist.removeQueueFighter(fighterId);
      }
    }

    // Persist: mark rumble as complete (status already set in finishCombat,
    // but update payout status for safety)
    persist.updateRumbleStatus(slot.id, "complete");

    this.cleanupSlot(slotIndex, slot.id);
  }

  // ---- Cleanup -------------------------------------------------------------

  private cleanupSlot(slotIndex: number, rumbleId?: string): void {
    if (rumbleId) {
      this.payoutProcessed.delete(rumbleId);
    }
    this.bettingPools.delete(slotIndex);
    this.combatStates.delete(slotIndex);
    this.autoRequeueFighters.delete(slotIndex);
  }

  private handleSlotRecycled(slotIndex: number, previousFighters: string[]): void {
    this.emit("slot_recycled", {
      slotIndex,
      previousFighters,
    });
  }

  // ---- Pairing helper (duplicated from rumble-engine for incremental use) --

  private createPairings(
    fighterIds: string[],
    previousPairings: Set<string>,
  ): { pairings: [string, string][]; bye: string | undefined } {
    const ids = [...fighterIds];

    // Fisher-Yates shuffle
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }

    let bye: string | undefined;
    if (ids.length % 2 !== 0) {
      bye = ids.pop()!;
    }

    const pairings: [string, string][] = [];
    for (let i = 0; i < ids.length; i += 2) {
      pairings.push([ids[i], ids[i + 1]]);
    }

    // Try to avoid repeating previous-turn pairings
    if (previousPairings.size > 0 && pairings.length > 1) {
      for (let i = 0; i < pairings.length; i++) {
        const key =
          pairings[i][0] < pairings[i][1]
            ? `${pairings[i][0]}:${pairings[i][1]}`
            : `${pairings[i][1]}:${pairings[i][0]}`;
        if (previousPairings.has(key)) {
          const swapIdx = (i + 1) % pairings.length;
          [pairings[i][1], pairings[swapIdx][1]] = [
            pairings[swapIdx][1],
            pairings[i][1],
          ];
          const newKeyI =
            pairings[i][0] < pairings[i][1]
              ? `${pairings[i][0]}:${pairings[i][1]}`
              : `${pairings[i][1]}:${pairings[i][0]}`;
          const newKeySwap =
            pairings[swapIdx][0] < pairings[swapIdx][1]
              ? `${pairings[swapIdx][0]}:${pairings[swapIdx][1]}`
              : `${pairings[swapIdx][1]}:${pairings[swapIdx][0]}`;
          if (previousPairings.has(newKeyI) || previousPairings.has(newKeySwap)) {
            // Revert
            [pairings[i][1], pairings[swapIdx][1]] = [
              pairings[swapIdx][1],
              pairings[i][1],
            ];
          }
        }
      }
    }

    return { pairings, bye };
  }

  // ---- External API --------------------------------------------------------

  /**
   * Mark a fighter for auto-requeue in the given slot.
   */
  setAutoRequeue(slotIndex: number, fighterId: string, enabled: boolean): void {
    if (!this.autoRequeueFighters.has(slotIndex)) {
      this.autoRequeueFighters.set(slotIndex, new Set());
    }
    const set = this.autoRequeueFighters.get(slotIndex)!;
    if (enabled) {
      set.add(fighterId);
    } else {
      set.delete(fighterId);
    }
  }

  /**
   * Get a snapshot of the current state for all slots.
   */
  getStatus(): Array<{
    slotIndex: number;
    state: SlotState;
    rumbleId: string;
    fighters: string[];
    turnCount: number;
    remainingFighters: number;
    bettingDeadline: Date | null;
  }> {
    const slots = this.queueManager.getSlots();
    return slots.map((slot) => {
      const combatState = this.combatStates.get(slot.slotIndex);
      const remaining = combatState
        ? combatState.fighters.filter((f) => f.hp > 0).length
        : slot.fighters.length;

      return {
        slotIndex: slot.slotIndex,
        state: slot.state,
        rumbleId: slot.id,
        fighters: [...slot.fighters],
        turnCount: combatState?.turns.length ?? 0,
        remainingFighters: remaining,
        bettingDeadline: slot.bettingDeadline,
      };
    });
  }

  /**
   * Get the current ICHOR shower pool balance.
   */
  getIchorShowerPool(): number {
    return this.ichorShowerPool;
  }

  /**
   * Get total rumbles completed since startup.
   */
  getTotalRumblesCompleted(): number {
    return this.totalRumblesCompleted;
  }

  /**
   * Get the combat state for a slot (for spectator views).
   */
  getCombatState(slotIndex: number): SlotCombatState | null {
    return this.combatStates.get(slotIndex) ?? null;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: RumbleOrchestrator | null = null;

export function getOrchestrator(): RumbleOrchestrator {
  if (!instance) {
    instance = new RumbleOrchestrator(getQueueManager());
  }
  return instance;
}

export function resetOrchestrator(): void {
  instance = null;
}
