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
  type BettingPool,
  type PayoutResult,
  type FighterOdds,
} from "./betting";

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

      this.emit("betting_open", {
        slotIndex: idx,
        rumbleId: slot.id,
        fighters: [...slot.fighters],
        deadline: slot.bettingDeadline!,
      });
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
    const METER_PER_TURN = 10; // matches combat.ts
    const SPECIAL_METER_COST = 100; // matches combat.ts

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

      // We can't call resolveCombat directly since it's imported only in rumble-engine.
      // Instead, use a simplified damage model that matches the weighted auto-play logic.
      // In production, this would call the combat engine directly.
      const result = this.resolveSimpleCombat(moveA, moveB, fA.meter, fB.meter);

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

    // Grant meter to all alive fighters
    for (const f of state.fighters) {
      if (f.hp > 0) {
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

    // Report result to queue manager (triggers payout transition on next advanceSlots)
    this.queueManager.reportResult(slot.slotIndex, {
      placements: ranked.map((f) => f.id),
      eliminationOrder: state.eliminationOrder,
      turnCount: state.turns.length,
    });

    this.emit("rumble_complete", {
      slotIndex: slot.slotIndex,
      rumbleId: slot.id,
      result,
    });
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
    let placements: string[] = [];
    if (slot.rumbleResult) {
      placements = slot.rumbleResult.placements;
    } else if (combatState) {
      // Fallback: derive from combat state
      const ranked = [...combatState.fighters].sort((a, b) => {
        if (b.hp !== a.hp) return b.hp - a.hp;
        return b.totalDamageDealt - a.totalDamageDealt;
      });
      placements = ranked.map((f) => f.id);
    }

    if (placements.length < 3) {
      console.warn(`[Orchestrator] Not enough fighters for payout in slot ${slotIndex}`);
      this.cleanupSlot(slotIndex);
      return;
    }

    // Calculate ICHOR block reward based on total rumbles completed
    const blockReward = getBlockReward(this.totalRumblesCompleted);

    // Calculate payouts if there's a betting pool with bets
    if (pool && pool.bets.length > 0) {
      const payoutResult = calculatePayouts(
        pool,
        placements,
        blockReward,
        this.ichorShowerPool,
      );

      // Accumulate ICHOR shower pool
      this.ichorShowerPool += payoutResult.ichorDistribution.showerPoolAccumulation;

      // Handle Ichor Shower
      if (payoutResult.ichorShowerTriggered && payoutResult.ichorShowerWinner) {
        this.emit("ichor_shower", {
          slotIndex,
          rumbleId: slot.id,
          winnerId: payoutResult.ichorShowerWinner,
          amount: payoutResult.ichorShowerAmount ?? 0,
        });

        // Reset shower pool after payout
        this.ichorShowerPool = 0;
      }

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
    }

    this.totalRumblesCompleted++;

    // Requeue fighters with autoRequeue
    const requeueSet = this.autoRequeueFighters.get(slotIndex);
    if (requeueSet) {
      for (const fighterId of slot.fighters) {
        if (requeueSet.has(fighterId)) {
          try {
            this.queueManager.addToQueue(fighterId, true);
          } catch {
            // Fighter might already be in queue or another slot; ignore
          }
        }
      }
    }

    this.cleanupSlot(slotIndex);
  }

  // ---- Cleanup -------------------------------------------------------------

  private cleanupSlot(slotIndex: number): void {
    this.bettingPools.delete(slotIndex);
    this.combatStates.delete(slotIndex);
    this.autoRequeueFighters.delete(slotIndex);
  }

  private handleSlotRecycled(slotIndex: number, previousFighters: string[]): void {
    // Clean up any stale payout tracking
    this.payoutProcessed.delete(
      this.queueManager.getSlot(slotIndex)?.id ?? "",
    );

    this.emit("slot_recycled", {
      slotIndex,
      previousFighters,
    });
  }

  // ---- Simplified combat resolution ----------------------------------------
  // This is used for incremental turn-by-turn execution. In production,
  // replace with a direct import of resolveCombat from combat.ts.

  private resolveSimpleCombat(
    moveA: string,
    moveB: string,
    meterA: number,
    meterB: number,
  ): {
    damageToA: number;
    damageToB: number;
    meterUsedA: number;
    meterUsedB: number;
  } {
    const STRIKE_DMG = 15;
    const SPECIAL_DMG = 30;
    const SPECIAL_COST = 100;

    const isStrike = (m: string) =>
      m === "HIGH_STRIKE" || m === "MID_STRIKE" || m === "LOW_STRIKE";
    const isGuard = (m: string) =>
      m === "GUARD_HIGH" || m === "GUARD_MID" || m === "GUARD_LOW";
    const isDodge = (m: string) => m === "DODGE";
    const isCatch = (m: string) => m === "CATCH";
    const isSpecial = (m: string) => m === "SPECIAL";

    // Check if a guard blocks a specific strike zone
    const guardBlocks = (guard: string, strike: string): boolean => {
      if (guard === "GUARD_HIGH" && strike === "HIGH_STRIKE") return true;
      if (guard === "GUARD_MID" && strike === "MID_STRIKE") return true;
      if (guard === "GUARD_LOW" && strike === "LOW_STRIKE") return true;
      return false;
    };

    let damageToA = 0;
    let damageToB = 0;
    let meterUsedA = 0;
    let meterUsedB = 0;

    // Handle specials
    if (isSpecial(moveA) && meterA >= SPECIAL_COST) {
      meterUsedA = SPECIAL_COST;
      if (!isDodge(moveB)) {
        damageToB = SPECIAL_DMG;
      }
    }
    if (isSpecial(moveB) && meterB >= SPECIAL_COST) {
      meterUsedB = SPECIAL_COST;
      if (!isDodge(moveA)) {
        damageToA = SPECIAL_DMG;
      }
    }

    // If both used specials, that's already resolved
    if (meterUsedA > 0 || meterUsedB > 0) {
      return { damageToA, damageToB, meterUsedA, meterUsedB };
    }

    // Strike vs Guard/Dodge/Catch/Strike
    if (isStrike(moveA)) {
      if (isGuard(moveB) && guardBlocks(moveB, moveA)) {
        damageToB = 0; // blocked
      } else if (isDodge(moveB)) {
        damageToB = 0; // dodged
      } else if (isCatch(moveB)) {
        // Catch beats strike: reflect damage
        damageToA = STRIKE_DMG;
      } else {
        damageToB = STRIKE_DMG;
      }
    }

    if (isStrike(moveB)) {
      if (isGuard(moveA) && guardBlocks(moveA, moveB)) {
        damageToA = 0; // blocked
      } else if (isDodge(moveA)) {
        damageToA = 0; // dodged
      } else if (isCatch(moveA)) {
        // Catch beats strike: reflect damage
        damageToB = STRIKE_DMG;
      } else {
        damageToA = STRIKE_DMG;
      }
    }

    return { damageToA, damageToB, meterUsedA, meterUsedB };
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
