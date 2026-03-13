import { describe, expect, it } from "vitest";

import { isMaxTurnsReachedError, shouldForceMaxTurnFallback } from "../lib/max-turn-guard";

describe("max turn guard", () => {
  it("recognizes Anchor max-turn errors from chain logs", () => {
    const err = new Error(
      "Simulation failed: AnchorError thrown in programs/rumble-engine/src/lib.rs:1395. " +
        "Error Code: MaxTurnsReached. Error Number: 6033. Error Message: Max combat turns reached.",
    );

    expect(isMaxTurnsReachedError(err)).toBe(true);
  });

  it("ignores unrelated transaction failures", () => {
    const err = new Error("custom program error: 0x177b");

    expect(isMaxTurnsReachedError(err)).toBe(false);
  });

  it("forces fallback only after the resolved cap turn has fully closed", () => {
    expect(
      shouldForceMaxTurnFallback({
        currentTurn: 120,
        maxCombatTurns: 120,
        remainingFighters: 2,
        turnResolved: true,
        currentSlot: 5000n,
        revealCloseSlot: 5000n,
      }),
    ).toBe(true);

    expect(
      shouldForceMaxTurnFallback({
        currentTurn: 120,
        maxCombatTurns: 120,
        remainingFighters: 2,
        turnResolved: false,
        currentSlot: 5000n,
        revealCloseSlot: 5000n,
      }),
    ).toBe(false);

    expect(
      shouldForceMaxTurnFallback({
        currentTurn: 119,
        maxCombatTurns: 120,
        remainingFighters: 2,
        turnResolved: true,
        currentSlot: 5000n,
        revealCloseSlot: 5000n,
      }),
    ).toBe(false);
  });
});
