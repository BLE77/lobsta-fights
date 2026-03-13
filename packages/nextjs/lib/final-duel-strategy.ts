import { SPECIAL_DAMAGE, SPECIAL_METER_COST, STRIKE_DAMAGE } from "./combat";
import type { MoveType } from "./types";

export const FINAL_DUEL_SUDDEN_DEATH_BONUS = 20;
export const FINAL_DUEL_SUDDEN_DEATH_CHIP = 20;

type StrategyFighterState = {
  id: string;
  hp: number;
  meter: number;
};

type RandomSource = () => number;

export function applyFinalDuelSuddenDeath(
  damageToA: number,
  damageToB: number,
): { damageToA: number; damageToB: number } {
  let nextDamageToA = damageToA;
  let nextDamageToB = damageToB;

  if (nextDamageToA > 0) nextDamageToA += FINAL_DUEL_SUDDEN_DEATH_BONUS;
  if (nextDamageToB > 0) nextDamageToB += FINAL_DUEL_SUDDEN_DEATH_BONUS;

  if (nextDamageToA === 0 && nextDamageToB === 0) {
    nextDamageToA = FINAL_DUEL_SUDDEN_DEATH_CHIP;
    nextDamageToB = FINAL_DUEL_SUDDEN_DEATH_CHIP;
  }

  return { damageToA: nextDamageToA, damageToB: nextDamageToB };
}

export function chooseHouseBotFallbackMove(params: {
  fighter: StrategyFighterState;
  opponent: StrategyFighterState;
  aliveCount: number;
  recentOpponentMoves: MoveType[];
  random: RandomSource;
}): MoveType {
  const { fighter, opponent, aliveCount, recentOpponentMoves, random } = params;
  const finalDuel = aliveCount === 2;
  const lastOpponentMove = recentOpponentMoves[0] ?? null;
  const recentDodges = recentOpponentMoves.filter((move) => move === "DODGE").length;

  if (fighter.meter >= SPECIAL_METER_COST) {
    if (
      opponent.meter < SPECIAL_METER_COST ||
      finalDuel ||
      opponent.hp <= SPECIAL_DAMAGE + FINAL_DUEL_SUDDEN_DEATH_BONUS
    ) {
      return "SPECIAL";
    }

    if (recentDodges === 0 && random() < 0.75) {
      return "SPECIAL";
    }
  }

  if (opponent.meter >= SPECIAL_METER_COST) {
    return "DODGE";
  }

  if (recentDodges >= 2 && random() < 0.7) {
    return "CATCH";
  }

  if (lastOpponentMove === "HIGH_STRIKE") return "GUARD_HIGH";
  if (lastOpponentMove === "MID_STRIKE") return "GUARD_MID";
  if (lastOpponentMove === "LOW_STRIKE") return "GUARD_LOW";

  if (fighter.hp <= 20 && !finalDuel) {
    return random() < 0.5 ? "DODGE" : "GUARD_MID";
  }

  if (finalDuel) {
    if (opponent.hp <= STRIKE_DAMAGE.LOW_STRIKE + FINAL_DUEL_SUDDEN_DEATH_BONUS) {
      return "LOW_STRIKE";
    }
    if (opponent.hp <= STRIKE_DAMAGE.MID_STRIKE + FINAL_DUEL_SUDDEN_DEATH_BONUS) {
      return "MID_STRIKE";
    }
    if (opponent.hp <= STRIKE_DAMAGE.HIGH_STRIKE + FINAL_DUEL_SUDDEN_DEATH_BONUS) {
      return "HIGH_STRIKE";
    }

    const pressureRoll = random();
    if (pressureRoll < 0.45) return "MID_STRIKE";
    if (pressureRoll < 0.75) return "HIGH_STRIKE";
    if (pressureRoll < 0.9) return "LOW_STRIKE";
    return "GUARD_MID";
  }

  const roll = random();
  if (roll < 0.67) {
    const strikes: MoveType[] = ["HIGH_STRIKE", "MID_STRIKE", "LOW_STRIKE"];
    return strikes[Math.floor(random() * strikes.length)];
  }
  if (roll < 0.87) {
    const guards: MoveType[] = ["GUARD_HIGH", "GUARD_MID", "GUARD_LOW"];
    return guards[Math.floor(random() * guards.length)];
  }
  if (roll < 0.95) {
    return "DODGE";
  }
  return "CATCH";
}
