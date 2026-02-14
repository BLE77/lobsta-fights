import * as persist from "./rumble-persistence";
import { getRumblePayoutMode } from "./rumble-payout-mode";
import { readBettorAccount, readRumbleAccountState } from "./solana-programs";
import { parseOnchainRumbleIdNumber } from "./rumble-id";
import { PublicKey } from "@solana/web3.js";

type FighterLike = { id?: string };
type PlacementLike = { id?: string; placement?: number };

const g = globalThis as unknown as { __rumblePayoutReconcileLastRunMs?: number };
const MIN_INTERVAL_MS = process.env.NODE_ENV === "production" ? 120_000 : 25_000;
const MAX_WALLET_SAMPLES_PER_RUMBLE = 30;
const WALLET_SAMPLE_CHUNK = 6;

function toWinnerFromPlacements(raw: unknown): string | null {
  if (!Array.isArray(raw)) return null;
  const placements = raw as PlacementLike[];
  const winner = placements.find((entry) => Number(entry?.placement) === 1);
  if (winner?.id && typeof winner.id === "string") return winner.id;
  const fallback = placements[0];
  return fallback?.id && typeof fallback.id === "string" ? fallback.id : null;
}

function toWinnerFromOnchainIndex(fightersRaw: unknown, winnerIndex: number | null): string | null {
  if (!Array.isArray(fightersRaw)) return null;
  if (!Number.isInteger(winnerIndex ?? -1) || (winnerIndex ?? -1) < 0) return null;
  const fighters = fightersRaw as FighterLike[];
  const fighter = fighters[winnerIndex as number];
  return fighter?.id && typeof fighter.id === "string" ? fighter.id : null;
}

/**
 * Last-resort winner inference for legacy rows where winner metadata is absent:
 * - read bettor PDAs for wallets that placed bets in this rumble;
 * - identify wallets that clearly won on-chain (claimable/claimed/winner stake > 0);
 * - if all winning single-fighter wallets point to one fighter, accept it.
 *
 * This is intentionally strict to avoid false settlements.
 */
async function inferWinnerFromOnchainWinningWallets(
  rumbleId: string,
  rumbleIdNum: number,
): Promise<string | null> {
  const bets = await persist.loadBetsForRumble(rumbleId);
  if (bets.length === 0) return null;

  const fightersByWallet = new Map<string, Set<string>>();
  for (const row of bets) {
    const wallet = String((row as any).wallet_address ?? "").trim();
    const fighterId = String((row as any).fighter_id ?? "").trim();
    if (!wallet || !fighterId) continue;
    if (!fightersByWallet.has(wallet)) fightersByWallet.set(wallet, new Set());
    fightersByWallet.get(wallet)!.add(fighterId);
  }
  if (fightersByWallet.size === 0) return null;

  const onchainRumble = await readRumbleAccountState(rumbleIdNum).catch(() => null);
  const winnerIndex = onchainRumble?.winnerIndex ?? null;

  const sampledWallets = [...fightersByWallet.keys()].slice(0, MAX_WALLET_SAMPLES_PER_RUMBLE);
  const candidateFighters: string[] = [];

  for (let i = 0; i < sampledWallets.length; i += WALLET_SAMPLE_CHUNK) {
    const chunk = sampledWallets.slice(i, i + WALLET_SAMPLE_CHUNK);
    const chunkResults = await Promise.all(
      chunk.map(async (wallet) => {
        let walletPk: PublicKey;
        try {
          walletPk = new PublicKey(wallet);
        } catch {
          return null;
        }

        const bettor = await readBettorAccount(walletPk, rumbleIdNum).catch(() => null);
        if (!bettor) return null;

        const wonByClaimData =
          bettor.claimableLamports > 0n ||
          bettor.totalClaimedLamports > 0n ||
          (bettor.claimed && bettor.solDeployedLamports > 0n);
        const wonByWinnerStake =
          winnerIndex !== null &&
          winnerIndex >= 0 &&
          winnerIndex < bettor.fighterDeploymentsLamports.length &&
          (bettor.fighterDeploymentsLamports[winnerIndex] ?? 0n) > 0n;
        if (!wonByClaimData && !wonByWinnerStake) return null;

        const fighters = [...(fightersByWallet.get(wallet) ?? [])];
        if (fighters.length !== 1) return null;
        return fighters[0];
      }),
    );

    for (const fighterId of chunkResults) {
      if (fighterId) candidateFighters.push(fighterId);
    }
  }

  if (candidateFighters.length === 0) return null;
  const unique = [...new Set(candidateFighters)];
  if (unique.length !== 1) return null;
  return unique[0];
}

export interface PayoutReconcileResult {
  ran: boolean;
  candidates: number;
  settled: number;
  skipped: number;
  unresolved: Array<{
    rumbleId: string;
    reason: string;
    pendingNetSol: number;
  }>;
}

/**
 * Safety-net reconciler:
 * - Finds completed/payout rumbles with stale pending bet rows.
 * - Resolves winner from DB winner_id / placements / on-chain winner index.
 * - Settles winner-takes-all rows so wallets don't accumulate orphaned "unsettled".
 */
export async function reconcileStalePendingPayouts(options?: {
  force?: boolean;
  limit?: number;
}): Promise<PayoutReconcileResult> {
  const force = options?.force === true;
  const limit = options?.limit ?? 25;

  const now = Date.now();
  const lastRun = g.__rumblePayoutReconcileLastRunMs ?? 0;
  if (!force && now - lastRun < MIN_INTERVAL_MS) {
    return { ran: false, candidates: 0, settled: 0, skipped: 0, unresolved: [] };
  }
  g.__rumblePayoutReconcileLastRunMs = now;

  const rows = await persist.loadPendingSettlementRumbles(limit);
  const result: PayoutReconcileResult = {
    ran: true,
    candidates: rows.length,
    settled: 0,
    skipped: 0,
    unresolved: [],
  };
  if (rows.length === 0) return result;

  const payoutMode = getRumblePayoutMode();
  for (const row of rows) {
    if (row.status !== "complete" && row.status !== "payout") {
      result.skipped += 1;
      continue;
    }

    let winnerId: string | null = row.winner_id ?? null;
    if (!winnerId) {
      winnerId = toWinnerFromPlacements(row.placements);
    }
    if (!winnerId) {
      const rumbleIdNum = parseOnchainRumbleIdNumber(row.id);
      if (rumbleIdNum !== null) {
        const onchain = await readRumbleAccountState(rumbleIdNum).catch(() => null);
        if (onchain && (onchain.state === "payout" || onchain.state === "complete")) {
          winnerId = toWinnerFromOnchainIndex(row.fighters, onchain.winnerIndex);
        }
      }
    }
    if (!winnerId) {
      const rumbleIdNum = parseOnchainRumbleIdNumber(row.id);
      if (rumbleIdNum !== null) {
        winnerId = await inferWinnerFromOnchainWinningWallets(row.id, rumbleIdNum).catch(() => null);
      }
    }

    if (!winnerId) {
      result.unresolved.push({
        rumbleId: row.id,
        reason: "winner_unknown",
        pendingNetSol: row.pending_net_sol,
      });
      continue;
    }

    try {
      await persist.settleWinnerTakeAllBets(row.id, winnerId, payoutMode);
      result.settled += 1;
    } catch {
      result.unresolved.push({
        rumbleId: row.id,
        reason: "settle_failed",
        pendingNetSol: row.pending_net_sol,
      });
    }
  }

  return result;
}
