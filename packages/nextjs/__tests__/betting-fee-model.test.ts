import { describe, expect, it } from "vitest";

import { calculatePayouts, createBettingPool, placeBet } from "../lib/betting";

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

describe("betting fee model", () => {
  it("applies the new upfront fee split on a single 1.0 SOL bet", () => {
    const pool = createBettingPool("rumble-single");

    placeBet(pool, "bettor-1", "fighter-a", 1.0);

    expect(pool.totalDeployed).toBeCloseTo(1.0, 9);
    expect(pool.adminFeeCollected).toBeCloseTo(0.01, 9);
    expect(pool.sponsorshipPaid.get("fighter-a")).toBeCloseTo(0.01, 9);
    expect(pool.netPool).toBeCloseTo(0.98, 9);
    expect(pool.bets).toHaveLength(1);
    expect(pool.bets[0].grossAmount).toBeCloseTo(1.0, 9);
    expect(pool.bets[0].solAmount).toBeCloseTo(0.98, 9);
  });

  it("charges the same total effective percentage when stake is split across fighters", () => {
    const pool = createBettingPool("rumble-split");

    placeBet(pool, "bettor-1", "fighter-a", 0.5);
    placeBet(pool, "bettor-1", "fighter-b", 0.3);
    placeBet(pool, "bettor-1", "fighter-c", 0.2);

    const totalSponsorship = sum(Array.from(pool.sponsorshipPaid.values()));

    expect(pool.totalDeployed).toBeCloseTo(1.0, 9);
    expect(pool.adminFeeCollected).toBeCloseTo(0.01, 9);
    expect(totalSponsorship).toBeCloseTo(0.01, 9);
    expect(pool.netPool).toBeCloseTo(0.98, 9);
    expect(pool.sponsorshipPaid.get("fighter-a")).toBeCloseTo(0.005, 9);
    expect(pool.sponsorshipPaid.get("fighter-b")).toBeCloseTo(0.003, 9);
    expect(pool.sponsorshipPaid.get("fighter-c")).toBeCloseTo(0.002, 9);
  });

  it("keeps sponsorship accrual working across repeated bets on the same fighter", () => {
    const pool = createBettingPool("rumble-sponsorship");

    placeBet(pool, "bettor-1", "fighter-a", 1.0);
    placeBet(pool, "bettor-2", "fighter-a", 0.5);
    placeBet(pool, "bettor-3", "fighter-b", 0.5);

    const totalSponsorship = sum(Array.from(pool.sponsorshipPaid.values()));

    expect(pool.sponsorshipPaid.get("fighter-a")).toBeCloseTo(0.015, 9);
    expect(pool.sponsorshipPaid.get("fighter-b")).toBeCloseTo(0.005, 9);
    expect(totalSponsorship).toBeCloseTo(0.02, 9);
    expect(pool.netPool).toBeCloseTo(1.96, 9);
  });

  it("uses a 3% losers-pool cut and pays winners pro rata plus returned stake", () => {
    const pool = createBettingPool("rumble-payout");

    placeBet(pool, "alice", "fighter-a", 1.0);
    placeBet(pool, "bob", "fighter-a", 2.0);
    placeBet(pool, "carol", "fighter-b", 2.0);
    placeBet(pool, "dave", "fighter-c", 1.0);

    const result = calculatePayouts(pool, ["fighter-a", "fighter-b", "fighter-c"], 2500, 0);
    const payoutsByBettor = new Map(result.winnerBettors.map(row => [row.bettorId, row]));

    expect(result.treasuryVault).toBeCloseTo(0.0882, 9);
    expect(result.placeBettors).toHaveLength(0);
    expect(result.showBettors).toHaveLength(0);
    expect(result.losingBettors).toHaveLength(2);

    expect(payoutsByBettor.get("alice")?.solReturned).toBeCloseTo(0.98, 9);
    expect(payoutsByBettor.get("alice")?.solProfit).toBeCloseTo(0.9506, 9);

    expect(payoutsByBettor.get("bob")?.solReturned).toBeCloseTo(1.96, 9);
    expect(payoutsByBettor.get("bob")?.solProfit).toBeCloseTo(1.9012, 9);

    const totalWinnerPayout = sum(
      result.winnerBettors.map(row => row.solReturned + row.solProfit),
    );
    expect(totalWinnerPayout).toBeCloseTo(5.7918, 9);
  });
});
