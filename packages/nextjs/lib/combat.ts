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

// Combat constants - Different damage per strike type for more variety!
export const STRIKE_DAMAGE: Record<string, number> = {
  HIGH_STRIKE: 39,   // High risk, high reward - goes for the head
  MID_STRIKE: 30,    // Balanced body shot
  LOW_STRIKE: 23,    // Safer leg sweep, less damage
};
export const CATCH_DAMAGE = 45;      // Big punish for catching a dodge
export const COUNTER_DAMAGE = 18;    // Damage when you block and counter
export const SPECIAL_DAMAGE = 52;    // Devastating unblockable
export const DAMAGE_VARIANCE = 4; // +/- range for damage rolls
export const METER_PER_TURN = 20;
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

/**
 * Cryptographically-secure random integer in [min, max].
 * Uses crypto.getRandomValues for fairness in game-critical paths.
 */
function secureRandomInt(min: number, max: number): number {
  if (max < min) {
    const temp = min;
    min = max;
    max = temp;
  }

  if (max === min) {
    return min;
  }

  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  const range = max - min + 1;
  return min + (arr[0] % range);
}

/**
 * Return a random integer in [base - variance, base + variance].
 * Ensures the result is at least 1.
 * Uses crypto.getRandomValues for fair damage rolls.
 */
export function randomDamage(base: number, variance: number = DAMAGE_VARIANCE): number {
  if (!Number.isFinite(base) || base <= 0 || !Number.isFinite(variance) || variance <= 0) {
    return 1;
  }

  const min = Math.max(1, base - variance);
  const max = base + variance;
  return secureRandomInt(min, max);
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
      damageToB = randomDamage(SPECIAL_DAMAGE);
    }
  } else if (effectiveMoveA === "CATCH") {
    // CATCH only works if opponent dodges
    if (effectiveMoveB === "DODGE") {
      damageToB = randomDamage(CATCH_DAMAGE);
    }
  } else if (effectiveMoveA && isStrike(effectiveMoveA)) {
    if (effectiveMoveB === "DODGE") {
      // B dodged - no damage
    } else if (effectiveMoveB === GUARD_BLOCKS_STRIKE[effectiveMoveA]) {
      // B blocked with correct guard - no damage, but B counters!
      damageToA = randomDamage(COUNTER_DAMAGE);
    } else {
      // Hit! Damage depends on strike type
      damageToB = randomDamage(STRIKE_DAMAGE[effectiveMoveA] || 10);
    }
  }

  // Calculate damage from B to A
  if (effectiveMoveB === "SPECIAL") {
    // SPECIAL ignores guards, only DODGE works
    if (effectiveMoveA !== "DODGE") {
      damageToA = randomDamage(SPECIAL_DAMAGE);
    }
  } else if (effectiveMoveB === "CATCH") {
    // CATCH only works if opponent dodges
    if (effectiveMoveA === "DODGE") {
      damageToA = randomDamage(CATCH_DAMAGE);
    }
  } else if (effectiveMoveB && isStrike(effectiveMoveB)) {
    if (effectiveMoveA === "DODGE") {
      // A dodged - no damage
    } else if (effectiveMoveA === GUARD_BLOCKS_STRIKE[effectiveMoveB]) {
      // A blocked with correct guard - no damage, but A counters!
      damageToB = randomDamage(COUNTER_DAMAGE);
    } else {
      // Hit! Damage depends on strike type
      damageToA = randomDamage(STRIKE_DAMAGE[effectiveMoveB] || 10);
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
