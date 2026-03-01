// =============================================================================
// Rumble Orchestrator - Coordinates queue, combat engine, and betting system
//
// The main lifecycle coordinator for the Ichor Rumble system. Manages 3
// staggered slots, each independently cycling through:
//   IDLE → BETTING → COMBAT → PAYOUT → IDLE
//
// Called on a regular tick (~1s). Emits events for live spectator updates.
// =============================================================================

import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
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
  type RumblePairing,
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
import {
  METER_PER_TURN,
  SPECIAL_METER_COST,
  resolveCombat,
  isValidMove,
  createMoveHash,
} from "./combat";
import { notifyFighter } from "./webhook";
import type { MoveType } from "./types";

import * as persist from "./rumble-persistence";
import { getRumblePayoutMode } from "./rumble-payout-mode";
import { parseOnchainRumbleIdNumber } from "./rumble-id";

import {
  distributeReward as distributeRewardOnChain,
  adminDistribute as adminDistributeOnChain,
  buildCommitMoveTx,
  buildRevealMoveTx,
  checkIchorShower as checkIchorShowerOnChain,
  computeMoveCommitmentHash,
  createRumble as createRumbleOnChain,
  deriveMoveCommitmentPda,
  finalizeRumbleOnChain as finalizeRumbleOnChainTx,
  openTurn as openTurnOnChain,
  readRumbleCombatState,
  startCombat as startCombatOnChain,
  resolveTurnOnChain,
  advanceTurnOnChain,
  completeRumble as completeRumbleOnChain,
  sweepTreasury as sweepTreasuryOnChain,
  ensureAta as ensureAtaOnChain,
  getIchorMint,
  deriveArenaConfigPda,
  readArenaConfig,
  readRumbleConfig,
  readRumbleAccountState,
  readMainnetRumbleAccountStateResilient,
  getAdminSignerPublicKey,
  type RumbleCombatAccountState,
  readShowerRequest,
  RUMBLE_ENGINE_ID,
  invalidateReadCache,
  closeMoveCommitmentOnChain,
  readRumbleFighters,
  postTurnResultOnChain,
  readMoveCommitmentData,
  createRumbleMainnet,
  reportResultMainnet,
  completeRumbleMainnet,
  sweepTreasuryMainnet,
  sweepTreasury as sweepTreasuryDevnet,
  reclaimMainnetRumbleRent,
  RUMBLE_ENGINE_ID_MAINNET,
  delegateCombatToEr,
  commitCombatFromEr,
  undelegateCombatFromEr,
  requestMatchupSeed,
  requestIchorShowerVrf,
} from "./solana-programs";
import { markOpComplete, markOpFailed, persistMainnetOp } from "./mainnet-retry";
import { Keypair, PublicKey, Transaction, Connection } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { getConnection, getErConnection, getBettingConnection } from "./solana-connection";

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

export interface TransformedPayout {
  winnerBettorsPayout: number;
  placeBettorsPayout: number;
  showBettorsPayout: number;
  treasuryVault: number;
  totalPool: number;
  ichorMined: number;
  ichorShowerTriggered: boolean;
  ichorShowerAmount: number;
}

export interface PayoutCompleteEvent {
  slotIndex: number;
  rumbleId: string;
  payout: TransformedPayout;
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
  fighterWallets: Map<string, PublicKey>;
  turns: RumbleTurn[];
  eliminationOrder: string[];
  previousPairings: Set<string>;
  turnDecisions: Map<number, Map<string, OnchainTurnDecision>>;
  lastOnchainTurnResolved: number;
  previousDamageTaken: Map<string, number>;
  lastTickAt: number;
}

interface OnchainTurnDecision {
  move: MoveType;
  moveCode: number;
  salt32Hex: string;
  commitmentHex: string;
  commitSubmitted: boolean;
  revealSubmitted: boolean;
  /** true if the server holds the keypair for this fighter; false means external signing via webhook */
  hasSigner: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NUM_SLOTS = 1;

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

const LEGACY_COMBAT_TICK_INTERVAL_MS_CONFIGURED = readIntervalMs(
  "RUMBLE_COMBAT_TICK_INTERVAL_MS",
  3_000,
  1_000,
  120_000,
);
const LEGACY_COMBAT_TICK_MIN_PROD_MS = readIntervalMs(
  "RUMBLE_COMBAT_TICK_MIN_PROD_MS",
  1_000,
  500,
  120_000,
);
const LEGACY_COMBAT_TICK_INTERVAL_MS =
  process.env.NODE_ENV === "production"
    ? Math.max(LEGACY_COMBAT_TICK_INTERVAL_MS_CONFIGURED, LEGACY_COMBAT_TICK_MIN_PROD_MS)
    : LEGACY_COMBAT_TICK_INTERVAL_MS_CONFIGURED;
// Serverless function max duration budget — matches Vercel maxDuration.
// Combat loop stops running turns BUDGET_RESERVE_MS before this to leave
// time for persistence. Overridable via env for Pro plan (60s).
const MAX_DURATION_MS = readIntervalMs(
  "RUMBLE_MAX_DURATION_MS",
  10_000,
  5_000,
  120_000,
);
const ONCHAIN_KEEPER_POLL_INTERVAL_MS = readIntervalMs(
  "RUMBLE_ONCHAIN_KEEPER_POLL_INTERVAL_MS",
  1_000,
  250,
  10_000,
);
const ONCHAIN_BETTING_DURATION_MS = readIntervalMs(
  "RUMBLE_BETTING_DURATION_MS",
  60_000,
  15_000,
  10 * 60_000,
);
const SLOT_MS_ESTIMATE = readIntervalMs(
  "RUMBLE_SLOT_MS_ESTIMATE",
  400,
  250,
  1_000,
);
const ONCHAIN_DEADLINE_UNIX_SLOT_GAP_THRESHOLD = 5_000_000n;
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
const HOUSE_BOT_IDS = (process.env.RUMBLE_HOUSE_BOT_IDS ?? "")
  .split(",")
  .map((id) => id.trim())
  .filter((id) => id.length > 0);
const HOUSE_BOTS_ENABLED = process.env.RUMBLE_HOUSE_BOTS_ENABLED === "true" && HOUSE_BOT_IDS.length > 0;
// Default to auto-fill ON when house bots are enabled; can be explicitly disabled.
const HOUSE_BOTS_AUTO_FILL = (process.env.RUMBLE_HOUSE_BOTS_AUTO_FILL ?? "true") !== "false";
const HOUSE_BOT_TARGET_POPULATION = readInt(
  "RUMBLE_HOUSE_BOT_TARGET_POPULATION",
  8,
  0,
  64,
);
const SHOWER_SETTLEMENT_POLL_MS = 12_000;
const ONCHAIN_FINALIZATION_DELAY_MS = 30_000; // completeRumble after 30s claim window (sweep disabled)
const ONCHAIN_FINALIZATION_RETRY_MS = 10_000;
const ONCHAIN_CREATE_RETRY_MS = 5_000;
const ONCHAIN_CREATE_STALL_TIMEOUT_MS = readIntervalMs(
  "RUMBLE_ONCHAIN_CREATE_STALL_TIMEOUT_MS",
  5 * 60_000,
  10_000,
  30 * 60_000,
);
const ABORT_STALLED_BETTING =
  process.env.RUMBLE_ABORT_STALLED_BETTING === undefined
    ? process.env.NODE_ENV !== "production"
    : process.env.RUMBLE_ABORT_STALLED_BETTING === "true";
const ONCHAIN_CREATE_VERIFY_ATTEMPTS = readInt(
  "RUMBLE_ONCHAIN_CREATE_VERIFY_ATTEMPTS",
  4,
  1,
  10,
);
const ONCHAIN_CREATE_VERIFY_BACKOFF_MS = readIntervalMs(
  "RUMBLE_ONCHAIN_CREATE_VERIFY_BACKOFF_MS",
  250,
  50,
  2_000,
);
const MAX_FINALIZATION_ATTEMPTS = 30;
const ONCHAIN_CREATE_RECOVERY_DEADLINE_SKEW_SEC = 5;
const ONCHAIN_ADMIN_HEALTH_CHECK_MS = readIntervalMs(
  "RUMBLE_ONCHAIN_ADMIN_HEALTH_CHECK_MS",
  15_000,
  2_000,
  120_000,
);
const MAX_MAP_SIZE = 500;
const TRACKING_MAP_CLEANUP_INTERVAL_MS = 60_000;
// Turn authority mode:
// - true  => full on-chain turn loop (requires deployed program with
//            open_turn/resolve_turn/advance_turn + combat_state account)
// - false => legacy off-chain turn loop with on-chain betting/payout state
//
// We default to legacy mode until the upgraded turn-authority program is
// deployed and verified on the target cluster.
const ONCHAIN_TURN_AUTHORITY = (process.env.RUMBLE_ONCHAIN_TURN_AUTHORITY ?? "false") === "true";

// "onchain" => full on-chain resolve_turn (original path)
// "hybrid"  => off-chain combat math, post_turn_result on-chain (Option D)
const RESOLUTION_MODE = (process.env.RUMBLE_RESOLUTION_MODE ?? "onchain") as "onchain" | "hybrid";

// Server-side secret mixed into fallback move hash so observers can't precompute fallback moves
// from public on-chain data. Generate with: openssl rand -hex 32
const FALLBACK_MOVE_SECRET = process.env.FALLBACK_MOVE_SECRET ?? randomBytes(32).toString("hex");

interface OnchainAdminHealth {
  checkedAt: number;
  ready: boolean;
  reason: string | null;
  signerPubkey: string | null;
  rumbleAdmin: string | null;
}

interface OnchainCreateFailure {
  rumbleId: string;
  slotIndex: number | null;
  fighterCount: number;
  attempts: number;
  firstSeenAt: number;
  lastSeenAt: number;
  reason: string;
  nextRetryAt: number | null;
}

interface PendingFinalization {
  rumbleId: string;
  rumbleIdNum: number;
  nextAttemptAt: number;
  attempts: number;
  completeDone: boolean;
}

interface PendingSweep {
  rumbleId: string;
  rumbleIdNum: number;
  /** Earliest wall-clock time we should attempt the sweep. */
  sweepAfter: number;
  attempts: number;
  /** True when no bettor placed a bet on the winning fighter. */
  noWinnerBets: boolean;
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

async function persistWithRetry(
  fn: () => Promise<void>,
  label: string,
  maxRetries = 3,
): Promise<void> {
  const delaysMs = [500, 1_000, 2_000];

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await fn();
      return;
    } catch (error) {
      if (attempt >= maxRetries) {
        console.error("[PERSIST_FAIL]", label, error);
        return;
      }
      const delayMs = delaysMs[Math.min(attempt, delaysMs.length - 1)];
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

// ---------------------------------------------------------------------------
// Deterministic combat functions (match on-chain resolve_duel exactly)
// Fixed damage values — NO variance/RNG
// ---------------------------------------------------------------------------

const D_STRIKE_HIGH = 39;
const D_STRIKE_MID = 30;
const D_STRIKE_LOW = 23;
const D_CATCH = 45;
const D_COUNTER = 18;
const D_SPECIAL = 52;
const D_METER_PER_TURN = 20;
const D_SPECIAL_METER_COST = 100;

function isStrikeCode(m: number): boolean { return m >= 0 && m <= 2; }
function isGuardCode(m: number): boolean { return m >= 3 && m <= 5; }

function guardForStrike(strike: number): number | null {
  // HIGH_STRIKE(0)->GUARD_HIGH(3), MID(1)->GUARD_MID(4), LOW(2)->GUARD_LOW(5)
  if (strike >= 0 && strike <= 2) return strike + 3;
  return null;
}

function strikeDamage(m: number): number {
  if (m === 0) return D_STRIKE_HIGH;
  if (m === 1) return D_STRIKE_MID;
  if (m === 2) return D_STRIKE_LOW;
  return 0;
}

function resolveDuelDeterministic(
  moveA: number, moveB: number, meterA: number, meterB: number
): { damageToA: number; damageToB: number; meterUsedA: number; meterUsedB: number } {
  let damageToA = 0, damageToB = 0;
  let meterUsedA = 0, meterUsedB = 0;

  const aSpecial = moveA === 8 && meterA >= D_SPECIAL_METER_COST;
  const bSpecial = moveB === 8 && meterB >= D_SPECIAL_METER_COST;
  if (aSpecial) meterUsedA = D_SPECIAL_METER_COST;
  if (bSpecial) meterUsedB = D_SPECIAL_METER_COST;

  const effectiveA = (moveA === 8 && !aSpecial) ? -1 : moveA;
  const effectiveB = (moveB === 8 && !bSpecial) ? -1 : moveB;

  // A's attack on B
  if (effectiveA === 8) { // SPECIAL
    if (effectiveB !== 6) damageToB = D_SPECIAL; // DODGE=6
  } else if (effectiveA === 7) { // CATCH
    if (effectiveB === 6) damageToB = D_CATCH;
  } else if (effectiveA >= 0 && isStrikeCode(effectiveA)) {
    if (effectiveB === 6) {
      // dodged
    } else if (guardForStrike(effectiveA) === effectiveB) {
      damageToA = D_COUNTER;
    } else {
      damageToB = strikeDamage(effectiveA);
    }
  }

  // B's attack on A
  if (effectiveB === 8) {
    if (effectiveA !== 6) damageToA = D_SPECIAL;
  } else if (effectiveB === 7) {
    if (effectiveA === 6) damageToA = D_CATCH;
  } else if (effectiveB >= 0 && isStrikeCode(effectiveB)) {
    if (effectiveA === 6) {
      // dodged
    } else if (guardForStrike(effectiveB) === effectiveA) {
      damageToB = D_COUNTER;
    } else {
      damageToA = strikeDamage(effectiveB);
    }
  }

  return { damageToA, damageToB, meterUsedA, meterUsedB };
}

// ---------------------------------------------------------------------------
// SHA256-based deterministic pairing & fallback moves (mirror on-chain logic)
// ---------------------------------------------------------------------------

function hashU64ForPairing(rumbleId: number, turn: number, fighterPubkey: PublicKey): bigint {
  const h = createHash("sha256");
  h.update(Buffer.from("pair-order"));
  const ridBuf = Buffer.alloc(8);
  ridBuf.writeBigUInt64LE(BigInt(rumbleId));
  h.update(ridBuf);
  const turnBuf = Buffer.alloc(4);
  turnBuf.writeUInt32LE(turn);
  h.update(turnBuf);
  h.update(fighterPubkey.toBuffer());
  const digest = h.digest();
  return digest.readBigUInt64LE(0);
}

function pairFightersForTurn(
  aliveIndices: number[],
  fighters: PublicKey[],
  rumbleId: number,
  turn: number,
): { pairs: [number, number][]; byeIdx: number | null } {
  const sorted = [...aliveIndices].sort((a, b) => {
    const ha = hashU64ForPairing(rumbleId, turn, fighters[a]);
    const hb = hashU64ForPairing(rumbleId, turn, fighters[b]);
    if (ha < hb) return -1;
    if (ha > hb) return 1;
    return Buffer.compare(fighters[a].toBuffer(), fighters[b].toBuffer());
  });

  const pairs: [number, number][] = [];
  let byeIdx: number | null = null;

  for (let i = 0; i + 1 < sorted.length; i += 2) {
    pairs.push([sorted[i], sorted[i + 1]]);
  }
  if (sorted.length % 2 === 1) {
    byeIdx = sorted[sorted.length - 1];
  }

  return { pairs, byeIdx };
}

function computeFallbackMove(rumbleId: number, turn: number, fighter: PublicKey, meter: number): number {
  const h = createHash("sha256");
  h.update(Buffer.from(FALLBACK_MOVE_SECRET, "hex"));
  const ridBuf = Buffer.alloc(8);
  ridBuf.writeBigUInt64LE(BigInt(rumbleId));
  h.update(ridBuf);
  const turnBuf = Buffer.alloc(4);
  turnBuf.writeUInt32LE(turn);
  h.update(turnBuf);
  h.update(fighter.toBuffer());
  h.update(Buffer.from("fallback"));
  const digest = h.digest();
  const roll = Number(digest.readBigUInt64LE(0) % 100n);

  if (meter >= D_SPECIAL_METER_COST && roll < 15) return 8; // SPECIAL
  if (roll < 25) return 0; // HIGH_STRIKE
  if (roll < 50) return 1; // MID_STRIKE
  if (roll < 65) return 2; // LOW_STRIKE
  if (roll < 75) return 3; // GUARD_HIGH
  if (roll < 83) return 4; // GUARD_MID
  if (roll < 90) return 5; // GUARD_LOW
  if (roll < 95) return 6; // DODGE
  return 7; // CATCH
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export class RumbleOrchestrator {
  private queueManager: RumbleQueueManager;
  private readonly houseBotIds = HOUSE_BOT_IDS;
  private readonly houseBotSet = new Set(HOUSE_BOT_IDS);
  private readonly fighterSignerById = new Map<string, Keypair>();
  private readonly fighterSignerByWallet = new Map<string, Keypair>();
  private houseBotsPaused = false;
  private houseBotTargetPopulationOverride: number | null = null;
  private houseBotsLastRestartAt: string | null = null;
  private lastPauseSyncAt = 0;

  // Betting pools indexed by slot
  private bettingPools: Map<number, BettingPool> = new Map();

  // Incremental combat state indexed by slot
  private combatStates: Map<number, SlotCombatState> = new Map();

  // Timestamp of when the current tick burst started (for serverless budget tracking)
  private tickStartedAt: number = Date.now();

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
  private settlingRumbleIds: Set<string> = new Set(); // rumble IDs currently attempting on-chain settlement
  private pendingFinalizations: Map<string, PendingFinalization> = new Map();
  private pendingSweeps: Map<string, PendingSweep> = new Map();
  private lastRentReclaimAt = 0;
  private onchainRumbleCreateRetryAt: Map<string, number> = new Map();
  private onchainRumbleCreateStartedAt: Map<string, number> = new Map();
  private onchainRumbleCreateLastError: Map<string, OnchainCreateFailure> = new Map();
  private warnedInvalidHouseBotIds: Set<string> = new Set();
  private onchainAdminHealth: OnchainAdminHealth = {
    checkedAt: 0,
    ready: true,
    reason: null,
    signerPubkey: null,
    rumbleAdmin: null,
  };
  private tickInFlight: Promise<void> | null = null;
  private inflightCleanup: Set<Promise<unknown>> = new Set();

  // Track consecutive fatal openTurn failures per rumble to detect unrecoverable on-chain state
  private openTurnFatalFailures: Map<string, number> = new Map();
  private lastTrackerCleanupAt = 0;

  /** Whether MagicBlock Ephemeral Rollups are enabled for combat. */
  private get erEnabled(): boolean {
    return process.env.MAGICBLOCK_ER_ENABLED === "true";
  }

  /** Get the connection to use for combat transactions (ER or L1). */
  private getCombatConnection(): Connection {
    return this.erEnabled ? getErConnection() : getConnection();
  }

  constructor(queueManager: RumbleQueueManager) {
    this.queueManager = queueManager;
    this.loadConfiguredFighterSigners();

    // Load persisted pause state from Supabase (survives deploys)
    this.loadPersistedPauseState();

    // Hook into the queue manager's slot recycling so we can handle auto-requeue
    this.queueManager.onSlotRecycled = (slotIndex, previousFighters, previousRumbleId) => {
      this.handleSlotRecycled(slotIndex, previousFighters, previousRumbleId);
    };
  }

  private loadPersistedPauseState(): void {
    persist.getAdminConfig("house_bots_paused").then((value) => {
      const paused = value === true;
      this.houseBotsPaused = paused;
      console.log(`[Orchestrator] Loaded persisted house_bots_paused = ${paused}`);
    }).catch(() => {
      console.warn("[Orchestrator] Failed to load persisted pause state, defaulting to false");
    });
  }

  private parseSecretKey(raw: unknown): Uint8Array | null {
    if (Array.isArray(raw) && raw.length >= 32) {
      try {
        return Uint8Array.from(raw.map((v) => Number(v)));
      } catch {
        return null;
      }
    }
    if (typeof raw === "string" && raw.trim().length > 0) {
      const normalized = raw.trim();
      try {
        if (normalized.startsWith("[") && normalized.endsWith("]")) {
          const parsed = JSON.parse(normalized);
          if (Array.isArray(parsed)) return Uint8Array.from(parsed.map((v) => Number(v)));
        }
      } catch {}
      try {
        const bytes = Buffer.from(normalized, "base64");
        if (bytes.length >= 32) return Uint8Array.from(bytes);
      } catch {}
      try {
        const bytes = Buffer.from(normalized, "hex");
        if (bytes.length >= 32) return Uint8Array.from(bytes);
      } catch {}
    }
    return null;
  }

  private registerFighterSigner(
    fighterId: string | null | undefined,
    walletAddress: string | null | undefined,
    secretRaw: unknown,
  ): void {
    const secret = this.parseSecretKey(secretRaw);
    if (!secret) return;

    let signer: Keypair;
    try {
      signer = Keypair.fromSecretKey(secret);
    } catch {
      return;
    }

    if (fighterId && fighterId.trim()) {
      this.fighterSignerById.set(fighterId.trim(), signer);
    }
    if (walletAddress && walletAddress.trim()) {
      this.fighterSignerByWallet.set(walletAddress.trim(), signer);
    } else {
      this.fighterSignerByWallet.set(signer.publicKey.toBase58(), signer);
    }
  }

  private loadConfiguredFighterSigners(): void {
    try {
      const rawEnv = process.env.RUMBLE_FIGHTER_SIGNER_KEYS_JSON?.trim();
      if (rawEnv) {
        const parsed = JSON.parse(rawEnv);
        if (Array.isArray(parsed)) {
          for (const row of parsed) {
            const fighterId =
              typeof row?.fighter_id === "string"
                ? row.fighter_id
                : typeof row?.fighterId === "string"
                  ? row.fighterId
                  : null;
            const walletAddress =
              typeof row?.wallet_public_key === "string"
                ? row.wallet_public_key
                : typeof row?.walletAddress === "string"
                  ? row.walletAddress
                  : null;
            this.registerFighterSigner(
              fighterId,
              walletAddress,
              row?.wallet_secret_key ?? row?.secret_key ?? row?.secretKey,
            );
          }
        } else if (parsed && typeof parsed === "object") {
          for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
            this.registerFighterSigner(key, key, value);
          }
        }
      }
    } catch (err) {
      console.warn("[Orchestrator] Failed parsing RUMBLE_FIGHTER_SIGNER_KEYS_JSON:", err);
    }

    const secretsPathRaw = process.env.HOUSE_BOT_SECRETS_FILE?.trim();
    if (!secretsPathRaw) return;

    try {
      const absolute = resolvePath(secretsPathRaw);
      if (!existsSync(absolute)) {
        console.warn(`[Orchestrator] HOUSE_BOT_SECRETS_FILE not found: ${absolute}`);
        return;
      }
      const content = readFileSync(absolute, "utf8");
      const parsed = JSON.parse(content);
      const bots: any[] = Array.isArray(parsed?.bots) ? parsed.bots : [];
      for (const bot of bots) {
        this.registerFighterSigner(
          typeof bot?.fighter_id === "string" ? bot.fighter_id : null,
          typeof bot?.wallet_public_key === "string" ? bot.wallet_public_key : null,
          bot?.wallet_secret_key,
        );
      }
    } catch (err) {
      console.warn("[Orchestrator] Failed loading HOUSE_BOT_SECRETS_FILE:", err);
    }
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
    // Atomic guard: if a tick is already running, return the existing promise
    // instead of starting a concurrent one (prevents TOCTOU race).
    const existing = this.tickInFlight;
    if (existing) {
      return existing;
    }

    const p = this.tickInternal().finally(() => {
      this.tickInFlight = null;
    });
    this.tickInFlight = p;
    return p;
  }

  private async tickInternal(): Promise<void> {
    // Track when this tick started for serverless budget management.
    // Combat loop uses this to stop before the function is killed.
    const now = Date.now();
    this.tickStartedAt = now;

    if (now - this.lastTrackerCleanupAt > TRACKING_MAP_CLEANUP_INTERVAL_MS) {
      this.lastTrackerCleanupAt = now;
      this.trimTrackingMaps();
    }

    // Sync pause state from DB every 10s so admin page toggles take effect
    if (now - this.lastPauseSyncAt > 10_000) {
      this.lastPauseSyncAt = now;
      try {
        const dbPaused = await persist.getAdminConfig("house_bots_paused");
        const paused = dbPaused === true;
        if (paused !== this.houseBotsPaused) {
          console.log(`[Orchestrator] Pause state synced from DB: ${this.houseBotsPaused} → ${paused}`);
          this.houseBotsPaused = paused;
        }
      } catch {}
    }

    let onchainAdminHealthy = true;
    if (ONCHAIN_TURN_AUTHORITY) {
      const health = await this.getOnchainAdminHealth();
      if (!health.ready) {
        onchainAdminHealthy = false;
        // Abort slots stuck in betting-init (no deadline yet) when signer is broken.
        const slots = this.queueManager.getSlots();
        for (const slot of slots) {
          if (slot.state === "betting" && !slot.bettingDeadline) {
            await this.abortStalledBettingSlot(
              slot,
              `on-chain admin unavailable: ${health.reason ?? "unknown reason"}`
            );
          }
        }
        // IMPORTANT: Do NOT return early here. advanceSlots() must still run
        // so that slots with an armed bettingDeadline can transition to combat.
        // processSlot() will be skipped for slots needing on-chain authority.
      }
    }

    await this.maintainHouseBotQueue();

    // Let the queue manager handle state transitions (idle→betting, betting→combat, etc.)
    this.queueManager.advanceSlots();

    const slots = this.queueManager.getSlots();
    const slotPromises: Promise<void>[] = [];
    for (const slot of slots) {
      // When on-chain admin is unhealthy, still process combat/payout slots
      // (they can run the legacy off-chain path) but skip betting init since
      // it requires on-chain rumble creation.
      if (ONCHAIN_TURN_AUTHORITY && !onchainAdminHealthy && slot.state === "betting") {
        continue;
      }
      slotPromises.push(this.processSlot(slot));
    }

    // Await all slot processing; individual errors are caught inside processSlot
    await Promise.all(slotPromises);

    await this.processPendingRumbleFinalizations();
    // Auto-sweep disabled — admin-only via admin panel
    // await this.processPendingSweeps();
    this.pollPendingIchorShower();
    this.periodicRentReclaim();
  }

  private async getOnchainAdminHealth(): Promise<OnchainAdminHealth> {
    const now = Date.now();
    if (now - this.onchainAdminHealth.checkedAt < ONCHAIN_ADMIN_HEALTH_CHECK_MS) {
      return this.onchainAdminHealth;
    }

    const signerPubkey = getAdminSignerPublicKey();
    if (!signerPubkey) {
      this.onchainAdminHealth = {
        checkedAt: now,
        ready: false,
        reason: "Missing SOLANA_DEPLOYER_KEYPAIR or SOLANA_DEPLOYER_KEYPAIR_PATH",
        signerPubkey: null,
        rumbleAdmin: null,
      };
      return this.onchainAdminHealth;
    }

    const cfg = await readRumbleConfig().catch(() => null);
    const rumbleAdminRaw = cfg?.admin;
    const rumbleAdmin =
      typeof rumbleAdminRaw === "string"
        ? rumbleAdminRaw
        : (rumbleAdminRaw as any)?.toBase58?.() ?? null;
    if (rumbleAdmin && signerPubkey !== rumbleAdmin) {
      this.onchainAdminHealth = {
        checkedAt: now,
        ready: false,
        reason: `Admin signer mismatch (signer=${signerPubkey}, onchain=${rumbleAdmin})`,
        signerPubkey,
        rumbleAdmin,
      };
      return this.onchainAdminHealth;
    }

    this.onchainAdminHealth = {
      checkedAt: now,
      ready: true,
      reason: null,
      signerPubkey,
      rumbleAdmin,
    };
    return this.onchainAdminHealth;
  }

  private resolveSlotIndexForRumble(rumbleId: string): number | null {
    const slot = this.queueManager.getSlots().find((entry) => entry.id === rumbleId);
    return slot ? slot.slotIndex : null;
  }

  private trimMap<K, V>(map: Map<K, V>): void {
    if (map.size <= MAX_MAP_SIZE) return;
    for (const key of map.keys()) {
      if (map.size <= MAX_MAP_SIZE) break;
      map.delete(key);
    }
  }

  private trimSet(set: Set<string>): void {
    if (set.size <= MAX_MAP_SIZE) return;
    for (const key of set) {
      if (set.size <= MAX_MAP_SIZE) break;
      set.delete(key);
    }
  }

  private trimTrackingMaps(): void {
    this.trimMap(this.settledRumbleIds);
    this.trimSet(this.settlingRumbleIds);
    this.trimMap(this.pendingFinalizations);
    this.trimMap(this.pendingSweeps);
    this.trimMap(this.onchainRumbleCreateRetryAt);
    this.trimMap(this.onchainRumbleCreateStartedAt);
    this.trimMap(this.onchainRumbleCreateLastError);
    this.trimSet(this.payoutProcessed);
  }

  private recordOnchainCreateFailure(
    rumbleId: string,
    reason: string,
    fighterCount: number,
    slotIndex: number | null,
  ): void {
    const now = Date.now();
    const existing = this.onchainRumbleCreateLastError.get(rumbleId);
    const nextRetryAt = this.onchainRumbleCreateRetryAt.get(rumbleId) ?? null;

    this.onchainRumbleCreateLastError.set(rumbleId, {
      rumbleId,
      slotIndex,
      fighterCount,
      attempts: (existing?.attempts ?? 0) + 1,
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: now,
      reason,
      nextRetryAt,
    });
    this.trimTrackingMaps();
  }

  private clearOnchainCreateFailure(rumbleId: string): void {
    this.onchainRumbleCreateLastError.delete(rumbleId);
  }

  getRuntimeHealth(): {
    onchainAdmin: OnchainAdminHealth;
    onchainCreateFailures: Array<{
      rumbleId: string;
      slotIndex: number | null;
      fighterCount: number;
      attempts: number;
      firstSeenAt: string;
      lastSeenAt: string;
      reason: string;
      nextRetryAt: string | null;
    }>;
  } {
    const onchainCreateFailures = [...this.onchainRumbleCreateLastError.values()]
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .slice(0, 8)
      .map((entry) => ({
        rumbleId: entry.rumbleId,
        slotIndex: entry.slotIndex,
        fighterCount: entry.fighterCount,
        attempts: entry.attempts,
        firstSeenAt: new Date(entry.firstSeenAt).toISOString(),
        lastSeenAt: new Date(entry.lastSeenAt).toISOString(),
        reason: entry.reason,
        nextRetryAt: entry.nextRetryAt ? new Date(entry.nextRetryAt).toISOString() : null,
      }));

    return {
      onchainAdmin: { ...this.onchainAdminHealth },
      onchainCreateFailures,
    };
  }

  private getHouseBotTargetPopulation(): number {
    return this.houseBotTargetPopulationOverride ?? HOUSE_BOT_TARGET_POPULATION;
  }

  private async removeQueuedHouseBots(): Promise<number> {
    const queueEntries = this.queueManager.getQueueEntries();
    let removedCount = 0;
    for (const entry of queueEntries) {
      const fighterId = entry.fighterId;
      if (!this.houseBotSet.has(fighterId)) continue;
      const removed = this.queueManager.removeFromQueue(fighterId);
      if (!removed) continue;
      removedCount += 1;
      await persist.removeQueueFighter(fighterId);
    }
    return removedCount;
  }

  /**
   * Keep "house bots" queued to fill rumbles.
   *
   * Behavior:
   * - Fill house bots up to TARGET_POPULATION minus real fighters present.
   * - Real fighters count toward the target, so house bots fill remaining slots.
   * - If more house bots than needed, remove excess from queue.
   */
  private async maintainHouseBotQueue(): Promise<void> {
    if (!HOUSE_BOTS_ENABLED) return;
    if (this.houseBotsPaused) return;
    if (!HOUSE_BOTS_AUTO_FILL) {
      // Don't auto-fill, but don't remove manually-queued bots either
      return;
    }

    const slots = this.queueManager.getSlots();
    const queueEntries = this.queueManager.getQueueEntries();
    const queuedIds = queueEntries.map((entry) => entry.fighterId);
    const queuedSet = new Set(queuedIds);
    const activeSet = new Set(
      slots
        .filter((slot) => slot.state !== "idle")
        .flatMap((slot) => slot.fighters),
    );

    const presentIds = new Set<string>([...queuedIds, ...activeSet]);

    // When real fighters are present, fill remaining slots with house bots
    // instead of draining all bots (which starves the queue).
    const realCount = [...presentIds].filter((id) => !this.houseBotSet.has(id)).length;
    const houseCount = [...presentIds].filter((id) => this.houseBotSet.has(id)).length;
    const target = this.getHouseBotTargetPopulation();
    // Fill up to target minus real fighters already present
    const desiredHouseBots = Math.max(0, target - realCount);
    const missing = Math.max(0, desiredHouseBots - houseCount);

    // Remove excess queued house bots if we have more than needed
    if (houseCount > desiredHouseBots) {
      const excess = houseCount - desiredHouseBots;
      const queuedHouseBots = queuedIds.filter((id) => this.houseBotSet.has(id));
      for (let i = 0; i < Math.min(excess, queuedHouseBots.length); i++) {
        this.queueManager.removeFromQueue(queuedHouseBots[i]);
        await persist.removeQueueFighter(queuedHouseBots[i]);
      }
      return;
    }

    if (missing === 0) return;

    const walletMap = await persist.lookupFighterWallets(this.houseBotIds);
    let added = 0;
    for (const fighterId of this.houseBotIds) {
      if (added >= missing) break;
      if (queuedSet.has(fighterId) || activeSet.has(fighterId)) continue;
      const wallet = walletMap.get(fighterId);
      if (!wallet) {
        if (!this.warnedInvalidHouseBotIds.has(fighterId)) {
          this.warnedInvalidHouseBotIds.add(fighterId);
          console.warn(`[HouseBots] Skipping ${fighterId}: missing wallet_address`);
        }
        continue;
      }
      try {
        void new PublicKey(wallet);
      } catch {
        if (!this.warnedInvalidHouseBotIds.has(fighterId)) {
          this.warnedInvalidHouseBotIds.add(fighterId);
          console.warn(`[HouseBots] Skipping ${fighterId}: invalid wallet_address (${wallet})`);
        }
        continue;
      }
      try {
        this.queueManager.addToQueue(fighterId, false);
        await persist.saveQueueFighter(fighterId, "waiting", false);
        queuedSet.add(fighterId);
        added += 1;
      } catch (err) {
        console.warn(`[HouseBots] Failed to queue ${fighterId}: ${formatError(err)}`);
      }
    }
  }

  async restartHouseBots(): Promise<{ removedQueuedHouseBots: number; restartedAt: string }> {
    const removedQueuedHouseBots = await this.removeQueuedHouseBots();
    this.houseBotsPaused = false;
    this.houseBotsLastRestartAt = new Date().toISOString();
    await persist.setAdminConfig("house_bots_paused", false);
    return {
      removedQueuedHouseBots,
      restartedAt: this.houseBotsLastRestartAt,
    };
  }

  async pauseHouseBots(): Promise<{ removedQueuedHouseBots: number }> {
    this.houseBotsPaused = true;
    await persist.setAdminConfig("house_bots_paused", true);
    const removedQueuedHouseBots = await this.removeQueuedHouseBots();
    return { removedQueuedHouseBots };
  }

  async resumeHouseBots(): Promise<void> {
    this.houseBotsPaused = false;
    await persist.setAdminConfig("house_bots_paused", false);
  }

  /**
   * Manually queue N house bots for a test run. Bypasses auto-fill gating.
   * Returns the list of fighter IDs actually queued.
   */
  async queueHouseBotsManually(count: number): Promise<{ queued: string[]; skipped: string[] }> {
    const target = Math.max(1, Math.min(this.houseBotIds.length, count));
    const slots = this.queueManager.getSlots();
    const queueEntries = this.queueManager.getQueueEntries();
    const queuedSet = new Set(queueEntries.map((e) => e.fighterId));
    const activeSet = new Set(
      slots.filter((s) => s.state !== "idle").flatMap((s) => s.fighters),
    );

    const walletMap = await persist.lookupFighterWallets(this.houseBotIds);
    const queued: string[] = [];
    const skipped: string[] = [];

    for (const fighterId of this.houseBotIds) {
      if (queued.length >= target) break;
      if (queuedSet.has(fighterId) || activeSet.has(fighterId)) {
        skipped.push(fighterId);
        continue;
      }
      const wallet = walletMap.get(fighterId);
      if (!wallet) { skipped.push(fighterId); continue; }
      try {
        void new PublicKey(wallet);
      } catch {
        skipped.push(fighterId);
        continue;
      }
      try {
        this.queueManager.addToQueue(fighterId, false);
        await persist.saveQueueFighter(fighterId, "waiting", false);
        queuedSet.add(fighterId);
        queued.push(fighterId);
      } catch {
        skipped.push(fighterId);
      }
    }
    return { queued, skipped };
  }

  /** Returns the configured house bot IDs. */
  getHouseBotIds(): string[] {
    return [...this.houseBotIds];
  }

  setHouseBotTargetPopulation(target: number | null): number {
    if (target === null) {
      this.houseBotTargetPopulationOverride = null;
      return this.getHouseBotTargetPopulation();
    }
    const safe = Math.max(0, Math.min(64, Math.floor(target)));
    this.houseBotTargetPopulationOverride = safe;
    return safe;
  }

  getHouseBotControlStatus(): {
    configuredEnabled: boolean;
    configuredAutoFill: boolean;
    configuredHouseBotCount: number;
    paused: boolean;
    targetPopulation: number;
    targetPopulationSource: "env" | "runtime_override";
    lastRestartAt: string | null;
  } {
    return {
      configuredEnabled: HOUSE_BOTS_ENABLED,
      configuredAutoFill: HOUSE_BOTS_AUTO_FILL,
      configuredHouseBotCount: this.houseBotIds.length,
      paused: this.houseBotsPaused,
      targetPopulation: this.getHouseBotTargetPopulation(),
      targetPopulationSource: this.houseBotTargetPopulationOverride === null ? "env" : "runtime_override",
      lastRestartAt: this.houseBotsLastRestartAt,
    };
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
    this.trimTrackingMaps();
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
          void persistWithRetry(
            () => persist.updateRumbleTxSignature(entry.rumbleId, "completeRumble", completeSig),
            `updateRumbleTxSignature:completeRumble:${entry.rumbleId}`,
          );
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

    // 2) Complete rumble on mainnet (fire-and-forget — don't block devnet finalization)
    void (async () => {
      try {
        await persistMainnetOp({
          rumbleId: entry.rumbleId,
          opType: "completeRumble",
          payload: { rumbleIdNum: entry.rumbleIdNum },
        });
        const mainnetSig = await completeRumbleMainnet(entry.rumbleIdNum);
        if (mainnetSig) {
          console.log(`[OnChain:Mainnet] completeRumble succeeded: ${mainnetSig}`);
          await markOpComplete(entry.rumbleId, "completeRumble", mainnetSig);
        } else {
          await markOpFailed(entry.rumbleId, "completeRumble", "completeRumbleMainnet returned null");
          console.warn(
            `[OnChain:Mainnet] completeRumble returned null for ${entry.rumbleId}`,
          );
        }
      } catch (err) {
        console.warn(`[OnChain:Mainnet] completeRumble error (non-blocking):`, err);
        await markOpFailed(entry.rumbleId, "completeRumble", formatError(err));
      }
    })();

    // NOTE: Auto-sweep disabled — sweep_treasury is admin-only now.
    // Users can claim payouts indefinitely; admin can sweep manually via admin panel.

    // 3) Reclaim rent from MoveCommitment PDAs (~1.46 SOL per rumble, fire-and-forget)
    try {
      const [fighters, combat] = await Promise.all([
        readRumbleFighters(entry.rumbleIdNum),
        readRumbleCombatState(entry.rumbleIdNum),
      ]);
      const totalTurns = combat?.currentTurn ?? 0;
      if (fighters.length > 0 && totalTurns > 0) {
        for (let turn = 1; turn <= totalTurns; turn++) {
          for (const fighter of fighters) {
            // Return rent to the fighter, not the admin
            closeMoveCommitmentOnChain(entry.rumbleIdNum, fighter, turn, fighter).catch(() => {});
          }
        }
        console.log(
          `[OnChain] queued ${fighters.length * totalTurns} MoveCommitment closures for rumble ${entry.rumbleId} (rent → fighters)`,
        );
      }
    } catch (e) {
      console.warn(`[OnChain] failed to queue MoveCommitment closures: ${e}`);
    }

    this.pendingFinalizations.delete(entry.rumbleId);
    console.log(`[OnChain] finalization complete for ${entry.rumbleId}`);
  }

  // ---------------------------------------------------------------------------
  // Vault Sweep — auto-sweep when no bettors can claim
  // ---------------------------------------------------------------------------

  /**
   * Read the mainnet on-chain state to determine if anyone bet on the winner.
   * If bettingPools[winnerIndex] == 0, nobody can call claim_payout, so the
   * vault is safe to sweep immediately (once the 24h on-chain window passes).
   * Confirms via BOTH on-chain state and the DB to be doubly sure.
   */
  private async checkAndEnqueueSweep(rumbleId: string, rumbleIdNum: number): Promise<void> {
    // Read mainnet on-chain state (where the real SOL lives)
    let noWinnerBets = false;
    try {
      const bettingConn = getBettingConnection();
      const mainnetState = await readRumbleAccountState(
        rumbleIdNum,
        bettingConn,
        RUMBLE_ENGINE_ID_MAINNET,
      ).catch(() => null);

      if (mainnetState && mainnetState.winnerIndex !== null && mainnetState.winnerIndex !== undefined) {
        const winnerPool = mainnetState.bettingPools[mainnetState.winnerIndex] ?? 0n;
        const totalDeployed = mainnetState.totalDeployedLamports ?? 0n;

        if (totalDeployed > 0n && winnerPool === 0n) {
          // Double-confirm via DB: check if any bets exist for the winner
          const dbBets = await persist.loadBetsForRumble(rumbleId).catch(() => []);
          // Find the winner fighter ID from DB
          const rumbleRecord = await persist.loadRumbleById(rumbleId).catch(() => null);
          const winnerId = (rumbleRecord as any)?.winner_id ?? null;

          let dbWinnerBets = 0;
          if (winnerId && dbBets.length > 0) {
            dbWinnerBets = dbBets.filter(
              (b: any) => String(b.fighter_id) === String(winnerId),
            ).length;
          }

          if (dbWinnerBets === 0) {
            noWinnerBets = true;
            console.log(
              `[Sweep] Rumble ${rumbleId}: NO bets on winner (winnerIdx=${mainnetState.winnerIndex}, ` +
              `winnerPool=0, totalDeployed=${totalDeployed}, dbWinnerBets=0). ` +
              `Queuing auto-sweep.`,
            );
          } else {
            console.log(
              `[Sweep] Rumble ${rumbleId}: on-chain winnerPool=0 but DB shows ${dbWinnerBets} winner bets — skipping auto-sweep (mismatch)`,
            );
          }
        } else if (totalDeployed === 0n) {
          console.log(`[Sweep] Rumble ${rumbleId}: no bets placed at all, nothing to sweep`);
          return;
        } else {
          console.log(
            `[Sweep] Rumble ${rumbleId}: winner has bets (pool=${winnerPool}). Queuing delayed sweep after claim window.`,
          );
        }
      } else {
        console.log(`[Sweep] Rumble ${rumbleId}: could not read mainnet state or no winner — queuing delayed sweep`);
      }
    } catch (err) {
      console.warn(`[Sweep] Failed to read mainnet state for ${rumbleId}:`, formatError(err));
    }

    // For no-winner-bets: try sweeping after a short delay (the on-chain 24h window
    // still applies, but we retry periodically). For normal cases: sweep after 24h+.
    const SWEEP_NO_WINNERS_DELAY_MS = 60_000; // retry every 60s for no-winner case
    const SWEEP_NORMAL_DELAY_MS = 24 * 60 * 60 * 1_000 + 120_000; // 24h + 2min buffer

    this.pendingSweeps.set(rumbleId, {
      rumbleId,
      rumbleIdNum,
      sweepAfter: Date.now() + (noWinnerBets ? SWEEP_NO_WINNERS_DELAY_MS : SWEEP_NORMAL_DELAY_MS),
      attempts: 0,
      noWinnerBets,
    });
  }

  private async processPendingSweeps(): Promise<void> {
    if (this.pendingSweeps.size === 0) return;
    const now = Date.now();
    const due = [...this.pendingSweeps.values()].filter((s) => s.sweepAfter <= now);
    if (due.length === 0) return;

    for (const sweep of due) {
      sweep.attempts += 1;
      const MAX_SWEEP_ATTEMPTS = 10;

      try {
        await persistMainnetOp({
          rumbleId: sweep.rumbleId,
          opType: "sweepTreasury",
          payload: { rumbleIdNum: sweep.rumbleIdNum },
        });
        // Try mainnet sweep first (where real SOL is)
        const mainnetSig = await sweepTreasuryMainnet(sweep.rumbleIdNum);
        if (mainnetSig) {
          console.log(
            `[Sweep] Mainnet vault swept for ${sweep.rumbleId}: ${mainnetSig}` +
            (sweep.noWinnerBets ? " (no winner bets — auto-sweep)" : ""),
          );
          await markOpComplete(sweep.rumbleId, "sweepTreasury", mainnetSig);
        } else {
          await markOpFailed(sweep.rumbleId, "sweepTreasury", "sweepTreasuryMainnet returned null");
        }

        // Also sweep devnet vault
        sweepTreasuryDevnet(sweep.rumbleIdNum)
          .then((devnetSig) => {
            if (devnetSig) {
              console.log(`[Sweep] Devnet vault swept for ${sweep.rumbleId}: ${devnetSig}`);
              void persistWithRetry(
                () => persist.updateRumbleTxSignature(sweep.rumbleId, "sweepTreasury_devnet", devnetSig),
                `updateRumbleTxSignature:sweepTreasury_devnet:${sweep.rumbleId}`,
              );
            }
          })
          .catch(() => {}); // devnet sweep is best-effort

        this.pendingSweeps.delete(sweep.rumbleId);
      } catch (err) {
        await markOpFailed(sweep.rumbleId, "sweepTreasury", formatError(err));
        const msg = formatError(err);
        if (msg.includes("ClaimWindowActive")) {
          // On-chain 24h window hasn't passed yet — retry later
          const retryMs = sweep.noWinnerBets ? 5 * 60_000 : 30 * 60_000;
          sweep.sweepAfter = now + retryMs;
          console.log(
            `[Sweep] ClaimWindowActive for ${sweep.rumbleId}, retrying in ${retryMs / 60_000}min` +
            (sweep.noWinnerBets ? " (no winner bets)" : ""),
          );
        } else if (sweep.attempts >= MAX_SWEEP_ATTEMPTS) {
          console.error(`[Sweep] Giving up on ${sweep.rumbleId} after ${MAX_SWEEP_ATTEMPTS} attempts: ${msg}`);
          this.pendingSweeps.delete(sweep.rumbleId);
        } else {
          sweep.sweepAfter = now + 60_000;
          console.warn(`[Sweep] Retry ${sweep.attempts}/${MAX_SWEEP_ATTEMPTS} for ${sweep.rumbleId}: ${msg}`);
        }
      }
    }
  }

  /** Every 30 min, batch complete+close eligible mainnet rumble accounts to reclaim rent. */
  private periodicRentReclaim(): void {
    const RENT_RECLAIM_INTERVAL_MS = 30 * 60_000;
    const now = Date.now();
    if (now - this.lastRentReclaimAt < RENT_RECLAIM_INTERVAL_MS) return;
    this.lastRentReclaimAt = now;

    reclaimMainnetRumbleRent()
      .then(({ completed, closed, reclaimedLamports }) => {
        if (completed > 0 || closed > 0) {
          console.log(
            `[RentReclaim] completed=${completed} closed=${closed} reclaimed=${(reclaimedLamports / 1e9).toFixed(6)} SOL`,
          );
        }
      })
      .catch((err) => {
        console.warn(`[RentReclaim] batch reclaim failed:`, (err as Error).message?.slice(0, 100));
      });
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
          await this.handlePayoutPhase(slot);
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
    const rumbleId = slot.id;
    const now = Date.now();

    if (!this.onchainRumbleCreateStartedAt.has(rumbleId)) {
      this.onchainRumbleCreateStartedAt.set(rumbleId, now);
      this.trimTrackingMaps();
    }

    const slotWalletsValid = await this.ensureSlotFighterWalletsValid(slot);
    if (!slotWalletsValid) {
      return;
    }

    // Create betting pool if we don't have one for this rumble
    if (!this.bettingPools.has(idx) || this.bettingPools.get(idx)!.rumbleId !== slot.id) {
      const pool = createBettingPool(slot.id);
      this.bettingPools.set(idx, pool);

      // Persist: create rumble record BEFORE betting window opens (FK constraint)
      // Must be awaited so the ucf_rumbles row exists before any bet can reference it.
      await persist.createRumbleRecord({
        id: slot.id,
        slotIndex: idx,
        fighters: slot.fighters.map((id) => ({ id, name: id })),
      });
      for (const fid of slot.fighters) {
        persist.saveQueueFighter(fid, "in_combat");
      }
    }

    // Keep trying to materialize the on-chain rumble account during betting.
    // A transient failure on the first create attempt must not leave the slot
    // permanently unbettable.
    const retryAt = this.onchainRumbleCreateRetryAt.get(rumbleId) ?? 0;
    if (now < retryAt) return;

    const targetBettingDeadlineUnix = Math.floor((Date.now() + ONCHAIN_BETTING_DURATION_MS) / 1000);
    const createdOrExists = await this.ensureOnchainRumbleExists(
      rumbleId,
      slot.fighters,
      targetBettingDeadlineUnix,
    );
    // Mainnet is best-effort — don't block devnet fights if mainnet wallet is broke
    if (createdOrExists) {
      this.ensureMainnetRumbleExists(
        rumbleId,
        slot.fighters,
        targetBettingDeadlineUnix,
      ).catch((err) => console.warn(`[OnChain:Mainnet] ensureMainnetRumbleExists non-blocking error:`, err));
    }
    if (createdOrExists) {
      this.onchainRumbleCreateRetryAt.delete(rumbleId);
      this.onchainRumbleCreateStartedAt.delete(rumbleId);
      this.clearOnchainCreateFailure(rumbleId);
      await this.armBettingWindowIfReady(slot);
    } else {
      this.onchainRumbleCreateRetryAt.set(rumbleId, now + ONCHAIN_CREATE_RETRY_MS);
      this.trimTrackingMaps();
      const startedAt = this.onchainRumbleCreateStartedAt.get(rumbleId) ?? now;
      if (ABORT_STALLED_BETTING && now - startedAt >= ONCHAIN_CREATE_STALL_TIMEOUT_MS) {
        await this.abortStalledBettingSlot(slot, "on-chain rumble creation timed out");
      }
    }
  }

  /**
   * Public self-heal entrypoint for APIs that need a signable on-chain bet tx.
   * Ensures the current betting slot's on-chain rumble exists.
   */
  async ensureOnchainRumbleForSlot(slotIndex: number): Promise<boolean> {
    const slot = this.queueManager.getSlot(slotIndex);
    if (!slot || slot.state !== "betting") return false;
    const targetBettingDeadlineUnix = Math.floor((Date.now() + ONCHAIN_BETTING_DURATION_MS) / 1000);
    const exists = await this.ensureOnchainRumbleExists(
      slot.id,
      slot.fighters,
      targetBettingDeadlineUnix,
    );
    // Mainnet is best-effort — don't block devnet fights if mainnet wallet is broke
    if (exists) {
      this.ensureMainnetRumbleExists(
        slot.id,
        slot.fighters,
        targetBettingDeadlineUnix,
      ).catch((err) => console.warn(`[OnChain:Mainnet] ensureMainnetRumbleExists non-blocking error:`, err));
      await this.armBettingWindowIfReady(slot);
    }
    return exists;
  }

  private async armBettingWindowIfReady(slot: RumbleSlot): Promise<void> {
    if (slot.state !== "betting" || slot.bettingDeadline) return;
    const rumbleIdNum = parseOnchainRumbleIdNumber(slot.id);
    let deadline: Date | undefined;
    if (rumbleIdNum !== null) {
      // Try mainnet first, fall back to devnet if mainnet unavailable
      invalidateReadCache(`rumble:mainnet:${rumbleIdNum}`);
      let onchain = await readMainnetRumbleAccountStateResilient(rumbleIdNum, {
        maxPasses: 2,
        retryDelayMs: 100,
      }).catch(() => null);
      if (!onchain) {
        // Mainnet unavailable — fall back to devnet on-chain state
        invalidateReadCache(`rumble:${rumbleIdNum}`);
        onchain = await readRumbleAccountState(rumbleIdNum).catch(() => null);
        if (!onchain) {
          console.warn(`[Orchestrator] armBettingWindowIfReady: neither mainnet nor devnet on-chain state readable for ${slot.id}`);
          return;
        }
        console.log(`[Orchestrator] armBettingWindowIfReady: using devnet on-chain state for ${slot.id} (mainnet unavailable)`);
      }
      if (onchain.state !== "betting") {
        console.warn(`[Orchestrator] armBettingWindowIfReady: on-chain state is "${onchain.state}" (not betting) for ${slot.id}`);
        return;
      }
      const closeRaw = ((onchain as any).bettingCloseSlot ?? onchain.bettingDeadlineTs ?? 0n) as bigint;
      if (closeRaw > 0n) {
        const clusterSlot = await getBettingConnection().getSlot("processed").catch(() => null);
        if (typeof clusterSlot === "number" && Number.isFinite(clusterSlot)) {
          const clusterSlotBig = BigInt(clusterSlot);
          const looksLikeUnix = closeRaw > clusterSlotBig + ONCHAIN_DEADLINE_UNIX_SLOT_GAP_THRESHOLD;
          if (looksLikeUnix) {
            const unixMs = Number(closeRaw) * 1_000;
            if (Number.isFinite(unixMs) && unixMs > 0) {
              // Ensure at least ONCHAIN_BETTING_DURATION_MS remaining
              const remaining = unixMs - Date.now();
              if (remaining < ONCHAIN_BETTING_DURATION_MS * 0.5) {
                // On-chain deadline already partially elapsed — extend to give full window
                deadline = new Date(Date.now() + ONCHAIN_BETTING_DURATION_MS);
                console.log(`[Orchestrator] On-chain deadline partially elapsed (${Math.round(remaining / 1000)}s left), extending to full ${ONCHAIN_BETTING_DURATION_MS / 1000}s window`);
              } else {
                deadline = new Date(unixMs);
              }
            }
          } else {
            const remainingSlots = closeRaw > clusterSlotBig ? closeRaw - clusterSlotBig : 0n;
            const capped = remainingSlots > 1_000_000n ? 1_000_000n : remainingSlots;
            deadline = new Date(Date.now() + Number(capped) * SLOT_MS_ESTIMATE);
          }
        }
      }
      // Fallback: on-chain exists but deadline wasn't parseable — give full window
      if (!deadline) {
        deadline = new Date(Date.now() + ONCHAIN_BETTING_DURATION_MS);
        console.log(`[Orchestrator] On-chain deadline not parseable, using full ${ONCHAIN_BETTING_DURATION_MS / 1000}s window`);
      }
    }

    const armed = this.queueManager.armBettingWindow(slot.slotIndex, deadline);
    if (!armed) return;
    const updated = this.queueManager.getSlot(slot.slotIndex);
    if (!updated?.bettingDeadline) return;

    console.log(`[Orchestrator] Betting window armed for ${slot.id}: deadline=${updated.bettingDeadline.toISOString()}`);
    this.emit("betting_open", {
      slotIndex: slot.slotIndex,
      rumbleId: slot.id,
      fighters: [...slot.fighters],
      deadline: updated.bettingDeadline,
    });
  }

  private async ensureSlotFighterWalletsValid(slot: RumbleSlot): Promise<boolean> {
    if (slot.fighters.length === 0) return false;
    const walletMap = await persist.lookupFighterWallets(slot.fighters);
    const invalid: string[] = [];
    for (const fighterId of slot.fighters) {
      const wallet = walletMap.get(fighterId);
      if (!wallet) {
        invalid.push(fighterId);
        continue;
      }
      try {
        void new PublicKey(wallet);
      } catch {
        invalid.push(fighterId);
      }
    }
    if (invalid.length === 0) return true;
    const invalidSet = new Set(invalid);
    await this.abortStalledBettingSlot(
      slot,
      `invalid fighter wallet(s): ${invalid.slice(0, 3).join(", ")}${invalid.length > 3 ? "..." : ""}`,
      invalidSet,
    );
    return false;
  }

  private async abortStalledBettingSlot(
    slot: RumbleSlot,
    reason: string,
    dropFighterIds: Set<string> = new Set(),
  ): Promise<void> {
    const rumbleId = slot.id;
    const slotIndex = slot.slotIndex;
    const fighters = this.queueManager.abortBettingSlot(slotIndex);

    this.onchainRumbleCreateRetryAt.delete(rumbleId);
    this.onchainRumbleCreateStartedAt.delete(rumbleId);
    this.clearOnchainCreateFailure(rumbleId);
    this.cleanupSlot(slotIndex, rumbleId);

      for (const fighterId of fighters) {
        if (dropFighterIds.has(fighterId)) {
          await persistWithRetry(
            () => persist.removeQueueFighter(fighterId),
            `removeQueueFighter:${fighterId}`,
          );
          continue;
        }
      try {
        this.queueManager.addToQueue(fighterId, false);
        await persist.saveQueueFighter(fighterId, "waiting", false);
      } catch {
        // Ignore duplicates/active-slot conflicts during recovery.
      }
    }

    await persistWithRetry(
      () => persist.updateRumbleStatus(rumbleId, "complete"),
      `updateRumbleStatus:complete:${rumbleId}`,
    );
    console.warn(`[Orchestrator] Recycled stalled betting slot ${slotIndex} (${rumbleId}): ${reason}`);
  }

  /**
   * Abort a combat slot that is stuck due to an unrecoverable on-chain error
   * (e.g. AccountDiscriminatorMismatch after program redeploy).
   * Marks the rumble as complete with no winner and re-queues all fighters.
   */
  private async abortStuckCombat(
    slot: RumbleSlot,
    state: SlotCombatState,
    reason: string,
  ): Promise<void> {
    const rumbleId = slot.id;
    const slotIndex = slot.slotIndex;
    const fighterIds = slot.fighters.slice();

    // Report a no-contest result so the slot transitions normally through payout→idle
    this.queueManager.reportResult(slotIndex, {
      rumbleId,
      fighters: state.fighters,
      turns: [],
      winner: state.fighters[0]?.id ?? "",
      placements: state.fighters.map((f, i) => ({ id: f.id, placement: i + 1 })),
      totalTurns: 0,
    });

    // Persist: mark rumble as complete (no real winner)
    await persistWithRetry(
      () => persist.updateRumbleStatus(rumbleId, "complete"),
      `updateRumbleStatus:complete:${rumbleId}`,
    );

    // Clean up tracking maps
    this.openTurnFatalFailures.delete(rumbleId);
    this.combatStates.delete(slotIndex);

    // Re-queue fighters for next rumble
    for (const fighterId of fighterIds) {
      try {
        this.queueManager.addToQueue(fighterId, false);
        await persist.saveQueueFighter(fighterId, "waiting", false);
      } catch {
        // Ignore duplicates/conflicts during recovery
      }
    }

    console.error(`[Orchestrator] Aborted stuck combat slot ${slotIndex} (${rumbleId}): ${reason}`);
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
    const slotIndex = this.resolveSlotIndexForRumble(rumbleId);
    const rumbleIdNum = parseOnchainRumbleIdNumber(rumbleId);
    if (rumbleIdNum === null) {
      console.warn(`[OnChain] Cannot parse rumbleId "${rumbleId}" for createRumble`);
      this.recordOnchainCreateFailure(
        rumbleId,
        "Could not parse numeric rumble id",
        fighterIds.length,
        slotIndex,
      );
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
          this.recordOnchainCreateFailure(
            rumbleId,
            `Invalid fighter wallet for ${fid}`,
            fighterIds.length,
            slotIndex,
          );
          return false;
        }
      } else {
        console.log(`[OnChain] No wallet for "${fid}", skipping createRumble`);
        this.recordOnchainCreateFailure(
          rumbleId,
          `Missing fighter wallet for ${fid}`,
          fighterIds.length,
          slotIndex,
        );
        return false;
      }
    }

    try {
      const sig = await createRumbleOnChain(rumbleIdNum, fighterPubkeys, bettingDeadlineUnix);
      if (sig) {
        console.log(`[OnChain] createRumble succeeded: ${sig}`);
        void persistWithRetry(
          () => persist.updateRumbleTxSignature(rumbleId, "createRumble", sig),
          `updateRumbleTxSignature:createRumble:${rumbleId}`,
        );
        this.clearOnchainCreateFailure(rumbleId);

        // Also create on mainnet for betting (fire-and-forget — don't block devnet combat)
        void (async () => {
          try {
            await persistMainnetOp({
              rumbleId,
              opType: "createRumble",
              payload: {
                rumbleIdNum,
                fighterWallets: fighterPubkeys.map((value) => value.toBase58()),
                bettingDeadlineUnix,
              },
            });
            const mainnetSig = await createRumbleMainnet(rumbleIdNum, fighterPubkeys, bettingDeadlineUnix);
            if (mainnetSig) {
              console.log(`[OnChain:Mainnet] createRumble succeeded: ${mainnetSig}`);
              await markOpComplete(rumbleId, "createRumble", mainnetSig);
            } else {
              await markOpFailed(rumbleId, "createRumble", "createRumbleMainnet returned null");
              console.warn(`[OnChain:Mainnet] createRumble returned null — mainnet betting unavailable for ${rumbleId}`);
            }
          } catch (err) {
            console.error(`[OnChain:Mainnet] createRumble error (non-blocking):`, err);
            await markOpFailed(rumbleId, "createRumble", formatError(err));
          }
        })();

        return true;
      } else {
        console.warn(`[OnChain] createRumble returned null — continuing off-chain`);
        this.recordOnchainCreateFailure(
          rumbleId,
          "createRumble RPC returned null signature",
          fighterIds.length,
          slotIndex,
        );
        return false;
      }
    } catch (err) {
      console.error(`[OnChain] createRumble error:`, err);
      this.recordOnchainCreateFailure(
        rumbleId,
        formatError(err),
        fighterIds.length,
        slotIndex,
      );
      return false;
    }
  }

  private async ensureOnchainRumbleExists(
    rumbleId: string,
    fighterIds: string[],
    bettingDeadlineUnix: number,
  ): Promise<boolean> {
    const slotIndex = this.resolveSlotIndexForRumble(rumbleId);
    const rumbleIdNum = parseOnchainRumbleIdNumber(rumbleId);
    if (rumbleIdNum === null) {
      this.recordOnchainCreateFailure(
        rumbleId,
        "Could not parse numeric rumble id",
        fighterIds.length,
        slotIndex,
      );
      return false;
    }

    const existing = await readRumbleAccountState(rumbleIdNum).catch(() => null);
    if (existing) {
      this.clearOnchainCreateFailure(rumbleId);
      return true;
    }

    const created = await this.createRumbleOnChain(rumbleId, fighterIds, bettingDeadlineUnix);
    if (!created) return false;
    invalidateReadCache(`rumble:${rumbleIdNum}`);

    let after: Awaited<ReturnType<typeof readRumbleAccountState>> = null;
    for (let attempt = 0; attempt < ONCHAIN_CREATE_VERIFY_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, ONCHAIN_CREATE_VERIFY_BACKOFF_MS * attempt)
        );
      }
      // Invalidate cache before each attempt so we don't re-read a cached null
      invalidateReadCache(`rumble:${rumbleIdNum}`);
      after = await readRumbleAccountState(rumbleIdNum).catch(() => null);
      if (after) break;
    }

    if (!after) {
      this.recordOnchainCreateFailure(
        rumbleId,
        `createRumble sent but PDA still not readable after ${ONCHAIN_CREATE_VERIFY_ATTEMPTS} checks`,
        fighterIds.length,
        slotIndex,
      );
      return false;
    }

    this.clearOnchainCreateFailure(rumbleId);
    return true;
  }

  private async ensureMainnetRumbleExists(
    rumbleId: string,
    fighterIds: string[],
    bettingDeadlineUnix: number,
  ): Promise<boolean> {
    const slotIndex = this.resolveSlotIndexForRumble(rumbleId);
    const rumbleIdNum = parseOnchainRumbleIdNumber(rumbleId);
    if (rumbleIdNum === null) {
      this.recordOnchainCreateFailure(
        rumbleId,
        "Could not parse numeric rumble id for mainnet create",
        fighterIds.length,
        slotIndex,
      );
      return false;
    }

    const existing = await readMainnetRumbleAccountStateResilient(rumbleIdNum, {
      maxPasses: 2,
      retryDelayMs: 100,
    }).catch(() => null);
    if (existing) {
      return true;
    }

    const walletMap = await persist.lookupFighterWallets(fighterIds);
    const fighterPubkeys: PublicKey[] = [];
    for (const fid of fighterIds) {
      const walletAddr = walletMap.get(fid);
      if (!walletAddr) {
        this.recordOnchainCreateFailure(
          rumbleId,
          `Missing fighter wallet for ${fid} (mainnet create)`,
          fighterIds.length,
          slotIndex,
        );
        return false;
      }
      try {
        fighterPubkeys.push(new PublicKey(walletAddr));
      } catch {
        this.recordOnchainCreateFailure(
          rumbleId,
          `Invalid fighter wallet for ${fid} (mainnet create)`,
          fighterIds.length,
          slotIndex,
        );
        return false;
      }
    }

    try {
      const sig = await createRumbleMainnet(rumbleIdNum, fighterPubkeys, bettingDeadlineUnix);
      if (!sig) {
        this.recordOnchainCreateFailure(
          rumbleId,
          "mainnet createRumble RPC returned null signature",
          fighterIds.length,
          slotIndex,
        );
        return false;
      }
      console.log(`[OnChain:Mainnet] createRumble succeeded (self-heal): ${sig}`);
      void persistWithRetry(
        () => persist.updateRumbleTxSignature(rumbleId, "createRumble_mainnet", sig),
        `updateRumbleTxSignature:createRumble_mainnet:${rumbleId}`,
      );
    } catch (err) {
      if (
        this.hasErrorTokenAny(err, [
          "already in use",
          "already initialized",
          "custom program error: 0x0",
        ])
      ) {
        console.log(`[OnChain:Mainnet] createRumble already materialized for ${rumbleId}; continuing`);
      } else {
        this.recordOnchainCreateFailure(
          rumbleId,
          `mainnet createRumble error: ${formatError(err)}`,
          fighterIds.length,
          slotIndex,
        );
        return false;
      }
    }

    invalidateReadCache(`rumble:mainnet:${rumbleIdNum}`);
    let after: Awaited<ReturnType<typeof readMainnetRumbleAccountStateResilient>> = null;
    for (let attempt = 0; attempt < ONCHAIN_CREATE_VERIFY_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, ONCHAIN_CREATE_VERIFY_BACKOFF_MS * attempt)
        );
      }
      invalidateReadCache(`rumble:mainnet:${rumbleIdNum}`);
      after = await readMainnetRumbleAccountStateResilient(rumbleIdNum, {
        maxPasses: 2,
        retryDelayMs: 100,
      }).catch(() => null);
      if (after) break;
    }

    if (!after) {
      this.recordOnchainCreateFailure(
        rumbleId,
        `mainnet createRumble sent but PDA still not readable after ${ONCHAIN_CREATE_VERIFY_ATTEMPTS} checks`,
        fighterIds.length,
        slotIndex,
      );
      return false;
    }

    return true;
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
          void persistWithRetry(
            () => persist.updateRumbleTxSignature(rumbleId, "startCombat", sig),
            `updateRumbleTxSignature:startCombat:${rumbleId}`,
          );
        }
      } catch (err) {
        console.warn(`[OnChain] startCombat (recovery) failed for ${rumbleId}: ${formatError(err)}`);
      }
      invalidateReadCache(`rumble:${rumbleIdNum}`);
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
      Math.floor((Date.now() + ONCHAIN_BETTING_DURATION_MS) / 1000),
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
        void persistWithRetry(
          () => persist.updateRumbleTxSignature(slot.id, "startCombat", sig),
          `updateRumbleTxSignature:startCombat:${slot.id}`,
        );
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
    if (!persisted.ok) {
      return { accepted: false, reason: persisted.reason };
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
    if (ONCHAIN_TURN_AUTHORITY) {
      if (!this.onchainAdminHealth.ready) {
        console.warn(
          `[Orchestrator] Slot ${slot.slotIndex} skipping combat tick — on-chain admin unhealthy, waiting for recovery`,
        );
        return; // Wait for on-chain to recover instead of falling back to unverifiable legacy mode
      }
      await this.handleCombatPhaseOnchain(slot);
      return;
    }
    console.warn("[Orchestrator] RUMBLE_ONCHAIN_TURN_AUTHORITY is false — legacy off-chain mode is deprecated and insecure");
    await this.handleCombatPhaseLegacy(slot);
  }

  private async handleCombatPhaseLegacy(slot: RumbleSlot): Promise<void> {
    const idx = slot.slotIndex;

    // -----------------------------------------------------------------------
    // Cold-start re-initialization: combatStates is empty on every new
    // serverless instance. We init fighters, then RESTORE progress from the
    // persisted turn_log so we don't reset everyone to 100 HP.
    // -----------------------------------------------------------------------
    if (!this.combatStates.has(idx) || this.combatStates.get(idx)!.rumbleId !== slot.id) {
      await this.initCombatState(slot);
      const state = this.combatStates.get(idx)!;

      // Check if this combat already has saved progress in the DB
      const savedTurnLog = await persist.loadRumbleTurnLog(slot.id);
      if (savedTurnLog && savedTurnLog.length > 0) {
        // COLD-START RESUME: Replay saved turns to reconstruct fighter state
        this.replaySavedTurns(state, savedTurnLog as RumbleTurn[]);
        console.log(
          `[Orchestrator] Slot ${idx} resumed combat from turn ${state.turns.length} ` +
            `(${state.fighters.filter(f => f.hp > 0).length} alive)`,
        );
      } else {
        // FRESH COMBAT: First time entering combat for this rumble
        const pool = this.bettingPools.get(idx);
        if (pool) {
          this.emit("betting_closed", {
            slotIndex: idx,
            rumbleId: slot.id,
            odds: calculateOdds(pool),
          });
        }

        // Persist status (also sets started_at) — AWAITED
        await persist.updateRumbleStatus(slot.id, "combat");

        // On-chain: start combat with 4s budget. If it fails, the on-chain
        // tick loop (lines ~1957-1963) will detect state=betting and retry.
        try {
          await Promise.race([
            this.startCombatOnChain(slot),
            new Promise<void>((_, reject) => setTimeout(() => reject(new Error("startCombat timeout")), 4_000)),
          ]);
        } catch (err) {
          console.warn(`[OnChain] startCombat initial attempt failed for ${slot.id}, will retry on next tick:`, err);
          // Not fatal — the on-chain tick loop self-heals by detecting betting state
        }

        // Request VRF matchup seed (fire-and-forget for fairness audit trail)
        const rumbleIdNumOffchain = parseOnchainRumbleIdNumber(slot.id);
        if (rumbleIdNumOffchain !== null) {
          requestMatchupSeed(rumbleIdNumOffchain).catch((err) => {
            console.warn(`[VRF] requestMatchupSeed failed for rumble ${slot.id}:`, err);
          });
        }

        this.emit("combat_started", {
          slotIndex: idx,
          rumbleId: slot.id,
          fighters: [...slot.fighters],
        });
      }
    }

    const state = this.combatStates.get(idx)!;

    // -----------------------------------------------------------------------
    // Run as many turns as the serverless budget allows.
    // Each turn still goes through requestFighterMove (webhooks / commit-
    // reveal for AI agents; instant fallback for bots). Per-turn persistence
    // is AWAITED so progress survives if the function is killed mid-combat.
    // On the next cold start, we resume from the last persisted turn.
    // -----------------------------------------------------------------------
    const BUDGET_RESERVE_MS = 2_000; // stop 2s before maxDuration
    const budgetDeadline = this.tickStartedAt + (MAX_DURATION_MS - BUDGET_RESERVE_MS);
    let turnsThisInvocation = 0;

    while (state.fighters.filter(f => f.hp > 0).length > 1) {
      if (Date.now() > budgetDeadline) {
        console.log(
          `[Orchestrator] Slot ${idx} pausing combat after ${turnsThisInvocation} turns (budget exhausted)`,
        );
        break;
      }
      await this.runCombatTurn(slot, state);
      turnsThisInvocation++;
      // runCombatTurn calls finishCombat when remaining <= 1
    }
  }

  /**
   * Replay saved turns from DB onto freshly-initialized combat fighters.
   * Reconstructs HP, damage stats, eliminations, and turn history so the
   * combat can resume from the correct state after a serverless cold start.
   */
  private replaySavedTurns(state: SlotCombatState, savedTurns: RumbleTurn[]): void {
    const fighterMap = new Map(state.fighters.map(f => [f.id, f]));

    for (const turn of savedTurns) {
      // Apply damage from each pairing
      for (const p of turn.pairings) {
        const fA = fighterMap.get(p.fighterA);
        const fB = fighterMap.get(p.fighterB);
        if (fA) {
          fA.hp = Math.max(0, fA.hp - p.damageToA);
          fA.totalDamageDealt += p.damageToB;
          fA.totalDamageTaken += p.damageToA;
        }
        if (fB) {
          fB.hp = Math.max(0, fB.hp - p.damageToB);
          fB.totalDamageDealt += p.damageToA;
          fB.totalDamageTaken += p.damageToB;
        }
      }

      // Mark eliminations
      for (const elimId of turn.eliminations) {
        const f = fighterMap.get(elimId);
        if (f && f.eliminatedOnTurn === null) {
          f.eliminatedOnTurn = turn.turnNumber;
          state.eliminationOrder.push(elimId);
        }
      }

      // Build pairing tracking for duplicate avoidance
      const pairingSet = new Set<string>();
      for (const p of turn.pairings) {
        const key = p.fighterA < p.fighterB
          ? `${p.fighterA}:${p.fighterB}`
          : `${p.fighterB}:${p.fighterA}`;
        pairingSet.add(key);
      }
      state.previousPairings = pairingSet;
    }

    // Restore turn history
    state.turns = savedTurns;
  }

  private async handleCombatPhaseOnchain(slot: RumbleSlot): Promise<void> {
    const idx = slot.slotIndex;
    const now = Date.now();
    const rumbleIdNum = parseOnchainRumbleIdNumber(slot.id);
    if (rumbleIdNum === null) return;

    // Initialize local state and start on-chain combat if needed.
    // On cold starts (new serverless instance) combatStates is empty, so we
    // re-init and then FALL THROUGH to the combat processing below instead
    // of returning early — this prevents a one-tick stall per cold start.
    let justInitialized = false;
    if (!this.combatStates.has(idx) || this.combatStates.get(idx)!.rumbleId !== slot.id) {
      await this.initCombatState(slot);

      const pool = this.bettingPools.get(idx);
      if (pool) {
        this.emit("betting_closed", {
          slotIndex: idx,
          rumbleId: slot.id,
          odds: calculateOdds(pool),
        });
      }

      try {
        await persist.updateRumbleStatus(slot.id, "combat");
      } catch (err) {
        console.error(`[Orchestrator] Failed to persist combat status for rumble ${slot.id}:`, err);
        return;
      }
      await this.startCombatOnChain(slot);

      // Delegate combat state to Ephemeral Rollup for real-time execution
      if (this.erEnabled) {
        try {
          const sig = await delegateCombatToEr(rumbleIdNum);
          if (sig) {
            console.log(`[ER] delegateCombat succeeded for rumble ${rumbleIdNum}: ${sig}`);
          }
        } catch (err) {
          console.warn(`[ER] delegateCombat failed for rumble ${rumbleIdNum}, falling back to L1:`, err);
        }
      }

      // Request VRF matchup seed for provably-fair fighter pairing
      try {
        const vrfSig = await requestMatchupSeed(rumbleIdNum);
        if (vrfSig) {
          console.log(`[VRF] requestMatchupSeed succeeded for rumble ${rumbleIdNum}: ${vrfSig}`);
        } else {
          console.warn(`[VRF] requestMatchupSeed returned null for rumble ${rumbleIdNum} — continuing with slot-hash RNG`);
        }
      } catch (err) {
        console.warn(`[VRF] requestMatchupSeed failed for rumble ${rumbleIdNum}, falling back to slot-hash RNG:`, err);
      }

      this.emit("combat_started", {
        slotIndex: idx,
        rumbleId: slot.id,
        fighters: [...slot.fighters],
      });
      justInitialized = true;
      // Fall through — proceed to combat processing in same tick
    }

    const state = this.combatStates.get(idx)!;
    if (!justInitialized) {
      if (now - state.lastTickAt < ONCHAIN_KEEPER_POLL_INTERVAL_MS) return;
    }
    state.lastTickAt = now;

    let onchainState = await readRumbleAccountState(rumbleIdNum).catch(() => null);
    if (!onchainState) return;

    if (onchainState.state === "betting") {
      await this.startCombatOnChain(slot);
      return;
    }

    if (onchainState.state === "payout" || onchainState.state === "complete") {
      await this.finishCombatFromOnchain(slot, state, rumbleIdNum);
      return;
    }

    let combat = await readRumbleCombatState(rumbleIdNum, this.getCombatConnection()).catch(() => null);
    if (!combat) return;

    const sync = this.syncLocalFightersFromOnchain(slot, state, combat);
    if (combat.turnResolved && combat.currentTurn > state.lastOnchainTurnResolved) {
      // Build pairings from on-chain data: derive who fought whom, look up
      // moves from turnDecisions, and compute per-fighter damage deltas.
      const turnPairings: RumblePairing[] = [];
      const turnNum = combat.currentTurn;
      const pairs = this.deriveOnchainPairings(slot, state, combat, rumbleIdNum);
      const decisions = state.turnDecisions.get(turnNum);
      let bye: string | undefined;

      // Find bye fighter (odd one out)
      const pairedFighters = new Set(pairs.flat());
      for (const f of state.fighters) {
        if (f.hp > 0 && !pairedFighters.has(f.id)) {
          bye = f.id;
          break;
        }
      }

      for (const [fighterA, fighterB] of pairs) {
        const idxA = slot.fighters.indexOf(fighterA);
        const idxB = slot.fighters.indexOf(fighterB);
        const prevDmgA = state.previousDamageTaken.get(fighterA) ?? 0;
        const prevDmgB = state.previousDamageTaken.get(fighterB) ?? 0;
        const curDmgA = Number(combat.totalDamageTaken[idxA] ?? 0n);
        const curDmgB = Number(combat.totalDamageTaken[idxB] ?? 0n);
        const moveA = decisions?.get(fighterA)?.move ?? "MID_STRIKE";
        const moveB = decisions?.get(fighterB)?.move ?? "MID_STRIKE";
        turnPairings.push({
          fighterA,
          fighterB,
          moveA,
          moveB,
          damageToA: Math.max(0, curDmgA - prevDmgA),
          damageToB: Math.max(0, curDmgB - prevDmgB),
        });
      }

      // Update previous damage tracking for next turn
      for (let i = 0; i < slot.fighters.length; i++) {
        state.previousDamageTaken.set(
          slot.fighters[i],
          Number(combat.totalDamageTaken[i] ?? 0n),
        );
      }

      const turn: RumbleTurn = {
        turnNumber: turnNum,
        pairings: turnPairings,
        eliminations: sync.newEliminations,
        bye,
      };
      state.turns.push(turn);
      state.lastOnchainTurnResolved = combat.currentTurn;
      await persist.updateRumbleTurnLog(slot.id, state.turns, state.turns.length);

      this.emit("turn_resolved", {
        slotIndex: idx,
        rumbleId: slot.id,
        turn,
        remainingFighters: combat.remainingFighters,
      });

      // Sync ER state to L1 for spectators
      if (this.erEnabled && combat.turnResolved) {
        commitCombatFromEr(rumbleIdNum).catch((err) =>
          console.warn(`[ER] commitCombat failed for rumble ${rumbleIdNum}:`, err)
        );
      }

      // Close MoveCommitment PDAs for the resolved turn (fire-and-forget).
      // Returns rent to each fighter so wallets don't drain over many rumbles.
      for (const fid of slot.fighters) {
        const wallet = state.fighterWallets.get(fid);
        if (!wallet) continue;
        closeMoveCommitmentOnChain(rumbleIdNum, wallet, turnNum, wallet, this.getCombatConnection()).catch(() => {});
      }

      for (const eliminatedId of sync.newEliminations) {
        this.emit("fighter_eliminated", {
          slotIndex: idx,
          rumbleId: slot.id,
          fighterId: eliminatedId,
          turnNumber: combat.currentTurn,
          remainingFighters: combat.remainingFighters,
        });
      }
    }

    // Open the first turn as soon as combat starts. Some combat accounts can
    // begin with currentTurn=0 and turnResolved=false; gating on turnResolved
    // can deadlock the match at "Waiting for combat to begin...".
    if (combat.currentTurn === 0 && combat.remainingFighters > 1) {
      try {
        const sig = await openTurnOnChain(rumbleIdNum, this.getCombatConnection());
        if (sig) {
          console.log(`[OnChain] openTurn succeeded: ${sig}`);
          void persistWithRetry(
            () => persist.updateRumbleTxSignature(slot.id, "openTurn", sig),
            `updateRumbleTxSignature:openTurn:${slot.id}`,
          );
          this.openTurnFatalFailures.delete(slot.id);
        }
      } catch (err) {
        // Fatal: AccountDiscriminatorMismatch means the on-chain rumble account
        // was created by a different program version. Retrying will never succeed.
        const FATAL_TOKENS = ["accountdiscriminatormismatch", "account discriminator did not match"];
        if (this.hasErrorTokenAny(err, FATAL_TOKENS)) {
          const count = (this.openTurnFatalFailures.get(slot.id) ?? 0) + 1;
          this.openTurnFatalFailures.set(slot.id, count);
          if (count >= 3) {
            console.error(
              `[Orchestrator] Aborting rumble ${slot.id} — on-chain account has stale discriminator ` +
              `(${count} consecutive fatal failures). Fighters will be re-queued.`,
            );
            await this.abortStuckCombat(slot, state, "on-chain account discriminator mismatch (program redeployed)");
            return;
          }
          console.warn(`[OnChain] openTurn fatal failure ${count}/3 for ${slot.id}: ${formatError(err)}`);
        } else if (
          // Idempotent/open-race failures are expected when multiple keepers
          // hit the same turn boundary.
          !this.hasErrorTokenAny(err, [
            "turn already open",
            "turnalreadyopen",
            "already in progress",
            "custom program error: 0x177b",
          ])
        ) {
          console.warn(`[OnChain] openTurn failed for ${slot.id}: ${formatError(err)}`);
        }
      }
      // Re-read combat state after open_turn so we can proceed to
      // commit/reveal/resolve in the same tick cycle.
      invalidateReadCache(`combat:${rumbleIdNum}`);
      combat = await readRumbleCombatState(rumbleIdNum, this.getCombatConnection()).catch(() => null);
      if (!combat || combat.currentTurn === 0) return;
    }

    const currentSlot = await this.getCombatConnection().getSlot("processed");
    const currentSlotBig = BigInt(currentSlot);

    // --- Missed-window recovery ---
    // If the reveal window has passed and the turn is still unresolved, always
    // attempt resolve_turn. This handles serverless cold starts, instance churn,
    // and any gap where the keeper missed the window.
    if (!combat.turnResolved && currentSlotBig >= combat.revealCloseSlot) {
      // Try submitting any remaining moves first (commit/reveal may have been
      // missed on previous instances).
      await this.submitOnchainMovesForTurn(slot, state, combat, rumbleIdNum, currentSlotBig);
      try {
        if (RESOLUTION_MODE === "hybrid") {
          await this.resolveAndPostTurnResult(slot, state, combat, rumbleIdNum);
        } else {
          const commitmentAccounts = await this.collectExistingMoveCommitments(
            state,
            rumbleIdNum,
            combat.currentTurn,
          );
          const sig = await resolveTurnOnChain(rumbleIdNum, commitmentAccounts, this.getCombatConnection());
          if (sig) {
            console.log(`[OnChain] resolveTurn succeeded: ${sig}`);
            void persistWithRetry(
              () => persist.updateRumbleTxSignature(slot.id, "resolveTurn", sig),
              `updateRumbleTxSignature:resolveTurn:${slot.id}`,
            );
          }
        }
      } catch (err) {
        if (
          !this.hasErrorTokenAny(err, [
            "turn already resolved",
            "turnalreadyresolved",
            "custom program error: 0x177d",
          ])
        ) {
          console.warn(`[OnChain] resolveTurn failed for ${slot.id}: ${formatError(err)}`);
        }
      }
      // Re-read to check if resolve succeeded so we can advance in same tick.
      invalidateReadCache(`combat:${rumbleIdNum}`);
      combat = await readRumbleCombatState(rumbleIdNum, this.getCombatConnection()).catch(() => null);
      if (!combat) return;

      // Record the just-resolved turn BEFORE checking remainingFighters.
      // Without this, the final killing-blow turn is never saved to state.turns
      // because the initial read at the top of this function had turnResolved=false.
      if (combat.turnResolved && combat.currentTurn > state.lastOnchainTurnResolved) {
        const syncAfterResolve = this.syncLocalFightersFromOnchain(slot, state, combat);
        const turnPairingsPost: RumblePairing[] = [];
        const turnNumPost = combat.currentTurn;
        const pairsPost = this.deriveOnchainPairings(slot, state, combat, rumbleIdNum);
        const decisionsPost = state.turnDecisions.get(turnNumPost);
        let byePost: string | undefined;

        const pairedFightersPost = new Set(pairsPost.flat());
        for (const f of state.fighters) {
          if (f.hp > 0 && !pairedFightersPost.has(f.id)) {
            byePost = f.id;
            break;
          }
        }

        for (const [fighterA, fighterB] of pairsPost) {
          const idxA = slot.fighters.indexOf(fighterA);
          const idxB = slot.fighters.indexOf(fighterB);
          const prevDmgA = state.previousDamageTaken.get(fighterA) ?? 0;
          const prevDmgB = state.previousDamageTaken.get(fighterB) ?? 0;
          const curDmgA = Number(combat.totalDamageTaken[idxA] ?? 0n);
          const curDmgB = Number(combat.totalDamageTaken[idxB] ?? 0n);
          const moveA = decisionsPost?.get(fighterA)?.move ?? "MID_STRIKE";
          const moveB = decisionsPost?.get(fighterB)?.move ?? "MID_STRIKE";
          turnPairingsPost.push({
            fighterA,
            fighterB,
            moveA,
            moveB,
            damageToA: Math.max(0, curDmgA - prevDmgA),
            damageToB: Math.max(0, curDmgB - prevDmgB),
          });
        }

        for (let i = 0; i < slot.fighters.length; i++) {
          state.previousDamageTaken.set(
            slot.fighters[i],
            Number(combat.totalDamageTaken[i] ?? 0n),
          );
        }

        const turnPost: RumbleTurn = {
          turnNumber: turnNumPost,
          pairings: turnPairingsPost,
          eliminations: syncAfterResolve.newEliminations,
          bye: byePost,
        };
        state.turns.push(turnPost);
        state.lastOnchainTurnResolved = combat.currentTurn;
        await persist.updateRumbleTurnLog(slot.id, state.turns, state.turns.length);

        this.emit("turn_resolved", {
          slotIndex: idx,
          rumbleId: slot.id,
          turn: turnPost,
          remainingFighters: combat.remainingFighters,
        });

        // Close MoveCommitment PDAs for the resolved turn (fire-and-forget).
        // Returns rent to each fighter so wallets don't drain over many rumbles.
        for (const fid of slot.fighters) {
          const wallet = state.fighterWallets.get(fid);
          if (!wallet) continue;
          closeMoveCommitmentOnChain(rumbleIdNum, wallet, turnNumPost, wallet, this.getCombatConnection()).catch(() => {});
        }

        for (const eliminatedId of syncAfterResolve.newEliminations) {
          this.emit("fighter_eliminated", {
            slotIndex: idx,
            rumbleId: slot.id,
            fighterId: eliminatedId,
            turnNumber: combat.currentTurn,
            remainingFighters: combat.remainingFighters,
          });
        }
      }
    }

    if (!combat.turnResolved) {
      // Turn is still within commit/reveal window — submit moves and wait.
      await this.submitOnchainMovesForTurn(slot, state, combat, rumbleIdNum, currentSlotBig);
      return;
    }

    // --- Turn is resolved: finalize or advance ---

    if (combat.remainingFighters <= 1) {
      // Undelegate combat state FIRST so both rumble + combat_state are writable on L1
      if (this.erEnabled) {
        try {
          const undelegateSig = await undelegateCombatFromEr(rumbleIdNum);
          if (undelegateSig) {
            console.log(`[ER] undelegateCombat succeeded for rumble ${rumbleIdNum}: ${undelegateSig}`);
          }
        } catch (err) {
          console.warn(`[ER] undelegateCombat failed for rumble ${rumbleIdNum}:`, err);
        }
      }

      // Finalize on L1 (rumble PDA is never delegated, needs mut access)
      try {
        const sig = await finalizeRumbleOnChainTx(rumbleIdNum, getConnection());
        if (sig) {
          console.log(`[OnChain] finalizeRumble succeeded: ${sig}`);
          await persistWithRetry(
            () => persist.updateRumbleTxSignature(slot.id, "reportResult", sig),
            `updateRumbleTxSignature:reportResult:${slot.id}`,
          );
        }
      } catch (err) {
        console.warn(`[OnChain] finalizeRumble failed for ${slot.id}: ${formatError(err)}`);
      }
      invalidateReadCache(`rumble:${rumbleIdNum}`);
      onchainState = await readRumbleAccountState(rumbleIdNum).catch(() => null);
      if (onchainState?.state === "payout" || onchainState?.state === "complete") {
        await this.finishCombatFromOnchain(slot, state, rumbleIdNum);
      }
      return;
    }

    // More than 1 fighter remains and turn is resolved — advance to next turn.
    if (currentSlotBig >= combat.revealCloseSlot) {
      try {
        const sig = await advanceTurnOnChain(rumbleIdNum, this.getCombatConnection());
        if (sig) {
          console.log(`[OnChain] advanceTurn succeeded: ${sig}`);
          void persistWithRetry(
            () => persist.updateRumbleTxSignature(slot.id, "advanceTurn", sig),
            `updateRumbleTxSignature:advanceTurn:${slot.id}`,
          );
        }
      } catch (err) {
        if (
          !this.hasErrorTokenAny(err, [
            "turn already open",
            "turnalreadyopen",
            "custom program error: 0x177b",
          ])
        ) {
          console.warn(`[OnChain] advanceTurn failed for ${slot.id}: ${formatError(err)}`);
        }
      }
    }
  }

  private async initCombatState(slot: RumbleSlot): Promise<void> {
    // Build RumbleFighter array from slot's fighter IDs.
    const MAX_HP = 100; // matches combat.ts default
    const fighterProfiles = await persist.loadRumbleFighterProfiles(slot.fighters);
    const fighterWalletRows = await persist.lookupFighterWallets(slot.fighters);
    const fighterWallets = new Map<string, PublicKey>();
    for (const fid of slot.fighters) {
      const wallet = fighterWalletRows.get(fid);
      if (!wallet) continue;
      try {
        fighterWallets.set(fid, new PublicKey(wallet));
      } catch {
        console.warn(`[Orchestrator] Invalid wallet for fighter ${fid}: ${wallet}`);
      }
    }

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
      fighterWallets,
      turns: [],
      eliminationOrder: [],
      previousPairings: new Set(),
      turnDecisions: new Map(),
      lastOnchainTurnResolved: 0,
      previousDamageTaken: new Map(),
      lastTickAt: Date.now(),
    });
  }

  private moveToCode(move: MoveType): number {
    switch (move) {
      case "HIGH_STRIKE":
        return 0;
      case "MID_STRIKE":
        return 1;
      case "LOW_STRIKE":
        return 2;
      case "GUARD_HIGH":
        return 3;
      case "GUARD_MID":
        return 4;
      case "GUARD_LOW":
        return 5;
      case "DODGE":
        return 6;
      case "CATCH":
        return 7;
      case "SPECIAL":
        return 8;
      default:
        return 1;
    }
  }

  private getSignerForFighter(fighterId: string, wallet: PublicKey | null): Keypair | null {
    const byId = this.fighterSignerById.get(fighterId);
    if (byId) return byId;
    if (!wallet) return null;
    return this.fighterSignerByWallet.get(wallet.toBase58()) ?? null;
  }

  private async sendFighterSignedTx(tx: Transaction, signer: Keypair): Promise<string> {
    tx.partialSign(signer);
    const conn = this.getCombatConnection();
    const signature = await conn.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: "processed",
      maxRetries: 3,
    });
    // Best-effort confirmation: check status once after a short delay.
    // Don't block the combat loop, but log failures so they're visible.
    this.bestEffortConfirm(conn, signature).catch(() => {});
    return signature;
  }

  /** Non-blocking single-check confirmation for fire-and-forget txs. */
  private async bestEffortConfirm(conn: import("@solana/web3.js").Connection, signature: string): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 2_000));
    try {
      const status = await conn.getSignatureStatus(signature);
      if (status?.value?.err) {
        console.warn(`[TxConfirm] Tx ${signature.slice(0, 12)}... failed on-chain:`, status.value.err);
      } else if (!status?.value) {
        console.warn(`[TxConfirm] Tx ${signature.slice(0, 12)}... not found after 2s — may have been dropped`);
      }
    } catch {
      // RPC error — not critical, on-chain polling will catch up
    }
  }

  /**
   * Request an external fighter to sign a transaction via their webhook.
   * The fighter can either:
   *   1. Return { signed_tx: "<base64>" } for us to submit, or
   *   2. Submit the tx themselves and return { submitted: true, signature: "<sig>" }
   * Returns the transaction signature on success, or null on failure/timeout.
   */
  private async requestExternalSign(
    webhookUrl: string,
    tx: Transaction,
    txType: "commit_move" | "reveal_move",
    rumbleId: string,
    turn: number,
    fighterId: string,
    fighterWallet: string,
  ): Promise<string | null> {
    try {
      const unsignedBytes = tx.serialize({
        requireAllSignatures: false,
        verifySignatures: false,
      });
      const unsignedBase64 = unsignedBytes.toString("base64");

      const response = await this.requestWebhookWithTimeout(webhookUrl, "tx_sign_request", {
        tx_type: txType,
        unsigned_tx: unsignedBase64,
        rumble_id: rumbleId,
        turn,
        fighter_id: fighterId,
        fighter_wallet: fighterWallet,
        instructions:
          "Sign this transaction with your wallet and return { signed_tx: '<base64>' }. " +
          "You can also submit the transaction directly to Solana and return { submitted: true, signature: '<sig>' }.",
      });

      if (!response) {
        console.warn(
          `[OnChain] tx_sign_request webhook timeout/failed for ${fighterId} (${txType} turn ${turn})`,
        );
        return null;
      }

      // Case 1: Fighter claims they submitted the tx themselves — verify on-chain
      if (
        response.submitted === true &&
        typeof response.signature === "string" &&
        response.signature.length > 0
      ) {
        const claimedSig = response.signature;
        // Verify the claimed signature actually landed on-chain
        try {
          const conn = this.getCombatConnection();
          await new Promise(resolve => setTimeout(resolve, 1_500));
          const status = await conn.getSignatureStatus(claimedSig);
          if (!status?.value || status.value.err) {
            console.warn(
              `[OnChain] External fighter ${fighterId} claimed self-submit but sig not confirmed: ${claimedSig}`,
            );
            return null; // Don't trust unverified claim
          }
        } catch {
          console.warn(`[OnChain] Could not verify self-submitted sig for ${fighterId}: ${claimedSig}`);
          return null;
        }
        console.log(
          `[OnChain] External fighter ${fighterId} self-submitted ${txType} turn ${turn} (verified): ${claimedSig}`,
        );
        return claimedSig;
      }

      // Case 2: Fighter returned a signed transaction for us to submit
      if (typeof response.signed_tx === "string" && response.signed_tx.length > 0) {
        const signedTx = Transaction.from(Buffer.from(response.signed_tx, "base64"));
        const conn = this.getCombatConnection();
        const signature = await conn.sendRawTransaction(signedTx.serialize(), {
          skipPreflight: false,
          preflightCommitment: "processed",
          maxRetries: 3,
        });
        console.log(
          `[OnChain] Submitted externally-signed ${txType} for ${fighterId} turn ${turn}: ${signature}`,
        );
        return signature;
      }

      console.warn(
        `[OnChain] tx_sign_request response from ${fighterId} missing signed_tx or submitted fields`,
      );
      return null;
    } catch (err) {
      console.warn(
        `[OnChain] requestExternalSign failed for ${fighterId} (${txType} turn ${turn}): ${formatError(err)}`,
      );
      return null;
    }
  }

  private hashU64(parts: Array<Buffer | Uint8Array>): bigint {
    const hasher = createHash("sha256");
    for (const part of parts) {
      hasher.update(part);
    }
    const digest = hasher.digest();
    return digest.readBigUInt64LE(0);
  }

  private deriveOnchainPairings(
    slot: RumbleSlot,
    state: SlotCombatState,
    combat: RumbleCombatAccountState,
    rumbleIdNum: number,
  ): Array<[string, string]> {
    const fighterCount = Math.min(slot.fighters.length, combat.fighterCount);
    const turn = combat.currentTurn;
    if (turn <= 0) return [];

    const rumbleBuf = Buffer.alloc(8);
    rumbleBuf.writeBigUInt64LE(BigInt(rumbleIdNum));
    const turnBuf = Buffer.alloc(4);
    turnBuf.writeUInt32LE(turn >>> 0);

    const aliveIndices: number[] = [];
    for (let i = 0; i < fighterCount; i++) {
      const hp = combat.hp[i] ?? 0;
      const eliminated = (combat.eliminationRank[i] ?? 0) > 0;
      if (hp > 0 && !eliminated) aliveIndices.push(i);
    }

    aliveIndices.sort((a, b) => {
      const fighterAId = slot.fighters[a];
      const fighterBId = slot.fighters[b];
      const fighterAWallet = state.fighterWallets.get(fighterAId);
      const fighterBWallet = state.fighterWallets.get(fighterBId);
      if (!fighterAWallet || !fighterBWallet) return a - b;

      const keyA = this.hashU64([
        Buffer.from("pair-order"),
        rumbleBuf,
        turnBuf,
        fighterAWallet.toBuffer(),
      ]);
      const keyB = this.hashU64([
        Buffer.from("pair-order"),
        rumbleBuf,
        turnBuf,
        fighterBWallet.toBuffer(),
      ]);
      if (keyA !== keyB) return keyA < keyB ? -1 : 1;
      return Buffer.compare(fighterAWallet.toBuffer(), fighterBWallet.toBuffer());
    });

    const pairs: Array<[string, string]> = [];
    for (let i = 0; i + 1 < aliveIndices.length; i += 2) {
      pairs.push([slot.fighters[aliveIndices[i]], slot.fighters[aliveIndices[i + 1]]]);
    }
    return pairs;
  }

  private syncLocalFightersFromOnchain(
    slot: RumbleSlot,
    state: SlotCombatState,
    combat: RumbleCombatAccountState,
  ): { newEliminations: string[] } {
    const newEliminations: string[] = [];
    const fighterCount = Math.min(slot.fighters.length, combat.fighterCount);

    for (let i = 0; i < fighterCount; i++) {
      const fighterId = slot.fighters[i];
      const fighter = state.fighters.find((f) => f.id === fighterId);
      if (!fighter) continue;

      const prevHp = fighter.hp;
      const hp = Math.max(0, Number(combat.hp[i] ?? fighter.hp));
      fighter.hp = hp;
      fighter.meter = Math.max(0, Math.min(100, Number(combat.meter[i] ?? fighter.meter)));
      fighter.totalDamageDealt = Number(combat.totalDamageDealt[i] ?? BigInt(fighter.totalDamageDealt));
      fighter.totalDamageTaken = Number(combat.totalDamageTaken[i] ?? BigInt(fighter.totalDamageTaken));

      const eliminatedRank = Number(combat.eliminationRank[i] ?? 0);
      if ((hp <= 0 || eliminatedRank > 0) && fighter.eliminatedOnTurn === null) {
        fighter.eliminatedOnTurn = combat.currentTurn > 0 ? combat.currentTurn : 1;
        state.eliminationOrder.push(fighterId);
        if (prevHp > 0) newEliminations.push(fighterId);
      }
    }

    return { newEliminations };
  }

  private async ensureOnchainTurnDecision(
    slot: RumbleSlot,
    state: SlotCombatState,
    fighterId: string,
    opponentId: string,
    rumbleIdNum: number,
    turn: number,
  ): Promise<OnchainTurnDecision | null> {
    const byTurn = state.turnDecisions.get(turn) ?? new Map<string, OnchainTurnDecision>();
    const existing = byTurn.get(fighterId);
    if (existing) return existing;

    const fighterWallet = state.fighterWallets.get(fighterId) ?? null;
    if (!fighterWallet) return null;
    const signer = this.getSignerForFighter(fighterId, fighterWallet);
    const hasSigner = !!signer;

    // If no local signer, check if the fighter has a webhook for external signing
    if (!hasSigner) {
      const profile = state.fighterProfiles.get(fighterId);
      const webhookUrl = profile?.webhookUrl;
      if (!webhookUrl) return null; // No signer AND no webhook — cannot participate on-chain
    }

    const fighter = state.fighters.find((f) => f.id === fighterId);
    const opponent = state.fighters.find((f) => f.id === opponentId);
    if (!fighter || !opponent) return null;

    const alive = state.fighters.filter((f) => f.hp > 0);
    const move = await this.requestFighterMove(slot, state, fighter, opponent, alive, turn);
    const moveCode = this.moveToCode(move);
    const salt32Hex = randomBytes(32).toString("hex");
    const commitment = computeMoveCommitmentHash(
      rumbleIdNum,
      turn,
      fighterWallet,
      moveCode,
      Uint8Array.from(Buffer.from(salt32Hex, "hex")),
    );
    const decision: OnchainTurnDecision = {
      move,
      moveCode,
      salt32Hex,
      commitmentHex: Buffer.from(commitment).toString("hex"),
      commitSubmitted: false,
      revealSubmitted: false,
      hasSigner,
    };
    byTurn.set(fighterId, decision);
    state.turnDecisions.set(turn, byTurn);
    return decision;
  }

  private hasErrorTokenAny(err: unknown, tokens: string[]): boolean {
    const text = formatError(err).toLowerCase();
    return tokens.some((token) => text.includes(token.toLowerCase()));
  }

  private async submitOnchainMovesForTurn(
    slot: RumbleSlot,
    state: SlotCombatState,
    combat: RumbleCombatAccountState,
    rumbleIdNum: number,
    currentSlot: bigint,
  ): Promise<void> {
    if (combat.currentTurn <= 0) return;

    const turn = combat.currentTurn;
    const pairings = this.deriveOnchainPairings(slot, state, combat, rumbleIdNum);
    for (const [fighterA, fighterB] of pairings) {
      await Promise.all([
        this.ensureOnchainTurnDecision(slot, state, fighterA, fighterB, rumbleIdNum, turn),
        this.ensureOnchainTurnDecision(slot, state, fighterB, fighterA, rumbleIdNum, turn),
      ]);
    }

    const decisionsByFighter = state.turnDecisions.get(turn);
    if (!decisionsByFighter) return;

    for (const [fighterId, decision] of decisionsByFighter.entries()) {
      const fighterWallet = state.fighterWallets.get(fighterId) ?? null;
      if (!fighterWallet) continue;

      const signer = decision.hasSigner
        ? this.getSignerForFighter(fighterId, fighterWallet)
        : null;

      // Resolve webhook URL for external fighters (no local signer)
      let webhookUrl: string | null = null;
      if (!signer) {
        const profile = state.fighterProfiles.get(fighterId);
        webhookUrl = profile?.webhookUrl ?? null;
        if (!webhookUrl) continue; // No signer and no webhook — skip
      }

      // --- COMMIT PHASE ---
      if (!decision.commitSubmitted && currentSlot <= combat.commitCloseSlot) {
        try {
          const tx = await buildCommitMoveTx(
            fighterWallet,
            rumbleIdNum,
            turn,
            Uint8Array.from(Buffer.from(decision.commitmentHex, "hex")),
          );

          let sig: string | null = null;
          if (signer) {
            // Case A: Local signer — sign and submit directly
            sig = await this.sendFighterSignedTx(tx, signer);
          } else {
            // Case B: External signer — request signing via webhook
            sig = await this.requestExternalSign(
              webhookUrl!,
              tx,
              "commit_move",
              slot.id,
              turn,
              fighterId,
              fighterWallet.toBase58(),
            );
          }

          if (sig) {
            decision.commitSubmitted = true;
            console.log(`[OnChain] commitMove ${fighterId} turn ${turn}: ${sig}`);
          }
        } catch (err) {
          if (
            this.hasErrorTokenAny(err, [
              "already in use",
              "custom program error: 0x0",
              "instruction 0:",
            ])
          ) {
            decision.commitSubmitted = true;
          } else {
            console.warn(
              `[OnChain] commitMove failed for fighter ${fighterId} turn ${turn}: ${formatError(err)}`,
            );
          }
        }
      }

      // --- REVEAL PHASE ---
      if (
        decision.commitSubmitted &&
        !decision.revealSubmitted &&
        currentSlot > combat.commitCloseSlot &&
        currentSlot <= combat.revealCloseSlot
      ) {
        try {
          const tx = await buildRevealMoveTx(
            fighterWallet,
            rumbleIdNum,
            turn,
            decision.moveCode,
            Uint8Array.from(Buffer.from(decision.salt32Hex, "hex")),
          );

          let sig: string | null = null;
          if (signer) {
            // Case A: Local signer — sign and submit directly
            sig = await this.sendFighterSignedTx(tx, signer);
          } else {
            // Case B: External signer — request signing via webhook
            sig = await this.requestExternalSign(
              webhookUrl!,
              tx,
              "reveal_move",
              slot.id,
              turn,
              fighterId,
              fighterWallet.toBase58(),
            );
          }

          if (sig) {
            decision.revealSubmitted = true;
            console.log(`[OnChain] revealMove ${fighterId} turn ${turn}: ${sig}`);
          }
        } catch (err) {
          if (
            this.hasErrorTokenAny(err, [
              "already revealed",
              "custom program error: 0x8a7",
            ])
          ) {
            decision.revealSubmitted = true;
          } else {
            console.warn(
              `[OnChain] revealMove failed for fighter ${fighterId} turn ${turn}: ${formatError(err)}`,
            );
          }
        }
      }
    }
  }

  private async collectExistingMoveCommitments(
    state: SlotCombatState,
    rumbleIdNum: number,
    turn: number,
  ): Promise<PublicKey[]> {
    const wallets = [...state.fighterWallets.values()];
    if (wallets.length === 0) return [];
    const pdas = wallets.map((wallet) => deriveMoveCommitmentPda(rumbleIdNum, wallet, turn)[0]);
    const infos = await this.getCombatConnection().getMultipleAccountsInfo(pdas, "processed");
    const resolved: PublicKey[] = [];
    for (let i = 0; i < pdas.length; i++) {
      const info = infos[i];
      if (!info) continue;
      if (!info.owner.equals(RUMBLE_ENGINE_ID)) continue;
      resolved.push(pdas[i]);
    }
    return resolved;
  }

  /**
   * Hybrid resolution: compute combat results off-chain and post them on-chain
   * via the `post_turn_result` instruction (Option D).
   */
  private async resolveAndPostTurnResult(
    slot: RumbleSlot,
    state: SlotCombatState,
    combat: NonNullable<Awaited<ReturnType<typeof readRumbleCombatState>>>,
    rumbleIdNum: number,
  ): Promise<void> {
    const fighterCount = combat.fighterCount;
    const turn = combat.currentTurn;

    // Guard: prevent duplicate turn if on-chain post failed and next tick retries
    if (turn <= state.lastOnchainTurnResolved) {
      return;
    }

    // Get fighter pubkeys from on-chain rumble account
    const fighters = await readRumbleFighters(rumbleIdNum);
    if (!fighters || fighters.length < fighterCount) {
      console.warn(`[Hybrid] Could not read fighter pubkeys for rumble ${rumbleIdNum}`);
      return;
    }

    // Get alive fighter indices
    const aliveIndices: number[] = [];
    for (let i = 0; i < fighterCount; i++) {
      if (combat.hp[i] > 0 && combat.eliminationRank[i] === 0) {
        aliveIndices.push(i);
      }
    }

    if (aliveIndices.length <= 1) {
      // Nothing to resolve — finalize will handle
      return;
    }

    // Pair fighters deterministically
    const { pairs, byeIdx } = pairFightersForTurn(aliveIndices, fighters, rumbleIdNum, turn);

    // Read revealed moves from MoveCommitment PDAs
    const movesByIdx = new Map<number, number>();
    for (const idx of aliveIndices) {
      const [pda] = deriveMoveCommitmentPda(rumbleIdNum, fighters[idx], turn);
      try {
        const data = await readMoveCommitmentData(pda);
        if (data && data.revealedMove !== null) {
          movesByIdx.set(idx, data.revealedMove);
        }
      } catch {
        // Will use fallback
      }
    }

    // Build duel results
    const duelResults: Array<{
      fighterAIdx: number;
      fighterBIdx: number;
      moveA: number;
      moveB: number;
      damageToA: number;
      damageToB: number;
    }> = [];

    for (const [idxA, idxB] of pairs) {
      const moveA = movesByIdx.get(idxA) ?? computeFallbackMove(rumbleIdNum, turn, fighters[idxA], combat.meter[idxA]);
      const moveB = movesByIdx.get(idxB) ?? computeFallbackMove(rumbleIdNum, turn, fighters[idxB], combat.meter[idxB]);

      const { damageToA, damageToB } = resolveDuelDeterministic(
        moveA, moveB, combat.meter[idxA], combat.meter[idxB]
      );

      duelResults.push({
        fighterAIdx: idxA,
        fighterBIdx: idxB,
        moveA,
        moveB,
        damageToA,
        damageToB,
      });
    }

    // Build local turn data BEFORE posting on-chain, so it's persisted
    // even if the next tick advances past this turn.
    const MOVE_CODE_NAMES: string[] = [
      "HIGH_STRIKE", "MID_STRIKE", "LOW_STRIKE",
      "GUARD_HIGH", "GUARD_MID", "GUARD_LOW",
      "DODGE", "CATCH", "SPECIAL",
    ];
    const turnPairings: RumblePairing[] = [];
    for (const dr of duelResults) {
      const fighterAId = slot.fighters[dr.fighterAIdx] ?? `idx-${dr.fighterAIdx}`;
      const fighterBId = slot.fighters[dr.fighterBIdx] ?? `idx-${dr.fighterBIdx}`;
      turnPairings.push({
        fighterA: fighterAId,
        fighterB: fighterBId,
        moveA: MOVE_CODE_NAMES[dr.moveA] ?? "MID_STRIKE",
        moveB: MOVE_CODE_NAMES[dr.moveB] ?? "MID_STRIKE",
        damageToA: dr.damageToA,
        damageToB: dr.damageToB,
      });
    }
    // Detect eliminations: fighter HP drops to 0 after this turn's damage
    const turnEliminations: string[] = [];
    for (const dr of duelResults) {
      const hpA = combat.hp[dr.fighterAIdx] - dr.damageToA;
      const hpB = combat.hp[dr.fighterBIdx] - dr.damageToB;
      if (hpA <= 0) turnEliminations.push(slot.fighters[dr.fighterAIdx]);
      if (hpB <= 0) turnEliminations.push(slot.fighters[dr.fighterBIdx]);
    }
    let byeFighterId: string | undefined;
    if (byeIdx !== null) {
      byeFighterId = slot.fighters[byeIdx];
    }
    const localTurn: RumbleTurn = {
      turnNumber: turn,
      pairings: turnPairings,
      eliminations: turnEliminations.filter(Boolean),
    };
    if (byeFighterId) localTurn.bye = byeFighterId;
    state.turns.push(localTurn);
    state.lastOnchainTurnResolved = turn;
    await persist.updateRumbleTurnLog(slot.id, state.turns, state.turns.length);

    // Compute remaining fighters after this turn's eliminations
    const remainingAfterTurn = aliveIndices.length - turnEliminations.length;

    // Emit turn_resolved so the UI and commentary hook receive the turn data.
    // Without this, hybrid-resolved turns are invisible to SSE listeners.
    this.emit("turn_resolved", {
      slotIndex: slot.slotIndex,
      rumbleId: slot.id,
      turn: localTurn,
      remainingFighters: remainingAfterTurn,
    });

    for (const eliminatedId of turnEliminations) {
      if (!eliminatedId) continue;
      this.emit("fighter_eliminated", {
        slotIndex: slot.slotIndex,
        rumbleId: slot.id,
        fighterId: eliminatedId,
        turnNumber: turn,
        remainingFighters: remainingAfterTurn,
      });
    }

    // Post results on-chain
    const sig = await postTurnResultOnChain(
      rumbleIdNum,
      duelResults,
      byeIdx,
      this.getCombatConnection(),
    );
    if (sig) {
      console.log(`[Hybrid] postTurnResult succeeded: ${sig}`);
      void persistWithRetry(
        () => persist.updateRumbleTxSignature(slot.id, "postTurnResult", sig),
        `updateRumbleTxSignature:postTurnResult:${slot.id}`,
      );
    }
  }

  private async finishCombatFromOnchain(
    slot: RumbleSlot,
    state: SlotCombatState,
    rumbleIdNum: number,
  ): Promise<void> {
    if (slot.rumbleResult) return;

    const [rumble, combat] = await Promise.all([
      readRumbleAccountState(rumbleIdNum).catch(() => null),
      readRumbleCombatState(rumbleIdNum, this.getCombatConnection()).catch(() => null),
    ]);
    if (!rumble || !combat) return;

    this.syncLocalFightersFromOnchain(slot, state, combat);

    let placements = slot.fighters
      .map((fighterId, index) => ({
        id: fighterId,
        placement: rumble.placements[index] ?? 0,
      }))
      .filter((row) => Number.isInteger(row.placement) && row.placement > 0)
      .sort((a, b) => a.placement - b.placement);

    // Safety net: deduplicate placements from on-chain (e.g. double-1st bug
    // when elimination_rank == fighter_count produced placement 1 colliding
    // with the winner). Re-number sequentially if any duplicates found.
    const seenPlacements = new Set<number>();
    let hasDuplicates = false;
    for (const p of placements) {
      if (seenPlacements.has(p.placement)) { hasDuplicates = true; break; }
      seenPlacements.add(p.placement);
    }
    if (hasDuplicates) {
      for (let i = 0; i < placements.length; i++) {
        placements[i].placement = i + 1;
      }
    }

    if (placements.length < 2) {
      const ranked = [...state.fighters].sort((a, b) => {
        if (a.hp > 0 || b.hp > 0) {
          if (b.hp !== a.hp) return b.hp - a.hp;
        }
        if ((b.eliminatedOnTurn ?? 0) !== (a.eliminatedOnTurn ?? 0)) {
          return (b.eliminatedOnTurn ?? 0) - (a.eliminatedOnTurn ?? 0);
        }
        return b.totalDamageDealt - a.totalDamageDealt;
      });
      placements = ranked.map((f, i) => ({ id: f.id, placement: i + 1 }));
    }

    const rankedFighters = placements
      .map((row) => {
        const fighter = state.fighters.find((f) => f.id === row.id);
        return fighter
          ? {
              ...fighter,
              placement: row.placement,
            }
          : null;
      })
      .filter((f): f is RumbleFighter => !!f)
      .sort((a, b) => a.placement - b.placement);

    if (rankedFighters.length < 2) return;
    const winner = rankedFighters[0].id;

    const result: RumbleResult = {
      rumbleId: slot.id,
      fighters: rankedFighters,
      turns: state.turns,
      winner,
      placements,
      totalTurns: state.turns.length,
    };

    await persist.completeRumbleRecord(
      slot.id,
      winner,
      result.placements,
      state.turns,
      state.turns.length,
    );

    this.queueManager.reportResult(slot.slotIndex, result);
    this.emit("rumble_complete", {
      slotIndex: slot.slotIndex,
      rumbleId: slot.id,
      result,
    });
  }

  private fallbackMoveForFighter(
    fighter: RumbleFighter,
    alive: RumbleFighter[],
    turnHistory: RumbleTurn[],
  ): MoveType {
    return selectMove(fighter, alive.filter((f) => f.id !== fighter.id), turnHistory as any);
  }

  private async requestWebhookWithTimeout(
    webhookUrl: string,
    event: string,
    payload: Record<string, any>,
  ): Promise<Record<string, any> | null> {
    const timeoutPromise = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), AGENT_MOVE_TIMEOUT_MS),
    );
    const webhookPromise = notifyFighter(webhookUrl, event, payload)
      .then((res) => {
        if (!res.success) return null;
        if (!res.data || typeof res.data !== "object") return null;
        return res.data as Record<string, any>;
      })
      .catch(() => null);
    return Promise.race([webhookPromise, timeoutPromise]);
  }

  private async requestFighterMoveCommitReveal(
    slot: RumbleSlot,
    state: SlotCombatState,
    fighter: RumbleFighter,
    opponent: RumbleFighter,
    webhookUrl: string,
    turnNumber: number,
  ): Promise<MoveType | null> {
    // Redact opponent exact values — provide tier hints instead of precise HP/meter
    const opponentHpTier = opponent.hp > 75 ? "high" : opponent.hp > 40 ? "mid" : opponent.hp > 0 ? "low" : "ko";
    const opponentMeterTier = opponent.meter >= 100 ? "full" : opponent.meter >= 60 ? "high" : opponent.meter >= 30 ? "mid" : "low";

    // Redact turn history: strip opponent move details, keep only own moves + outcomes
    const redactedHistory = state.turns.slice(-6).map((t: any) => ({
      turn: t.turn,
      your_move: t.fighter_a_id === fighter.id ? t.move_a : t.move_b,
      outcome: t.outcome,
      your_damage_taken: t.fighter_a_id === fighter.id ? t.damage_to_a : t.damage_to_b,
    }));

    const sharedState = {
      mode: "rumble",
      rumble_id: slot.id,
      slot_index: slot.slotIndex,
      turn: turnNumber,
      fighter_id: fighter.id,
      fighter_name: fighter.name,
      opponent_id: opponent.id,
      opponent_name: opponent.name,
      match_id: slot.id,
      match_state: {
        your_hp: fighter.hp,
        opponent_hp_tier: opponentHpTier,
        your_meter: fighter.meter,
        opponent_meter_tier: opponentMeterTier,
        round: 1,
        turn: turnNumber,
        your_rounds_won: 0,
        opponent_rounds_won: 0,
      },
      your_state: {
        hp: fighter.hp,
        meter: fighter.meter,
      },
      opponent_state: {
        hp_tier: opponentHpTier,
        meter_tier: opponentMeterTier,
      },
      turn_history: redactedHistory,
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

    const commitResp = await this.requestWebhookWithTimeout(
      webhookUrl,
      "move_commit_request",
      {
        ...sharedState,
        hash_format: "sha256(move:salt)",
      },
    );
    const commitHashRaw = typeof commitResp?.move_hash === "string" ? commitResp.move_hash.trim() : "";
    const commitHash = commitHashRaw.toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(commitHash)) return null;

    const revealResp = await this.requestWebhookWithTimeout(
      webhookUrl,
      "move_reveal_request",
      {
        ...sharedState,
        move_hash: commitHash,
      },
    );
    const rawMove = typeof revealResp?.move === "string" ? revealResp.move.trim().toUpperCase() : "";
    const salt = typeof revealResp?.salt === "string" ? revealResp.salt.trim() : "";
    if (!isValidMove(rawMove) || !salt) return null;

    const recomputed = createMoveHash(rawMove as MoveType, salt).toLowerCase();
    if (recomputed !== commitHash) return null;
    return rawMove as MoveType;
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
    const hasRealWebhook =
      webhookUrl &&
      !webhookUrl.includes("polling-mode.local") &&
      !webhookUrl.includes("example.com");

    // If no webhook AND no polling table, short-circuit to fallback
    if (!hasRealWebhook && !webhookUrl) return fallback;

    // Redacted opponent info for the polling request payload
    const opponentHpTier =
      opponent.hp > 75 ? "high" : opponent.hp > 40 ? "mid" : opponent.hp > 0 ? "low" : "ko";
    const opponentMeterTier =
      opponent.meter >= 100 ? "full" : opponent.meter >= 60 ? "high" : opponent.meter >= 30 ? "mid" : "low";

    const moveRequestPayload: Record<string, unknown> = {
      mode: "rumble",
      rumble_id: slot.id,
      slot_index: slot.slotIndex,
      turn: turnNumber,
      fighter_id: fighter.id,
      fighter_name: fighter.name,
      opponent_id: opponent.id,
      opponent_name: opponent.name,
      match_state: {
        your_hp: fighter.hp,
        opponent_hp_tier: opponentHpTier,
        your_meter: fighter.meter,
        opponent_meter_tier: opponentMeterTier,
        round: 1,
        turn: turnNumber,
      },
      your_state: { hp: fighter.hp, meter: fighter.meter },
      opponent_state: { hp_tier: opponentHpTier, meter_tier: opponentMeterTier },
      valid_moves: [
        "HIGH_STRIKE", "MID_STRIKE", "LOW_STRIKE",
        "GUARD_HIGH", "GUARD_MID", "GUARD_LOW",
        "DODGE", "CATCH", "SPECIAL",
      ],
      timeout_ms: AGENT_MOVE_TIMEOUT_MS,
    };

    // Write pending move request to DB for polling bots (fire-and-forget write)
    const pendingWritten = await persist.writePendingMoveRequest(
      slot.id,
      turnNumber,
      fighter.id,
      moveRequestPayload,
      AGENT_MOVE_TIMEOUT_MS + 2_000, // TTL: move timeout + 2s grace
    );

    try {
      // --- Webhook path (commit-reveal + legacy) ---
      if (hasRealWebhook) {
        // Preferred mode: commit-reveal
        const committedMove = await this.requestFighterMoveCommitReveal(
          slot,
          state,
          fighter,
          opponent,
          webhookUrl,
          turnNumber,
        );
        if (committedMove) return committedMove;

        // Backward compatibility: legacy single-step move_request.
        const responseData = await this.requestWebhookWithTimeout(
          webhookUrl,
          "move_request",
          {
            ...moveRequestPayload,
            match_id: slot.id,
            match_state: {
              your_hp: fighter.hp,
              opponent_hp: opponent.hp,
              your_meter: fighter.meter,
              opponent_meter: opponent.meter,
              round: 1,
              turn: turnNumber,
              your_rounds_won: 0,
              opponent_rounds_won: 0,
            },
            opponent_state: {
              hp: opponent.hp,
              meter: opponent.meter,
            },
            turn_history: state.turns.slice(-6),
          },
        );
        const directMove =
          typeof responseData?.move === "string" ? responseData.move.trim().toUpperCase() : "";
        if (isValidMove(directMove)) return directMove as MoveType;
      }

      // --- Polling path: check if bot submitted a move via the API ---
      if (pendingWritten) {
        const polledMove = await this.pollForMoveResponse(slot.id, turnNumber, fighter.id);
        if (polledMove && isValidMove(polledMove)) return polledMove as MoveType;
      }
    } finally {
      // Clean up the pending request
      void persistWithRetry(
        () => persist.expirePendingMoveRequest(slot.id, turnNumber, fighter.id),
        `expirePendingMoveRequest:${slot.id}:${turnNumber}:${fighter.id}`,
      );
    }

    return fallback;
  }

  /**
   * Poll Supabase for a move submitted via the polling API.
   * Checks every 300ms for up to AGENT_MOVE_TIMEOUT_MS.
   */
  private async pollForMoveResponse(
    rumbleId: string,
    turn: number,
    fighterId: string,
  ): Promise<string | null> {
    const POLL_INTERVAL = 300;
    const maxAttempts = Math.ceil(AGENT_MOVE_TIMEOUT_MS / POLL_INTERVAL);

    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
      const move = await persist.readPendingMoveResponse(rumbleId, turn, fighterId);
      if (move) return move;
    }
    return null;
  }

  /**
   * Execute a single combat turn for a slot. Called from tick() during
   * combat phase, throttled to one turn per legacy combat tick interval.
   */
  async runCombatPhase(slotIndex: number): Promise<void> {
    const slot = this.queueManager.getSlot(slotIndex);
    if (!slot || slot.state !== "combat") return;
    await this.handleCombatPhase(slot);
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

    // Persist: update turn log after each turn — AWAITED to survive cold starts.
    // Without await, fire-and-forget writes are killed when the serverless
    // function terminates, losing all combat progress.
    await persist.updateRumbleTurnLog(slot.id, state.turns, state.turns.length);

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

    // Persist: complete rumble record with winner and placements — AWAITED
    await persist.completeRumbleRecord(
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
    const rumbleIdNum = parseOnchainRumbleIdNumber(rumbleId);
    if (rumbleIdNum === null) {
      console.warn(`[Orchestrator] Cannot parse rumbleId "${rumbleId}" as number, skipping on-chain`);
      return;
    }

    // Dedup guard: prevent double on-chain settlement for the same rumble
    if (this.settledRumbleIds.has(rumbleId)) {
      console.warn(`[Orchestrator] settleOnChain already processed for rumbleId "${rumbleId}", skipping`);
      return;
    }
    if (this.settlingRumbleIds.has(rumbleId)) {
      console.warn(`[Orchestrator] settleOnChain already in progress for rumbleId "${rumbleId}", skipping`);
      return;
    }
    this.settlingRumbleIds.add(rumbleId);
    this.trimTrackingMaps();

    let settlementSucceeded = false;
    let ichorSuccess = false;
    try {
    // 1. Ensure on-chain result is finalized (payout-ready).
    try {
      let onchainState = await this.ensureOnchainRumbleIsCombatReady(
        rumbleId,
        fighterOrder,
        Math.floor(Date.now() / 1000) - ONCHAIN_CREATE_RECOVERY_DEADLINE_SKEW_SEC,
      );
      if (!onchainState) {
        throw new Error(`[OnChain] finalize skipped for ${rumbleId}: on-chain rumble unavailable`);
      }

      if (onchainState.state === "combat") {
        // Undelegate combat state FIRST so both rumble + combat_state are writable on L1
        if (this.erEnabled) {
          try {
            const undelegateSig = await undelegateCombatFromEr(rumbleIdNum);
            if (undelegateSig) {
              console.log(`[ER] undelegateCombat succeeded for rumble ${rumbleIdNum}: ${undelegateSig}`);
            }
          } catch (err) {
            console.warn(`[ER] undelegateCombat failed for rumble ${rumbleIdNum}:`, err);
          }
        }

        // Finalize on L1 (rumble PDA is never delegated, needs mut access)
        const finalizeSig = await finalizeRumbleOnChainTx(rumbleIdNum, getConnection()).catch(() => null);
        if (finalizeSig) {
          console.log(`[OnChain] finalizeRumble succeeded: ${finalizeSig}`);
          void persistWithRetry(
            () => persist.updateRumbleTxSignature(rumbleId, "reportResult", finalizeSig),
            `updateRumbleTxSignature:reportResult:${rumbleId}`,
          );
        }
        onchainState = await readRumbleAccountState(rumbleIdNum).catch(() => null);
      }

      if (onchainState?.state !== "payout" && onchainState?.state !== "complete") {
        console.warn(
          `[OnChain] rumble ${rumbleId} not payout-ready yet (state=${onchainState?.state ?? "unknown"})`,
        );
        return;
      }

      // Post result to mainnet so bettors can claim real SOL payouts.
      // Fire-and-forget — mainnet failure must NOT block devnet settlement.
      const fighterCount = fighterOrder.length;
      const placementsArray = new Array(fighterCount).fill(0);
      for (const p of placements) {
        const idx = fighterOrder.indexOf(p.id);
        if (idx >= 0 && idx < fighterCount) placementsArray[idx] = p.placement;
      }
      const winnerIdx = fighterOrder.indexOf(winnerId);
      if (winnerIdx >= 0) {
        void (async () => {
          try {
            await persistMainnetOp({
              rumbleId,
              opType: "reportResult",
              payload: { rumbleIdNum, placements: placementsArray, winnerIndex: winnerIdx },
            });
            const mainnetSig = await reportResultMainnet(rumbleIdNum, placementsArray, winnerIdx);
            if (mainnetSig) {
              console.log(`[OnChain:Mainnet] reportResult succeeded: ${mainnetSig}`);
              await markOpComplete(rumbleId, "reportResult", mainnetSig);
            } else {
              await markOpFailed(rumbleId, "reportResult", "reportResultMainnet returned null");
              console.warn(`[OnChain:Mainnet] reportResult returned null for ${rumbleId}`);
            }
          } catch (err) {
            console.error(`[OnChain:Mainnet] reportResult error (non-blocking):`, err);
            await markOpFailed(rumbleId, "reportResult", formatError(err));
          }
        })();
      }
    } catch (err) {
      console.error(`[OnChain] finalizeRumble error:`, err);
      return;
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

        // Idempotency guard: skip if distributeReward already called for this rumble
        const existingSig = await persist.getRumbleTxSignature(rumbleId, "distributeReward");
        if (existingSig) {
          console.log(`[OnChain] distributeReward already done for ${rumbleId} (${existingSig}), skipping`);
        }

        // distributeReward: sends 1st place share + shower pool cut, increments rumble counter
        const sig = !existingSig ? await distributeRewardOnChain(winnerAta, showerVaultAta) : null;
        if (sig) {
          console.log(`[OnChain] distributeReward (1st place) succeeded: ${sig}`);
          void persistWithRetry(
            () => persist.updateRumbleTxSignature(rumbleId, "distributeReward", sig),
            `updateRumbleTxSignature:distributeReward:${rumbleId}`,
          );
          void persistWithRetry(
            () => persist.updateRumbleTxSignature(rumbleId, "mintRumbleReward", sig),
            `updateRumbleTxSignature:mintRumbleReward:${rumbleId}`,
          );
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

          const rewardKey: `ichor-fighter-${string}` = `ichor-fighter-${fighterWallet.toBase58()}`;
          const existingSig = await persist.getRumbleTxSignature(rumbleId, rewardKey);
          if (existingSig) {
            console.log(
              `[OnChain] adminDistribute fighter reward to ${fighterId} already done for ${rumbleId} (${existingSig}), skipping`,
            );
            continue;
          }

          const sig = await adminDistributeOnChain(ata, amountLamports);
          if (sig) {
            console.log(`[OnChain] adminDistribute fighter reward to ${fighterId} succeeded: ${sig}`);
            await persistWithRetry(
              () => persist.updateRumbleTxSignature(rumbleId, rewardKey, sig),
              `updateRumbleTxSignature:${rewardKey}:${rumbleId}`,
            );
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

          const rewardKey: `ichor-bettor-${string}` = `ichor-bettor-${bettorWalletStr}`;
          const existingSig = await persist.getRumbleTxSignature(rumbleId, rewardKey);
          if (existingSig) {
            console.log(
              `[OnChain] adminDistribute bettor reward to ${bettorWalletStr} already done for ${rumbleId} (${existingSig}), skipping`,
            );
            continue;
          }

          const sig = await adminDistributeOnChain(ata, amountLamports);
          if (sig) {
            console.log(`[OnChain] adminDistribute bettor reward to ${bettorWalletStr} succeeded: ${sig}`);
            await persistWithRetry(
              () => persist.updateRumbleTxSignature(rumbleId, rewardKey, sig),
              `updateRumbleTxSignature:${rewardKey}:${rumbleId}`,
            );
          } else {
            console.warn(`[OnChain] adminDistribute bettor reward to ${bettorWalletStr} returned null`);
          }
        } catch (err) {
          console.error(`[OnChain] adminDistribute bettor reward for ${bettorWalletStr} error:`, err);
        }
      }

      // 3. Check Ichor Shower — try VRF first, fall back to slot-hash
      if (winnerAta) {
        try {
          let showerRecipientAta = winnerAta;
          let showerRecipientWallet = winnerId;
          let showerRecipientOwnerWallet: PublicKey | null = winnerWallet;
          const chosenBettorWallet = this.pickWeightedWinnerBettorWallet(payoutResult);
          if (chosenBettorWallet) {
            try {
              const bettorPk = new PublicKey(chosenBettorWallet);
              await ensureAtaOnChain(ichorMint, bettorPk);
              showerRecipientAta = getAssociatedTokenAddressSync(ichorMint, bettorPk);
              showerRecipientWallet = chosenBettorWallet;
              showerRecipientOwnerWallet = bettorPk;
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
              const expectedRecipientAta = showerRecipientOwnerWallet
                ? getAssociatedTokenAddressSync(ichorMint, showerRecipientOwnerWallet)
                : null;
              showerRecipientAta = new PublicKey(pendingShower.recipientTokenAccount);
              if (expectedRecipientAta && !showerRecipientAta.equals(expectedRecipientAta)) {
                // If on-chain request points to a different token account, we don't
                // reliably know its owner here. Verify existence only before VRF.
                showerRecipientOwnerWallet = null;
              }
            } catch {}
          }

          let showerRecipientAtaReady = false;
          try {
            if (showerRecipientOwnerWallet) {
              const ensuredRecipientAta = await ensureAtaOnChain(ichorMint, showerRecipientOwnerWallet);
              if (ensuredRecipientAta) {
                showerRecipientAta = ensuredRecipientAta;
                showerRecipientAtaReady = true;
              }
            } else {
              const showerRecipientAccountInfo = await getConnection().getAccountInfo(showerRecipientAta);
              showerRecipientAtaReady = !!showerRecipientAccountInfo;
            }
          } catch (err) {
            console.warn("[Orchestrator] Failed to ensure shower recipient ATA:", err);
          }

          // Read on-chain shower pool BEFORE the call to detect trigger
          invalidateReadCache("arena");
          const arenaBeforeShower = await readArenaConfig().catch(() => null);
          const poolBefore = arenaBeforeShower ? Number(arenaBeforeShower.ichorShowerPool) : 0;

          // Try MagicBlock VRF for provably-fair shower roll
          let showerHandled = false;
        try {
          if (showerRecipientAtaReady) {
            const vrfSig = await requestIchorShowerVrf(showerRecipientAta, showerVaultAta);
            if (vrfSig) {
              console.log(`[VRF] requestIchorShowerVrf succeeded: ${vrfSig}`);
              void persistWithRetry(
                () => persist.updateRumbleTxSignature(rumbleId, "ichorShowerVrf", vrfSig),
                `updateRumbleTxSignature:ichorShowerVrf:${rumbleId}`,
              );
              showerHandled = true;
            }
          } else {
            console.warn(
              `[OnChain] Skipping VRF shower request, shower recipient ATA not ready: ${showerRecipientAta.toBase58()}`,
            );
          }
          } catch (vrfErr) {
            const showerErr = vrfErr as { logs?: unknown };
            console.warn(`[VRF] requestIchorShowerVrf failed, falling back to checkIchorShower:`, {
              error: showerErr,
              logs: showerErr?.logs,
            });
          }

          // Fallback to slot-hash based shower if VRF unavailable
          if (!showerHandled) {
            try {
              const showerSig = await checkIchorShowerOnChain(showerRecipientAta, showerVaultAta);
              if (showerSig) {
                console.log(`[OnChain] checkIchorShower succeeded: ${showerSig}`);
                void persistWithRetry(
                  () => persist.updateRumbleTxSignature(rumbleId, "checkIchorShower", showerSig),
                  `updateRumbleTxSignature:checkIchorShower:${rumbleId}`,
                );
              } else {
                console.warn(`[OnChain] checkIchorShower returned null — continuing off-chain`);
              }
            } catch (showerErr) {
              const fallbackErr = showerErr as { logs?: unknown };
              console.warn("[OnChain] checkIchorShowerOnChain failed, continuing off-chain:", {
                error: fallbackErr,
                logs: fallbackErr?.logs,
              });
            }
          }

          // Read on-chain shower pool AFTER to detect if shower triggered
          if (poolBefore > 0) {
            try {
              // Brief delay to let tx confirmation propagate
              await new Promise(r => setTimeout(r, 2000));
              invalidateReadCache("arena");
              const arenaAfterShower = await readArenaConfig().catch(() => null);
              const poolAfter = arenaAfterShower ? Number(arenaAfterShower.ichorShowerPool) : poolBefore;

              if (poolAfter === 0 && poolBefore > 0) {
                // ICHOR SHOWER TRIGGERED!
                const showerAmount = poolBefore / 1e9; // Convert lamports to ICHOR
                const recipientAmount = showerAmount * 0.9; // 90% to recipient
                console.log(
                  `[ICHOR SHOWER] TRIGGERED! pool=${poolBefore} (${showerAmount} ICHOR), ` +
                  `recipient=${showerRecipientWallet}, payout=${recipientAmount} ICHOR`,
                );

                // Update in-memory payout data
                const slotIndex = this.findSlotIndexByRumbleId(rumbleId);
                if (slotIndex !== null) {
                  const existing = this.transformedPayouts.get(slotIndex);
                  if (existing) {
                    existing.ichorShowerTriggered = true;
                    existing.ichorShowerAmount = recipientAmount;
                    // Re-persist updated payout
                    persist.savePayoutResult(rumbleId, existing).catch(err => {
                      console.error(`[ICHOR SHOWER] Failed to persist updated payout:`, err);
                    });
                  }
                }

                // Reset in-memory shower pool (on-chain already reset)
                this.ichorShowerPool = 0;

                // Persist shower trigger to Supabase
                persist.triggerIchorShower(rumbleId, showerRecipientWallet, recipientAmount).catch(err => {
                  console.error(`[ICHOR SHOWER] Failed to persist to Supabase:`, err);
                });

                // Emit event for commentary system
                this.emit("ichor_shower", {
                  slotIndex: slotIndex ?? 0,
                  rumbleId,
                  winnerId: showerRecipientWallet,
                  amount: recipientAmount,
                });
              } else {
                console.log(
                  `[ICHOR SHOWER] No trigger this time. poolBefore=${poolBefore}, poolAfter=${poolAfter}`,
                );
              }
            } catch (err) {
              console.warn(`[ICHOR SHOWER] Failed to read back shower result:`, err);
            }
          }
        } catch (err) {
          console.error(`[OnChain] checkIchorShower error:`, err);
        }
      }
      ichorSuccess = true;
    } catch (err) {
      console.error(`[OnChain] ICHOR distribution error:`, err);
    }

    // 4-5. completeRumble + sweepTreasury are finalized asynchronously after claim window.
    if (ichorSuccess) {
      this.enqueueRumbleFinalization(rumbleId, rumbleIdNum, ONCHAIN_FINALIZATION_DELAY_MS);
      settlementSucceeded = true;
    }
    } finally {
      this.settlingRumbleIds.delete(rumbleId);
      if (settlementSucceeded) {
        this.settledRumbleIds.set(rumbleId, Date.now());
        this.trimTrackingMaps();
      }
    }
  }

  // ---- Payout phase --------------------------------------------------------

  private payoutProcessed: Set<string> = new Set(); // track rumble IDs already paid out
  private payoutResults: Map<number, PayoutResult> = new Map(); // store payout results for status API
  private transformedPayouts: Map<number, { winnerBettorsPayout: number; placeBettorsPayout: number; showBettorsPayout: number; treasuryVault: number; totalPool: number; ichorMined: number; ichorShowerTriggered: boolean; ichorShowerAmount: number }> = new Map();

  private async handlePayoutPhase(slot: RumbleSlot): Promise<void> {
    const idx = slot.slotIndex;

    // Only process payout once per rumble
    if (this.payoutProcessed.has(slot.id)) return;

    let payoutSucceeded = false;
    try {
      await this.runPayoutPhase(idx);
      payoutSucceeded = true;
    } catch (err) {
      console.error(`[Orchestrator] Payout error for slot ${idx}:`, err);
    } finally {
      if (payoutSucceeded) {
        this.payoutProcessed.add(slot.id);
        this.trimTrackingMaps();
      }
    }
  }

  async stop(): Promise<void> {
    if (this.inflightCleanup.size === 0) return;
    await Promise.allSettled([...this.inflightCleanup]);
  }

  private trackInFlightCleanup<T>(promise: Promise<T>): Promise<T> {
    let tracked: Promise<T>;
    tracked = promise.finally(() => {
      this.inflightCleanup.delete(tracked);
    });
    this.inflightCleanup.add(tracked);
    return tracked;
  }

  async runPayoutPhase(slotIndex: number): Promise<void> {
    const slot = this.queueManager.getSlot(slotIndex);
    if (!slot) return;

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

    // ---- On-chain payout calculation (source of truth) ----
    // Read betting pools and winner directly from the on-chain rumble account.
    // This mirrors the exact math in the claim_payout instruction, ensuring
    // the display numbers match what bettors can actually claim.
    // If the on-chain read fails, we throw so handlePayoutPhase does NOT mark
    // this rumble as processed — it will retry on the next tick.
    const LAMPORTS = 1_000_000_000;
    const TREASURY_CUT_BPS = 1_000; // 10% — matches on-chain constant

    const rumbleIdNum = parseOnchainRumbleIdNumber(slot.id);
    let onchainTotalPool = 0;
    let onchainWinnerBettorsPayout = 0;
    let onchainTreasuryVault = 0;

    if (rumbleIdNum !== null) {
      const rumbleAccount = await readRumbleAccountState(rumbleIdNum);
      if (!rumbleAccount) {
        // Rumble must exist on-chain during payout — null means RPC issue
        console.warn(`[Orchestrator] readRumbleAccountState returned null for ${slot.id} — will retry`);
        throw new Error(`On-chain rumble account unavailable for ${slot.id}`);
      }

      if (rumbleAccount.winnerIndex !== null) {
        const fighterCount = rumbleAccount.fighterCount;

        // Use bettingPools already read from rumbleAccount (avoids duplicate RPC call)
        const onchainPools = rumbleAccount.bettingPools;
        if (!onchainPools || onchainPools.length === 0) {
          console.warn(`[Orchestrator] bettingPools empty for ${slot.id} — will retry`);
          throw new Error(`On-chain betting pools unavailable for ${slot.id}`);
        }

        let losersPool = 0n;
        let firstPool = 0n;

        for (let i = 0; i < fighterCount; i++) {
          const pool = onchainPools[i] ?? 0n;
          const p = rumbleAccount.placements[i] ?? 0;
          if (p === 1) {
            firstPool += pool;
          } else {
            losersPool += pool;
          }
        }

        const totalPoolLamports = firstPool + losersPool;
        const treasuryCut = (losersPool * BigInt(TREASURY_CUT_BPS)) / 10_000n;
        const distributable = losersPool - treasuryCut;

        // Winner-takes-all: all distributable goes to 1st place bettors
        // Total payout for winners = firstPool (stake returned) + distributable
        const winnerPayoutLamports = firstPool + distributable;

        onchainTotalPool = Number(totalPoolLamports) / LAMPORTS;
        onchainWinnerBettorsPayout = Number(winnerPayoutLamports) / LAMPORTS;
        onchainTreasuryVault = Number(treasuryCut) / LAMPORTS;

        console.log(
          `[Orchestrator] On-chain payout for ${slot.id}: totalPool=${onchainTotalPool.toFixed(4)} SOL, winnerPayout=${onchainWinnerBettorsPayout.toFixed(4)} SOL, treasury=${onchainTreasuryVault.toFixed(4)} SOL`,
        );
      }
      // If winnerIndex is null, no winner yet — pools stay at 0
    }

    // Read block reward from on-chain arena config for ICHOR distribution
    const arenaConfig = await readArenaConfig().catch(() => null);
    const rewardLamports = arenaConfig?.effectiveReward ?? 2_500n * 1_000_000_000n;
    const blockReward = Number(rewardLamports) / 1_000_000_000;

    // ICHOR distribution still uses the off-chain calculatePayouts for now,
    // since ICHOR is minted separately from SOL payouts. Populate bets from
    // Supabase so bettor ICHOR shares are calculated correctly.
    const placementIds = placements.map((p) => p.id);
    const minimalPool = createBettingPool(slot.id);
    minimalPool.totalDeployed = onchainTotalPool;
    minimalPool.netPool = onchainTotalPool; // close enough for ICHOR calc

    // Load bets from Supabase for bettor ICHOR distribution
    try {
      const dbBets = await persist.loadBetsForRumble(slot.id);
      for (const row of dbBets) {
        const grossAmount = Number(row.gross_amount ?? 0);
        const netAmount = Number(row.net_amount ?? 0);
        if (grossAmount <= 0) continue;
        minimalPool.bets.push({
          bettorId: String(row.wallet_address),
          fighterId: String(row.fighter_id),
          grossAmount,
          solAmount: netAmount > 0 ? netAmount : grossAmount * (1 - ADMIN_FEE_RATE - SPONSORSHIP_RATE),
          timestamp: new Date(),
        });
      }
    } catch (err) {
      console.warn(`[Orchestrator] Failed to load bets from DB for ICHOR calc:`, err);
    }
    const payoutResult = calculatePayouts(
      minimalPool,
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
      try {
        await persist.updateIchorShowerPool(showerPoolIncrement);
      } catch (err) {
        console.error(`[Orchestrator] Failed to persist ICHOR shower pool for ${slot.id}:`, err);
      }
    }

    // Persist: increment aggregate stats
    try {
      await persist.incrementStats(
        onchainTotalPool,
        payoutResult.ichorDistribution.totalMined,
        0,
      );
    } catch (err) {
      console.error(`[Orchestrator] Failed to increment stats for ${slot.id}:`, err);
    }

    // Store payout result for status API
    this.payoutResults.set(slotIndex, payoutResult);

    // Build payout info from on-chain data (the source of truth for SOL amounts).
    // Stored both in-memory (for Railway status API) and persisted to Supabase (for Vercel).
    const transformedPayout = {
      winnerBettorsPayout: onchainWinnerBettorsPayout,
      placeBettorsPayout: 0,
      showBettorsPayout: 0,
      treasuryVault: onchainTreasuryVault,
      totalPool: onchainTotalPool,
      ichorMined: payoutResult.ichorDistribution.totalMined,
      ichorShowerTriggered: false,
      ichorShowerAmount: 0,
    };
    this.transformedPayouts.set(slotIndex, transformedPayout);
    try {
      await persist.savePayoutResult(slot.id, transformedPayout);
    } catch (err) {
      // Clean up in-memory state and throw so handlePayoutPhase retries
      this.transformedPayouts.delete(slotIndex);
      this.payoutResults.delete(slotIndex);
      console.error(`[Orchestrator] Failed to persist payout result for ${slot.id} — will retry:`, err);
      throw err;
    }

    console.log(`[Orchestrator] Payout for ${slot.id}:`, {
      totalPool: onchainTotalPool.toFixed(4),
      winnerBettorsPayout: onchainWinnerBettorsPayout.toFixed(4),
      treasuryVault: onchainTreasuryVault.toFixed(4),
      ichorMined: payoutResult.ichorDistribution.totalMined.toFixed(2),
    });

    this.emit("payout_complete", {
      slotIndex,
      rumbleId: slot.id,
      payout: transformedPayout,
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

    // Requeue fighters with autoRequeue.
    // Check both the in-memory map AND the DB flag — the in-memory map may
    // be empty after a cold restart (recovery doesn't populate it).
    let requeueSet = this.autoRequeueFighters.get(slotIndex);
    if (!requeueSet || requeueSet.size === 0) {
      // Fallback: check the DB for auto_requeue flags
      const dbFlags = await persist.loadAutoRequeueFlags(slot.fighters);
      if (dbFlags.size > 0) requeueSet = dbFlags;
    }
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

    // Note: DB status stays "payout" until handleSlotRecycled sets "complete"
    // after PAYOUT_DURATION_MS, giving Vercel status API time to read payout data.

    this.cleanupSlot(slotIndex, slot.id);
  }

  // ---- Rebuild betting pool from DB or on-chain ----------------------------

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
    const cleanup = (async () => {
      // Mark rumble as "complete" in DB now that payout display window is over.
      // Even if DB write fails, continue cleaning up in-memory state to prevent
      // stale maps from blocking future slots.
      try {
        await persist.updateRumbleStatus(previousRumbleId, "complete");
      } catch (err) {
        console.error(
          `[Orchestrator] Failed to persist payout-complete status for ${previousRumbleId} (continuing cleanup):`,
          err,
        );
      }

      this.payoutProcessed.delete(previousRumbleId);
      this.onchainRumbleCreateRetryAt.delete(previousRumbleId);
      this.onchainRumbleCreateStartedAt.delete(previousRumbleId);
      this.clearOnchainCreateFailure(previousRumbleId);
      this.combatStates.delete(slotIndex);
      this.payoutResults.delete(slotIndex);
      this.transformedPayouts.delete(slotIndex);
      this.trimTrackingMaps();

      this.emit("slot_recycled", {
        slotIndex,
        previousFighters,
      });
    })();

    this.trackInFlightCleanup(cleanup);
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
        slot.state === "combat" && combatState && !ONCHAIN_TURN_AUTHORITY
          ? new Date(Math.max(now, combatState.lastTickAt + LEGACY_COMBAT_TICK_INTERVAL_MS))
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
        turnIntervalMs:
          slot.state === "combat" && combatState && !ONCHAIN_TURN_AUTHORITY
            ? LEGACY_COMBAT_TICK_INTERVAL_MS
            : null,
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
   * Find the slot index for a given rumble ID.
   */
  private findSlotIndexByRumbleId(rumbleId: string): number | null {
    const slots = this.queueManager.getSlots();
    for (const slot of slots) {
      if (slot.id === rumbleId) return slot.slotIndex;
    }
    return null;
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

  /**
   * Get the transformed payout (on-chain SOL amounts) for a slot.
   * Used by the status API to display correct payout numbers.
   */
  getTransformedPayout(slotIndex: number): { winnerBettorsPayout: number; placeBettorsPayout: number; showBettorsPayout: number; treasuryVault: number; totalPool: number; ichorMined: number; ichorShowerTriggered: boolean; ichorShowerAmount: number } | null {
    return this.transformedPayouts.get(slotIndex) ?? null;
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
  __rumbleCommentaryHookRegistered?: boolean;
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
  // Register shared commentary hook once (Railway worker pre-generates audio)
  if (!g.__rumbleCommentaryHookRegistered) {
    g.__rumbleCommentaryHookRegistered = true;
    import("./commentary-hook")
      .then(({ registerCommentaryHook }) => registerCommentaryHook(g.__rumbleOrchestrator!))
      .catch((err) => console.warn("[Orchestrator] Commentary hook registration failed:", err));
  }
  return g.__rumbleOrchestrator;
}

export function resetOrchestrator(): void {
  if (g.__rumbleAutoTickTimer) {
    clearInterval(g.__rumbleAutoTickTimer);
    g.__rumbleAutoTickTimer = undefined;
  }
  g.__rumbleOrchestrator = undefined;
}
