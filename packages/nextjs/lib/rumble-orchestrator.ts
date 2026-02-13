// =============================================================================
// Rumble Orchestrator - Coordinates queue, combat engine, and betting system
//
// The main lifecycle coordinator for the Ichor Rumble system. Manages 3
// staggered slots, each independently cycling through:
//   IDLE → BETTING → COMBAT → PAYOUT → IDLE
//
// Called on a regular tick (~1s). Emits events for live spectator updates.
// =============================================================================

import { randomBytes } from "node:crypto";
import {
  RumbleQueueManager,
  getQueueManager,
  type RumbleSlot,
  type SlotState,
} from "./queue-manager";

/** Cryptographically secure random float in [0, 1) */
function secureRandom(): number {
  const buf = randomBytes(4);
  return buf.readUInt32BE(0) / 0x100000000;
}

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
  getSeasonReward,
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
  distributeReward as distributeRewardOnChain,
  adminDistribute as adminDistributeOnChain,
  checkIchorShower as checkIchorShowerOnChain,
  createRumble as createRumbleOnChain,
  startCombat as startCombatOnChain,
  reportResult as reportResultOnChain,
  completeRumble as completeRumbleOnChain,
  sweepTreasury as sweepTreasuryOnChain,
  updateFighterRecord as updateFighterRecordOnChain,
  ensureAta as ensureAtaOnChain,
  getIchorMint,
  deriveArenaConfigPda,
  readArenaConfig,
  readShowerRequest,
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
const SHOWER_SETTLEMENT_POLL_MS = 12_000;

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
  private lastShowerPollAt = 0;
  private showerPollInFlight = false;

  // Dedup: track rumble IDs that have been settled on-chain to prevent double payouts
  private settledRumbleIds: Map<string, number> = new Map(); // rumbleId → timestamp

  constructor(queueManager: RumbleQueueManager) {
    this.queueManager = queueManager;

    // Hook into the queue manager's slot recycling so we can handle auto-requeue
    this.queueManager.onSlotRecycled = (slotIndex, previousFighters, previousRumbleId) => {
      this.handleSlotRecycled(slotIndex, previousFighters, previousRumbleId);
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
   *
   * Returns a promise that resolves once all slot processing (including
   * awaited on-chain calls) completes for this tick.
   */
  async tick(): Promise<void> {
    // Let the queue manager handle state transitions (idle→betting, betting→combat, etc.)
    this.queueManager.advanceSlots();

    const slots = this.queueManager.getSlots();
    const slotPromises: Promise<void>[] = [];
    for (const slot of slots) {
      slotPromises.push(this.processSlot(slot));
    }

    // Await all slot processing; individual errors are caught inside processSlot
    await Promise.all(slotPromises);

    this.pollPendingIchorShower();
  }

  private pollPendingIchorShower(): void {
    if (this.showerPollInFlight) return;
    const now = Date.now();
    if (now - this.lastShowerPollAt < SHOWER_SETTLEMENT_POLL_MS) return;
    this.lastShowerPollAt = now;
    this.showerPollInFlight = true;
    this.pollPendingIchorShowerAsync()
      .catch((err) => {
        console.error("[Orchestrator] Pending ICHOR shower poll failed:", err);
      })
      .finally(() => {
        this.showerPollInFlight = false;
      });
  }

  private async pollPendingIchorShowerAsync(): Promise<void> {
    const pendingShower = await readShowerRequest().catch(() => null);
    if (!pendingShower?.active) return;
    if (pendingShower.recipientTokenAccount === "11111111111111111111111111111111") return;

    let recipientAta: PublicKey;
    try {
      recipientAta = new PublicKey(pendingShower.recipientTokenAccount);
    } catch {
      return;
    }

    const ichorMint = getIchorMint();
    const [arenaConfigPda] = deriveArenaConfigPda();
    const showerVaultAta = getAssociatedTokenAddressSync(ichorMint, arenaConfigPda, true);
    const sig = await checkIchorShowerOnChain(recipientAta, showerVaultAta);
    if (sig) {
      console.log(`[OnChain] pending checkIchorShower succeeded: ${sig}`);
    } else {
      console.warn(`[OnChain] pending checkIchorShower returned null`);
    }
  }

  // ---- Per-slot processing -------------------------------------------------

  private async processSlot(slot: RumbleSlot): Promise<void> {
    try {
      switch (slot.state) {
        case "betting":
          await this.handleBettingPhase(slot);
          break;
        case "combat":
          await this.handleCombatPhase(slot);
          break;
        case "payout":
          this.handlePayoutPhase(slot);
          break;
        // idle: nothing to do, queue manager handles transition
      }
    } catch (err) {
      console.error(`[Orchestrator] processSlot error for slot ${slot.slotIndex} (${slot.state}):`, err);
    }
  }

  // ---- Betting phase -------------------------------------------------------

  private async handleBettingPhase(slot: RumbleSlot): Promise<void> {
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

      // On-chain: create rumble (awaited, but failures don't block the game)
      await this.createRumbleOnChain(slot);
    }
  }

  /**
   * Create a rumble on-chain when betting opens.
   * Awaited but failures do not block the off-chain game loop.
   */
  private async createRumbleOnChain(slot: RumbleSlot): Promise<void> {
    const rumbleIdNum = parseInt(slot.id.replace(/\D/g, ""), 10);
    if (isNaN(rumbleIdNum)) {
      console.warn(`[OnChain] Cannot parse rumbleId "${slot.id}" for createRumble`);
      return;
    }

    // Resolve fighter names to wallet pubkeys via Supabase lookup
    const walletMap = await persist.lookupFighterWallets(slot.fighters);
    const fighterPubkeys: PublicKey[] = [];
    for (const fid of slot.fighters) {
      const walletAddr = walletMap.get(fid);
      if (walletAddr) {
        try {
          fighterPubkeys.push(new PublicKey(walletAddr));
        } catch {
          console.warn(`[OnChain] Invalid wallet for "${fid}": ${walletAddr}`);
          return;
        }
      } else {
        console.log(`[OnChain] No wallet for "${fid}", skipping createRumble`);
        return;
      }
    }

    const deadline = slot.bettingDeadline
      ? Math.floor(slot.bettingDeadline.getTime() / 1000)
      : Math.floor(Date.now() / 1000) + 60;

    try {
      const sig = await createRumbleOnChain(rumbleIdNum, fighterPubkeys, deadline);
      if (sig) {
        console.log(`[OnChain] createRumble succeeded: ${sig}`);
        persist.updateRumbleTxSignature(slot.id, "createRumble", sig);
      } else {
        console.warn(`[OnChain] createRumble returned null — continuing off-chain`);
      }
    } catch (err) {
      console.error(`[OnChain] createRumble error:`, err);
    }
  }

  /**
   * Transition a rumble on-chain from Betting to Combat.
   * Awaited but failures do not block the off-chain game loop.
   */
  private async startCombatOnChain(slot: RumbleSlot): Promise<void> {
    const rumbleIdNum = parseInt(slot.id.replace(/\D/g, ""), 10);
    if (isNaN(rumbleIdNum)) return;

    try {
      const sig = await startCombatOnChain(rumbleIdNum);
      if (sig) {
        console.log(`[OnChain] startCombat succeeded: ${sig}`);
        persist.updateRumbleTxSignature(slot.id, "startCombat", sig);
      } else {
        console.warn(`[OnChain] startCombat returned null — continuing off-chain`);
      }
    } catch (err) {
      console.error(`[OnChain] startCombat error:`, err);
    }
  }

  /**
   * External API: place a bet on a fighter in a slot.
   * Returns { accepted: true } or { accepted: false, reason: string }.
   */
  placeBet(
    slotIndex: number,
    bettorId: string,
    fighterId: string,
    solAmount: number,
  ): { accepted: boolean; reason?: string } {
    const slot = this.queueManager.getSlot(slotIndex);
    if (!slot) {
      console.log(`[placeBet] REJECTED: slot ${slotIndex} not found`);
      return { accepted: false, reason: "Slot not found." };
    }
    if (slot.state !== "betting") {
      console.log(`[placeBet] REJECTED: slot ${slotIndex} state=${slot.state} (not betting)`);
      return { accepted: false, reason: "Betting is not open for this slot." };
    }

    // Validate fighter is in this rumble
    if (!slot.fighters.includes(fighterId)) {
      console.log(`[placeBet] REJECTED: fighter ${fighterId} not in slot fighters: [${slot.fighters.join(", ")}]`);
      return { accepted: false, reason: "Fighter is not in this Rumble." };
    }

    const pool = this.bettingPools.get(slotIndex);
    if (!pool || pool.rumbleId !== slot.id) {
      console.log(`[placeBet] REJECTED: no pool for slot ${slotIndex} or rumbleId mismatch`);
      return { accepted: false, reason: "Betting pool not available." };
    }

    // Duplicate bet prevention: reject if this wallet already bet on a DIFFERENT fighter
    const existingBetOnOther = pool.bets.find(
      (b) => b.bettorId === bettorId && b.fighterId !== fighterId,
    );
    if (existingBetOnOther) {
      console.log(
        `[placeBet] REJECTED: wallet ${bettorId} already bet on ${existingBetOnOther.fighterId} in slot ${slotIndex}, cannot also bet on ${fighterId}`,
      );
      return {
        accepted: false,
        reason:
          "You already bet on a different fighter in this slot. One fighter per wallet per Rumble.",
      };
    }

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

    return { accepted: true };
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

  private async handleCombatPhase(slot: RumbleSlot): Promise<void> {
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

      // On-chain: transition from Betting -> Combat (awaited, failures don't block)
      await this.startCombatOnChain(slot);

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

    // Run one turn (awaited so on-chain settlement is properly tracked)
    await this.runCombatTurn(slot, state);
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

    await this.runCombatTurn(slot, state);
  }

  private async runCombatTurn(slot: RumbleSlot, state: SlotCombatState): Promise<void> {
    const MAX_TURNS = 20;

    const alive = state.fighters.filter((f) => f.hp > 0);

    // If only 0-1 fighters remain, rumble is complete
    if (alive.length <= 1) {
      await this.finishCombat(slot, state);
      return;
    }

    // If we've hit max turns, end the rumble
    if (state.turns.length >= MAX_TURNS) {
      await this.finishCombat(slot, state);
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
      await this.finishCombat(slot, state);
    }
  }

  private async finishCombat(slot: RumbleSlot, state: SlotCombatState): Promise<void> {
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

    // On-chain settlement: awaited so we get proper logging and error tracking.
    // settleOnChain has internal try/catch per step — failures are logged but
    // do not throw, so the off-chain game loop continues regardless.
    await this.settleOnChain(slot.id, winner, result.placements, state.fighters);
  }

  // ---------------------------------------------------------------------------
  // Placement-based ICHOR reward split
  // ---------------------------------------------------------------------------

  // Percentage of distributable ICHOR (after shower cut) by placement.
  // 1st=40%, 2nd=25%, 3rd=15%, remaining 20% split evenly among losers.
  private static PLACEMENT_SPLITS = [0.40, 0.25, 0.15];
  private static PARTICIPATION_POOL_PCT = 0.20;

  /**
   * Calculate ICHOR amounts for each fighter based on placement.
   * Returns a map of fighterId → ICHOR amount (in raw lamports, 9 decimals).
   */
  private calculatePlacementRewards(
    placements: Array<{ id: string; placement: number }>,
    totalDistributable: bigint,
  ): Map<string, bigint> {
    const rewards = new Map<string, bigint>();
    const sorted = [...placements].sort((a, b) => a.placement - b.placement);

    // Top 3 get fixed percentages
    for (let i = 0; i < Math.min(3, sorted.length); i++) {
      const pct = RumbleOrchestrator.PLACEMENT_SPLITS[i];
      const amount = (totalDistributable * BigInt(Math.round(pct * 10000))) / 10000n;
      rewards.set(sorted[i].id, amount);
    }

    // Remaining fighters split the participation pool evenly
    const losers = sorted.slice(3);
    if (losers.length > 0) {
      const participationTotal =
        (totalDistributable * BigInt(Math.round(RumbleOrchestrator.PARTICIPATION_POOL_PCT * 10000))) / 10000n;
      const perLoser = participationTotal / BigInt(losers.length);
      for (const loser of losers) {
        rewards.set(loser.id, perLoser);
      }
    }

    return rewards;
  }

  /**
   * Resolve a fighter ID to a Solana wallet PublicKey.
   * Tries parsing as pubkey first, falls back to DB lookup.
   */
  private async resolveFighterWallet(fighterId: string): Promise<PublicKey | null> {
    try {
      return new PublicKey(fighterId);
    } catch {
      const walletMap = await persist.lookupFighterWallets([fighterId]);
      const walletAddr = walletMap.get(fighterId);
      if (walletAddr) {
        try {
          return new PublicKey(walletAddr);
        } catch {
          console.warn(`[Orchestrator] Invalid wallet for "${fighterId}": ${walletAddr}`);
        }
      }
      return null;
    }
  }

  /**
   * Settle a completed rumble on-chain:
   * 1. Report result on-chain (placements)
   * 2. Distribute ICHOR rewards by placement (1st via distributeReward, rest via adminDistribute)
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
    // Dedup guard: prevent double on-chain settlement for the same rumble
    if (this.settledRumbleIds.has(rumbleId)) {
      console.warn(`[Orchestrator] settleOnChain already processed for rumbleId "${rumbleId}", skipping`);
      return;
    }
    this.settledRumbleIds.set(rumbleId, Date.now());

    const rumbleIdNum = parseInt(rumbleId.replace(/\D/g, ""), 10);
    if (isNaN(rumbleIdNum)) {
      console.warn(`[Orchestrator] Cannot parse rumbleId "${rumbleId}" as number, skipping on-chain`);
      return;
    }

    // 1. Report result on-chain
    try {
      const placementArray = placements.map((p) => p.placement);
      const winnerIndex = placements.findIndex((p) => p.placement === 1);
      if (winnerIndex >= 0) {
        const sig = await reportResultOnChain(rumbleIdNum, placementArray, winnerIndex);
        if (sig) {
          console.log(`[OnChain] reportResult succeeded: ${sig}`);
          persist.updateRumbleTxSignature(rumbleId, "reportResult", sig);
        } else {
          console.warn(`[OnChain] reportResult returned null — continuing off-chain`);
        }
      }
    } catch (err) {
      console.error(`[OnChain] reportResult error:`, err);
    }

    // 2. Distribute ICHOR rewards by placement
    try {
      const ichorMint = getIchorMint();
      const [arenaConfigPda] = deriveArenaConfigPda();
      const showerVaultAta = getAssociatedTokenAddressSync(ichorMint, arenaConfigPda, true);

      // Ensure shower vault ATA exists
      try {
        await ensureAtaOnChain(ichorMint, arenaConfigPda, true);
      } catch (ataErr) {
        console.warn(`[Orchestrator] Failed to create shower vault ATA:`, ataErr);
      }

      // Resolve winner wallet for the distributeReward call (handles shower + rumble counter)
      const winnerWallet = await this.resolveFighterWallet(winnerId);

      if (winnerWallet) {
        const winnerAta = getAssociatedTokenAddressSync(ichorMint, winnerWallet);
        try {
          await ensureAtaOnChain(ichorMint, winnerWallet);
        } catch (ataErr) {
          console.warn(`[Orchestrator] Failed to create winner ATA:`, ataErr);
        }

        // distributeReward: sends 1st place share + shower pool cut, increments rumble counter
        const sig = await distributeRewardOnChain(winnerAta, showerVaultAta);
        if (sig) {
          console.log(`[OnChain] distributeReward (1st place) succeeded: ${sig}`);
          persist.updateRumbleTxSignature(rumbleId, "mintRumbleReward", sig);
        } else {
          console.warn(`[OnChain] distributeReward returned null — continuing off-chain`);
        }
      }

      // Read arena config to calculate placement rewards from base_reward
      const arenaConfig = await readArenaConfig();
      if (arenaConfig && placements.length > 1) {
        // The base reward determines how much ICHOR goes to non-1st fighters.
        // distributeReward already handled 1st + shower. We use adminDistribute
        // for 2nd, 3rd, and participation based on the base reward.
        const baseReward = arenaConfig.baseReward;
        // Distributable to 2nd/3rd/losers: 60% of base reward (1st got 40% via distributeReward)
        const nonFirstPool = (baseReward * 60n) / 100n;

        // Split: 2nd=25/60, 3rd=15/60, losers=20/60 of nonFirstPool
        const sorted = [...placements].sort((a, b) => a.placement - b.placement);

        for (let i = 1; i < sorted.length; i++) {
          let amount: bigint;
          if (i === 1) {
            // 2nd place: 25% of total = 25/60 of nonFirstPool
            amount = (nonFirstPool * 2500n) / 6000n;
          } else if (i === 2) {
            // 3rd place: 15% of total = 15/60 of nonFirstPool
            amount = (nonFirstPool * 1500n) / 6000n;
          } else {
            // Participation: 20% of total split among remaining
            const loserCount = BigInt(sorted.length - 3);
            if (loserCount <= 0n) continue;
            const participationPool = (nonFirstPool * 2000n) / 6000n;
            amount = participationPool / loserCount;
          }

          if (amount <= 0n) continue;

          const fighterWallet = await this.resolveFighterWallet(sorted[i].id);
          if (!fighterWallet) {
            console.log(`[Orchestrator] No wallet for "${sorted[i].id}", skipping ICHOR placement reward`);
            continue;
          }

          try {
            await ensureAtaOnChain(ichorMint, fighterWallet);
            const ata = getAssociatedTokenAddressSync(ichorMint, fighterWallet);
            const sig = await adminDistributeOnChain(ata, amount);
            if (sig) {
              console.log(
                `[OnChain] adminDistribute (place ${sorted[i].placement}) to ${sorted[i].id} succeeded: ${sig}`
              );
            } else {
              console.warn(
                `[OnChain] adminDistribute (place ${sorted[i].placement}) to ${sorted[i].id} returned null — continuing off-chain`
              );
            }
          } catch (err) {
            console.error(`[OnChain] adminDistribute for ${sorted[i].id} error:`, err);
          }
        }
      }

      // 3. Check Ichor Shower (state machine: request first, then settle later)
      if (winnerWallet) {
        try {
          const winnerAta = getAssociatedTokenAddressSync(ichorMint, winnerWallet);
          let showerRecipientAta = winnerAta;
          const pendingShower = await readShowerRequest().catch(() => null);
          if (
            pendingShower?.active &&
            pendingShower.recipientTokenAccount !== "11111111111111111111111111111111"
          ) {
            try {
              showerRecipientAta = new PublicKey(pendingShower.recipientTokenAccount);
            } catch {}
          }

          const showerSig = await checkIchorShowerOnChain(showerRecipientAta, showerVaultAta);
          if (showerSig) {
            console.log(`[OnChain] checkIchorShower succeeded: ${showerSig}`);
            persist.updateRumbleTxSignature(rumbleId, "checkIchorShower", showerSig);
          } else {
            console.warn(`[OnChain] checkIchorShower returned null — continuing off-chain`);
          }
        } catch (err) {
          console.error(`[OnChain] checkIchorShower error:`, err);
        }
      }
    } catch (err) {
      console.error(`[OnChain] ICHOR distribution error:`, err);
    }

    // 4. Complete rumble on-chain
    try {
      const sig = await completeRumbleOnChain(rumbleIdNum);
      if (sig) {
        console.log(`[OnChain] completeRumble succeeded: ${sig}`);
        persist.updateRumbleTxSignature(rumbleId, "completeRumble", sig);
      } else {
        console.warn(`[OnChain] completeRumble returned null — continuing off-chain`);
      }
    } catch (err) {
      console.error(`[OnChain] completeRumble error:`, err);
    }

    // 5. Sweep remaining vault SOL to treasury
    try {
      const sig = await sweepTreasuryOnChain(rumbleIdNum);
      if (sig) {
        console.log(`[OnChain] sweepTreasury succeeded: ${sig}`);
        persist.updateRumbleTxSignature(rumbleId, "sweepTreasury", sig);
      } else {
        console.warn(`[OnChain] sweepTreasury returned null — continuing off-chain`);
      }
    } catch (err) {
      console.error(`[OnChain] sweepTreasury error:`, err);
    }
  }

  // ---- Payout phase --------------------------------------------------------

  private payoutProcessed: Set<string> = new Set(); // track rumble IDs already paid out
  private payoutResults: Map<number, PayoutResult> = new Map(); // store payout results for status API

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
    const blockReward = getSeasonReward();

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

      // Store payout result for status API
      this.payoutResults.set(slotIndex, payoutResult);

      // Log payout summary
      const summary = summarizePayouts(payoutResult);
      console.log(`[Orchestrator] Payout for ${slot.id}:`, summary);

      this.emit("payout_complete", {
        slotIndex,
        rumbleId: slot.id,
        payout: payoutResult,
      });
    } else {
      // No bets were placed; store a zero payout result for the status API
      console.log(`[Orchestrator] No bets for ${slot.id}, skipping SOL payout`);

      this.payoutResults.set(slotIndex, {
        rumbleId: slot.id,
        winnerBettors: [],
        placeBettors: [],
        showBettors: [],
        losingBettors: [],
        treasuryVault: 0,
        totalBurned: 0,
        sponsorships: new Map(),
        ichorDistribution: {
          totalMined: 0,
          winningBettors: new Map(),
          secondPlaceBettors: new Map(),
          thirdPlaceBettors: new Map(),
          fighters: new Map(),
          showerPoolAccumulation: 0,
        },
        ichorShowerTriggered: false,
      });

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

  private cleanupSlot(slotIndex: number, _rumbleId?: string): void {
    // NOTE: do NOT delete from payoutProcessed here — the QueueManager still
    // shows the slot in payout state for PAYOUT_DURATION_MS. Deleting early
    // causes handlePayoutPhase to re-run on every tick. The payout ID is
    // cleaned up in handleSlotRecycled when the slot returns to idle.
    //
    // KEEP combatStates alive during payout so the status API can serve
    // final fighter HPs / placements to the spectator page.
    this.bettingPools.delete(slotIndex);
    // combatStates preserved until handleSlotRecycled
    this.autoRequeueFighters.delete(slotIndex);
  }

  private handleSlotRecycled(
    slotIndex: number,
    previousFighters: string[],
    previousRumbleId: string,
  ): void {
    this.payoutProcessed.delete(previousRumbleId);
    this.combatStates.delete(slotIndex);
    this.payoutResults.delete(slotIndex);

    // Prune settled rumble IDs older than 1 hour to prevent unbounded growth
    const ONE_HOUR_MS = 60 * 60 * 1000;
    const cutoff = Date.now() - ONE_HOUR_MS;
    for (const [id, ts] of this.settledRumbleIds) {
      if (ts < cutoff) {
        this.settledRumbleIds.delete(id);
      }
    }

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
      const j = Math.floor(secureRandom() * (i + 1));
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

  // ---- Recovery helpers ----------------------------------------------------

  /**
   * Restore a betting pool from saved bets during cold-start recovery.
   * Called by rumble-state-recovery.ts to reconstruct in-memory state
   * without losing bets that were already placed.
   */
  restoreBettingPool(
    slotIndex: number,
    rumbleId: string,
    bets: Array<{ wallet_address: string; fighter_id: string; gross_amount: number; net_amount: number }>,
  ): void {
    const pool = createBettingPool(rumbleId);

    for (const bet of bets) {
      const grossAmount = bet.gross_amount;
      const netAmount = bet.net_amount;
      const adminFee = grossAmount * ADMIN_FEE_RATE;
      const sponsorship = grossAmount * SPONSORSHIP_RATE;

      pool.bets.push({
        bettorId: bet.wallet_address,
        fighterId: bet.fighter_id,
        grossAmount,
        solAmount: netAmount,
        timestamp: new Date(),
      });

      pool.totalDeployed += grossAmount;
      pool.adminFeeCollected += adminFee;
      pool.netPool += netAmount;

      const currentSponsor = pool.sponsorshipPaid.get(bet.fighter_id) ?? 0;
      pool.sponsorshipPaid.set(bet.fighter_id, currentSponsor + sponsorship);
    }

    this.bettingPools.set(slotIndex, pool);
    console.log(
      `[Orchestrator] Restored betting pool for slot ${slotIndex}: ${bets.length} bets, ${pool.totalDeployed} SOL`
    );
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

  /**
   * Get the payout result for a slot (for spectator views during payout phase).
   */
  getPayoutResult(slotIndex: number): PayoutResult | null {
    return this.payoutResults.get(slotIndex) ?? null;
  }
}

// ---------------------------------------------------------------------------
// Singleton — uses globalThis to survive Next.js HMR reloads in dev mode.
// Without globalThis, each route compilation gets its own module instance
// and a separate Orchestrator, causing state to diverge across routes.
// ---------------------------------------------------------------------------

const g = globalThis as unknown as { __rumbleOrchestrator?: RumbleOrchestrator };

export function getOrchestrator(): RumbleOrchestrator {
  if (!g.__rumbleOrchestrator) {
    g.__rumbleOrchestrator = new RumbleOrchestrator(getQueueManager());
  }
  return g.__rumbleOrchestrator;
}

export function resetOrchestrator(): void {
  g.__rumbleOrchestrator = undefined;
}
