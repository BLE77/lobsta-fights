#!/usr/bin/env npx tsx
/**
 * ╔══════════════════════════════════════════════╗
 * ║  UCF VERIFIER BOT — Level 2 Security Audit  ║
 * ╠══════════════════════════════════════════════╣
 * ║  Independently verifies all combat results   ║
 * ║  by replaying math from on-chain data.       ║
 * ║  Zero imports from project code.             ║
 * ╚══════════════════════════════════════════════╝
 *
 * Usage:
 *   npx tsx scripts/verifier-bot.ts --rumble-id 42
 *   npx tsx scripts/verifier-bot.ts --watch
 *   npx tsx scripts/verifier-bot.ts --rumble-id 42 --rpc https://api.devnet.solana.com
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { createHash } from "crypto";

// ─── Program & Network ──────────────────────────────────────────────────────

const PROGRAM_ID = new PublicKey("2TvW4EfbmMe566ZQWZWd8kX34iFR2DM3oBUpjwpRJcqC");

const DEFAULT_RPC = process.env.NEXT_PUBLIC_HELIUS_API_KEY
  ? `https://devnet.helius-rpc.com/?api-key=${process.env.NEXT_PUBLIC_HELIUS_API_KEY}`
  : "https://api.devnet.solana.com";

// ─── Combat Constants (exact match with on-chain lib.rs) ────────────────────

const MOVE_HIGH_STRIKE = 0;
const MOVE_MID_STRIKE = 1;
const MOVE_LOW_STRIKE = 2;
const MOVE_GUARD_HIGH = 3;
const MOVE_GUARD_MID = 4;
const MOVE_GUARD_LOW = 5;
const MOVE_DODGE = 6;
const MOVE_CATCH = 7;
const MOVE_SPECIAL = 8;

const STRIKE_DAMAGE_HIGH = 26;
const STRIKE_DAMAGE_MID = 20;
const STRIKE_DAMAGE_LOW = 15;
const CATCH_DAMAGE = 30;
const COUNTER_DAMAGE = 12;
const SPECIAL_DAMAGE = 35;

const METER_PER_TURN = 20;
const SPECIAL_METER_COST = 100;
const START_HP = 100;
const MAX_FIGHTERS = 16;

const MOVE_NAMES = [
  "HIGH_STRIKE",
  "MID_STRIKE",
  "LOW_STRIKE",
  "GUARD_HIGH",
  "GUARD_MID",
  "GUARD_LOW",
  "DODGE",
  "CATCH",
  "SPECIAL",
] as const;

// ─── PDA Seeds ──────────────────────────────────────────────────────────────

const SEED_RUMBLE = Buffer.from("rumble");
const SEED_COMBAT_STATE = Buffer.from("combat_state");
const SEED_MOVE_COMMIT = Buffer.from("move_commit");

// ─── Account discriminators (sha256("account:<Name>")[0..8]) ────────────────

const DISC_RUMBLE = Buffer.from([121, 136, 74, 188, 164, 146, 171, 5]);
const DISC_COMBAT_STATE = Buffer.from([81, 24, 234, 237, 157, 188, 177, 99]);
const DISC_MOVE_COMMITMENT = Buffer.from([86, 55, 88, 157, 101, 93, 13, 220]);

// ─── Borsh enum: RumbleState ────────────────────────────────────────────────

const RUMBLE_STATE_BETTING = 0;
const RUMBLE_STATE_COMBAT = 1;
const RUMBLE_STATE_PAYOUT = 2;
const RUMBLE_STATE_COMPLETE = 3;

const STATE_NAMES: Record<number, string> = {
  [RUMBLE_STATE_BETTING]: "Betting",
  [RUMBLE_STATE_COMBAT]: "Combat",
  [RUMBLE_STATE_PAYOUT]: "Payout",
  [RUMBLE_STATE_COMPLETE]: "Complete",
};

// ─── Types ──────────────────────────────────────────────────────────────────

interface RumbleAccount {
  id: bigint;
  state: number;
  fighters: PublicKey[];
  fighterCount: number;
}

interface CombatStateAccount {
  rumbleId: bigint;
  fighterCount: number;
  currentTurn: number;
  turnOpenSlot: bigint;
  commitCloseSlot: bigint;
  revealCloseSlot: bigint;
  turnResolved: boolean;
  remainingFighters: number;
  winnerIndex: number;
  hp: number[];
  meter: number[];
  eliminationRank: number[];
  totalDamageDealt: bigint[];
  totalDamageTaken: bigint[];
  bump: number;
}

interface MoveCommitmentAccount {
  rumbleId: bigint;
  fighter: PublicKey;
  turn: number;
  moveHash: Uint8Array;
  revealedMove: number;
  revealed: boolean;
  committedSlot: bigint;
  revealedSlot: bigint;
  bump: number;
}

interface DuelRecord {
  idxA: number;
  idxB: number;
  moveA: number;
  moveB: number;
  moveASource: "revealed" | "fallback";
  moveBSource: "revealed" | "fallback";
  damageToA: number;
  damageToB: number;
}

interface TurnResult {
  turn: number;
  duels: DuelRecord[];
  byeIndex: number | null;
  hpAfter: number[];
  meterAfter: number[];
  eliminationRankAfter: number[];
  remainingAfter: number;
}

// ─── Crypto Utilities ───────────────────────────────────────────────────────

/** Replicates the on-chain hash_u64: SHA256(concat(parts))[0..8] as u64 LE */
function hashU64(parts: Buffer[]): bigint {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  const digest = h.digest();
  return digest.readBigUInt64LE(0);
}

function u64LeBuffer(v: bigint | number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(v));
  return buf;
}

function u32LeBuffer(v: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(v >>> 0);
  return buf;
}

// ─── PDA Derivation ─────────────────────────────────────────────────────────

function deriveRumblePda(rumbleId: bigint): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [SEED_RUMBLE, u64LeBuffer(rumbleId)],
    PROGRAM_ID,
  );
  return pda;
}

function deriveCombatStatePda(rumbleId: bigint): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [SEED_COMBAT_STATE, u64LeBuffer(rumbleId)],
    PROGRAM_ID,
  );
  return pda;
}

function deriveMoveCommitmentPda(
  rumbleId: bigint,
  fighter: PublicKey,
  turn: number,
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [SEED_MOVE_COMMIT, u64LeBuffer(rumbleId), fighter.toBuffer(), u32LeBuffer(turn)],
    PROGRAM_ID,
  );
  return pda;
}

// ─── Account Parsing (raw Borsh, no Anchor SDK) ────────────────────────────

function parseRumbleAccount(data: Buffer): RumbleAccount {
  // Validate discriminator
  if (!data.subarray(0, 8).equals(DISC_RUMBLE)) {
    throw new Error("Invalid Rumble account discriminator");
  }
  let offset = 8;

  const id = data.readBigUInt64LE(offset);
  offset += 8;

  const state = data.readUInt8(offset);
  offset += 1;

  const fighters: PublicKey[] = [];
  for (let i = 0; i < MAX_FIGHTERS; i++) {
    fighters.push(new PublicKey(data.subarray(offset, offset + 32)));
    offset += 32;
  }

  const fighterCount = data.readUInt8(offset);

  return { id, state, fighters: fighters.slice(0, fighterCount), fighterCount };
}

function parseCombatStateAccount(data: Buffer): CombatStateAccount {
  if (!data.subarray(0, 8).equals(DISC_COMBAT_STATE)) {
    throw new Error("Invalid CombatState account discriminator");
  }
  let offset = 8;

  const rumbleId = data.readBigUInt64LE(offset); offset += 8;
  const fighterCount = data.readUInt8(offset); offset += 1;
  const currentTurn = data.readUInt32LE(offset); offset += 4;
  const turnOpenSlot = data.readBigUInt64LE(offset); offset += 8;
  const commitCloseSlot = data.readBigUInt64LE(offset); offset += 8;
  const revealCloseSlot = data.readBigUInt64LE(offset); offset += 8;
  const turnResolved = data.readUInt8(offset) !== 0; offset += 1;
  const remainingFighters = data.readUInt8(offset); offset += 1;
  const winnerIndex = data.readUInt8(offset); offset += 1;

  const hp: number[] = [];
  for (let i = 0; i < MAX_FIGHTERS; i++) {
    hp.push(data.readUInt16LE(offset)); offset += 2;
  }

  const meter: number[] = [];
  for (let i = 0; i < MAX_FIGHTERS; i++) {
    meter.push(data.readUInt8(offset)); offset += 1;
  }

  const eliminationRank: number[] = [];
  for (let i = 0; i < MAX_FIGHTERS; i++) {
    eliminationRank.push(data.readUInt8(offset)); offset += 1;
  }

  const totalDamageDealt: bigint[] = [];
  for (let i = 0; i < MAX_FIGHTERS; i++) {
    totalDamageDealt.push(data.readBigUInt64LE(offset)); offset += 8;
  }

  const totalDamageTaken: bigint[] = [];
  for (let i = 0; i < MAX_FIGHTERS; i++) {
    totalDamageTaken.push(data.readBigUInt64LE(offset)); offset += 8;
  }

  const bump = data.readUInt8(offset);

  return {
    rumbleId, fighterCount, currentTurn, turnOpenSlot, commitCloseSlot,
    revealCloseSlot, turnResolved, remainingFighters, winnerIndex,
    hp, meter, eliminationRank, totalDamageDealt, totalDamageTaken, bump,
  };
}

function parseMoveCommitmentAccount(data: Buffer): MoveCommitmentAccount | null {
  if (data.length < 103) return null;
  if (!data.subarray(0, 8).equals(DISC_MOVE_COMMITMENT)) return null;

  let offset = 8;
  const rumbleId = data.readBigUInt64LE(offset); offset += 8;
  const fighter = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
  const turn = data.readUInt32LE(offset); offset += 4;
  const moveHash = new Uint8Array(data.subarray(offset, offset + 32)); offset += 32;
  const revealedMove = data.readUInt8(offset); offset += 1;
  const revealed = data.readUInt8(offset) !== 0; offset += 1;
  const committedSlot = data.readBigUInt64LE(offset); offset += 8;
  const revealedSlot = data.readBigUInt64LE(offset); offset += 8;
  const bump = data.readUInt8(offset);

  return {
    rumbleId, fighter, turn, moveHash, revealedMove, revealed,
    committedSlot, revealedSlot, bump,
  };
}

// ─── Combat Logic (exact replica of on-chain Rust) ──────────────────────────

function isStrike(m: number): boolean {
  return m === MOVE_HIGH_STRIKE || m === MOVE_MID_STRIKE || m === MOVE_LOW_STRIKE;
}

function guardForStrike(m: number): number | null {
  if (m === MOVE_HIGH_STRIKE) return MOVE_GUARD_HIGH;
  if (m === MOVE_MID_STRIKE) return MOVE_GUARD_MID;
  if (m === MOVE_LOW_STRIKE) return MOVE_GUARD_LOW;
  return null;
}

function strikeDamage(m: number): number {
  if (m === MOVE_HIGH_STRIKE) return STRIKE_DAMAGE_HIGH;
  if (m === MOVE_MID_STRIKE) return STRIKE_DAMAGE_MID;
  if (m === MOVE_LOW_STRIKE) return STRIKE_DAMAGE_LOW;
  return 0;
}

function isValidMoveCode(m: number): boolean {
  return m >= 0 && m <= 8;
}

/**
 * Exact replica of on-chain resolve_duel().
 * Returns [damageToA, damageToB, meterUsedA, meterUsedB].
 */
function resolveDuel(
  moveA: number,
  moveB: number,
  meterA: number,
  meterB: number,
): [number, number, number, number] {
  let damageToA = 0;
  let damageToB = 0;
  let meterUsedA = 0;
  let meterUsedB = 0;

  const aSpecial = moveA === MOVE_SPECIAL && meterA >= SPECIAL_METER_COST;
  const bSpecial = moveB === MOVE_SPECIAL && meterB >= SPECIAL_METER_COST;
  if (aSpecial) meterUsedA = SPECIAL_METER_COST;
  if (bSpecial) meterUsedB = SPECIAL_METER_COST;

  // Fizzled special → u8::MAX (255), effectively "no move"
  const effectiveA = moveA === MOVE_SPECIAL && !aSpecial ? 255 : moveA;
  const effectiveB = moveB === MOVE_SPECIAL && !bSpecial ? 255 : moveB;

  // ── A attacks B ──
  if (effectiveA === MOVE_SPECIAL) {
    if (effectiveB !== MOVE_DODGE) damageToB = SPECIAL_DAMAGE;
  } else if (effectiveA === MOVE_CATCH) {
    if (effectiveB === MOVE_DODGE) damageToB = CATCH_DAMAGE;
  } else if (isStrike(effectiveA)) {
    if (effectiveB === MOVE_DODGE) {
      // dodged
    } else if (guardForStrike(effectiveA) === effectiveB) {
      damageToA = COUNTER_DAMAGE;
    } else {
      damageToB = strikeDamage(effectiveA);
    }
  }

  // ── B attacks A ──
  if (effectiveB === MOVE_SPECIAL) {
    if (effectiveA !== MOVE_DODGE) damageToA = SPECIAL_DAMAGE;
  } else if (effectiveB === MOVE_CATCH) {
    if (effectiveA === MOVE_DODGE) damageToA = CATCH_DAMAGE;
  } else if (isStrike(effectiveB)) {
    if (effectiveA === MOVE_DODGE) {
      // dodged
    } else if (guardForStrike(effectiveB) === effectiveA) {
      damageToB = COUNTER_DAMAGE;
    } else {
      damageToA = strikeDamage(effectiveB);
    }
  }

  return [damageToA, damageToB, meterUsedA, meterUsedB];
}

/**
 * Exact replica of on-chain fallback_move_code().
 * Uses the multi-hash approach: "fallback-move" for roll, then
 * "fallback-strike" or "fallback-guard" sub-hashes for specific move selection.
 */
function fallbackMoveCode(
  rumbleId: bigint,
  turn: number,
  fighter: PublicKey,
  meter: number,
): number {
  const ridBuf = u64LeBuffer(rumbleId);
  const turnBuf = u32LeBuffer(turn);
  const fighterBuf = fighter.toBuffer();

  const roll = Number(
    hashU64([Buffer.from("fallback-move"), ridBuf, turnBuf, fighterBuf]) % BigInt(100),
  );

  if (meter >= SPECIAL_METER_COST && roll < 15) return MOVE_SPECIAL;

  if (roll < 67) {
    const strikeIdx = Number(
      hashU64([Buffer.from("fallback-strike"), ridBuf, turnBuf, fighterBuf]) % BigInt(3),
    );
    return [MOVE_HIGH_STRIKE, MOVE_MID_STRIKE, MOVE_LOW_STRIKE][strikeIdx];
  }

  if (roll < 87) {
    const guardIdx = Number(
      hashU64([Buffer.from("fallback-guard"), ridBuf, turnBuf, fighterBuf]) % BigInt(3),
    );
    return [MOVE_GUARD_HIGH, MOVE_GUARD_MID, MOVE_GUARD_LOW][guardIdx];
  }

  if (roll < 95) return MOVE_DODGE;
  return MOVE_CATCH;
}

/**
 * Compute pairing order: sort alive indices by hash_u64("pair-order" || ...)
 * with tiebreak by pubkey bytes. Exact replica of on-chain.
 */
function computePairOrder(
  aliveIndices: number[],
  rumbleId: bigint,
  turn: number,
  fighters: PublicKey[],
): number[] {
  const ridBuf = u64LeBuffer(rumbleId);
  const turnBuf = u32LeBuffer(turn);
  const pairOrderPrefix = Buffer.from("pair-order");

  const sorted = [...aliveIndices].sort((a, b) => {
    const keyA = hashU64([pairOrderPrefix, ridBuf, turnBuf, fighters[a].toBuffer()]);
    const keyB = hashU64([pairOrderPrefix, ridBuf, turnBuf, fighters[b].toBuffer()]);
    if (keyA < keyB) return -1;
    if (keyA > keyB) return 1;
    // Tiebreak: compare pubkey bytes lexicographically
    const bytesA = fighters[a].toBuffer();
    const bytesB = fighters[b].toBuffer();
    return Buffer.compare(bytesA, bytesB);
  });

  return sorted;
}

function moveName(m: number): string {
  return MOVE_NAMES[m] ?? `UNKNOWN(${m})`;
}

// ─── Network Helpers ────────────────────────────────────────────────────────

async function fetchAccountData(
  conn: Connection,
  address: PublicKey,
): Promise<Buffer | null> {
  const info = await conn.getAccountInfo(address, "confirmed");
  if (!info || !info.data) return null;
  return Buffer.from(info.data);
}

async function fetchMoveCommitment(
  conn: Connection,
  rumbleId: bigint,
  fighter: PublicKey,
  turn: number,
): Promise<MoveCommitmentAccount | null> {
  const pda = deriveMoveCommitmentPda(rumbleId, fighter, turn);
  const data = await fetchAccountData(conn, pda);
  if (!data) return null;
  return parseMoveCommitmentAccount(data);
}

/**
 * Batch-fetch all MoveCommitment PDAs for a set of fighters in a single
 * getMultipleAccountsInfo call.
 */
async function batchFetchMoveCommitments(
  conn: Connection,
  rumbleId: bigint,
  fighters: PublicKey[],
  indices: number[],
  turn: number,
): Promise<Map<number, MoveCommitmentAccount>> {
  const pdas = indices.map((idx) =>
    deriveMoveCommitmentPda(rumbleId, fighters[idx], turn),
  );
  const accounts = await conn.getMultipleAccountsInfo(pdas, "confirmed");

  const result = new Map<number, MoveCommitmentAccount>();
  for (let i = 0; i < indices.length; i++) {
    const accInfo = accounts[i];
    if (!accInfo || !accInfo.data) continue;
    const parsed = parseMoveCommitmentAccount(Buffer.from(accInfo.data));
    if (parsed && parsed.revealed) {
      result.set(indices[i], parsed);
    }
  }
  return result;
}

// ─── Turn Replay Engine ─────────────────────────────────────────────────────

/**
 * Replays a single turn using the exact on-chain algorithm.
 * Takes mutable copies of hp/meter/eliminationRank/remainingFighters and
 * returns the mutations.
 */
function replayTurn(
  turn: number,
  rumbleId: bigint,
  fighters: PublicKey[],
  fighterCount: number,
  hp: number[],
  meter: number[],
  eliminationRank: number[],
  remainingFighters: number,
  moveCommitments: Map<number, MoveCommitmentAccount>,
): TurnResult {
  // 1. Get alive indices
  const aliveIndices = [];
  for (let i = 0; i < fighterCount; i++) {
    if (hp[i] > 0 && eliminationRank[i] === 0) {
      aliveIndices.push(i);
    }
  }

  // 2. Sort by pair-order hash
  const sorted = computePairOrder(aliveIndices, rumbleId, turn, fighters);

  // 3. Process duels
  const duels: DuelRecord[] = [];
  const pairedIndices: number[] = [];
  const eliminatedThisTurn: number[] = [];
  let byeIndex: number | null = null;

  for (let c = 0; c + 1 < sorted.length; c += 2) {
    const idxA = sorted[c];
    const idxB = sorted[c + 1];

    // Determine moves
    const commitA = moveCommitments.get(idxA);
    const commitB = moveCommitments.get(idxB);

    let moveA: number;
    let moveASource: "revealed" | "fallback";
    if (commitA && commitA.revealed && isValidMoveCode(commitA.revealedMove)) {
      moveA = commitA.revealedMove;
      moveASource = "revealed";
    } else {
      moveA = fallbackMoveCode(rumbleId, turn, fighters[idxA], meter[idxA]);
      moveASource = "fallback";
    }

    let moveB: number;
    let moveBSource: "revealed" | "fallback";
    if (commitB && commitB.revealed && isValidMoveCode(commitB.revealedMove)) {
      moveB = commitB.revealedMove;
      moveBSource = "revealed";
    } else {
      moveB = fallbackMoveCode(rumbleId, turn, fighters[idxB], meter[idxB]);
      moveBSource = "fallback";
    }

    // Resolve duel
    const [damageToA, damageToB, meterUsedA, meterUsedB] = resolveDuel(
      moveA, moveB, meter[idxA], meter[idxB],
    );

    // Apply meter usage
    meter[idxA] = Math.max(0, meter[idxA] - meterUsedA);
    meter[idxB] = Math.max(0, meter[idxB] - meterUsedB);

    // Apply damage
    hp[idxA] = Math.max(0, hp[idxA] - damageToA);
    hp[idxB] = Math.max(0, hp[idxB] - damageToB);

    pairedIndices.push(idxA, idxB);

    duels.push({
      idxA, idxB, moveA, moveB, moveASource, moveBSource, damageToA, damageToB,
    });

    // Track eliminations
    if (hp[idxA] === 0 && eliminationRank[idxA] === 0) {
      eliminatedThisTurn.push(idxA);
    }
    if (hp[idxB] === 0 && eliminationRank[idxB] === 0) {
      eliminatedThisTurn.push(idxB);
    }
  }

  // Bye fighter (odd count → last in sorted array)
  if (sorted.length % 2 === 1) {
    byeIndex = sorted[sorted.length - 1];
  }

  // 4. Post-duel meter gains for paired survivors
  for (const idx of pairedIndices) {
    if (hp[idx] > 0) {
      meter[idx] = Math.min(meter[idx] + METER_PER_TURN, SPECIAL_METER_COST);
    }
  }

  // 5. Bye fighter meter
  if (byeIndex !== null) {
    meter[byeIndex] = Math.min(meter[byeIndex] + METER_PER_TURN, SPECIAL_METER_COST);
  }

  // 6. Process eliminations
  for (const idx of eliminatedThisTurn) {
    if (eliminationRank[idx] > 0) continue;
    const eliminatedSoFar = fighterCount - remainingFighters;
    eliminationRank[idx] = eliminatedSoFar + 1;
    remainingFighters -= 1;
  }

  return {
    turn,
    duels,
    byeIndex,
    hpAfter: [...hp],
    meterAfter: [...meter],
    eliminationRankAfter: [...eliminationRank],
    remainingAfter: remainingFighters,
  };
}

// ─── Verification Engine ────────────────────────────────────────────────────

interface VerificationResult {
  rumbleId: bigint;
  fighterCount: number;
  turnsPlayed: number;
  turnResults: TurnResult[];
  hpMatch: boolean;
  meterMatch: boolean;
  eliminationMatch: boolean;
  damageDealtMatch: boolean;
  damageTakenMatch: boolean;
  allMatch: boolean;
  hpDiffs: string[];
  meterDiffs: string[];
  eliminationDiffs: string[];
  damageDealtDiffs: string[];
  damageTakenDiffs: string[];
}

async function verifyRumble(
  conn: Connection,
  rumbleId: bigint,
): Promise<VerificationResult> {
  // Fetch Rumble account
  const rumblePda = deriveRumblePda(rumbleId);
  const rumbleData = await fetchAccountData(conn, rumblePda);
  if (!rumbleData) {
    throw new Error(`Rumble #${rumbleId} account not found at ${rumblePda.toBase58()}`);
  }
  const rumble = parseRumbleAccount(rumbleData);

  // Fetch CombatState account
  const combatPda = deriveCombatStatePda(rumbleId);
  const combatData = await fetchAccountData(conn, combatPda);
  if (!combatData) {
    throw new Error(`CombatState for rumble #${rumbleId} not found at ${combatPda.toBase58()}`);
  }
  const combat = parseCombatStateAccount(combatData);

  const turnsPlayed = combat.currentTurn;
  const fighterCount = rumble.fighterCount;

  // Initialize running state (mirrors on-chain init_combat)
  const hp = new Array(MAX_FIGHTERS).fill(0);
  const meter = new Array(MAX_FIGHTERS).fill(0);
  const eliminationRank = new Array(MAX_FIGHTERS).fill(0);
  const totalDamageDealt = new Array(MAX_FIGHTERS).fill(BigInt(0)) as bigint[];
  const totalDamageTaken = new Array(MAX_FIGHTERS).fill(BigInt(0)) as bigint[];
  let remainingFighters = fighterCount;

  for (let i = 0; i < fighterCount; i++) {
    hp[i] = START_HP;
  }

  // Replay each turn
  const turnResults: TurnResult[] = [];

  for (let t = 1; t <= turnsPlayed; t++) {
    // Fetch move commitments for all alive fighters this turn
    const aliveIndices = [];
    for (let i = 0; i < fighterCount; i++) {
      if (hp[i] > 0 && eliminationRank[i] === 0) aliveIndices.push(i);
    }

    const moveCommitments = await batchFetchMoveCommitments(
      conn, rumbleId, rumble.fighters, aliveIndices, t,
    );

    // Track damage before this turn
    const hpBefore = [...hp];

    const result = replayTurn(
      t, rumbleId, rumble.fighters, fighterCount,
      hp, meter, eliminationRank, remainingFighters, moveCommitments,
    );

    // Track damage dealt/taken for verification
    for (const duel of result.duels) {
      totalDamageDealt[duel.idxA] += BigInt(duel.damageToB); // A dealt damageToB to B
      totalDamageDealt[duel.idxB] += BigInt(duel.damageToA); // B dealt damageToA to A
      totalDamageTaken[duel.idxA] += BigInt(duel.damageToA);
      totalDamageTaken[duel.idxB] += BigInt(duel.damageToB);
    }

    remainingFighters = result.remainingAfter;
    turnResults.push(result);
  }

  // Compare final state with on-chain
  const hpDiffs: string[] = [];
  const meterDiffs: string[] = [];
  const eliminationDiffs: string[] = [];
  const damageDealtDiffs: string[] = [];
  const damageTakenDiffs: string[] = [];

  for (let i = 0; i < fighterCount; i++) {
    if (hp[i] !== combat.hp[i]) {
      hpDiffs.push(`  [${i}] expected HP=${hp[i]}, on-chain HP=${combat.hp[i]}`);
    }
    if (meter[i] !== combat.meter[i]) {
      meterDiffs.push(`  [${i}] expected meter=${meter[i]}, on-chain meter=${combat.meter[i]}`);
    }
    if (eliminationRank[i] !== combat.eliminationRank[i]) {
      eliminationDiffs.push(
        `  [${i}] expected rank=${eliminationRank[i]}, on-chain rank=${combat.eliminationRank[i]}`,
      );
    }
    if (BigInt(totalDamageDealt[i]) !== BigInt(combat.totalDamageDealt[i])) {
      damageDealtDiffs.push(
        `  [${i}] expected dealt=${totalDamageDealt[i]}, on-chain dealt=${combat.totalDamageDealt[i]}`,
      );
    }
    if (BigInt(totalDamageTaken[i]) !== BigInt(combat.totalDamageTaken[i])) {
      damageTakenDiffs.push(
        `  [${i}] expected taken=${totalDamageTaken[i]}, on-chain taken=${combat.totalDamageTaken[i]}`,
      );
    }
  }

  const hpMatch = hpDiffs.length === 0;
  const meterMatch = meterDiffs.length === 0;
  const eliminationMatch = eliminationDiffs.length === 0;
  const damageDealtMatch = damageDealtDiffs.length === 0;
  const damageTakenMatch = damageTakenDiffs.length === 0;
  const allMatch = hpMatch && meterMatch && eliminationMatch && damageDealtMatch && damageTakenMatch;

  return {
    rumbleId, fighterCount, turnsPlayed, turnResults,
    hpMatch, meterMatch, eliminationMatch, damageDealtMatch, damageTakenMatch,
    allMatch, hpDiffs, meterDiffs, eliminationDiffs, damageDealtDiffs, damageTakenDiffs,
  };
}

// ─── Display / Formatting ───────────────────────────────────────────────────

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  bgRed: "\x1b[41m",
  bgGreen: "\x1b[42m",
};

function ok(msg: string): string {
  return `${C.green}\u2713${C.reset} ${msg}`;
}

function fail(msg: string): string {
  return `${C.red}\u2717${C.reset} ${msg}`;
}

function printBanner(): void {
  console.log(`
${C.cyan}${C.bold}\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557
\u2551  UCF VERIFIER BOT \u2014 Level 2 Security Audit  \u2551
\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d${C.reset}
`);
}

function printResult(result: VerificationResult): void {
  const { rumbleId, fighterCount, turnsPlayed, turnResults, allMatch } = result;

  console.log(
    `${C.bold}Rumble #${rumbleId}${C.reset} \u2014 ${fighterCount} fighters, ${turnsPlayed} turns played\n`,
  );

  for (const tr of turnResults) {
    const duelCount = tr.duels.length;
    const byeStr = tr.byeIndex !== null ? `1 bye [${tr.byeIndex}]` : "0 byes";
    console.log(
      `${C.bold}Turn ${tr.turn}${C.reset} (${duelCount} duel${duelCount !== 1 ? "s" : ""}, ${byeStr}):`,
    );

    for (const d of tr.duels) {
      const moveAStr = moveName(d.moveA);
      const moveBStr = moveName(d.moveB);
      const srcA = d.moveASource === "fallback" ? `${C.dim}(fb)${C.reset}` : "";
      const srcB = d.moveBSource === "fallback" ? `${C.dim}(fb)${C.reset}` : "";

      let dmgStr: string;
      if (d.damageToA === 0 && d.damageToB === 0) {
        dmgStr = "0 dmg to both";
      } else {
        const parts: string[] = [];
        if (d.damageToA > 0) parts.push(`${d.damageToA} to [${d.idxA}]`);
        if (d.damageToB > 0) parts.push(`${d.damageToB} to [${d.idxB}]`);
        dmgStr = parts.join(", ");
      }

      console.log(
        `  [${d.idxA}] vs [${d.idxB}]: ${moveAStr}${srcA} vs ${moveBStr}${srcB} \u2192 ${dmgStr}`,
      );
    }

    if (tr.byeIndex !== null) {
      console.log(`  [${tr.byeIndex}]: bye (meter +${METER_PER_TURN})`);
    }

    console.log();
  }

  // Final comparison
  console.log(`${C.bold}\u2550\u2550\u2550 Final State Comparison \u2550\u2550\u2550${C.reset}\n`);

  console.log(result.hpMatch ? ok("HP array matches on-chain") : fail("HP MISMATCH"));
  if (!result.hpMatch) result.hpDiffs.forEach((d) => console.log(`    ${C.red}${d}${C.reset}`));

  console.log(result.meterMatch ? ok("Meter array matches on-chain") : fail("Meter MISMATCH"));
  if (!result.meterMatch) result.meterDiffs.forEach((d) => console.log(`    ${C.red}${d}${C.reset}`));

  console.log(
    result.eliminationMatch
      ? ok("Elimination ranks match on-chain")
      : fail("Elimination rank MISMATCH"),
  );
  if (!result.eliminationMatch)
    result.eliminationDiffs.forEach((d) => console.log(`    ${C.red}${d}${C.reset}`));

  console.log(
    result.damageDealtMatch
      ? ok("Damage dealt matches on-chain")
      : fail("Damage dealt MISMATCH"),
  );
  if (!result.damageDealtMatch)
    result.damageDealtDiffs.forEach((d) => console.log(`    ${C.red}${d}${C.reset}`));

  console.log(
    result.damageTakenMatch
      ? ok("Damage taken matches on-chain")
      : fail("Damage taken MISMATCH"),
  );
  if (!result.damageTakenMatch)
    result.damageTakenDiffs.forEach((d) => console.log(`    ${C.red}${d}${C.reset}`));

  console.log();
  console.log(
    `${C.bold}\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550${C.reset}`,
  );
  if (allMatch) {
    console.log(
      `${C.bgGreen}${C.bold} VERDICT: ALL ${turnsPlayed} TURNS VERIFIED \u2713 ${C.reset}`,
    );
  } else {
    console.log(
      `${C.bgRed}${C.bold} VERDICT: DISCREPANCY DETECTED \u2717 ${C.reset}`,
    );
  }
  console.log(
    `${C.bold}\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550${C.reset}`,
  );
  console.log();
}

// ─── Watch Mode ─────────────────────────────────────────────────────────────

async function findActiveRumbles(conn: Connection): Promise<bigint[]> {
  // Use getProgramAccounts with memcmp filter: state byte = Combat (1) at offset 16
  const accounts = await conn.getProgramAccounts(PROGRAM_ID, {
    filters: [
      { dataSize: 8 + 8 + 1 + 512 + 1 + 128 + 8 + 8 + 8 + 16 + 1 + 8 + 8 + 8 + 1 }, // Rumble account size
      { memcmp: { offset: 0, bytes: Buffer.from(DISC_RUMBLE).toString("base64"), encoding: "base64" } },
      { memcmp: { offset: 16, bytes: Buffer.from([RUMBLE_STATE_COMBAT]).toString("base64"), encoding: "base64" } },
    ],
  });

  return accounts.map((a) => {
    const data = Buffer.from(a.account.data);
    return data.readBigUInt64LE(8);
  });
}

async function watchMode(conn: Connection, pollIntervalMs: number): Promise<void> {
  console.log(`${C.cyan}Watch mode active.${C.reset} Polling every ${pollIntervalMs / 1000}s for active rumbles...\n`);

  const verified = new Set<string>(); // "rumbleId:turn" keys we've already verified

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const activeIds = await findActiveRumbles(conn);

      if (activeIds.length === 0) {
        process.stdout.write(`${C.dim}[${new Date().toISOString()}] No active rumbles${C.reset}\r`);
      } else {
        console.log(
          `\n${C.cyan}[${new Date().toISOString()}]${C.reset} Found ${activeIds.length} active rumble(s): ${activeIds.join(", ")}`,
        );

        for (const rid of activeIds) {
          try {
            // Check current turn
            const combatPda = deriveCombatStatePda(rid);
            const combatData = await fetchAccountData(conn, combatPda);
            if (!combatData) continue;
            const combat = parseCombatStateAccount(combatData);

            // Only verify if there are resolved turns we haven't checked
            const turnToCheck = combat.turnResolved
              ? combat.currentTurn
              : combat.currentTurn > 0
                ? combat.currentTurn - 1
                : 0;

            if (turnToCheck === 0) continue;

            const key = `${rid}:${turnToCheck}`;
            if (verified.has(key)) continue;

            console.log(`\n${C.yellow}Verifying rumble #${rid} through turn ${turnToCheck}...${C.reset}`);
            const result = await verifyRumble(conn, rid);
            printResult(result);
            verified.add(key);

            if (!result.allMatch) {
              console.log(
                `${C.bgRed}${C.bold} !!! ALERT: Rumble #${rid} failed verification !!! ${C.reset}`,
              );
            }
          } catch (err) {
            console.error(`${C.red}Error verifying rumble #${rid}:${C.reset}`, err);
          }
        }
      }
    } catch (err) {
      console.error(`${C.red}Watch poll error:${C.reset}`, err);
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function parseArgs(): { rumbleId: bigint | null; watch: boolean; rpc: string; pollInterval: number } {
  const args = process.argv.slice(2);
  let rumbleId: bigint | null = null;
  let watch = false;
  let rpc = DEFAULT_RPC;
  let pollInterval = 10_000;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--rumble-id":
        rumbleId = BigInt(args[++i]);
        break;
      case "--watch":
        watch = true;
        break;
      case "--rpc":
        rpc = args[++i];
        break;
      case "--poll-interval":
        pollInterval = parseInt(args[++i], 10) * 1000;
        break;
      case "--help":
      case "-h":
        console.log(`
UCF Verifier Bot — Level 2 Security

Usage:
  npx tsx scripts/verifier-bot.ts --rumble-id <ID>     Verify a specific rumble
  npx tsx scripts/verifier-bot.ts --watch               Watch for active rumbles
  npx tsx scripts/verifier-bot.ts --rumble-id <ID> --rpc <URL>

Options:
  --rumble-id <ID>       Rumble ID to verify
  --watch                Continuously poll for active rumbles
  --rpc <URL>            Custom Solana RPC endpoint
  --poll-interval <sec>  Watch mode poll interval in seconds (default: 10)
  --help                 Show this help
`);
        process.exit(0);
      default:
        console.error(`Unknown argument: ${args[i]}`);
        process.exit(1);
    }
  }

  return { rumbleId, watch, rpc, pollInterval };
}

async function main(): Promise<void> {
  const { rumbleId, watch, rpc, pollInterval } = parseArgs();

  printBanner();

  const conn = new Connection(rpc, "confirmed");
  console.log(`${C.dim}RPC: ${rpc}${C.reset}`);
  console.log(`${C.dim}Program: ${PROGRAM_ID.toBase58()}${C.reset}\n`);

  if (watch) {
    await watchMode(conn, pollInterval);
  } else if (rumbleId !== null) {
    try {
      const result = await verifyRumble(conn, rumbleId);
      printResult(result);
      process.exit(result.allMatch ? 0 : 1);
    } catch (err) {
      console.error(`${C.red}${C.bold}Error:${C.reset}`, err);
      process.exit(2);
    }
  } else {
    console.error("Please provide --rumble-id <ID> or --watch. Use --help for usage.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(2);
});
