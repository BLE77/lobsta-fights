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
  summarizePayouts,
  ADMIN_FEE_RATE,
  SPONSORSHIP_RATE,
  type BettingPool,
  type PayoutResult,
  type FighterOdds,
} from "./betting";
import { METER_PER_TURN, SPECIAL_METER_COST, resolveCombat } from "./combat";
import { isValidMove } from "./combat";
import { notifyFighter } from "./webhook";
import type { MoveType } from "./types";

import * as persist from "./rumble-persistence";
import { getRumblePayoutMode } from "./rumble-payout-mode";
import { parseOnchainRumbleIdNumber } from "./rumble-id";

import {
  distributeReward as distributeRewardOnChain,
  adminDistribute as adminDistributeOnChain,
  checkIchorShower as checkIchorShowerOnChain,
  createRumble as createRumbleOnChain,
  startCombat as startCombatOnChain,
  reportResult as reportResultOnChain,
  completeRumble as completeRumbleOnChain,
  sweepTreasury as sweepTreasuryOnChain,
  ensureAta as ensureAtaOnChain,
  getIchorMint,
  deriveArenaConfigPda,
  readArenaConfig,
  readRumbleAccountState,
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
  fighterProfiles: Map<string, persist.RumbleFighterProfile>;
  turns: RumbleTurn[];
  eliminationOrder: string[];
  previousPairings: Set<string>;
  lastTickAt: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NUM_SLOTS = 3;

function readIntervalMs(
  envName: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = Number(process.env[envName] ?? "");
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(raw)));
}

function readInt(
  envName: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = Number(process.env[envName] ?? "");
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(raw)));
}

const COMBAT_TICK_INTERVAL_MS = readIntervalMs(
  "RUMBLE_COMBAT_TICK_INTERVAL_MS",
  3_000,
  1_000,
  120_000,
);
const AGENT_MOVE_TIMEOUT_MS = readIntervalMs(
  "RUMBLE_AGENT_MOVE_TIMEOUT_MS",
  3_500,
  500,
  20_000,
);
const MAX_COMBAT_TURNS = readInt(
  "RUMBLE_MAX_COMBAT_TURNS",
  120,
  20,
  2_000,
);
const SHOWER_SETTLEMENT_POLL_MS = 12_000;
const ONCHAIN_FINALIZATION_DELAY_MS = 30_000;
const ONCHAIN_FINALIZATION_RETRY_MS = 10_000;
const MAX_FINALIZATION_ATTEMPTS = 30;
const ONCHAIN_CREATE_RECOVERY_DEADLINE_SKEW_SEC = 5;

interface PendingFinalization {
  rumbleId: string;
  rumbleIdNum: number;
  nextAttemptAt: number;
  attempts: number;
  completeDone: boolean;
}

function formatError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function hasErrorToken(err: unknown, token: string): boolean {
  return formatError(err).toLowerCase().includes(token.toLowerCase());
}

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
  private pendingFinalizations: Map<string, PendingFinalization> = new Map();
  private tickInFlight: Promise<void> | null = null;

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
    if (this.tickInFlight) {
      return this.tickInFlight;
    }

    this.tickInFlight = this.tickInternal().finally(() => {
      this.tickInFlight = null;
    });
    return this.tickInFlight;
  }

  private async tickInternal(): Promise<void> {
    // Let the queue manager handle state transitions (idle→betting, betting→combat, etc.)
    this.queueManager.advanceSlots();

    const slots = this.queueManager.getSlots();
    const slotPromises: Promise<void>[] = [];
    for (const slot of slots) {
      slotPromises.push(this.processSlot(slot));
    }

    // Await all slot processing; individual errors are caught inside processSlot
    await Promise.all(slotPromises);

    await this.processPendingRumbleFinalizations();
    this.pollPendingIchorShower();
  }

  private enqueueRumbleFinalization(rumbleId: string, rumbleIdNum: number, delayMs: number): void {
    const existing = this.pendingFinalizations.get(rumbleId);
    if (existing) {
      existing.nextAttemptAt = Math.min(existing.nextAttemptAt, Date.now() + delayMs);
      return;
    }
    this.pendingFinalizations.set(rumbleId, {
      rumbleId,
      rumbleIdNum,
      nextAttemptAt: Date.now() + delayMs,
      attempts: 0,
      completeDone: false,
    });
  }

  private async processPendingRumbleFinalizations(): Promise<void> {
    if (this.pendingFinalizations.size === 0) return;
    const now = Date.now();
    const due = [...this.pendingFinalizations.values()].filter((entry) => entry.nextAttemptAt <= now);
    if (due.length === 0) return;
    await Promise.all(due.map((entry) => this.finalizeRumbleOnChain(entry)));
  }

  private async finalizeRumbleOnChain(entry: PendingFinalization): Promise<void> {
    entry.attempts += 1;

    // 1) completeRumble
    if (!entry.completeDone) {
      try {
        const completeSig = await completeRumbleOnChain(entry.rumbleIdNum);
        if (completeSig) {
          console.log(`[OnChain] completeRumble succeeded: ${completeSig}`);
          persist.updateRumbleTxSignature(entry.rumbleId, "completeRumble", completeSig);
          entry.completeDone = true;
        } else {
          throw new Error("completeRumble returned null");
        }
      } catch (err) {
        const onchainState = await readRumbleAccountState(entry.rumbleIdNum).catch(() => null);
        if (onchainState?.state === "complete") {
          entry.completeDone = true;
          console.log(
            `[OnChain] completeRumble already finalized for ${entry.rumbleId}; skipping duplicate complete call`
          );
        } else {
          if (entry.attempts >= MAX_FINALIZATION_ATTEMPTS) {
            this.pendingFinalizations.delete(entry.rumbleId);
            console.error(`[OnChain] completeRumble failed permanently for ${entry.rumbleId}:`, err);
            return;
          }
          entry.nextAttemptAt = Date.now() + ONCHAIN_FINALIZATION_RETRY_MS;
          console.warn(
            `[OnChain] completeRumble retry ${entry.attempts}/${MAX_FINALIZATION_ATTEMPTS} for ${entry.rumbleId} (${formatError(err)})`
          );
          return;
        }
      }
    }

    // 2) sweepTreasury
    try {
      const sweepSig = await sweepTreasuryOnChain(entry.rumbleIdNum);
      if (sweepSig) {
        console.log(`[OnChain] sweepTreasury succeeded: ${sweepSig}`);
        persist.updateRumbleTxSignature(entry.rumbleId, "sweepTreasury", sweepSig);
      } else {
        throw new Error("sweepTreasury returned null");
      }
      this.pendingFinalizations.delete(entry.rumbleId);
    } catch (err) {
      // If the vault is already drained, finalization is effectively complete.
      if (hasErrorToken(err, "NothingToClaim") || hasErrorToken(err, "InsufficientVaultFunds")) {
        console.log(`[OnChain] sweepTreasury already drained for ${entry.rumbleId}; marking finalization complete`);
        this.pendingFinalizations.delete(entry.rumbleId);
        return;
      }
      if (entry.attempts >= MAX_FINALIZATION_ATTEMPTS) {
        this.pendingFinalizations.delete(entry.rumbleId);
        console.error(`[OnChain] sweepTreasury failed permanently for ${entry.rumbleId}:`, err);
        return;
      }
      entry.nextAttemptAt = Date.now() + ONCHAIN_FINALIZATION_RETRY_MS;
      console.warn(
        `[OnChain] sweepTreasury retry ${entry.attempts}/${MAX_FINALIZATION_ATTEMPTS} for ${entry.rumbleId} (${formatError(err)})`
      );
    }
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
      await this.createRumbleOnChain(
        slot.id,
        slot.fighters,
        slot.bettingDeadline
          ? Math.floor(slot.bettingDeadline.getTime() / 1000)
          : Math.floor(Date.now() / 1000) + 60,
      );
    }
  }

  /**
   * Create a rumble on-chain when betting opens.
   * Awaited but failures do not block the off-chain game loop.
   */
  private async createRumbleOnChain(
    rumbleId: string,
    fighterIds: string[],
    bettingDeadlineUnix: number,
  ): Promise<boolean> {
    const rumbleIdNum = parseOnchainRumbleIdNumber(rumbleId);
    if (rumbleIdNum === null) {
      console.warn(`[OnChain] Cannot parse rumbleId "${rumbleId}" for createRumble`);
      return false;
    }

    // Resolve fighter names to wallet pubkeys via Supabase lookup
    const walletMap = await persist.lookupFighterWallets(fighterIds);
    const fighterPubkeys: PublicKey[] = [];
    for (const fid of fighterIds) {
      const walletAddr = walletMap.get(fid);
      if (walletAddr) {
        try {
          fighterPubkeys.push(new PublicKey(walletAddr));
        } catch {
          console.warn(`[OnChain] Invalid wallet for "${fid}": ${walletAddr}`);
          return false;
        }
      } else {
        console.log(`[OnChain] No wallet for "${fid}", skipping createRumble`);
        return false;
      }
    }

    try {
      const sig = await createRumbleOnChain(rumbleIdNum, fighterPubkeys, bettingDeadlineUnix);
      if (sig) {
        console.log(`[OnChain] createRumble succeeded: ${sig}`);
        persist.updateRumbleTxSignature(rumbleId, "createRumble", sig);
        return true;
      } else {
        console.warn(`[OnChain] createRumble returned null — continuing off-chain`);
        return false;
      }
    } catch (err) {
      console.error(`[OnChain] createRumble error:`, err);
      return false;
    }
  }

  private async ensureOnchainRumbleExists(
    rumbleId: string,
    fighterIds: string[],
    bettingDeadlineUnix: number,
  ): Promise<boolean> {
    const rumbleIdNum = parseOnchainRumbleIdNumber(rumbleId);
    if (rumbleIdNum === null) return false;

    const existing = await readRumbleAccountState(rumbleIdNum).catch(() => null);
    if (existing) return true;

    const created = await this.createRumbleOnChain(rumbleId, fighterIds, bettingDeadlineUnix);
    if (!created) return false;

    const after = await readRumbleAccountState(rumbleIdNum).catch(() => null);
    return !!after;
  }

  private async ensureOnchainRumbleIsCombatReady(
    rumbleId: string,
    fighterIds: string[],
    bettingDeadlineUnix: number,
  ): Promise<Awaited<ReturnType<typeof readRumbleAccountState>>> {
    const rumbleIdNum = parseOnchainRumbleIdNumber(rumbleId);
    if (rumbleIdNum === null) return null;

    const exists = await this.ensureOnchainRumbleExists(rumbleId, fighterIds, bettingDeadlineUnix);
    if (!exists) return null;

    let state = await readRumbleAccountState(rumbleIdNum).catch(() => null);
    if (!state) return null;

    if (state.state === "betting") {
      try {
        const sig = await startCombatOnChain(rumbleIdNum);
        if (sig) {
          console.log(`[OnChain] startCombat (recovery) succeeded: ${sig}`);
          persist.updateRumbleTxSignature(rumbleId, "startCombat", sig);
        }
      } catch (err) {
        console.warn(`[OnChain] startCombat (recovery) failed for ${rumbleId}: ${formatError(err)}`);
      }
      state = await readRumbleAccountState(rumbleIdNum).catch(() => null);
    }
    return state;
  }

  /**
   * Transition a rumble on-chain from Betting to Combat.
   * Awaited but failures do not block the off-chain game loop.
   */
  private async startCombatOnChain(slot: RumbleSlot): Promise<void> {
    const rumbleIdNum = parseOnchainRumbleIdNumber(slot.id);
    if (rumbleIdNum === null) return;

    const onchainState = await this.ensureOnchainRumbleIsCombatReady(
      slot.id,
      slot.fighters,
      slot.bettingDeadline
        ? Math.floor(slot.bettingDeadline.getTime() / 1000)
        : Math.floor(Date.now() / 1000) + 60,
    );
    if (!onchainState) {
      console.warn(`[OnChain] startCombat skipped: rumble ${slot.id} does not exist on-chain yet`);
      return;
    }
    if (onchainState.state === "combat" || onchainState.state === "payout" || onchainState.state === "complete") {
      return;
    }

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
  ): Promise<{ accepted: boolean; reason?: string }> {
    return this.placeBets(slotIndex, bettorId, [{ fighterId, solAmount }]);
  }

  /**
   * External API: place multiple bets in one request for the same slot.
   * Returns { accepted: true } or { accepted: false, reason: string }.
   */
  async placeBets(
    slotIndex: number,
    bettorId: string,
    bets: Array<{ fighterId: string; solAmount: number }>,
  ): Promise<{ accepted: boolean; reason?: string }> {
    if (!bets.length) {
      return { accepted: false, reason: "No bets provided." };
    }

    const slot = this.queueManager.getSlot(slotIndex);
    if (!slot) {
      console.log(`[placeBets] REJECTED: slot ${slotIndex} not found`);
      return { accepted: false, reason: "Slot not found." };
    }
    if (slot.state !== "betting") {
      console.log(`[placeBets] REJECTED: slot ${slotIndex} state=${slot.state} (not betting)`);
      return { accepted: false, reason: "Betting is not open for this slot." };
    }

    for (const bet of bets) {
      if (!slot.fighters.includes(bet.fighterId)) {
        console.log(
          `[placeBets] REJECTED: fighter ${bet.fighterId} not in slot fighters: [${slot.fighters.join(", ")}]`,
        );
        return { accepted: false, reason: "Fighter is not in this Rumble." };
      }
      if (!Number.isFinite(bet.solAmount) || bet.solAmount <= 0) {
        return { accepted: false, reason: "Bet amount must be positive." };
      }
    }

    const pool = this.bettingPools.get(slotIndex);
    if (!pool || pool.rumbleId !== slot.id) {
      console.log(`[placeBets] REJECTED: no pool for slot ${slotIndex} or rumbleId mismatch`);
      return { accepted: false, reason: "Betting pool not available." };
    }

    const persisted = await persist.saveBets(
      bets.map((bet) => {
        const adminFee = bet.solAmount * ADMIN_FEE_RATE;
        const sponsorFee = bet.solAmount * SPONSORSHIP_RATE;
        const netAmount = bet.solAmount - adminFee - sponsorFee;
        return {
          rumbleId: slot.id,
          walletAddress: bettorId,
          fighterId: bet.fighterId,
          grossAmount: bet.solAmount,
          netAmount,
          adminFee,
          sponsorFee,
        };
      }),
    );
    if (!persisted) {
      return { accepted: false, reason: "Bet registration failed. Please retry with the same signed transaction." };
    }

    for (const bet of bets) {
      placeBetInPool(pool, bettorId, bet.fighterId, bet.solAmount);

      // Also record in the queue manager's betting pool (for its own tracking)
      this.queueManager.placeBet(slotIndex, bettorId, bet.solAmount);
    }

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
      await this.initCombatState(slot);

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

  private async initCombatState(slot: RumbleSlot): Promise<void> {
    // Build RumbleFighter array from slot's fighter IDs.
    const MAX_HP = 100; // matches combat.ts default
    const fighterProfiles = await persist.loadRumbleFighterProfiles(slot.fighters);

    const fighters: RumbleFighter[] = slot.fighters.map((id) => ({
      id,
      name: fighterProfiles.get(id)?.name ?? id,
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
      fighterProfiles,
      turns: [],
      eliminationOrder: [],
      previousPairings: new Set(),
      lastTickAt: Date.now(),
    });
  }

  private fallbackMoveForFighter(
    fighter: RumbleFighter,
    alive: RumbleFighter[],
    turnHistory: RumbleTurn[],
  ): MoveType {
    return selectMove(fighter, alive.filter((f) => f.id !== fighter.id), turnHistory as any);
  }

  private async requestFighterMove(
    slot: RumbleSlot,
    state: SlotCombatState,
    fighter: RumbleFighter,
    opponent: RumbleFighter,
    alive: RumbleFighter[],
    turnNumber: number,
  ): Promise<MoveType> {
    const fallback = this.fallbackMoveForFighter(fighter, alive, state.turns);
    const profile = state.fighterProfiles.get(fighter.id);
    const webhookUrl = profile?.webhookUrl;
    if (!webhookUrl) return fallback;

    const matchState = {
      your_hp: fighter.hp,
      opponent_hp: opponent.hp,
      your_meter: fighter.meter,
      opponent_meter: opponent.meter,
      round: 1,
      turn: turnNumber,
      your_rounds_won: 0,
      opponent_rounds_won: 0,
    };

    const payload = {
      mode: "rumble",
      rumble_id: slot.id,
      slot_index: slot.slotIndex,
      turn: turnNumber,
      fighter_id: fighter.id,
      fighter_name: fighter.name,
      opponent_id: opponent.id,
      opponent_name: opponent.name,
      match_id: slot.id,
      match_state: matchState,
      your_state: {
        hp: fighter.hp,
        meter: fighter.meter,
      },
      opponent_state: {
        hp: opponent.hp,
        meter: opponent.meter,
      },
      turn_history: state.turns.slice(-6),
      valid_moves: [
        "HIGH_STRIKE",
        "MID_STRIKE",
        "LOW_STRIKE",
        "GUARD_HIGH",
        "GUARD_MID",
        "GUARD_LOW",
        "DODGE",
        "CATCH",
        "SPECIAL",
      ],
      timeout_ms: AGENT_MOVE_TIMEOUT_MS,
    };

    const timeoutPromise = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), AGENT_MOVE_TIMEOUT_MS),
    );
    const webhookPromise = notifyFighter(webhookUrl, "move_request", payload)
      .then((res) => (res.success ? res.data : null))
      .catch(() => null);

    const responseData = await Promise.race([webhookPromise, timeoutPromise]);
    const rawMove =
      (responseData && typeof responseData === "object" && (responseData as any).move) || null;
    const normalized = typeof rawMove === "string" ? rawMove.trim().toUpperCase() : "";
    if (isValidMove(normalized)) {
      return normalized as MoveType;
    }
    return fallback;
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
    const alive = state.fighters.filter((f) => f.hp > 0);

    // If only 0-1 fighters remain, rumble is complete
    if (alive.length <= 1) {
      await this.finishCombat(slot, state);
      return;
    }

    const turnNumber = state.turns.length + 1;
    const overtimeTurns = Math.max(0, turnNumber - MAX_COMBAT_TURNS);
    const suddenDeathActive = overtimeTurns > 0;
    const suddenDeathBonus = suddenDeathActive ? Math.min(20, Math.max(1, Math.floor((overtimeTurns + 1) / 2))) : 0;
    if (suddenDeathActive && overtimeTurns === 1) {
      console.log(
        `[Orchestrator] Slot ${slot.slotIndex} entering sudden death at turn ${turnNumber}; no HP-ranked winner until elimination.`,
      );
    }
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

    const pairingMoves = await Promise.all(
      pairings.map(async ([idA, idB]) => {
        const fA = state.fighters.find((f) => f.id === idA)!;
        const fB = state.fighters.find((f) => f.id === idB)!;
        const [moveA, moveB] = await Promise.all([
          this.requestFighterMove(slot, state, fA, fB, alive, turnNumber),
          this.requestFighterMove(slot, state, fB, fA, alive, turnNumber),
        ]);
        return { idA, idB, moveA, moveB };
      }),
    );

    for (const { idA, idB, moveA, moveB } of pairingMoves) {
      const fA = state.fighters.find((f) => f.id === idA)!;
      const fB = state.fighters.find((f) => f.id === idB)!;

      const result = resolveCombat(moveA, moveB, fA.meter, fB.meter);
      let damageToA = result.damageToA;
      let damageToB = result.damageToB;

      // Sudden death: combat must converge to true elimination, never HP ranking.
      if (suddenDeathActive) {
        if (damageToA > 0) damageToA += suddenDeathBonus;
        if (damageToB > 0) damageToB += suddenDeathBonus;
        if (damageToA === 0 && damageToB === 0) {
          damageToA = suddenDeathBonus;
          damageToB = suddenDeathBonus;
        }
      }

      // Apply meter usage
      fA.meter = Math.max(0, fA.meter - result.meterUsedA);
      fB.meter = Math.max(0, fB.meter - result.meterUsedB);

      // Apply damage
      fA.hp = Math.max(0, fA.hp - damageToA);
      fB.hp = Math.max(0, fB.hp - damageToB);

      // Track stats
      fA.totalDamageDealt += damageToB;
      fA.totalDamageTaken += damageToA;
      fB.totalDamageDealt += damageToA;
      fB.totalDamageTaken += damageToB;

      turnPairings.push({
        fighterA: idA,
        fighterB: idB,
        moveA,
        moveB,
        damageToA,
        damageToB,
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
    if (remaining <= 1) {
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

  private toIchorLamports(amountIchor: number): bigint {
    if (!Number.isFinite(amountIchor) || amountIchor <= 0) return 0n;
    return BigInt(Math.max(0, Math.floor(amountIchor * 1_000_000_000)));
  }

  private pickWeightedWinnerBettorWallet(payoutResult: PayoutResult): string | null {
    const winners = payoutResult.winnerBettors.filter(
      row => Number.isFinite(row.solDeployed) && row.solDeployed > 0 && typeof row.bettorId === "string",
    );
    if (!winners.length) return null;
    const totalWeight = winners.reduce((sum, row) => sum + row.solDeployed, 0);
    if (!(totalWeight > 0)) return null;
    const roll = secureRandom() * totalWeight;
    let acc = 0;
    for (const row of winners) {
      acc += row.solDeployed;
      if (roll <= acc) return row.bettorId;
    }
    return winners[winners.length - 1]?.bettorId ?? null;
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
    payoutResult: PayoutResult,
    fighterOrder: string[],
  ): Promise<void> {
    // Dedup guard: prevent double on-chain settlement for the same rumble
    if (this.settledRumbleIds.has(rumbleId)) {
      console.warn(`[Orchestrator] settleOnChain already processed for rumbleId "${rumbleId}", skipping`);
      return;
    }
    this.settledRumbleIds.set(rumbleId, Date.now());

    const rumbleIdNum = parseOnchainRumbleIdNumber(rumbleId);
    if (rumbleIdNum === null) {
      console.warn(`[Orchestrator] Cannot parse rumbleId "${rumbleId}" as number, skipping on-chain`);
      return;
    }

    // 1. Report result on-chain.
    // IMPORTANT: placement vector must be aligned to the rumble's ORIGINAL
    // fighter order used in create_rumble, not ranked order.
    try {
      const placementById = new Map<string, number>();
      for (const row of placements) {
        if (typeof row.id === "string" && Number.isInteger(row.placement) && row.placement > 0) {
          placementById.set(row.id, row.placement);
        }
      }

      const placementArray: number[] = [];
      for (const fighterId of fighterOrder) {
        const placement = placementById.get(fighterId) ?? 0;
        if (!placement) {
          throw new Error(
            `[OnChain] reportResult skipped for ${rumbleId}: missing placement for fighter ${fighterId}`,
          );
        }
        placementArray.push(placement);
      }

      const winnerIndex = placementArray.findIndex((p) => p === 1);
      if (winnerIndex >= 0) {
        let onchainState = await this.ensureOnchainRumbleIsCombatReady(
          rumbleId,
          fighterOrder,
          Math.floor(Date.now() / 1000) - ONCHAIN_CREATE_RECOVERY_DEADLINE_SKEW_SEC,
        );
        if (!onchainState) {
          throw new Error(
            `[OnChain] reportResult skipped for ${rumbleId}: on-chain rumble unavailable`,
          );
        }
        if (onchainState.state === "payout" || onchainState.state === "complete") {
          console.log(
            `[OnChain] reportResult already applied for ${rumbleId} (state=${onchainState.state}), skipping`,
          );
        } else {
          if (onchainState.state === "betting") {
            // best effort: transition before reporting
            await startCombatOnChain(rumbleIdNum).catch(() => null);
            onchainState = await readRumbleAccountState(rumbleIdNum).catch(() => null);
          }
          if (onchainState?.state !== "combat") {
            console.warn(
              `[OnChain] reportResult skipped for ${rumbleId}: unexpected state=${onchainState?.state ?? "unknown"}`,
            );
          } else {
            const sig = await reportResultOnChain(rumbleIdNum, placementArray, winnerIndex);
            if (sig) {
              console.log(`[OnChain] reportResult succeeded: ${sig}`);
              persist.updateRumbleTxSignature(rumbleId, "reportResult", sig);
            } else {
              console.warn(`[OnChain] reportResult returned null — continuing off-chain`);
            }
          }
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

      // Resolve winner wallet for the distributeReward call (1st fighter share + shower pool accounting).
      const winnerWallet = await this.resolveFighterWallet(winnerId);
      let winnerAta: PublicKey | null = null;

      if (winnerWallet) {
        winnerAta = getAssociatedTokenAddressSync(ichorMint, winnerWallet);
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

      // Distribute non-1st fighter ICHOR shares from payout distribution.
      for (const [fighterId, ichorAmount] of payoutResult.ichorDistribution.fighters.entries()) {
        if (fighterId === winnerId) continue;
        const amountLamports = this.toIchorLamports(ichorAmount);
        if (amountLamports <= 0n) continue;

        const fighterWallet = await this.resolveFighterWallet(fighterId);
        if (!fighterWallet) {
          console.log(`[Orchestrator] No wallet for "${fighterId}", skipping fighter ICHOR reward`);
          continue;
        }

        try {
          await ensureAtaOnChain(ichorMint, fighterWallet);
          const ata = getAssociatedTokenAddressSync(ichorMint, fighterWallet);
          const sig = await adminDistributeOnChain(ata, amountLamports);
          if (sig) {
            console.log(`[OnChain] adminDistribute fighter reward to ${fighterId} succeeded: ${sig}`);
          } else {
            console.warn(`[OnChain] adminDistribute fighter reward to ${fighterId} returned null`);
          }
        } catch (err) {
          console.error(`[OnChain] adminDistribute fighter reward for ${fighterId} error:`, err);
        }
      }

      // Distribute winner-bettor ICHOR shares from payout distribution.
      for (const [bettorWalletStr, ichorAmount] of payoutResult.ichorDistribution.winningBettors.entries()) {
        const amountLamports = this.toIchorLamports(ichorAmount);
        if (amountLamports <= 0n) continue;

        let bettorWallet: PublicKey;
        try {
          bettorWallet = new PublicKey(bettorWalletStr);
        } catch {
          console.warn(`[OnChain] Skipping bettor ICHOR reward for invalid wallet "${bettorWalletStr}"`);
          continue;
        }

        try {
          await ensureAtaOnChain(ichorMint, bettorWallet);
          const ata = getAssociatedTokenAddressSync(ichorMint, bettorWallet);
          const sig = await adminDistributeOnChain(ata, amountLamports);
          if (sig) {
            console.log(`[OnChain] adminDistribute bettor reward to ${bettorWalletStr} succeeded: ${sig}`);
          } else {
            console.warn(`[OnChain] adminDistribute bettor reward to ${bettorWalletStr} returned null`);
          }
        } catch (err) {
          console.error(`[OnChain] adminDistribute bettor reward for ${bettorWalletStr} error:`, err);
        }
      }

      // 3. Check Ichor Shower (state machine: request first, then settle later)
      if (winnerAta) {
        try {
          let showerRecipientAta = winnerAta;
          const chosenBettorWallet = this.pickWeightedWinnerBettorWallet(payoutResult);
          if (chosenBettorWallet) {
            try {
              const bettorPk = new PublicKey(chosenBettorWallet);
              await ensureAtaOnChain(ichorMint, bettorPk);
              showerRecipientAta = getAssociatedTokenAddressSync(ichorMint, bettorPk);
            } catch (err) {
              console.warn(`[OnChain] Failed to use bettor shower recipient "${chosenBettorWallet}":`, err);
            }
          }

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

    // 4-5. completeRumble + sweepTreasury are finalized asynchronously after claim window.
    this.enqueueRumbleFinalization(rumbleId, rumbleIdNum, ONCHAIN_FINALIZATION_DELAY_MS);
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

    const winnerFighterId = placements
      .slice()
      .sort((a, b) => a.placement - b.placement)[0]?.id;
    if (winnerFighterId) {
      // Ensure DB has a complete winner/placements record even if in-memory
      // pool state was lost during a restart.
      const persistedTurns =
        slot.rumbleResult?.turns ?? combatState?.turns ?? [];
      const persistedTotalTurns =
        slot.rumbleResult?.totalTurns ?? combatState?.turns.length ?? 0;
      await persist.completeRumbleRecord(
        slot.id,
        winnerFighterId,
        placements,
        persistedTurns,
        persistedTotalTurns,
      );
    }

    // Read block reward from on-chain arena config (season_reward > base_reward fallback).
    const arenaConfig = await readArenaConfig().catch(() => null);
    const rewardLamports = arenaConfig?.effectiveReward ?? 2_500n * 1_000_000_000n;
    const blockReward = Number(rewardLamports) / 1_000_000_000;

    const placementIds = placements.map((p) => p.id);
    const payoutPool = pool ?? createBettingPool(slot.id);
    const payoutResult = calculatePayouts(
      payoutPool,
      placementIds,
      blockReward,
      this.ichorShowerPool,
    );

    // Ichor Shower trigger is fully on-chain; keep API state from on-chain flow.
    payoutResult.ichorShowerTriggered = false;
    payoutResult.ichorShowerAmount = undefined;
    payoutResult.ichorShowerWinner = undefined;
    payoutResult.totalBurned = 0;

    // Accumulate ICHOR shower pool
    const showerPoolIncrement = payoutResult.ichorDistribution.showerPoolAccumulation;
    this.ichorShowerPool += showerPoolIncrement;

    // Persist: atomically increment ichor shower pool
    if (showerPoolIncrement > 0) {
      persist.updateIchorShowerPool(showerPoolIncrement);
    }

    // Persist: increment aggregate stats
    persist.incrementStats(
      payoutPool.totalDeployed,
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

    // On-chain settlement uses the same computed payout distribution as source of truth.
    if (winnerFighterId) {
      await this.settleOnChain(
        slot.id,
        winnerFighterId,
        placements,
        payoutResult,
        slot.fighters,
      );
    }

    // Always settle persisted bet rows if we have a winner id, even when the
    // in-memory betting pool is empty after a server restart.
    if (winnerFighterId) {
      await persist.settleWinnerTakeAllBets(
        slot.id,
        winnerFighterId,
        getRumblePayoutMode(),
      );
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
    nextTurnAt: Date | null;
    turnIntervalMs: number | null;
  }> {
    const slots = this.queueManager.getSlots();
    const now = Date.now();
    return slots.map((slot) => {
      const combatState = this.combatStates.get(slot.slotIndex);
      const remaining = combatState
        ? combatState.fighters.filter((f) => f.hp > 0).length
        : slot.fighters.length;
      const nextTurnAt =
        slot.state === "combat" && combatState
          ? new Date(Math.max(now, combatState.lastTickAt + COMBAT_TICK_INTERVAL_MS))
          : null;

      return {
        slotIndex: slot.slotIndex,
        state: slot.state,
        rumbleId: slot.id,
        fighters: [...slot.fighters],
        turnCount: combatState?.turns.length ?? 0,
        remainingFighters: remaining,
        bettingDeadline: slot.bettingDeadline,
        nextTurnAt,
        turnIntervalMs: slot.state === "combat" && combatState ? COMBAT_TICK_INTERVAL_MS : null,
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

const g = globalThis as unknown as {
  __rumbleOrchestrator?: RumbleOrchestrator;
  __rumbleAutoTickTimer?: ReturnType<typeof setInterval>;
};

function shouldAutoTick(): boolean {
  const envToggle = process.env.RUMBLE_AUTO_TICK;
  if (envToggle === "true") return true;
  if (envToggle === "false") return false;
  return process.env.NODE_ENV !== "production";
}

function autoTickIntervalMs(): number {
  const raw = Number(process.env.RUMBLE_AUTO_TICK_INTERVAL_MS ?? "2000");
  if (!Number.isFinite(raw)) return 2000;
  return Math.max(1000, Math.floor(raw));
}

function canUnrefTimer(timer: unknown): timer is { unref: () => void } {
  return typeof timer === "object" && timer !== null && "unref" in timer;
}

function ensureAutoTick(orchestrator: RumbleOrchestrator): void {
  if (!shouldAutoTick()) return;
  if (g.__rumbleAutoTickTimer) return;

  const intervalMs = autoTickIntervalMs();
  g.__rumbleAutoTickTimer = setInterval(() => {
    orchestrator.tick().catch((err) => {
      console.error("[RumbleAutoTick] Tick error:", err);
    });
  }, intervalMs);

  if (canUnrefTimer(g.__rumbleAutoTickTimer) && typeof g.__rumbleAutoTickTimer.unref === "function") {
    g.__rumbleAutoTickTimer.unref();
  }

  console.log(`[RumbleAutoTick] Enabled (${intervalMs}ms interval)`);
}

export function getOrchestrator(): RumbleOrchestrator {
  if (!g.__rumbleOrchestrator) {
    g.__rumbleOrchestrator = new RumbleOrchestrator(getQueueManager());
  }
  ensureAutoTick(g.__rumbleOrchestrator);
  return g.__rumbleOrchestrator;
}

export function resetOrchestrator(): void {
  if (g.__rumbleAutoTickTimer) {
    clearInterval(g.__rumbleAutoTickTimer);
    g.__rumbleAutoTickTimer = undefined;
  }
  g.__rumbleOrchestrator = undefined;
}
