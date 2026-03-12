import { describe, expect, it } from "vitest";

import { inferWinnerTakeAllClaimableLamports } from "../lib/rumble-onchain-claims";

describe("inferWinnerTakeAllClaimableLamports", () => {
  it("returns original winning stake plus pro-rata losers-pool share after the 3% treasury cut", () => {
    const payoutLamports = inferWinnerTakeAllClaimableLamports(
      {
        winnerIndex: 0,
        bettingPools: [
          2_940_000_000n,
          1_960_000_000n,
          980_000_000n,
        ],
      },
      980_000_000n,
    );

    expect(payoutLamports).toBe(1_930_600_000n);
  });

  it("matches the full-pool winner example when one bettor owns the whole winning side", () => {
    const payoutLamports = inferWinnerTakeAllClaimableLamports(
      {
        winnerIndex: 0,
        bettingPools: [
          980_000_000n,
          1_960_000_000n,
        ],
      },
      980_000_000n,
    );

    expect(payoutLamports).toBe(2_881_200_000n);
  });

  it("returns zero when the winner pool is empty", () => {
    const payoutLamports = inferWinnerTakeAllClaimableLamports(
      {
        winnerIndex: 1,
        bettingPools: [980_000_000n, 0n, 980_000_000n],
      },
      980_000_000n,
    );

    expect(payoutLamports).toBe(0n);
  });

  it("returns zero when winner index is missing", () => {
    const payoutLamports = inferWinnerTakeAllClaimableLamports(
      {
        winnerIndex: null,
        bettingPools: [980_000_000n, 980_000_000n],
      },
      980_000_000n,
    );

    expect(payoutLamports).toBe(0n);
  });
});
