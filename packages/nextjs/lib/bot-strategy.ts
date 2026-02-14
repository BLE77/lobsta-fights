// @ts-nocheck
/**
 * Clawdbot AI Fighter Strategy
 *
 * A simple but effective fighting bot strategy for UCF (Ultimate Claw Fighting).
 * This module provides move selection logic that can be used by the sample bot webhook.
 *
 * Strategy Overview:
 * - Weighted random move selection favoring strikes (60%)
 * - Use SPECIAL when meter >= 100 (high priority)
 * - Use DODGE occasionally (20% chance) for unpredictability
 * - Basic wager evaluation for challenge acceptance
 */

import { MoveType } from "./types";
import { SPECIAL_METER_COST, generateSalt } from "./combat";

// Move weights for random selection (higher = more likely)
const MOVE_WEIGHTS: Record<MoveType, number> = {
  HIGH_STRIKE: 25,
  MID_STRIKE: 25,
  LOW_STRIKE: 20,
  GUARD_HIGH: 5,
  GUARD_MID: 5,
  GUARD_LOW: 5,
  DODGE: 10,
  CATCH: 3,
  SPECIAL: 2, // Low weight since we handle SPECIAL separately when meter is full
};

// All available moves
const ALL_MOVES: MoveType[] = [
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

// Strike moves only
const STRIKE_MOVES: MoveType[] = ["HIGH_STRIKE", "MID_STRIKE", "LOW_STRIKE"];

/**
 * Match state passed to the bot from the match engine
 */
export interface BotMatchState {
  your_hp: number;
  opponent_hp: number;
  your_meter: number;
  opponent_meter: number;
  round: number;
  turn: number;
  your_rounds_won: number;
  opponent_rounds_won: number;
}

/**
 * The result of the bot's move decision
 */
export interface BotMoveDecision {
  move: MoveType;
  salt: string;
}

/**
 * Select a random move based on weighted probabilities
 */
function weightedRandomMove(excludeSpecial = false): MoveType {
  const moves = excludeSpecial
    ? ALL_MOVES.filter((m) => m !== "SPECIAL")
    : ALL_MOVES;

  const weights = moves.map((m) => MOVE_WEIGHTS[m]);
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);

  let random = Math.random() * totalWeight;

  for (let i = 0; i < moves.length; i++) {
    random -= weights[i];
    if (random <= 0) {
      return moves[i];
    }
  }

  // Fallback to a random strike
  return STRIKE_MOVES[Math.floor(Math.random() * STRIKE_MOVES.length)];
}

/**
 * Get a random strike move
 */
function randomStrike(): MoveType {
  return STRIKE_MOVES[Math.floor(Math.random() * STRIKE_MOVES.length)];
}

/**
 * Main strategy function - decides what move to make based on match state
 */
export function selectMove(matchState: BotMatchState): BotMoveDecision {
  const salt = generateSalt();
  let move: MoveType;

  const { your_hp, opponent_hp, your_meter, opponent_meter } = matchState;

  // Priority 1: Use SPECIAL if meter is full (high damage opportunity)
  if (your_meter >= SPECIAL_METER_COST) {
    // 80% chance to use special when available
    if (Math.random() < 0.8) {
      return { move: "SPECIAL", salt };
    }
  }

  // Priority 2: If low HP, be more defensive
  if (your_hp <= 20) {
    // 40% chance to dodge when low HP
    if (Math.random() < 0.4) {
      return { move: "DODGE", salt };
    }
    // 30% chance to guard
    if (Math.random() < 0.3) {
      const guards: MoveType[] = ["GUARD_HIGH", "GUARD_MID", "GUARD_LOW"];
      return { move: guards[Math.floor(Math.random() * guards.length)], salt };
    }
  }

  // Priority 3: If opponent has full meter, consider DODGE (they might SPECIAL)
  if (opponent_meter >= SPECIAL_METER_COST) {
    // 35% chance to dodge when opponent has special ready
    if (Math.random() < 0.35) {
      return { move: "DODGE", salt };
    }
  }

  // Priority 4: Random dodge chance (20%)
  if (Math.random() < 0.2) {
    return { move: "DODGE", salt };
  }

  // Priority 5: Weighted random move (favoring strikes)
  // Exclude SPECIAL from random selection if we don't have meter
  move = weightedRandomMove(your_meter < SPECIAL_METER_COST);

  return { move, salt };
}

/**
 * Decide whether to accept a challenge based on points and wager
 *
 * Strategy:
 * - Never accept if points < wager * 2 (too risky)
 * - Always accept small wagers (under 50 points)
 * - Probabilistic acceptance for medium wagers
 */
export function shouldAcceptChallenge(
  yourPoints: number,
  wagerAmount: number
): boolean {
  // Never accept if we can't afford to lose safely
  if (yourPoints < wagerAmount * 2) {
    return false;
  }

  // Always accept small wagers
  if (wagerAmount <= 50) {
    return true;
  }

  // For larger wagers, accept based on our point buffer
  const pointRatio = yourPoints / wagerAmount;

  // More conservative as wager gets bigger relative to our points
  if (pointRatio >= 10) {
    return true; // We have 10x the wager, always accept
  } else if (pointRatio >= 5) {
    return Math.random() < 0.9; // 90% accept
  } else if (pointRatio >= 3) {
    return Math.random() < 0.7; // 70% accept
  } else {
    return Math.random() < 0.5; // 50% accept if barely above threshold
  }
}

/**
 * Log utility for debugging bot decisions
 */
export function logBotDecision(
  event: string,
  decision: any,
  details?: Record<string, any>
): void {
  console.log(`[Clawdbot] ${event}:`, {
    decision,
    ...details,
    timestamp: new Date().toISOString(),
  });
}
