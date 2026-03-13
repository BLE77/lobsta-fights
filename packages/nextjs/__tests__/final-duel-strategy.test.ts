import { describe, expect, it } from "vitest";
import {
  applyFinalDuelSuddenDeath,
  chooseHouseBotFallbackMove,
  FINAL_DUEL_SUDDEN_DEATH_BONUS,
  FINAL_DUEL_SUDDEN_DEATH_CHIP,
} from "../lib/final-duel-strategy";

describe("final duel sudden death", () => {
  it("forces chip damage when both sides would otherwise deal no damage", () => {
    expect(applyFinalDuelSuddenDeath(0, 0)).toEqual({
      damageToA: FINAL_DUEL_SUDDEN_DEATH_CHIP,
      damageToB: FINAL_DUEL_SUDDEN_DEATH_CHIP,
    });
  });

  it("boosts real hits instead of replacing them", () => {
    expect(applyFinalDuelSuddenDeath(30, 23)).toEqual({
      damageToA: 30 + FINAL_DUEL_SUDDEN_DEATH_BONUS,
      damageToB: 23 + FINAL_DUEL_SUDDEN_DEATH_BONUS,
    });
  });
});

describe("house bot fallback strategy", () => {
  it("fires SPECIAL immediately in a final duel when meter is full", () => {
    const move = chooseHouseBotFallbackMove({
      fighter: { id: "house-a", hp: 64, meter: 100 },
      opponent: { id: "human-b", hp: 88, meter: 100 },
      aliveCount: 2,
      recentOpponentMoves: [],
      random: () => 0.95,
    });

    expect(move).toBe("SPECIAL");
  });

  it("punishes repeated dodges with CATCH", () => {
    const move = chooseHouseBotFallbackMove({
      fighter: { id: "house-a", hp: 75, meter: 0 },
      opponent: { id: "human-b", hp: 75, meter: 0 },
      aliveCount: 4,
      recentOpponentMoves: ["DODGE", "DODGE", "MID_STRIKE"],
      random: () => 0.5,
    });

    expect(move).toBe("CATCH");
  });

  it("uses the correct guard against the opponent's last strike", () => {
    const move = chooseHouseBotFallbackMove({
      fighter: { id: "house-a", hp: 40, meter: 0 },
      opponent: { id: "human-b", hp: 40, meter: 0 },
      aliveCount: 3,
      recentOpponentMoves: ["LOW_STRIKE"],
      random: () => 0.5,
    });

    expect(move).toBe("GUARD_LOW");
  });

  it("chooses the cheapest guaranteed killing strike in the final duel", () => {
    const move = chooseHouseBotFallbackMove({
      fighter: { id: "house-a", hp: 55, meter: 20 },
      opponent: { id: "human-b", hp: 35, meter: 0 },
      aliveCount: 2,
      recentOpponentMoves: [],
      random: () => 0.1,
    });

    expect(move).toBe("LOW_STRIKE");
  });
});
