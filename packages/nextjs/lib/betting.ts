// =============================================================================
// ICHOR Betting System — SOL Deployment + Payout Calculation
// Pure calculation logic, no database or blockchain calls.
//
// Flow per Rumble:
//   1. Spectators deploy SOL on fighters during betting phase
//   2. 1% admin fee deducted immediately
//   3. 5% fighter sponsorship deducted (goes to fighter owner, win or lose)
//   4. Remaining SOL forms the net pool
//   5. After combat: SOL on losing fighters (1st/2nd/3rd excluded) = the pot
//   6. 10% of pot → treasury vault
//   7. 90% of pot → split among top-3 bettors (70/20/10)
//   8. Winning bettors get original SOL back + profit share
//   9. ICHOR mined and distributed
//  10. Ichor Shower check (1/500)
// =============================================================================

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Bet {
  bettorId: string;
  fighterId: string;
  grossAmount: number; // what the user actually sent
  solAmount: number; // net amount after fees (what enters the pool)
  timestamp: Date;
}

export interface BettingPool {
  rumbleId: string;
  bets: Bet[];
  totalDeployed: number;
  adminFeeCollected: number;
  sponsorshipPaid: Map<string, number>; // fighterId → SOL paid to owner
  netPool: number; // total deployed minus admin fee minus sponsorship
}

export interface BettorPayout {
  bettorId: string;
  solDeployed: number;
  solReturned: number; // original stake returned (0 if lost)
  solProfit: number; // share of losers' pot (0 if lost)
  ichorMined: number;
}

export interface PayoutResult {
  rumbleId: string;
  winnerBettors: BettorPayout[]; // 1st place
  placeBettors: BettorPayout[]; // 2nd place
  showBettors: BettorPayout[]; // 3rd place
  losingBettors: BettorPayout[]; // everyone else
  treasuryVault: number;
  totalBurned: number;
  sponsorships: Map<string, number>;
  ichorDistribution: IchorDistribution;
  ichorShowerTriggered: boolean;
  ichorShowerWinner?: string;
  ichorShowerAmount?: number;
}

export interface FighterOdds {
  fighterId: string;
  solDeployed: number;
  betCount: number;
  impliedProbability: number; // fraction of net pool on this fighter
  potentialReturn: number; // multiplier if this fighter wins (1st place)
}

export interface IchorDistribution {
  totalMined: number;
  winningBettors: Map<string, number>; // 1st place bettorId → ICHOR (70% of 60%)
  secondPlaceBettors: Map<string, number>; // 2nd place bettorId → ICHOR (20% of 60%)
  thirdPlaceBettors: Map<string, number>; // 3rd place bettorId → ICHOR (10% of 60%)
  fighters: Map<string, number>; // fighterId → ICHOR
  showerPoolAccumulation: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ADMIN_FEE_RATE = 0.01; // 1% off the top
export const SPONSORSHIP_RATE = 0.05; // 5% to fighter owner
const TREASURY_RATE = 0.10; // 10% of losers' pot
const WINNERS_SHARE_RATE = 0.90; // 90% of losers' pot to bettors

// Winner-takes-all: 100% of losers' pot goes to 1st place bettors
const WIN_SHARE = 1.0; // 1st place bettors get everything
const PLACE_SHARE = 0; // 2nd place bettors get nothing
const SHOW_SHARE = 0; // 3rd place bettors get nothing

// --- Seasons ---
// ICHOR reward per Rumble is season-based (admin-configurable), not auto-halving.
export const SEASON_NAME = "Training Season";
export const SEASON_REWARD = 1000; // ICHOR per fight this season

// ICHOR distribution splits
const ICHOR_BETTORS_SHARE = 0.60; // 60% to winning bettors
const ICHOR_FIGHTERS_SHARE = 0.30; // 30% to fighters by placement
const ICHOR_SHOWER_SHARE = 0.10; // 10% to Ichor Shower pool

// Fighter ICHOR placement splits (of the 30% fighters share)
const FIGHTER_1ST_SHARE = 0.40;
const FIGHTER_2ND_SHARE = 0.25;
const FIGHTER_3RD_SHARE = 0.15;
const FIGHTER_REST_SHARE = 0.20; // split among 4th and below

// Ichor Shower
const ICHOR_SHOWER_ODDS = 500; // 1 in 500
const ICHOR_SHOWER_WINNER_SHARE = 0.90; // 90% to winner
const ICHOR_SHOWER_BURN_SHARE = 0.10; // 10% burned

// Additional Ichor Shower pool accumulation per Rumble (beyond the 10% block reward share)
const ICHOR_SHOWER_EXTRA_MINT = 0.2;

// ---------------------------------------------------------------------------
// Core Functions
// ---------------------------------------------------------------------------

/**
 * Create a fresh empty betting pool for a Rumble.
 */
export function createBettingPool(rumbleId: string): BettingPool {
  return {
    rumbleId,
    bets: [],
    totalDeployed: 0,
    adminFeeCollected: 0,
    sponsorshipPaid: new Map(),
    netPool: 0,
  };
}

/**
 * Place a bet. Deducts 1% admin fee and 5% sponsorship immediately.
 * Returns the updated pool (mutates in place for efficiency).
 *
 * The bettor's effective SOL in the pool = solAmount * (1 - 0.01 - 0.05) = 94% of deployed.
 */
export function placeBet(
  pool: BettingPool,
  bettorId: string,
  fighterId: string,
  solAmount: number,
): BettingPool {
  if (solAmount <= 0) {
    throw new Error("SOL amount must be positive");
  }

  // Deduct fees from the gross amount
  const adminFee = solAmount * ADMIN_FEE_RATE;
  const sponsorship = solAmount * SPONSORSHIP_RATE;
  const netAmount = solAmount - adminFee - sponsorship;

  // Record the bet with both gross and net amounts
  const bet: Bet = {
    bettorId,
    fighterId,
    grossAmount: solAmount,
    solAmount: netAmount,
    timestamp: new Date(),
  };

  pool.bets.push(bet);
  pool.totalDeployed += solAmount;
  pool.adminFeeCollected += adminFee;
  pool.netPool += netAmount;

  // Accumulate sponsorship per fighter
  const currentSponsorship = pool.sponsorshipPaid.get(fighterId) ?? 0;
  pool.sponsorshipPaid.set(fighterId, currentSponsorship + sponsorship);

  return pool;
}

/**
 * Calculate implied odds for every fighter in the pool.
 * Returns an array sorted by SOL deployed (most popular first).
 */
export function calculateOdds(pool: BettingPool): FighterOdds[] {
  if (pool.netPool === 0) return [];

  // Aggregate net SOL per fighter
  const fighterSol = new Map<string, number>();
  const fighterBetCount = new Map<string, number>();

  for (const bet of pool.bets) {
    fighterSol.set(bet.fighterId, (fighterSol.get(bet.fighterId) ?? 0) + bet.solAmount);
    fighterBetCount.set(bet.fighterId, (fighterBetCount.get(bet.fighterId) ?? 0) + 1);
  }

  const odds: FighterOdds[] = [];

  for (const [fighterId, sol] of fighterSol) {
    const impliedProbability = sol / pool.netPool;
    // If this fighter wins 1st: the bettor pool on losers is the pot.
    // Losers' SOL = netPool - sol on this fighter.
    // Winners get 90% of pot * 70% (1st place share) + their stake back.
    // Potential return = (stake back + profit) / stake
    const losersPot = pool.netPool - sol;
    const winnersShare = losersPot * WINNERS_SHARE_RATE * WIN_SHARE;
    // Return per 1 SOL net deployed on this fighter
    const potentialReturn = sol > 0 ? (sol + winnersShare) / sol : 0;

    odds.push({
      fighterId,
      solDeployed: sol,
      betCount: fighterBetCount.get(fighterId) ?? 0,
      impliedProbability,
      potentialReturn,
    });
  }

  odds.sort((a, b) => b.solDeployed - a.solDeployed);
  return odds;
}

/**
 * Calculate all payouts after a Rumble completes.
 *
 * @param pool - The betting pool with all bets placed
 * @param placements - Ordered array of fighter IDs by final placement.
 *                     Index 0 = 1st place (winner), index 1 = 2nd, index 2 = 3rd, etc.
 * @param blockReward - ICHOR reward for this Rumble (default SEASON_REWARD)
 * @param ichorShowerPool - Current accumulated Ichor Shower pool (for payout if triggered)
 */
export function calculatePayouts(
  pool: BettingPool,
  placements: string[],
  blockReward: number = SEASON_REWARD,
  ichorShowerPool: number = 0,
): PayoutResult {
  if (placements.length < 3) {
    throw new Error("Need at least 3 fighters for placement (win/place/show)");
  }

  const firstId = placements[0];
  const secondId = placements[1];
  const thirdId = placements[2];
  const winnerId = firstId;

  // Group bets by fighter, and aggregate net SOL per fighter
  const betsByFighter = new Map<string, Bet[]>();
  const solByFighter = new Map<string, number>();

  for (const bet of pool.bets) {
    const list = betsByFighter.get(bet.fighterId) ?? [];
    list.push(bet);
    betsByFighter.set(bet.fighterId, list);
    solByFighter.set(bet.fighterId, (solByFighter.get(bet.fighterId) ?? 0) + bet.solAmount);
  }

  // Winner-takes-all: pot = ALL non-winner fighters' SOL
  let pot = 0;
  for (const [fighterId, sol] of solByFighter) {
    if (fighterId !== winnerId) {
      pot += sol;
    }
  }

  // Treasury takes 10% of the pot
  const treasuryVault = pot * TREASURY_RATE;

  // Remaining 90% split among top-3 bettors
  const distributablePot = pot * WINNERS_SHARE_RATE;
  const winPot = distributablePot * WIN_SHARE; // 70% of 90%
  const placePot = distributablePot * PLACE_SHARE; // 20% of 90%
  const showPot = distributablePot * SHOW_SHARE; // 10% of 90%

  // ICHOR distribution
  const ichorDistribution = calculateIchorDistribution(
    pool,
    placements,
    firstId,
    secondId,
    thirdId,
    blockReward,
  );

  // Helper: build payout array for bettors on a specific fighter
  function buildPayouts(
    fighterId: string,
    potShare: number,
    ichorMap: Map<string, number>,
  ): BettorPayout[] {
    const bets = betsByFighter.get(fighterId) ?? [];
    const totalSolOnFighter = solByFighter.get(fighterId) ?? 0;
    if (totalSolOnFighter === 0) return [];

    return bets.map((bet) => {
      const proportion = bet.solAmount / totalSolOnFighter;
      const profit = potShare * proportion;
      return {
        bettorId: bet.bettorId,
        solDeployed: bet.solAmount,
        solReturned: bet.solAmount, // top-3 bettors get their stake back
        solProfit: profit,
        ichorMined: ichorMap.get(bet.bettorId) ?? 0,
      };
    });
  }

  const winnerBettors = buildPayouts(firstId, winPot, ichorDistribution.winningBettors);
  const placeBettors = buildPayouts(secondId, placePot, ichorDistribution.secondPlaceBettors);
  const showBettors = buildPayouts(thirdId, showPot, ichorDistribution.thirdPlaceBettors);

  // Losing bettors: everyone who didn't bet on the winner — no return, no profit, no ICHOR
  const losingBettors: BettorPayout[] = [];
  for (const [fighterId, bets] of betsByFighter) {
    if (fighterId === winnerId) continue;
    for (const bet of bets) {
      losingBettors.push({
        bettorId: bet.bettorId,
        solDeployed: bet.solAmount,
        solReturned: 0,
        solProfit: 0,
        ichorMined: 0,
      });
    }
  }

  // Ichor Shower check
  const showerTriggered = checkIchorShower();
  let showerWinner: string | undefined;
  let showerAmount: number | undefined;

  if (showerTriggered && ichorShowerPool > 0 && winnerBettors.length > 0) {
    showerWinner = selectIchorShowerWinner(winnerBettors);
    showerAmount = ichorShowerPool * ICHOR_SHOWER_WINNER_SHARE; // 90% to winner
  }

  const totalBurned = showerTriggered && ichorShowerPool > 0
    ? ichorShowerPool * ICHOR_SHOWER_BURN_SHARE
    : 0;

  return {
    rumbleId: pool.rumbleId,
    winnerBettors,
    placeBettors,
    showBettors,
    losingBettors,
    treasuryVault,
    totalBurned,
    sponsorships: new Map(pool.sponsorshipPaid),
    ichorDistribution,
    ichorShowerTriggered: showerTriggered,
    ichorShowerWinner: showerWinner,
    ichorShowerAmount: showerAmount,
  };
}

// ---------------------------------------------------------------------------
// ICHOR Mining Distribution
// ---------------------------------------------------------------------------

/**
 * Calculate ICHOR mining distribution for a Rumble.
 *
 * Per Rumble (season-based, e.g. 1000 ICHOR for Training Season):
 *   60% → winner bettors only (proportional to SOL deployed on 1st place fighter)
 *   30% → fighters by placement (1st: 40%, 2nd: 25%, 3rd: 15%, rest: split 20%)
 *   10% → Ichor Shower pool accumulation
 */
function calculateIchorDistribution(
  pool: BettingPool,
  placements: string[],
  winnerId: string,
  secondId: string,
  thirdId: string,
  blockReward: number,
): IchorDistribution {
  const bettorIchor = blockReward * ICHOR_BETTORS_SHARE; // 60% = 600 ICHOR
  const fighterIchor = blockReward * ICHOR_FIGHTERS_SHARE; // 30% = 300 ICHOR
  const showerIchor = blockReward * ICHOR_SHOWER_SHARE; // 10% = 100 ICHOR

  // Winner-takes-all: all 60% bettor ICHOR goes to winner bettors only
  const firstIchor = bettorIchor; // 100% of 60% = 600 ICHOR
  const secondIchor = 0;
  const thirdIchor = 0;

  // Helper: distribute ICHOR proportionally among bettors on a specific fighter
  function distributeToBettors(fighterId: string, ichorAmount: number): Map<string, number> {
    const result = new Map<string, number>();
    let totalSol = 0;
    for (const bet of pool.bets) {
      if (bet.fighterId === fighterId) totalSol += bet.solAmount;
    }
    if (totalSol > 0) {
      for (const bet of pool.bets) {
        if (bet.fighterId === fighterId) {
          const proportion = bet.solAmount / totalSol;
          const existing = result.get(bet.bettorId) ?? 0;
          result.set(bet.bettorId, existing + ichorAmount * proportion);
        }
      }
    }
    return result;
  }

  const winningBettors = distributeToBettors(winnerId, firstIchor);
  const secondPlaceBettors = distributeToBettors(secondId, secondIchor);
  const thirdPlaceBettors = distributeToBettors(thirdId, thirdIchor);

  // --- Fighters: 30% split by placement ---
  const fighters = new Map<string, number>();

  if (placements.length >= 1) {
    fighters.set(placements[0], fighterIchor * FIGHTER_1ST_SHARE); // 1st: 40% of 0.3 = 0.12
  }
  if (placements.length >= 2) {
    fighters.set(placements[1], fighterIchor * FIGHTER_2ND_SHARE); // 2nd: 25% of 0.3 = 0.075
  }
  if (placements.length >= 3) {
    fighters.set(placements[2], fighterIchor * FIGHTER_3RD_SHARE); // 3rd: 15% of 0.3 = 0.045
  }

  // 4th and below split remaining 20%
  const restCount = Math.max(0, placements.length - 3);
  if (restCount > 0) {
    const restPerFighter = (fighterIchor * FIGHTER_REST_SHARE) / restCount;
    for (let i = 3; i < placements.length; i++) {
      fighters.set(placements[i], restPerFighter);
    }
  }

  return {
    totalMined: blockReward,
    winningBettors,
    secondPlaceBettors,
    thirdPlaceBettors,
    fighters,
    showerPoolAccumulation: showerIchor + ICHOR_SHOWER_EXTRA_MINT, // 0.1 + 0.2 = 0.3 per Rumble
  };
}

// ---------------------------------------------------------------------------
// Ichor Shower (Jackpot)
// ---------------------------------------------------------------------------

/**
 * 1/500 random check for Ichor Shower trigger.
 * In production, this would use on-chain randomness (slot hash).
 * Here we use Math.random() as a placeholder.
 */
export function checkIchorShower(rngValue?: number): boolean {
  const value = rngValue ?? Math.random();
  // Map to integer [0, 499] and check if 0
  return Math.floor(value * ICHOR_SHOWER_ODDS) === 0;
}

/**
 * Select the Ichor Shower winner from winning bettors, weighted by SOL deployed.
 * Higher SOL deployed = higher chance of winning.
 */
export function selectIchorShowerWinner(
  winningBettors: BettorPayout[],
  rngValue?: number,
): string {
  if (winningBettors.length === 0) {
    throw new Error("No winning bettors to select from");
  }

  const totalSol = winningBettors.reduce((sum, b) => sum + b.solDeployed, 0);
  if (totalSol === 0) {
    throw new Error("Total SOL deployed is zero");
  }

  const roll = (rngValue ?? Math.random()) * totalSol;
  let cumulative = 0;

  for (const bettor of winningBettors) {
    cumulative += bettor.solDeployed;
    if (roll < cumulative) {
      return bettor.bettorId;
    }
  }

  // Floating point safety: return last bettor
  return winningBettors[winningBettors.length - 1].bettorId;
}

// ---------------------------------------------------------------------------
// Seasons
// ---------------------------------------------------------------------------

/**
 * Get the current season's ICHOR reward per Rumble.
 * Season-based model — admin changes the reward between seasons.
 * No automatic halving.
 */
export function getSeasonReward(): number {
  return SEASON_REWARD;
}

/** @deprecated Use getSeasonReward() instead */
export function getBlockReward(_totalRumblesCompleted: number): number {
  return SEASON_REWARD;
}

// ---------------------------------------------------------------------------
// Utility / Summary
// ---------------------------------------------------------------------------

/**
 * Get gross SOL deployed on a specific fighter (before fees).
 * Useful for display purposes.
 */
export function getGrossDeployedOnFighter(pool: BettingPool, fighterId: string): number {
  // Each bet's solAmount is NET (after 6% fees). Reverse: gross = net / 0.94
  let netOnFighter = 0;
  for (const bet of pool.bets) {
    if (bet.fighterId === fighterId) {
      netOnFighter += bet.solAmount;
    }
  }
  return netOnFighter / (1 - ADMIN_FEE_RATE - SPONSORSHIP_RATE);
}

/**
 * Get total effective (net) SOL deployed on a fighter in the pool.
 */
export function getNetDeployedOnFighter(pool: BettingPool, fighterId: string): number {
  let total = 0;
  for (const bet of pool.bets) {
    if (bet.fighterId === fighterId) {
      total += bet.solAmount;
    }
  }
  return total;
}

/**
 * Compute a complete payout summary with human-readable numbers.
 * Useful for logging and display.
 */
export function summarizePayouts(result: PayoutResult): {
  totalWinnerPayout: number;
  totalPlacePayout: number;
  totalShowPayout: number;
  totalLost: number;
  treasuryVault: number;
  totalSponsorships: number;
  ichorMinedTotal: number;
  ichorShowerInfo: string;
} {
  const sum = (arr: BettorPayout[]) =>
    arr.reduce((s, b) => s + b.solReturned + b.solProfit, 0);

  const totalSponsorships = Array.from(result.sponsorships.values()).reduce(
    (s, v) => s + v,
    0,
  );

  let ichorShowerInfo = "Not triggered";
  if (result.ichorShowerTriggered) {
    if (result.ichorShowerWinner) {
      ichorShowerInfo = `Triggered! Winner: ${result.ichorShowerWinner}, Amount: ${result.ichorShowerAmount?.toFixed(4)} ICHOR`;
    } else {
      ichorShowerInfo = "Triggered but no eligible winners (pool empty)";
    }
  }

  return {
    totalWinnerPayout: sum(result.winnerBettors),
    totalPlacePayout: sum(result.placeBettors),
    totalShowPayout: sum(result.showBettors),
    totalLost: result.losingBettors.reduce((s, b) => s + b.solDeployed, 0),
    treasuryVault: result.treasuryVault,
    totalSponsorships,
    ichorMinedTotal: result.ichorDistribution.totalMined,
    ichorShowerInfo,
  };
}
