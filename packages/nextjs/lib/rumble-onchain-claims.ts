import { createHash } from "node:crypto";
import { LAMPORTS_PER_SOL, PublicKey, type Connection } from "@solana/web3.js";
import { utils as anchorUtils } from "@coral-xyz/anchor";
import { getBettingConnection, getBettingRpcEndpoint } from "./solana-connection";
import {
  RUMBLE_ENGINE_ID_MAINNET,
  readRumbleAccountState,
  deriveRumblePdaMainnet,
  deriveVaultPdaMainnet,
} from "./solana-programs";
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

// ---------------------------------------------------------------------------
// getProgramAccountsV2 — Helius-specific, 1 credit instead of 10.
// Falls back to regular getProgramAccounts if V2 fails.
// ---------------------------------------------------------------------------

interface GpaV2Account {
  pubkey: string;
  lamports: number;
  owner: string;
  data: string; // base64-encoded
  space: number;
}

async function listBettorAccountsV2(
  wallet: PublicKey,
  rpcUrl: string,
): Promise<BettorAccountDecoded[]> {
  const body = {
    jsonrpc: "2.0",
    id: "bettor-scan",
    method: "getProgramAccountsV2",
    params: [
      RUMBLE_ENGINE_ID_MAINNET.toBase58(),
      {
        encoding: "base64",
        commitment: "confirmed",
        limit: 1000,
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
      },
    ],
  };

  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`V2 HTTP ${res.status}`);

  const json = await res.json();
  if (json.error) throw new Error(json.error.message ?? "V2 RPC error");

  const accounts: GpaV2Account[] = json.result?.accounts ?? [];
  const decoded: BettorAccountDecoded[] = [];
  for (const acct of accounts) {
    const buf = Buffer.from(acct.data, "base64");
    const row = decodeBettorAccountData(buf);
    if (row) decoded.push(row);
  }
  return decoded;
}

async function listBettorAccountsLegacy(
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
 * List bettor accounts for a wallet.
 * Uses getProgramAccountsV2 (1 credit) with fallback to legacy (10 credits).
 */
async function listBettorAccountsForWallet(
  wallet: PublicKey,
  connection: Connection,
): Promise<BettorAccountDecoded[]> {
  const rpcUrl = getBettingRpcEndpoint();
  // Only try V2 on Helius endpoints
  if (rpcUrl.includes("helius")) {
    try {
      return await listBettorAccountsV2(wallet, rpcUrl);
    } catch (err: any) {
      console.warn(`[claims] getProgramAccountsV2 failed, falling back to legacy:`, err?.message);
    }
  }
  return listBettorAccountsLegacy(wallet, connection);
}

// ---------------------------------------------------------------------------
// Batch rumble state reads via getMultipleAccountsInfo (1 credit for all)
// ---------------------------------------------------------------------------

const STATE_NAMES: Record<number, "betting" | "combat" | "payout" | "complete"> = {
  0: "betting",
  1: "combat",
  2: "payout",
  3: "complete",
};

interface MinimalRumbleState {
  state: "betting" | "combat" | "payout" | "complete";
  winnerIndex: number | null;
  totalDeployedLamports: bigint;
  adminFeeCollectedLamports: bigint;
  sponsorshipPaidLamports: bigint;
  bettingPools: bigint[];
}

/**
 * Batch-read rumble account states using getMultipleAccountsInfo.
 * 1 RPC call for ALL rumble IDs instead of N individual calls.
 */
async function batchReadRumbleStates(
  rumbleIds: number[],
  connection: Connection,
): Promise<Map<number, MinimalRumbleState | null>> {
  const result = new Map<number, MinimalRumbleState | null>();
  if (rumbleIds.length === 0) return result;

  // Derive all PDAs
  const pdas = rumbleIds.map((id) => deriveRumblePdaMainnet(id)[0]);

  // Batch fetch in chunks of 100 (RPC limit)
  const CHUNK = 100;
  for (let i = 0; i < pdas.length; i += CHUNK) {
    const chunkPdas = pdas.slice(i, i + CHUNK);
    const chunkIds = rumbleIds.slice(i, i + CHUNK);

    try {
      const infos = await connection.getMultipleAccountsInfo(chunkPdas, "confirmed");
      for (let j = 0; j < infos.length; j++) {
        const info = infos[j];
        const rumbleId = chunkIds[j];
        if (!info || info.data.length < 40) {
          result.set(rumbleId, null);
          continue;
        }

        const data = info.data;
        // Rumble account layout (must match on-chain struct exactly):
        // discriminator(8) + id(8) + state(1) + fighters(32*16=512) +
        // fighter_count(1) + betting_pools(8*16=128) + total_deployed(8) +
        // admin_fee_collected(8) + sponsorship_paid(8) + placements(16) +
        // winner_index(1) + betting_deadline(8) + combat_started_at(8) +
        // completed_at(8) + bump(1) = 724
        const stateVal = data[16]; // state (u8)
        const state = STATE_NAMES[stateVal] ?? "betting";

        const fightersOffset = 8 + 8 + 1; // 17
        const fighterCountOffset = fightersOffset + 32 * 16; // 529
        const fighterCount = data[fighterCountOffset];
        const bettingPoolsOffset = fighterCountOffset + 1; // 530
        const totalDeployedOffset = bettingPoolsOffset + 8 * 16; // 658
        const adminFeeCollectedOffset = totalDeployedOffset + 8; // 666
        const sponsorshipPaidOffset = adminFeeCollectedOffset + 8; // 674
        const placementsOffset = sponsorshipPaidOffset + 8; // 682
        const winnerIndexOffset = placementsOffset + 16; // 698

        const winnerIndex = data[winnerIndexOffset];

        const totalDeployedLamports = data.length >= totalDeployedOffset + 8
          ? readU64LE(data, totalDeployedOffset) : 0n;
        const adminFeeCollectedLamports = data.length >= adminFeeCollectedOffset + 8
          ? readU64LE(data, adminFeeCollectedOffset) : 0n;
        const sponsorshipPaidLamports = data.length >= sponsorshipPaidOffset + 8
          ? readU64LE(data, sponsorshipPaidOffset) : 0n;

        // Read betting pools (16 x u64)
        const bettingPools: bigint[] = [];
        if (data.length >= bettingPoolsOffset + 8 * 16) {
          for (let k = 0; k < 16; k++) {
            bettingPools.push(readU64LE(data, bettingPoolsOffset + k * 8));
          }
        }

        result.set(rumbleId, {
          state,
          winnerIndex: state === "payout" || state === "complete" ? winnerIndex : null,
          totalDeployedLamports,
          adminFeeCollectedLamports,
          sponsorshipPaidLamports,
          bettingPools,
        });
      }
    } catch (err: any) {
      console.error(`[claims] batchReadRumbleStates chunk failed:`, err?.message);
      // Fall back to individual reads for this chunk
      for (const id of chunkIds) {
        try {
          const s = await readRumbleAccountState(id, connection, RUMBLE_ENGINE_ID_MAINNET);
          if (s) {
            result.set(id, {
              state: s.state,
              winnerIndex: s.winnerIndex,
              totalDeployedLamports: s.totalDeployedLamports,
              adminFeeCollectedLamports: s.adminFeeCollectedLamports,
              sponsorshipPaidLamports: s.sponsorshipPaidLamports,
              bettingPools: s.bettingPools ?? [],
            });
          } else {
            result.set(id, null);
          }
        } catch {
          result.set(id, null);
        }
      }
    }
  }
  return result;
}

/**
 * Batch-read vault balances using getMultipleAccountsInfo.
 * Reads AccountInfo.lamports instead of calling getBalance N times.
 * 1 RPC call for all vaults.
 */
async function batchReadVaultBalances(
  rumbleIds: number[],
  connection: Connection,
): Promise<Map<number, number>> {
  const result = new Map<number, number>();
  if (rumbleIds.length === 0) return result;

  const pdas = rumbleIds.map((id) => deriveVaultPdaMainnet(id)[0]);

  const CHUNK = 100;
  for (let i = 0; i < pdas.length; i += CHUNK) {
    const chunkPdas = pdas.slice(i, i + CHUNK);
    const chunkIds = rumbleIds.slice(i, i + CHUNK);

    try {
      const infos = await connection.getMultipleAccountsInfo(chunkPdas, "confirmed");
      for (let j = 0; j < infos.length; j++) {
        result.set(chunkIds[j], infos[j]?.lamports ?? 0);
      }
    } catch {
      // Fallback to individual getBalance
      for (const id of chunkIds) {
        try {
          const [vaultPda] = deriveVaultPdaMainnet(id);
          const bal = await connection.getBalance(vaultPda, "confirmed");
          result.set(id, bal);
        } catch {
          result.set(id, 0);
        }
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Main snapshot function
// ---------------------------------------------------------------------------

/**
 * Fully on-chain payout snapshot for a wallet.
 * Source of truth is bettor + rumble program accounts only.
 *
 * Optimizations applied:
 * - getProgramAccountsV2 (1 credit instead of 10)
 * - getMultipleAccountsInfo for rumble states (1 call instead of N)
 * - getMultipleAccountsInfo for vault balances (1 call instead of N)
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

  // Batch-read all rumble states in 1 RPC call
  const rumbleIds = [...new Set(bettorRows.map((row) => row.rumbleIdNum))];
  const rumbleStateById = await batchReadRumbleStates(rumbleIds, connection);

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

  // First pass: identify rumbles that need vault balance checks
  const needsVaultCheck: number[] = [];
  const candidateBettors: BettorAccountDecoded[] = [];

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

    needsVaultCheck.push(bettor.rumbleIdNum);
    candidateBettors.push(bettor);
  }

  // Batch-read all vault balances in 1 RPC call
  const uniqueVaultIds = [...new Set(needsVaultCheck)];
  const vaultBalances = await batchReadVaultBalances(uniqueVaultIds, connection);

  // Second pass: apply vault balance checks and compute payouts
  for (const bettor of candidateBettors) {
    const rumbleState = rumbleStateById.get(bettor.rumbleIdNum)!;
    const winnerIndex = rumbleState.winnerIndex!;
    const winnerDeploymentLamports = bettor.fighterDeploymentsLamports[winnerIndex] ?? 0n;
    const onchainClaimableLamports = bettor.claimableLamports;

    const vaultBalance = vaultBalances.get(bettor.rumbleIdNum) ?? 0;
    const estimatedPayoutLamports = onchainClaimableLamports > 0n
      ? onchainClaimableLamports
      : winnerDeploymentLamports;
    // Vault PDAs are ephemeral and can be fully drained (no rent reserve needed).
    // Only skip if vault literally can't cover the estimated payout.
    if (vaultBalance < Number(estimatedPayoutLamports)) continue;

    const onchainClaimableSol = Number(onchainClaimableLamports) / LAMPORTS_PER_SOL;

    // Compute actual proportional payout when claimableLamports is 0
    let inferredClaimableSol: number;
    if (onchainClaimableSol > 0) {
      inferredClaimableSol = onchainClaimableSol;
    } else {
      const totalWinnerPool = rumbleState.bettingPools?.[winnerIndex] ?? 0n;
      const netPrizePool = rumbleState.totalDeployedLamports
        - rumbleState.adminFeeCollectedLamports
        - rumbleState.sponsorshipPaidLamports;

      if (totalWinnerPool > 0n && netPrizePool > 0n) {
        const payoutLamports = (winnerDeploymentLamports * netPrizePool) / totalWinnerPool;
        inferredClaimableSol = Number(payoutLamports) / LAMPORTS_PER_SOL;
      } else {
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
