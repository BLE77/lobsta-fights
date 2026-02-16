// Queue Manager - Manages the fighter queue and 3 staggered Rumble slots
// See ICHOR_WHITEPAPER.md section 8 for design details.

import type { RumbleResult } from "./rumble-engine";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SlotState = "idle" | "betting" | "combat" | "payout";

export interface RumbleSlot {
  id: string;
  slotIndex: number;
  state: SlotState;
  fighters: string[];
  bettingPool: Map<string, number>;
  bettingDeadline: Date | null;
  combatStartedAt: Date | null;
  rumbleResult: RumbleResult | null;
}

export interface QueueEntry {
  fighterId: string;
  joinedAt: Date;
  autoRequeue: boolean;
  priority: number; // lower = higher priority (0 is highest)
}

export interface QueueManager {
  addToQueue(fighterId: string, autoRequeue?: boolean): QueueEntry;
  removeFromQueue(fighterId: string): boolean;
  abortBettingSlot(slotIndex: number): string[];
  getQueuePosition(fighterId: string): number | null;
  getQueueLength(): number;
  getQueueEntries(): QueueEntry[];
  getQueueStartCountdownMs(): number | null;
  armBettingWindow(slotIndex: number, deadline?: Date): boolean;
  getSlots(): RumbleSlot[];
  getSlot(slotIndex: number): RumbleSlot | null;
  advanceSlots(): void;
  startNextRumble(slotIndex: number): string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NUM_SLOTS = 3;
const FIGHTERS_PER_RUMBLE = 16;
const MIN_FIGHTERS_TO_START = 8;

function readDurationMs(
  envName: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = Number(process.env[envName] ?? "");
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(raw)));
}

const BETTING_DURATION_MS = readDurationMs(
  "RUMBLE_BETTING_DURATION_MS",
  60 * 1000,
  15 * 1000,
  10 * 60 * 1000,
);
const COMBAT_DURATION_MS = readDurationMs(
  "RUMBLE_COMBAT_DURATION_MS",
  5 * 60 * 1000,
  60 * 1000,
  2 * 60 * 60 * 1000,
);
const PAYOUT_DURATION_MS = readDurationMs(
  "RUMBLE_PAYOUT_DURATION_MS",
  30 * 1000,
  10 * 1000,
  5 * 60 * 1000,
);
const BETTING_CLOSE_GRACE_MS = readDurationMs(
  "RUMBLE_BETTING_CLOSE_GRACE_MS",
  1_500,
  0,
  15_000,
);
const QUEUE_LOCK_COUNTDOWN_MS = readDurationMs(
  "RUMBLE_QUEUE_LOCK_COUNTDOWN_MS",
  30_000,
  5_000,
  120_000,
);

// Slot offsets -- each slot is staggered by ~2 minutes so there's always
// something happening. These aren't wall-clock offsets; they're the initial
// phase each slot starts in. We rotate through betting -> combat -> payout.
const SLOT_INITIAL_STATES: SlotState[] = ["betting", "combat", "payout"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let rumbleCounter = 0;

function generateRumbleId(): string {
  rumbleCounter += 1;
  return `rumble_${Date.now()}_${rumbleCounter}`;
}

function createEmptySlot(slotIndex: number): RumbleSlot {
  return {
    id: generateRumbleId(),
    slotIndex,
    state: "idle",
    fighters: [],
    bettingPool: new Map(),
    bettingDeadline: null,
    combatStartedAt: null,
    rumbleResult: null,
  };
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class RumbleQueueManager implements QueueManager {
  private queue: QueueEntry[] = [];
  private slots: RumbleSlot[];
  private fighterSet: Set<string> = new Set(); // quick lookup for duplicates
  private queueReadyAtMs: number | null = null;

  constructor() {
    this.slots = Array.from({ length: NUM_SLOTS }, (_, i) => createEmptySlot(i));
  }

  // ---- Queue operations ---------------------------------------------------

  addToQueue(fighterId: string, autoRequeue = false): QueueEntry {
    // Prevent duplicate entries
    if (this.fighterSet.has(fighterId)) {
      const existing = this.queue.find((e) => e.fighterId === fighterId);
      if (existing) return existing;
    }

    // Also prevent joining if already in an active slot
    for (const slot of this.slots) {
      if (slot.state !== "idle" && slot.fighters.includes(fighterId)) {
        throw new Error(
          `Fighter ${fighterId} is already in active Rumble slot ${slot.slotIndex}`
        );
      }
    }

    const entry: QueueEntry = {
      fighterId,
      joinedAt: new Date(),
      autoRequeue,
      priority: 0, // default priority; can be adjusted for stakers later
    };

    this.queue.push(entry);
    this.fighterSet.add(fighterId);
    this.sortQueue();
    return entry;
  }

  removeFromQueue(fighterId: string): boolean {
    const idx = this.queue.findIndex((e) => e.fighterId === fighterId);
    if (idx === -1) return false;
    this.queue.splice(idx, 1);
    this.fighterSet.delete(fighterId);
    return true;
  }

  getQueuePosition(fighterId: string): number | null {
    const idx = this.queue.findIndex((e) => e.fighterId === fighterId);
    return idx === -1 ? null : idx + 1; // 1-based position
  }

  getQueueLength(): number {
    return this.queue.length;
  }

  getQueueEntries(): QueueEntry[] {
    return this.queue.map((entry) => ({ ...entry }));
  }

  getQueueStartCountdownMs(): number | null {
    if (this.queue.length < MIN_FIGHTERS_TO_START) return null;
    if (this.queueReadyAtMs === null) return QUEUE_LOCK_COUNTDOWN_MS;
    const deadline = this.queueReadyAtMs + QUEUE_LOCK_COUNTDOWN_MS;
    return Math.max(0, deadline - Date.now());
  }

  /**
   * Returns an estimated wait time in milliseconds for a fighter in the queue.
   * Null if fighter is not in queue.
   */
  getEstimatedWait(fighterId: string): number | null {
    const pos = this.getQueuePosition(fighterId);
    if (pos === null) return null;

    // How many full "batches" ahead of this fighter?
    const batchesAhead = Math.floor((pos - 1) / FIGHTERS_PER_RUMBLE);
    // Each batch takes roughly one full cycle to process.
    // With 3 staggered slots, a new rumble opens every ~cycle/3.
    const cycleDuration =
      BETTING_DURATION_MS + COMBAT_DURATION_MS + PAYOUT_DURATION_MS;
    const timeBetweenRumbles = cycleDuration / NUM_SLOTS;
    return batchesAhead * timeBetweenRumbles;
  }

  // ---- Slot operations ----------------------------------------------------

  getSlots(): RumbleSlot[] {
    return [...this.slots];
  }

  getSlot(slotIndex: number): RumbleSlot | null {
    return this.slots[slotIndex] ?? null;
  }

  /**
   * Called on a regular timer tick. Advances each slot through its lifecycle
   * based on elapsed time / deadlines.
   *
   * State machine per slot:
   *   idle -> betting (when fighters available)
   *   betting -> combat (when betting deadline passes)
   *   combat -> payout (when rumbleResult is set)
   *   payout -> idle (after payout duration, then auto-requeue fighters)
   */
  advanceSlots(): void {
    const now = new Date();

    for (const slot of this.slots) {
      switch (slot.state) {
        case "idle":
          this.tryStartBetting(slot);
          break;

        case "betting":
          if (
            slot.bettingDeadline &&
            now.getTime() >= slot.bettingDeadline.getTime() + BETTING_CLOSE_GRACE_MS
          ) {
            console.log(
              `[QM] Slot ${slot.slotIndex} betting→combat: now=${now.toISOString()} deadline=${slot.bettingDeadline.toISOString()} diff=${now.getTime() - slot.bettingDeadline.getTime()}ms grace=${BETTING_CLOSE_GRACE_MS}ms`,
            );
            this.transitionToCombat(slot, now);
          }
          break;

        case "combat":
          // Combat ends only when rumbleResult is set externally by the engine.
          if (slot.rumbleResult) {
            this.transitionToPayout(slot);
          }
          break;

        case "payout":
          // Payout is handled externally (by the betting system).
          // After PAYOUT_DURATION_MS we reset the slot.
          if (slot.combatStartedAt) {
            const payoutStart =
              (slot.rumbleResult ? slot.combatStartedAt.getTime() : 0) +
              COMBAT_DURATION_MS;
            // Use a simple flag: once payout duration has passed, recycle.
            // We repurpose combatStartedAt to track payout start by checking
            // total elapsed time.
          }
          // Simplified: transition to idle after payout duration.
          // We track payout start as the time we entered payout state.
          // Store it on the slot as a lightweight approach.
          this.tryFinishPayout(slot, now);
          break;
      }
    }
  }

  /**
   * Pull top fighters from the queue into the given slot and begin betting.
   * Returns the fighter IDs that were pulled.
   */
  startNextRumble(slotIndex: number): string[] {
    const slot = this.slots[slotIndex];
    if (!slot) return [];
    if (slot.state !== "idle" && slot.state !== "betting") return [];

    const pulled = this.pullFighters();
    if (pulled.length === 0) return [];

    slot.id = generateRumbleId();
    slot.fighters = pulled;
    slot.bettingPool = new Map();
    // Betting window starts only after on-chain rumble initialization.
    slot.bettingDeadline = null;
    slot.combatStartedAt = null;
    slot.rumbleResult = null;
    slot.state = "betting";
    this.queueReadyAtMs = null;

    console.log(`[QM] Slot ${slotIndex} entered betting (awaiting on-chain init)`);

    return pulled;
  }

  armBettingWindow(slotIndex: number, deadline?: Date): boolean {
    const slot = this.slots[slotIndex];
    if (!slot || slot.state !== "betting") return false;
    if (slot.bettingDeadline) return true;
    slot.bettingDeadline = deadline ?? new Date(Date.now() + BETTING_DURATION_MS);
    console.log(
      `[QM] Slot ${slotIndex} betting window armed: deadline=${slot.bettingDeadline.toISOString()}`
    );
    return true;
  }

  /**
   * Abort a slot stuck in betting and return fighters that were in that slot.
   * The slot is reset to idle and onSlotRecycled hook is triggered.
   */
  abortBettingSlot(slotIndex: number): string[] {
    const slot = this.slots[slotIndex];
    if (!slot || slot.state !== "betting") return [];
    const fighters = [...slot.fighters];
    const previousRumbleId = slot.id;

    slot.id = generateRumbleId();
    slot.state = "idle";
    slot.fighters = [];
    slot.bettingPool = new Map();
    slot.bettingDeadline = null;
    slot.combatStartedAt = null;
    slot.rumbleResult = null;

    this.onSlotRecycled(slotIndex, fighters, previousRumbleId);
    return fighters;
  }

  /**
   * Allows external code (the rumble engine) to report the combat result for
   * a slot, which will trigger the payout transition on the next advanceSlots.
   */
  reportResult(slotIndex: number, result: RumbleResult): void {
    const slot = this.slots[slotIndex];
    if (!slot || slot.state !== "combat") return;
    slot.rumbleResult = result;
  }

  /**
   * Place a bet on a fighter in a slot that is currently in betting state.
   * Returns true if the bet was accepted.
   */
  placeBet(slotIndex: number, bettorId: string, amount: number): boolean {
    const slot = this.slots[slotIndex];
    if (!slot || slot.state !== "betting") return false;
    if (slot.bettingDeadline && new Date() >= slot.bettingDeadline) return false;

    const current = slot.bettingPool.get(bettorId) ?? 0;
    slot.bettingPool.set(bettorId, current + amount);
    return true;
  }

  // ---- Private helpers ----------------------------------------------------

  /** Sort queue: lower priority number first, then by joinedAt (FIFO). */
  private sortQueue(): void {
    this.queue.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.joinedAt.getTime() - b.joinedAt.getTime();
    });
  }

  /** Pull up to FIGHTERS_PER_RUMBLE fighters from the front of the queue. */
  private pullFighters(): string[] {
    const count = Math.min(this.queue.length, FIGHTERS_PER_RUMBLE);
    if (count === 0) return [];

    const pulled = this.queue.splice(0, count);
    for (const entry of pulled) {
      this.fighterSet.delete(entry.fighterId);
    }
    return pulled.map((e) => e.fighterId);
  }

  /** If queue has enough fighters and slot is idle, start betting. */
  private tryStartBetting(slot: RumbleSlot): void {
    if (this.queue.length < MIN_FIGHTERS_TO_START) {
      this.queueReadyAtMs = null;
      return;
    }

    // If we've already filled the full bracket, start immediately.
    if (this.queue.length >= FIGHTERS_PER_RUMBLE) {
      this.startNextRumble(slot.slotIndex);
      return;
    }

    if (this.queueReadyAtMs === null) {
      this.queueReadyAtMs = Date.now();
      return;
    }

    if (Date.now() < this.queueReadyAtMs + QUEUE_LOCK_COUNTDOWN_MS) {
      return;
    }

    this.startNextRumble(slot.slotIndex);
  }

  /** Transition a slot from betting to combat. */
  private transitionToCombat(slot: RumbleSlot, now: Date): void {
    slot.state = "combat";
    slot.combatStartedAt = now;
  }

  /** Transition a slot from combat to payout. */
  private transitionToPayout(slot: RumbleSlot): void {
    slot.state = "payout";
    // Store payout start time. We stash it in a lightweight way by
    // recording the current time. We'll use a private map for payout tracking.
    this.payoutStartTimes.set(slot.slotIndex, new Date());
  }

  /** Track when each slot entered payout so we know when to recycle. */
  private payoutStartTimes: Map<number, Date> = new Map();

  /** Check if payout duration has elapsed and recycle the slot. */
  private tryFinishPayout(slot: RumbleSlot, now: Date): void {
    const payoutStart = this.payoutStartTimes.get(slot.slotIndex);
    if (!payoutStart) {
      // No start time recorded -- record now and wait.
      this.payoutStartTimes.set(slot.slotIndex, now);
      return;
    }

    if (now.getTime() - payoutStart.getTime() >= PAYOUT_DURATION_MS) {
      this.recycleSlot(slot);
    }
  }

  /** Reset a slot to idle and auto-requeue fighters that opted in. */
  private recycleSlot(slot: RumbleSlot): void {
    // Auto-requeue fighters
    for (const fighterId of slot.fighters) {
      // Check if this fighter had autoRequeue set.
      // Since we already pulled them from the queue, we store that info
      // separately. For now, re-add everyone. In production, we'd check a
      // fighter config table. This simple approach re-adds them to the back.
      // Callers should set autoRequeue via addToQueue when they re-enter.
    }

    // Clean up payout tracking
    this.payoutStartTimes.delete(slot.slotIndex);

    // Reset slot to idle
    const oldFighters = slot.fighters;
    const oldRumbleId = slot.id;
    slot.id = generateRumbleId();
    slot.state = "idle";
    slot.fighters = [];
    slot.bettingPool = new Map();
    slot.bettingDeadline = null;
    slot.combatStartedAt = null;
    slot.rumbleResult = null;

    // Emit event so external systems can handle auto-requeue.
    // Kept as a no-op for now; will hook into Supabase later.
    this.onSlotRecycled(slot.slotIndex, oldFighters, oldRumbleId);
  }

  /**
   * Hook for external systems to handle auto-requeue after a slot recycles.
   * Override or replace this in production.
   */
  onSlotRecycled(_slotIndex: number, _previousFighters: string[], _previousRumbleId: string): void {
    // no-op by default -- external code can monkeypatch or subclass
  }

  // ---- Recovery helpers ----------------------------------------------------

  /**
   * Restore a slot to a specific state during cold-start recovery.
   * Directly sets the slot's fighters, state, and deadlines without
   * pulling from the queue. Used by rumble-state-recovery.ts.
   */
  restoreSlot(
    slotIndex: number,
    rumbleId: string,
    fighters: string[],
    state: SlotState,
    bettingDeadline: Date | null,
  ): boolean {
    const slot = this.slots[slotIndex];
    if (!slot) return false;

    slot.id = rumbleId;
    slot.state = state;
    slot.fighters = fighters;
    slot.bettingPool = new Map();
    slot.bettingDeadline = bettingDeadline;
    slot.combatStartedAt = state === "combat" ? new Date() : null;
    slot.rumbleResult = null;

    // Remove restored fighters from the queue if they're in it
    for (const fid of fighters) {
      this.removeFromQueue(fid);
    }

    console.log(
      `[QM] Restored slot ${slotIndex} → state=${state} rumbleId=${rumbleId} fighters=${fighters.length} deadline=${bettingDeadline?.toISOString() ?? "none"}`
    );
    return true;
  }

  // ---- Initialization helpers ---------------------------------------------

  /**
   * Initialize the 3 slots with staggered states so we immediately have
   * the betting/combat/payout pipeline running. Call this when the server
   * starts and the queue already has fighters.
   */
  initializeStaggered(): void {
    for (let i = 0; i < NUM_SLOTS; i++) {
      const desiredState = SLOT_INITIAL_STATES[i];
      const slot = this.slots[i];

      if (desiredState === "betting") {
        this.tryStartBetting(slot);
      }
      // For combat and payout, we'd need fighters already in the slot.
      // In practice, on a fresh start all slots begin idle and
      // advanceSlots() naturally staggers them as the queue fills.
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton — uses globalThis to survive Next.js HMR reloads in dev mode.
// Without globalThis, each route compilation gets its own module instance
// and a separate QueueManager, causing state to diverge across routes.
// ---------------------------------------------------------------------------

const g = globalThis as unknown as { __rumbleQueueManager?: RumbleQueueManager };

export function getQueueManager(): RumbleQueueManager {
  if (!g.__rumbleQueueManager) {
    g.__rumbleQueueManager = new RumbleQueueManager();
  }
  return g.__rumbleQueueManager;
}

/** Reset the singleton -- useful for tests. */
export function resetQueueManager(): void {
  g.__rumbleQueueManager = undefined;
}
