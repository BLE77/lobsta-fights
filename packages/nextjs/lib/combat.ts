import crypto from "crypto";
import { MoveType, TurnResult } from "./types";

// Valid moves in UCF
export const VALID_MOVES: MoveType[] = [
  "HIGH_STRIKE",
  "MID_STRIKE",
  "LOW_STRIKE",
  "GUARD_HIGH",
  "GUARD_MID",
  "GUARD_LOW",
  "DODGE",
  "CATCH",
  "SPECIAL",
];

// Strike to guard mapping - which guard blocks which strike
export const GUARD_BLOCKS_STRIKE: Record<string, MoveType> = {
  HIGH_STRIKE: "GUARD_HIGH",
  MID_STRIKE: "GUARD_MID",
  LOW_STRIKE: "GUARD_LOW",
};

// Combat constants
export const STRIKE_DAMAGE = 10;
export const SPECIAL_DAMAGE = 20;
export const METER_PER_TURN = 25;
export const SPECIAL_METER_COST = 100;
export const MAX_HP = 100;
export const ROUNDS_TO_WIN = 2; // Best of 3

/**
 * Generate a random salt for move commitment
 */
export function generateSalt(): string {
  return crypto.randomBytes(16).toString("hex");
}

/**
 * Create a commitment hash for a move
 * Format: SHA256(move:salt)
 */
export function createMoveHash(move: MoveType, salt: string): string {
  return crypto
    .createHash("sha256")
    .update(`${move}:${salt}`)
    .digest("hex");
}

/**
 * Verify that a revealed move matches a commitment hash
 */
export function verifyCommitment(move: string, salt: string, hash: string): boolean {
  const computed = crypto
    .createHash("sha256")
    .update(`${move}:${salt}`)
    .digest("hex");
  return computed === hash;
}

/**
 * Check if a move is a strike
 */
export function isStrike(move: MoveType): boolean {
  return move === "HIGH_STRIKE" || move === "MID_STRIKE" || move === "LOW_STRIKE";
}

/**
 * Check if a move is a guard
 */
export function isGuard(move: MoveType): boolean {
  return move === "GUARD_HIGH" || move === "GUARD_MID" || move === "GUARD_LOW";
}

/**
 * Check if a move is valid
 */
export function isValidMove(move: string): move is MoveType {
  return VALID_MOVES.includes(move as MoveType);
}

export interface CombatResult {
  damageToA: number;
  damageToB: number;
  result: TurnResult;
  meterUsedA: number;
  meterUsedB: number;
}

/**
 * Resolve combat between two moves
 *
 * Combat rules:
 * - Strike vs matching guard = blocked (0 damage)
 * - Strike vs wrong guard = hit (10 damage)
 * - Strike vs DODGE = dodged (0 damage)
 * - SPECIAL ignores guards (20 damage), but DODGE still works
 * - SPECIAL requires meter >= 100
 */
export function resolveCombat(
  moveA: MoveType,
  moveB: MoveType,
  meterA: number,
  meterB: number
): CombatResult {
  let damageToA = 0;
  let damageToB = 0;
  let meterUsedA = 0;
  let meterUsedB = 0;

  // Handle SPECIAL moves - only work if meter is sufficient
  const aUsesSpecial = moveA === "SPECIAL" && meterA >= SPECIAL_METER_COST;
  const bUsesSpecial = moveB === "SPECIAL" && meterB >= SPECIAL_METER_COST;

  if (aUsesSpecial) meterUsedA = SPECIAL_METER_COST;
  if (bUsesSpecial) meterUsedB = SPECIAL_METER_COST;

  // If SPECIAL used without meter, it fizzles (no damage dealt)
  const effectiveMoveA = moveA === "SPECIAL" && !aUsesSpecial ? null : moveA;
  const effectiveMoveB = moveB === "SPECIAL" && !bUsesSpecial ? null : moveB;

  // Calculate damage from A to B
  if (effectiveMoveA === "SPECIAL") {
    // SPECIAL ignores guards, only DODGE works
    if (effectiveMoveB !== "DODGE") {
      damageToB = SPECIAL_DAMAGE;
    }
  } else if (effectiveMoveA && isStrike(effectiveMoveA)) {
    if (effectiveMoveB === "DODGE") {
      // B dodged - no damage
    } else if (effectiveMoveB === GUARD_BLOCKS_STRIKE[effectiveMoveA]) {
      // B blocked with correct guard - no damage
    } else {
      // Hit!
      damageToB = STRIKE_DAMAGE;
    }
  }

  // Calculate damage from B to A
  if (effectiveMoveB === "SPECIAL") {
    // SPECIAL ignores guards, only DODGE works
    if (effectiveMoveA !== "DODGE") {
      damageToA = SPECIAL_DAMAGE;
    }
  } else if (effectiveMoveB && isStrike(effectiveMoveB)) {
    if (effectiveMoveA === "DODGE") {
      // A dodged - no damage
    } else if (effectiveMoveA === GUARD_BLOCKS_STRIKE[effectiveMoveB]) {
      // A blocked with correct guard - no damage
    } else {
      // Hit!
      damageToA = STRIKE_DAMAGE;
    }
  }

  // Determine result type
  let result: TurnResult;
  if (damageToA > 0 && damageToB > 0) {
    result = "TRADE";
  } else if (damageToB > 0) {
    result = "A_HIT";
  } else if (damageToA > 0) {
    result = "B_HIT";
  } else {
    // No damage dealt - determine why
    if ((effectiveMoveA && isStrike(effectiveMoveA)) || effectiveMoveA === "SPECIAL") {
      if (effectiveMoveB === "DODGE") {
        result = "B_DODGED";
      } else if (effectiveMoveB && isGuard(effectiveMoveB)) {
        result = "B_BLOCKED";
      } else {
        result = "BOTH_DEFEND";
      }
    } else if ((effectiveMoveB && isStrike(effectiveMoveB)) || effectiveMoveB === "SPECIAL") {
      if (effectiveMoveA === "DODGE") {
        result = "A_DODGED";
      } else if (effectiveMoveA && isGuard(effectiveMoveA)) {
        result = "A_BLOCKED";
      } else {
        result = "BOTH_DEFEND";
      }
    } else {
      result = "BOTH_DEFEND";
    }
  }

  return { damageToA, damageToB, result, meterUsedA, meterUsedB };
}
