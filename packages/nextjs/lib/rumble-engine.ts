/**
 * Rumble Engine - Battle Royale combat for 8-16 fighters
 *
 * Extends the existing UCF combat system (combat.ts) into a multi-fighter
 * elimination format. Each turn, remaining fighters are randomly paired
 * and each pair resolves using the standard resolveCombat() logic.
 * Fighters eliminated at 0 HP. After 20 turns, survivors ranked by HP.
 */

import crypto from "crypto";
import { MoveType } from "./types";
import {
  VALID_MOVES,
  STRIKE_DAMAGE,
  METER_PER_TURN,
  SPECIAL_METER_COST,
  MAX_HP,
  resolveCombat,
} from "./combat";

// -------------------------------------------------------------------
// Types
// -------------------------------------------------------------------

export interface RumbleFighter {
  id: string;
  name: string;
  hp: number;
  meter: number;
  totalDamageDealt: number;
  totalDamageTaken: number;
  eliminatedOnTurn: number | null;
  placement: number;
}

export interface RumblePairing {
  fighterA: string;
  fighterB: string;
  moveA: string;
  moveB: string;
  damageToA: number;
  damageToB: number;
}

export interface RumbleTurn {
  turnNumber: number;
  pairings: RumblePairing[];
  eliminations: string[];
  bye?: string;
}

export interface RumbleResult {
  rumbleId: string;
  fighters: RumbleFighter[];
  turns: RumbleTurn[];
  winner: string;
  placements: Array<{ id: string; placement: number }>;
  totalTurns: number;
}

// -------------------------------------------------------------------
// Constants
// -------------------------------------------------------------------

const MAX_TURNS = 20;
const MIN_FIGHTERS = 8;
const MAX_FIGHTERS = 16;

// -------------------------------------------------------------------
// Move selection (placeholder - will be replaced by bot API calls)
// -------------------------------------------------------------------

/**
 * Placeholder AI move selection.
 * Weighted distribution: 67% strikes, 20% guards, 8% dodge, 5% catch.
 * Uses SPECIAL when meter is full (100).
 */
export function selectMove(
  fighter: RumbleFighter,
  _opponents: RumbleFighter[],
  _turnHistory: RumbleTurn[]
): MoveType {
  // Use SPECIAL when meter is full
  if (fighter.meter >= SPECIAL_METER_COST) {
    return "SPECIAL";
  }

  const roll = Math.random();

  if (roll < 0.67) {
    // 67% strikes - pick one of the three randomly
    const strikes: MoveType[] = ["HIGH_STRIKE", "MID_STRIKE", "LOW_STRIKE"];
    return strikes[Math.floor(Math.random() * strikes.length)];
  } else if (roll < 0.87) {
    // 20% guards
    const guards: MoveType[] = ["GUARD_HIGH", "GUARD_MID", "GUARD_LOW"];
    return guards[Math.floor(Math.random() * guards.length)];
  } else if (roll < 0.95) {
    // 8% dodge
    return "DODGE";
  } else {
    // 5% catch
    return "CATCH";
  }
}

// -------------------------------------------------------------------
// Pairing logic
// -------------------------------------------------------------------

/**
 * Fisher-Yates shuffle (in-place).
 */
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Create pairings for a set of fighters, avoiding repeat pairings from
 * the previous turn when possible.
 *
 * Returns { pairings: [idA, idB][], bye: string | undefined }
 */
function createPairings(
  fighterIds: string[],
  previousPairings: Set<string>
): { pairings: [string, string][]; bye: string | undefined } {
  const ids = [...fighterIds];
  shuffle(ids);

  let bye: string | undefined;

  // If odd number, last fighter gets a bye
  if (ids.length % 2 !== 0) {
    bye = ids.pop()!;
  }

  // Build naive pairings from shuffled order
  let pairings: [string, string][] = [];
  for (let i = 0; i < ids.length; i += 2) {
    pairings.push([ids[i], ids[i + 1]]);
  }

  // Try to avoid repeating previous-turn pairings.
  // If a pair was seen last turn, attempt a single swap pass.
  if (previousPairings.size > 0 && pairings.length > 1) {
    for (let i = 0; i < pairings.length; i++) {
      const key = pairingKey(pairings[i][0], pairings[i][1]);
      if (previousPairings.has(key)) {
        // Try swapping one member with next pair
        const swapIdx = (i + 1) % pairings.length;
        // Swap second members
        [pairings[i][1], pairings[swapIdx][1]] = [
          pairings[swapIdx][1],
          pairings[i][1],
        ];
        // If the swap created another repeat, revert
        const newKeyI = pairingKey(pairings[i][0], pairings[i][1]);
        const newKeySwap = pairingKey(
          pairings[swapIdx][0],
          pairings[swapIdx][1]
        );
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

/**
 * Stable key for a pairing (order-independent).
 */
function pairingKey(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

// -------------------------------------------------------------------
// Main Rumble Engine
// -------------------------------------------------------------------

/**
 * Run a complete Rumble battle royale.
 *
 * @param entries - Array of { id, name } for each fighter (8-16 fighters)
 * @param rumbleId - Optional unique ID; generated if omitted
 * @returns RumbleResult with full placements and turn log
 */
export function runRumble(
  entries: Array<{ id: string; name: string }>,
  rumbleId?: string
): RumbleResult {
  if (entries.length < MIN_FIGHTERS || entries.length > MAX_FIGHTERS) {
    throw new Error(
      `Rumble requires ${MIN_FIGHTERS}-${MAX_FIGHTERS} fighters, got ${entries.length}`
    );
  }

  const id = rumbleId ?? crypto.randomUUID();

  // Initialise fighter state
  const fighters: Map<string, RumbleFighter> = new Map();
  for (const entry of entries) {
    fighters.set(entry.id, {
      id: entry.id,
      name: entry.name,
      hp: MAX_HP,
      meter: 0,
      totalDamageDealt: 0,
      totalDamageTaken: 0,
      eliminatedOnTurn: null,
      placement: 0, // assigned at end
    });
  }

  const turns: RumbleTurn[] = [];
  const eliminationOrder: string[] = []; // earliest eliminated first
  let previousPairingsSet = new Set<string>();

  // ------- Main loop -------
  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const alive = [...fighters.values()].filter((f) => f.hp > 0);

    // If only one (or zero) fighters remain, we're done
    if (alive.length <= 1) break;

    // Create pairings
    const aliveIds = alive.map((f) => f.id);
    const { pairings, bye } = createPairings(aliveIds, previousPairingsSet);

    const turnPairings: RumblePairing[] = [];
    const turnEliminations: string[] = [];
    const currentPairingsSet = new Set<string>();

    for (const [idA, idB] of pairings) {
      const fA = fighters.get(idA)!;
      const fB = fighters.get(idB)!;

      // Select moves
      const allOpponents = alive.filter((f) => f.id !== fA.id);
      const moveA = selectMove(fA, allOpponents, turns);
      const moveB = selectMove(
        fB,
        alive.filter((f) => f.id !== fB.id),
        turns
      );

      // Resolve combat using existing engine
      const result = resolveCombat(moveA, moveB, fA.meter, fB.meter);

      // Apply meter usage
      fA.meter -= result.meterUsedA;
      fB.meter -= result.meterUsedB;

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

      currentPairingsSet.add(pairingKey(idA, idB));
    }

    // Grant meter to all alive fighters (after combat resolution)
    for (const f of fighters.values()) {
      if (f.hp > 0) {
        f.meter = Math.min(f.meter + METER_PER_TURN, SPECIAL_METER_COST);
      }
    }

    // Record eliminations for this turn
    for (const f of fighters.values()) {
      if (f.hp <= 0 && f.eliminatedOnTurn === null) {
        f.eliminatedOnTurn = turn;
        turnEliminations.push(f.id);
        eliminationOrder.push(f.id);
      }
    }

    const turnRecord: RumbleTurn = {
      turnNumber: turn,
      pairings: turnPairings,
      eliminations: turnEliminations,
    };
    if (bye) {
      turnRecord.bye = bye;
    }

    turns.push(turnRecord);
    previousPairingsSet = currentPairingsSet;

    // Check if only one remains after eliminations
    const stillAlive = [...fighters.values()].filter((f) => f.hp > 0);
    if (stillAlive.length <= 1) break;
  }

  // ------- Determine placements -------
  const allFighters = [...fighters.values()];
  const alive = allFighters.filter((f) => f.hp > 0);
  const eliminated = allFighters.filter((f) => f.hp <= 0);

  // Sort alive fighters by HP descending, tiebreak by total damage dealt descending
  alive.sort((a, b) => {
    if (b.hp !== a.hp) return b.hp - a.hp;
    return b.totalDamageDealt - a.totalDamageDealt;
  });

  // Eliminated fighters: later elimination = better placement.
  // Among fighters eliminated on the same turn, tiebreak by higher HP before
  // that turn (approximated by lower damage taken).
  eliminated.sort((a, b) => {
    // Later elimination turn = better rank (closer to 1st)
    if (a.eliminatedOnTurn !== b.eliminatedOnTurn) {
      return (b.eliminatedOnTurn ?? 0) - (a.eliminatedOnTurn ?? 0);
    }
    // Tiebreak: more damage dealt = better
    return b.totalDamageDealt - a.totalDamageDealt;
  });

  // Assign placements
  const ranked = [...alive, ...eliminated];
  for (let i = 0; i < ranked.length; i++) {
    ranked[i].placement = i + 1;
  }

  const winner = ranked[0].id;
  const placements = ranked.map((f) => ({ id: f.id, placement: f.placement }));

  return {
    rumbleId: id,
    fighters: ranked,
    turns,
    winner,
    placements,
    totalTurns: turns.length,
  };
}
