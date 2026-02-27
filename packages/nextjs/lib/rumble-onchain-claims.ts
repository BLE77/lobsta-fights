import { createHash } from "node:crypto";
import { LAMPORTS_PER_SOL, PublicKey, type Connection } from "@solana/web3.js";
import { utils as anchorUtils } from "@coral-xyz/anchor";
import { getBettingConnection } from "./solana-connection";
import { RUMBLE_ENGINE_ID_MAINNET, readRumbleAccountState, deriveVaultPdaMainnet } from "./solana-programs";
import { freshSupabase } from "./supabase";
import { getRumbleSessionMinTimestampMs } from "./rumble-session";
import { parseOnchainRumbleIdNumber } from "./rumble-id";

export interface OnchainClaimableRumble {
  rumbleId: string;
  rumbleIdNum: number;
  onchainState: "betting" | "combat" | "payout" | "complete";
  onchainClaimableSol: number;
  inferredClaimableSol: number;
}

interface BettorAccountDecoded {
  rumbleId: bigint;
  rumbleIdNum: number;
  solDeployedLamports: bigint;
  claimableLamports: bigint;
  totalClaimedLamports: bigint;
  claimed: boolean;
  fighterDeploymentsLamports: bigint[];
}

export interface OnchainWalletPayoutSnapshot {
  claimableRumbles: OnchainClaimableRumble[];
  totalClaimableSol: number;
  totalClaimedSol: number;
  pendingNotReadySol: number;
}

const BETTOR_DISCRIMINATOR = createHash("sha256")
  .update("account:BettorAccount")
  .digest()
  .subarray(0, 8);
const BETTOR_MIN_DATA_LEN = 59;

function readU64LE(data: Uint8Array, offset: number): bigint {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return view.getBigUint64(offset, true);
}

function decodeBettorAccountData(data: Buffer): BettorAccountDecoded | null {
  if (!data || data.length < BETTOR_MIN_DATA_LEN) return null;

  let offset = 8; // discriminator
  offset += 32; // authority

  const rumbleId = readU64LE(data, offset);
  offset += 8;

  const fighterIndex = data[offset] ?? 0;
  offset += 1;

  const solDeployedLamports = readU64LE(data, offset);
  offset += 8;

  let claimableLamports = 0n;
  let totalClaimedLamports = 0n;
  let claimed = false;
  const fighterDeploymentsLamports: bigint[] = [];

  if (data.length >= offset + 8 + 8 + 8 + 1 + 1) {
    claimableLamports = readU64LE(data, offset);
    offset += 8;
    totalClaimedLamports = readU64LE(data, offset);
    offset += 8;
    offset += 8; // last_claim_ts
    claimed = data[offset] === 1;
    offset += 1;
    offset += 1; // bump
  } else if (data.length >= offset + 1 + 1) {
    claimed = data[offset] === 1;
    offset += 1;
    offset += 1; // bump
  }

  if (data.length >= offset + 8 * 16) {
    for (let i = 0; i < 16; i++) {
      fighterDeploymentsLamports.push(readU64LE(data, offset));
      offset += 8;
    }
  } else {
    const legacy = Array<bigint>(16).fill(0n);
    if (fighterIndex >= 0 && fighterIndex < 16) legacy[fighterIndex] = solDeployedLamports;
    fighterDeploymentsLamports.push(...legacy);
  }

  const rumbleIdNum = Number(rumbleId);
  if (!Number.isSafeInteger(rumbleIdNum) || rumbleIdNum < 0) return null;

  return {
    rumbleId,
    rumbleIdNum,
    solDeployedLamports,
    claimableLamports,
    totalClaimedLamports,
    claimed,
    fighterDeploymentsLamports,
  };
}

async function listBettorAccountsForWallet(
  wallet: PublicKey,
  connection: Connection,
): Promise<BettorAccountDecoded[]> {
  const accounts = await connection.getProgramAccounts(RUMBLE_ENGINE_ID_MAINNET, {
    commitment: "confirmed",
    filters: [
      {
        memcmp: {
          offset: 0,
          bytes: anchorUtils.bytes.bs58.encode(BETTOR_DISCRIMINATOR),
        },
      },
      {
        memcmp: {
          offset: 8,
          bytes: wallet.toBase58(),
        },
      },
    ],
  });

  const decoded: BettorAccountDecoded[] = [];
  for (const account of accounts) {
    const row = decodeBettorAccountData(account.account.data as Buffer);
    if (row) decoded.push(row);
  }
  return decoded;
}

/**
 * Fully on-chain payout snapshot for a wallet.
 * Source of truth is bettor + rumble program accounts only.
 */
export async function discoverOnchainWalletPayoutSnapshot(
  wallet: PublicKey,
  limit: number = 40,
): Promise<OnchainWalletPayoutSnapshot> {
  const connection = getBettingConnection();
  const minTimestampMs = getRumbleSessionMinTimestampMs();
  const bettorRowsRaw = await listBettorAccountsForWallet(wallet, connection);
  const bettorRows =
    minTimestampMs === null
      ? bettorRowsRaw
      : bettorRowsRaw.filter((row) => {
          const ts = deriveRumbleTimestampMs(row.rumbleIdNum);
          return ts !== null && ts >= minTimestampMs;
        });

  const rumbleIds = [...new Set(bettorRows.map((row) => row.rumbleIdNum))];
  const rumbleStateById = new Map<number, Awaited<ReturnType<typeof readRumbleAccountState>>>();
  const CHUNK_SIZE = 10;
  for (let i = 0; i < rumbleIds.length; i += CHUNK_SIZE) {
    const chunk = rumbleIds.slice(i, i + CHUNK_SIZE);
    const rows = await Promise.all(
      chunk.map(async (rumbleIdNum) => ({
        rumbleIdNum,
        state: await readRumbleAccountState(rumbleIdNum, connection, RUMBLE_ENGINE_ID_MAINNET).catch((err) => {
          console.error(`[claims] readRumbleAccountState failed for rumble ${rumbleIdNum}:`, err?.message ?? err);
          return null;
        }),
      })),
    );
    for (const row of rows) {
      rumbleStateById.set(row.rumbleIdNum, row.state);
    }
  }

  const claimableRumbles: OnchainClaimableRumble[] = [];
  let totalClaimedLamports = 0n;
  let pendingNotReadyLamports = 0n;
  const activeDbRumbleIds = new Set<number>();
  try {
    const { data: activeRows } = await freshSupabase()
      .from("ucf_rumbles")
      .select("id")
      .in("status", ["betting", "combat"]);
    for (const row of activeRows ?? []) {
      const parsed = parseOnchainRumbleIdNumber(String((row as any).id ?? ""));
      if (parsed !== null) {
        activeDbRumbleIds.add(parsed);
      }
    }
  } catch {
    // ignore; exposure stays conservative (0 for unknown active map)
  }

  for (const bettor of bettorRows) {
    totalClaimedLamports += bettor.totalClaimedLamports;

    const rumbleState = rumbleStateById.get(bettor.rumbleIdNum);
    if (!rumbleState) continue;

    const payoutReady = rumbleState.state === "payout" || rumbleState.state === "complete";
    if (!payoutReady) {
      if (activeDbRumbleIds.has(bettor.rumbleIdNum)) {
        pendingNotReadyLamports += bettor.solDeployedLamports;
      }
      continue;
    }
    if (bettor.claimed) continue;
    if (rumbleState.winnerIndex === null) continue;

    const winnerIndex = rumbleState.winnerIndex;
    const winnerDeploymentLamports = bettor.fighterDeploymentsLamports[winnerIndex] ?? 0n;
    const onchainClaimableLamports = bettor.claimableLamports;
    if (winnerDeploymentLamports <= 0n && onchainClaimableLamports <= 0n) continue;

    // Check vault has enough SOL to actually pay out (skip swept vaults)
    let vaultBalance = 0;
    try {
      const [vaultPda] = deriveVaultPdaMainnet(bettor.rumbleIdNum);
      vaultBalance = await connection.getBalance(vaultPda, "confirmed");
      const estimatedPayoutLamports = onchainClaimableLamports > 0n
        ? onchainClaimableLamports
        : winnerDeploymentLamports;
      if (vaultBalance < Number(estimatedPayoutLamports) + 900_000) continue;
    } catch {
      // If we can't check vault balance, skip conservatively
      continue;
    }

    const onchainClaimableSol = Number(onchainClaimableLamports) / LAMPORTS_PER_SOL;

    // Compute actual proportional payout when claimableLamports is 0
    let inferredClaimableSol: number;
    if (onchainClaimableSol > 0) {
      inferredClaimableSol = onchainClaimableSol;
    } else {
      // Proportional payout: (bettor_winner_stake / total_winner_pool) * net_prize_pool
      const totalWinnerPool = rumbleState.bettingPools?.[winnerIndex] ?? 0n;
      const netPrizePool = rumbleState.totalDeployedLamports
        - rumbleState.adminFeeCollectedLamports
        - rumbleState.sponsorshipPaidLamports;

      if (totalWinnerPool > 0n && netPrizePool > 0n) {
        // Use bigint arithmetic to avoid floating point precision issues
        const payoutLamports = (winnerDeploymentLamports * netPrizePool) / totalWinnerPool;
        inferredClaimableSol = Number(payoutLamports) / LAMPORTS_PER_SOL;
      } else {
        // Fallback: use vault balance proportional share if pool data unavailable
        inferredClaimableSol = Number(winnerDeploymentLamports) / LAMPORTS_PER_SOL;
      }
    }

    claimableRumbles.push({
      rumbleId: bettor.rumbleId.toString(),
      rumbleIdNum: bettor.rumbleIdNum,
      onchainState: rumbleState.state,
      onchainClaimableSol,
      inferredClaimableSol,
    });
  }

  claimableRumbles.sort((a, b) => b.inferredClaimableSol - a.inferredClaimableSol);
  const boundedClaimable = claimableRumbles.slice(0, Math.max(1, Math.min(limit, 250)));
  const totalClaimableSol = boundedClaimable.reduce((sum, row) => {
    return sum + (row.onchainClaimableSol > 0 ? row.onchainClaimableSol : row.inferredClaimableSol);
  }, 0);

  return {
    claimableRumbles: boundedClaimable,
    totalClaimableSol: Number(totalClaimableSol.toFixed(9)),
    totalClaimedSol: Number((Number(totalClaimedLamports) / LAMPORTS_PER_SOL).toFixed(9)),
    pendingNotReadySol: Number((Number(pendingNotReadyLamports) / LAMPORTS_PER_SOL).toFixed(9)),
  };
}

export async function discoverOnchainClaimableRumbles(
  wallet: PublicKey,
  limit: number = 40,
): Promise<OnchainClaimableRumble[]> {
  const snapshot = await discoverOnchainWalletPayoutSnapshot(wallet, limit);
  return snapshot.claimableRumbles;
}
function deriveRumbleTimestampMs(rumbleIdNum: number): number | null {
  const raw = String(rumbleIdNum);
  if (raw.length < 13) return null;
  const ts = Number(raw.slice(0, 13));
  if (!Number.isSafeInteger(ts) || ts < 1_600_000_000_000) return null;
  return ts;
}
