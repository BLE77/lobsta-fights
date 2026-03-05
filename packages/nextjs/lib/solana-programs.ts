/**
 * Solana Program Integration Layer
 *
 * Connects the off-chain orchestrator to the on-chain Solana programs.
 * Uses @coral-xyz/anchor to build transactions against the IDLs.
 *
 * All functions return unsigned transactions for the caller to sign.
 * Server-side admin functions sign with the deployer keypair.
 */
import * as anchor from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  Transaction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  GetCommitmentSignature,
  createTopUpEscrowInstruction,
  escrowPdaFromEscrowAuthority,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  getConnection,
  getBettingConnection,
  getBettingReadConnections,
  getErConnection,
} from "./solana-connection";
import { createHash, randomBytes } from "node:crypto";
import { keccak_256 } from "@noble/hashes/sha3";

// IDLs (imported as JSON)
import fighterRegistryIdl from "./idl/fighter_registry.json";
import ichorTokenIdl from "./idl/ichor_token.json";
import rumbleEngineIdl from "./idl/rumble_engine.json";

// ---------------------------------------------------------------------------
// Program IDs
// ---------------------------------------------------------------------------

const DEFAULT_FIGHTER_REGISTRY_ID = "2hA6Jvj1yjP2Uj3qrJcsBeYA2R9xPM95mDKw1ncKVExa";
const DEFAULT_ICHOR_TOKEN_ID = "925GAeqjKMX4B5MDANB91SZCvrx8HpEgmPJwHJzxKJx1";
const DEFAULT_RUMBLE_ENGINE_ID = "638DcfW6NaBweznnzmJe4PyxCw51s3CTkykUNskWnxTU";

function readEnvTrimmed(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function readFirstEnv(names: string[]): string {
  for (const name of names) {
    const value = readEnvTrimmed(name);
    if (value) return value;
  }
  return "";
}

export const FIGHTER_REGISTRY_ID = new PublicKey(
  readFirstEnv([
    "NEXT_PUBLIC_FIGHTER_REGISTRY_PROGRAM",
    "FIGHTER_REGISTRY_PROGRAM_ID",
    "NEXT_PUBLIC_FIGHTER_REGISTRY_ID",
  ]) || DEFAULT_FIGHTER_REGISTRY_ID,
);
export const ICHOR_TOKEN_ID = new PublicKey(
  readFirstEnv([
    "NEXT_PUBLIC_ICHOR_TOKEN_PROGRAM",
    "ICHOR_TOKEN_PROGRAM_ID",
    "NEXT_PUBLIC_ICHOR_TOKEN_ID",
  ]) || DEFAULT_ICHOR_TOKEN_ID,
);
export const RUMBLE_ENGINE_ID = new PublicKey(
  readFirstEnv([
    "NEXT_PUBLIC_RUMBLE_ENGINE_PROGRAM",
    "RUMBLE_ENGINE_PROGRAM_ID",
    "NEXT_PUBLIC_RUMBLE_ENGINE_ID",
  ]) || DEFAULT_RUMBLE_ENGINE_ID,
);

/**
 * Mainnet program ID for betting operations.
 * Same program deployed to mainnet-beta — only betting instructions are called there.
 * Falls back to devnet program ID if not configured (for testing).
 */
export const RUMBLE_ENGINE_ID_MAINNET = new PublicKey(
  readEnvTrimmed("NEXT_PUBLIC_RUMBLE_ENGINE_MAINNET") ||
  readEnvTrimmed("RUMBLE_ENGINE_MAINNET_PROGRAM_ID") ||
  readEnvTrimmed("NEXT_PUBLIC_RUMBLE_ENGINE_ID_MAINNET") ||
  RUMBLE_ENGINE_ID.toBase58()
);

export const ICHOR_TOKEN_ID_MAINNET = new PublicKey(
  readEnvTrimmed("NEXT_PUBLIC_ICHOR_TOKEN_MAINNET") ||
  readEnvTrimmed("NEXT_PUBLIC_ICHOR_TOKEN_ID_MAINNET") ||
  readEnvTrimmed("ICHOR_TOKEN_MAINNET_PROGRAM_ID") ||
  ICHOR_TOKEN_ID.toBase58()
);

export function isMainnetConfigured(): boolean {
  const hasRumbleEngine = Boolean(
    readEnvTrimmed("NEXT_PUBLIC_RUMBLE_ENGINE_MAINNET") ||
    readEnvTrimmed("RUMBLE_ENGINE_MAINNET_PROGRAM_ID") ||
    readEnvTrimmed("NEXT_PUBLIC_RUMBLE_ENGINE_ID_MAINNET")
  );

  const hasMainnetDeployer = Boolean(readEnvTrimmed("SOLANA_MAINNET_DEPLOYER_KEYPAIR"));

  return hasRumbleEngine && hasMainnetDeployer;
}

// ---------------------------------------------------------------------------
// PDA Seeds
// ---------------------------------------------------------------------------

const ARENA_SEED = Buffer.from("arena_config");
const DISTRIBUTION_VAULT_SEED = Buffer.from("distribution_vault");
const SHOWER_REQUEST_SEED = Buffer.from("shower_request");
const ENTROPY_CONFIG_SEED = Buffer.from("entropy_config");
const PENDING_ADMIN_SEED = Buffer.from("pending_admin");
const ENTROPY_VAR_SEED = Buffer.from("var");
const REGISTRY_SEED = Buffer.from("registry_config");
const CONFIG_SEED = Buffer.from("rumble_config");
const FIGHTER_SEED = Buffer.from("fighter");
const WALLET_STATE_SEED = Buffer.from("wallet_state");
const RUMBLE_SEED = Buffer.from("rumble");
const VAULT_SEED = Buffer.from("vault");
const BETTOR_SEED = Buffer.from("bettor");
const SPONSORSHIP_SEED = Buffer.from("sponsorship");
const MOVE_COMMIT_SEED = Buffer.from("move_commit");
const COMBAT_STATE_SEED = Buffer.from("combat_state");
const DELEGATION_BUFFER_SEED = Buffer.from("buffer");
const DELEGATION_RECORD_SEED = Buffer.from("delegation");
const DELEGATION_METADATA_SEED = Buffer.from("delegation-metadata");
const SLOT_HASHES_SYSVAR_ID = new PublicKey(
  "SysvarS1otHashes111111111111111111111111111"
);

// MagicBlock Delegation Program
const DELEGATION_PROGRAM_ID = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const MAGIC_PROGRAM_ID = new PublicKey("Magic11111111111111111111111111111111111111");
const MAGIC_CONTEXT_ID = new PublicKey("MagicContext1111111111111111111111111111111");
const ER_VALIDATOR_CACHE_TTL_MS = Math.max(
  5_000,
  Number(process.env.MAGICBLOCK_ER_VALIDATOR_CACHE_TTL_MS ?? "60000"),
);
const ER_ESCROW_MIN_SOL = Math.max(
  0,
  Number(process.env.MAGICBLOCK_ER_ESCROW_MIN_SOL ?? "0.02"),
);
const ER_ESCROW_TOPUP_MAX_SOL = Math.max(
  0,
  Number(process.env.MAGICBLOCK_ER_ESCROW_TOPUP_MAX_SOL ?? "0.05"),
);

type ErClosestValidator = { identity: string; fqdn?: string };
type ErRouterLikeConnection = Connection & {
  getClosestValidator?: () => Promise<ErClosestValidator>;
  getLatestBlockhashForTransaction?: (
    transaction: Transaction,
    options?: { commitment?: anchor.web3.Commitment },
  ) => Promise<{ blockhash: string; lastValidBlockHeight: number }>;
};

const _erValidatorConnectionCache = new Map<string, Connection>();
let _erClosestValidatorCache:
  | { at: number; endpoint: string; value: ErClosestValidator | null }
  | null = null;

function normalizeErValidatorEndpoint(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed.replace(/\/+$/, "");
  }
  return `https://${trimmed.replace(/\/+$/, "")}`;
}

function getOrCreateErValidatorConnection(endpoint: string): Connection {
  const normalized = normalizeErValidatorEndpoint(endpoint);
  const existing = _erValidatorConnectionCache.get(normalized);
  if (existing) return existing;
  const conn = new Connection(normalized, {
    commitment: "confirmed",
    wsEndpoint: normalized.replace("https://", "wss://"),
  });
  _erValidatorConnectionCache.set(normalized, conn);
  return conn;
}

async function getErClosestValidatorCached(conn: Connection): Promise<ErClosestValidator | null> {
  const routerConn = conn as ErRouterLikeConnection;
  if (typeof routerConn.getClosestValidator !== "function") return null;

  const endpoint = String((conn as any).rpcEndpoint ?? (conn as any)._rpcEndpoint ?? "");
  const now = Date.now();
  if (
    _erClosestValidatorCache &&
    _erClosestValidatorCache.endpoint === endpoint &&
    now - _erClosestValidatorCache.at < ER_VALIDATOR_CACHE_TTL_MS
  ) {
    return _erClosestValidatorCache.value;
  }

  try {
    const validator = await routerConn.getClosestValidator();
    _erClosestValidatorCache = { at: now, endpoint, value: validator ?? null };
    return validator ?? null;
  } catch (error) {
    console.warn("[ER] getClosestValidator failed; using router connection for log parsing.", error);
    _erClosestValidatorCache = { at: now, endpoint, value: null };
    return null;
  }
}

async function resolveErRoutingConnections(
  preferredConnection?: Connection,
): Promise<{ txConnection: Connection; logConnection: Connection; validatorEndpoint: string | null }> {
  const txConnection = preferredConnection ?? getErConnection();
  const validator = await getErClosestValidatorCached(txConnection);
  const validatorEndpoint = normalizeErValidatorEndpoint(String(validator?.fqdn ?? ""));
  if (!validatorEndpoint) {
    return {
      txConnection,
      logConnection: txConnection,
      validatorEndpoint: null,
    };
  }
  return {
    txConnection,
    logConnection: getOrCreateErValidatorConnection(validatorEndpoint),
    validatorEndpoint,
  };
}

/**
 * Check if a combat state PDA is currently delegated to ER.
 * Detects delegation by checking if the L1 account owner is the Delegation Program.
 */
export async function isCombatStateDelegated(rumbleId: number): Promise<boolean> {
  const [combatStatePda] = deriveCombatStatePda(rumbleId);
  const conn = getConnection(); // Always check L1
  const info = await conn.getAccountInfo(combatStatePda);
  if (!info) return false;
  return info.owner.equals(DELEGATION_PROGRAM_ID);
}

/**
 * Poll L1 until combat state is no longer delegated (owner reverts from
 * Delegation Program back to rumble_engine). Returns true if undelegation
 * confirmed within the timeout, false if still delegated after maxWaitMs.
 */
export async function waitForUndelegation(
  rumbleId: number,
  maxWaitMs: number = 15000,
): Promise<boolean> {
  console.log(`[ER-WAIT-UNDELEGATE] Polling L1 for undelegation of rumble ${rumbleId} (maxWait=${maxWaitMs}ms)...`);
  const pollIntervalMs = 2000;
  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    try {
      const stillDelegated = await isCombatStateDelegated(rumbleId);
      if (!stillDelegated) {
        console.log(`[ER-WAIT-UNDELEGATE] Undelegation confirmed for rumble ${rumbleId} (${Date.now() - startTime}ms elapsed)`);
        return true;
      }
    } catch (err) {
      // RPC error — treat as "still delegated" and keep polling
      console.warn(`[ER-WAIT-UNDELEGATE] RPC error for rumble ${rumbleId} (will retry):`, err);
    }
    await new Promise(r => setTimeout(r, pollIntervalMs));
  }
  console.warn(`[ER-WAIT-UNDELEGATE] Timed out for rumble ${rumbleId} after ${maxWaitMs}ms — still delegated`);
  return false; // Timed out, still delegated
}

// MagicBlock VRF Program
const VRF_PROGRAM_ID = new PublicKey("Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz");
const VRF_DEFAULT_QUEUE = new PublicKey("Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh");
const VRF_IDENTITY_SEED = Buffer.from("identity");

// ---------------------------------------------------------------------------
// Time-based read cache — reduces RPC calls for hot on-chain reads
// ---------------------------------------------------------------------------

type CacheEntry = { data: unknown; expiresAt: number; lastAccessed: number };
const _readCache = new Map<string, CacheEntry>();
const _readInFlight = new Map<string, Promise<unknown>>();

type CachedReadOptions = {
  nullTtlMs?: number;
};

function cachedRead<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
  options?: CachedReadOptions,
): Promise<T> {
  const now = Date.now();
  const hit = _readCache.get(key);
  if (hit) {
    if (hit.expiresAt <= now) {
      _readCache.delete(key);
    } else {
      hit.lastAccessed = now;
      return Promise.resolve(hit.data as T);
    }
  }
  const pending = _readInFlight.get(key);
  if (pending) return pending as Promise<T>;

  const request = fn()
    .then((r) => {
      const ts = Date.now();
      const isNullish = r === null || r === undefined;
      const effectiveTtl = isNullish
        ? Math.max(0, options?.nullTtlMs ?? ttlMs)
        : ttlMs;
      if (effectiveTtl > 0) {
        _readCache.set(key, {
          data: r,
          expiresAt: ts + effectiveTtl,
          lastAccessed: ts,
        });
      }
      if (_readCache.size > 200) {
        for (const [k, v] of _readCache) {
          if (v.expiresAt <= ts) _readCache.delete(k);
        }

        if (_readCache.size > 200) {
          const byAccess = [..._readCache.entries()].sort(
            (a, b) => a[1].lastAccessed - b[1].lastAccessed,
          );
          const keep = 150;
          const toRemove = _readCache.size - keep;
          for (const [k] of byAccess.slice(0, toRemove)) {
            _readCache.delete(k);
          }
        }
      }
      return r;
    })
    .finally(() => {
      _readInFlight.delete(key);
    });

  _readInFlight.set(key, request as Promise<unknown>);
  return request;
}

export function invalidateReadCache(prefix?: string) {
  if (!prefix) {
    _readCache.clear();
    _readInFlight.clear();
    return;
  }
  for (const k of _readCache.keys()) {
    if (k.startsWith(prefix)) _readCache.delete(k);
  }
  for (const k of _readInFlight.keys()) {
    if (k.startsWith(prefix)) _readInFlight.delete(k);
  }
}

// ---------------------------------------------------------------------------
// PDA Derivation Helpers (exported for frontend use)
// ---------------------------------------------------------------------------

export function deriveArenaConfigPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([ARENA_SEED], ICHOR_TOKEN_ID);
}

export function deriveShowerRequestPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([SHOWER_REQUEST_SEED], ICHOR_TOKEN_ID);
}

export function deriveEntropyConfigPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([ENTROPY_CONFIG_SEED], ICHOR_TOKEN_ID);
}

export function deriveDistributionVaultPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([DISTRIBUTION_VAULT_SEED], ICHOR_TOKEN_ID);
}

export function deriveRegistryConfigPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([REGISTRY_SEED], FIGHTER_REGISTRY_ID);
}

export function deriveRumbleConfigPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([CONFIG_SEED], RUMBLE_ENGINE_ID);
}

function deriveVrfProgramIdentityPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([VRF_IDENTITY_SEED], programId)[0];
}

export function deriveFighterPda(
  authority: PublicKey,
  fighterIndex: number
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [FIGHTER_SEED, authority.toBuffer(), Buffer.from([fighterIndex])],
    FIGHTER_REGISTRY_ID
  );
}

export function deriveWalletStatePda(authority: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [WALLET_STATE_SEED, authority.toBuffer()],
    FIGHTER_REGISTRY_ID
  );
}

export function deriveRumblePda(rumbleId: bigint | number): [PublicKey, number] {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(rumbleId));
  return PublicKey.findProgramAddressSync(
    [RUMBLE_SEED, buf],
    RUMBLE_ENGINE_ID
  );
}

export function deriveVaultPda(rumbleId: bigint | number): [PublicKey, number] {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(rumbleId));
  return PublicKey.findProgramAddressSync(
    [VAULT_SEED, buf],
    RUMBLE_ENGINE_ID
  );
}

export function deriveBettorPda(
  rumbleId: bigint | number,
  bettor: PublicKey
): [PublicKey, number] {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(rumbleId));
  return PublicKey.findProgramAddressSync(
    [BETTOR_SEED, buf, bettor.toBuffer()],
    RUMBLE_ENGINE_ID
  );
}

export function deriveSponsorshipPda(
  fighterPubkey: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SPONSORSHIP_SEED, fighterPubkey.toBuffer()],
    RUMBLE_ENGINE_ID
  );
}

export function deriveMoveCommitmentPda(
  rumbleId: bigint | number,
  fighter: PublicKey,
  turn: number,
): [PublicKey, number] {
  const rumbleBuf = Buffer.alloc(8);
  rumbleBuf.writeBigUInt64LE(BigInt(rumbleId));
  const turnBuf = Buffer.alloc(4);
  turnBuf.writeUInt32LE(turn >>> 0);
  return PublicKey.findProgramAddressSync(
    [MOVE_COMMIT_SEED, rumbleBuf, fighter.toBuffer(), turnBuf],
    RUMBLE_ENGINE_ID,
  );
}

export function deriveCombatStatePda(
  rumbleId: bigint | number,
  programId: PublicKey = RUMBLE_ENGINE_ID,
): [PublicKey, number] {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(rumbleId));
  return PublicKey.findProgramAddressSync(
    [COMBAT_STATE_SEED, buf],
    programId,
  );
}

function deriveDelegationBufferPda(
  combatStatePda: PublicKey,
  ownerProgramId: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [DELEGATION_BUFFER_SEED, combatStatePda.toBuffer()],
    ownerProgramId,
  );
}

function deriveDelegationRecordPda(combatStatePda: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [DELEGATION_RECORD_SEED, combatStatePda.toBuffer()],
    DELEGATION_PROGRAM_ID,
  );
}

function deriveDelegationMetadataPda(combatStatePda: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [DELEGATION_METADATA_SEED, combatStatePda.toBuffer()],
    DELEGATION_PROGRAM_ID,
  );
}

// ---------------------------------------------------------------------------
// Mainnet PDA Derivation Helpers (betting operations)
// ---------------------------------------------------------------------------

export function deriveRumbleConfigPdaMainnet(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([CONFIG_SEED], RUMBLE_ENGINE_ID_MAINNET);
}

export function deriveRumblePdaMainnet(rumbleId: bigint | number): [PublicKey, number] {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(rumbleId));
  return PublicKey.findProgramAddressSync(
    [RUMBLE_SEED, buf],
    RUMBLE_ENGINE_ID_MAINNET,
  );
}

export function deriveVaultPdaMainnet(rumbleId: bigint | number): [PublicKey, number] {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(rumbleId));
  return PublicKey.findProgramAddressSync(
    [VAULT_SEED, buf],
    RUMBLE_ENGINE_ID_MAINNET,
  );
}

export function deriveBettorPdaMainnet(
  rumbleId: bigint | number,
  bettor: PublicKey,
): [PublicKey, number] {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(rumbleId));
  return PublicKey.findProgramAddressSync(
    [BETTOR_SEED, buf, bettor.toBuffer()],
    RUMBLE_ENGINE_ID_MAINNET,
  );
}

export function deriveSponsorshipPdaMainnet(
  fighterPubkey: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SPONSORSHIP_SEED, fighterPubkey.toBuffer()],
    RUMBLE_ENGINE_ID_MAINNET,
  );
}

function readU64LE(data: Uint8Array, offset: number): bigint {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return view.getBigUint64(offset, true);
}

function readI64LE(data: Uint8Array, offset: number): bigint {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return view.getBigInt64(offset, true);
}

export interface BettorAccountState {
  address: PublicKey;
  authority: PublicKey;
  rumbleId: bigint;
  fighterIndex: number;
  solDeployedLamports: bigint;
  claimableLamports: bigint;
  totalClaimedLamports: bigint;
  lastClaimTs: bigint;
  claimed: boolean;
  bump: number;
  fighterDeploymentsLamports: bigint[];
}

export type OnchainRumbleState = "betting" | "combat" | "payout" | "complete";

const ONCHAIN_RUMBLE_STATES: OnchainRumbleState[] = [
  "betting",
  "combat",
  "payout",
  "complete",
];

export interface RumbleAccountState {
  address: PublicKey;
  rumbleId: bigint;
  state: OnchainRumbleState;
  fighterCount: number;
  /** Fighter public keys extracted from the on-chain account (avoids separate RPC call). */
  fighters: PublicKey[];
  placements: number[];
  winnerIndex: number | null;
  bettingPools: bigint[];
  totalDeployedLamports: bigint;
  adminFeeCollectedLamports: bigint;
  sponsorshipPaidLamports: bigint;
  bettingCloseSlot: bigint;
  // Legacy compatibility field: this account offset previously represented
  // unix timestamp and is now used as on-chain slot close.
  bettingDeadlineTs: bigint;
  combatStartedAtTs: bigint;
  completedAtTs: bigint;
}

export interface RumbleCombatAccountState {
  address: PublicKey;
  rumbleId: bigint;
  fighterCount: number;
  currentTurn: number;
  turnOpenSlot: bigint;
  commitCloseSlot: bigint;
  revealCloseSlot: bigint;
  turnResolved: boolean;
  remainingFighters: number;
  winnerIndex: number | null;
  hp: number[];
  meter: number[];
  eliminationRank: number[];
  totalDamageDealt: bigint[];
  totalDamageTaken: bigint[];
  bump: number;
}

function getConnectionCacheKey(connection: Connection): string {
  const connAny = connection as unknown as {
    rpcEndpoint?: string;
    _rpcEndpoint?: string;
  };
  const endpoint = connAny.rpcEndpoint ?? connAny._rpcEndpoint ?? "unknown";
  return endpoint.replace(/api[_-]key=[^&]+/gi, "api-key=redacted");
}

/**
 * Read a rumble account's current state directly from chain.
 * Pass programId to read from mainnet program (uses mainnet PDA derivation).
 */
export async function readRumbleAccountState(
  rumbleId: bigint | number,
  connection?: Connection,
  programId?: PublicKey,
): Promise<RumbleAccountState | null> {
  const useMainnet = programId && !programId.equals(RUMBLE_ENGINE_ID);
  const conn = connection ?? (useMainnet ? getBettingConnection() : getConnection());
  const endpointKey = getConnectionCacheKey(conn);
  const key = `rumble:${useMainnet ? "mainnet:" : ""}${rumbleId}:${endpointKey}`;
  // 10s cache — rumble state (betting/combat/payout) doesn't change faster than this.
  // Saves ~70% of getAccountInfo calls vs the previous 3s cache.
  return cachedRead(key, 10_000, async () => {
    const [rumblePda] = useMainnet ? deriveRumblePdaMainnet(rumbleId) : deriveRumblePda(rumbleId);
    const MIN_RUMBLE_ACCOUNT_LEN = 724;
    // Use processed commitment to minimize stale reads around betting close.
    const info = await conn.getAccountInfo(rumblePda, "processed");
    if (!info || info.data.length < MIN_RUMBLE_ACCOUNT_LEN) return null;

    const data = info.data;
    const parsedRumbleId = readU64LE(data, 8);
    const rawState = data[16] ?? 0;
    const state = ONCHAIN_RUMBLE_STATES[rawState];
    if (!state) return null;

    const fightersOffset = 8 + 8 + 1;
    const fighterCountOffset = fightersOffset + 32 * 16;
    const fighterCount = Math.min(data[fighterCountOffset] ?? 0, 16);
    const bettingPoolsOffset = fighterCountOffset + 1;
    const totalDeployedOffset = bettingPoolsOffset + 8 * 16;
    const adminFeeCollectedOffset = totalDeployedOffset + 8;
    const sponsorshipPaidOffset = adminFeeCollectedOffset + 8;
    const placementsOffset = sponsorshipPaidOffset + 8;
    const winnerIndexOffset = placementsOffset + 16;
    const bettingDeadlineOffset = winnerIndexOffset + 1;
    const combatStartedAtOffset = bettingDeadlineOffset + 8;
    const completedAtOffset = combatStartedAtOffset + 8;

    // Extract fighter public keys from the same data (avoids separate RPC call)
    const fighters: PublicKey[] = [];
    for (let i = 0; i < fighterCount; i++) {
      const start = fightersOffset + i * 32;
      if (start + 32 <= data.length) {
        const pk = new PublicKey(data.slice(start, start + 32));
        if (!pk.equals(PublicKey.default)) {
          fighters.push(pk);
        }
      }
    }

    const winnerIndexRaw = data.length > winnerIndexOffset ? data[winnerIndexOffset] : undefined;
    const winnerIndex =
      typeof winnerIndexRaw === "number" && winnerIndexRaw < 16 ? winnerIndexRaw : null;

    const bettingPools: bigint[] = [];
    if (data.length >= bettingPoolsOffset + 8 * 16) {
      for (let i = 0; i < 16; i++) {
        bettingPools.push(readU64LE(data, bettingPoolsOffset + i * 8));
      }
    }
    const totalDeployedLamports = data.length >= totalDeployedOffset + 8 ? readU64LE(data, totalDeployedOffset) : 0n;
    const adminFeeCollectedLamports = data.length >= adminFeeCollectedOffset + 8 ? readU64LE(data, adminFeeCollectedOffset) : 0n;
    const sponsorshipPaidLamports = data.length >= sponsorshipPaidOffset + 8 ? readU64LE(data, sponsorshipPaidOffset) : 0n;

    const placements: number[] = [];
    for (let i = 0; i < 16; i++) {
      const offset = placementsOffset + i;
      placements.push(offset < data.length ? data[offset] ?? 0 : 0);
    }
    const bettingDeadlineRaw = data.length >= bettingDeadlineOffset + 8 ? readI64LE(data, bettingDeadlineOffset) : 0n;
    const bettingCloseSlot = bettingDeadlineRaw > 0n ? bettingDeadlineRaw : 0n;
    const combatStartedAtTs = data.length >= combatStartedAtOffset + 8 ? readI64LE(data, combatStartedAtOffset) : 0n;
    const completedAtTs = data.length >= completedAtOffset + 8 ? readI64LE(data, completedAtOffset) : 0n;

    return {
      address: rumblePda,
      rumbleId: parsedRumbleId,
      state,
      fighterCount,
      fighters,
      placements,
      winnerIndex,
      bettingPools,
      totalDeployedLamports,
      adminFeeCollectedLamports,
      sponsorshipPaidLamports,
      bettingCloseSlot,
      bettingDeadlineTs: bettingDeadlineRaw,
      combatStartedAtTs,
      completedAtTs,
    };
  }, {
    // Avoid poisoning retries for newly-created accounts while still reducing
    // hot-loop misses.
    nullTtlMs: 500,
  });
}

interface ResilientMainnetReadOptions {
  maxPasses?: number;
  retryDelayMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Read mainnet betting state with endpoint fallback.
 * Never falls back to devnet, preserving mainnet as source-of-truth.
 */
export async function readMainnetRumbleAccountStateResilient(
  rumbleId: bigint | number,
  options?: ResilientMainnetReadOptions,
): Promise<RumbleAccountState | null> {
  const maxPasses = Math.max(1, options?.maxPasses ?? 2);
  const retryDelayMs = Math.max(0, options?.retryDelayMs ?? 150);
  for (let pass = 0; pass < maxPasses; pass++) {
    for (const conn of getBettingReadConnections()) {
      const state = await readRumbleAccountState(
        rumbleId,
        conn,
        RUMBLE_ENGINE_ID_MAINNET,
      ).catch(() => null);
      if (state) return state;
    }
    if (pass < maxPasses - 1 && retryDelayMs > 0) {
      await sleep(retryDelayMs);
    }
  }
  return null;
}

/**
 * Read the raw betting_pools[16] (u64 lamport values) from the on-chain
 * rumble account. Delegates to cached readRumbleAccountState to avoid
 * duplicate RPC calls (saves 1 credit per call).
 */
export async function readRumbleBettingPools(
  rumbleId: bigint | number,
  connection?: Connection,
): Promise<bigint[] | null> {
  const state = await readRumbleAccountState(rumbleId, connection);
  return state?.bettingPools ?? null;
}

/**
 * Read the combat state PDA for a rumble directly from chain.
 */
export async function readRumbleCombatState(
  rumbleId: bigint | number,
  connection?: Connection,
): Promise<RumbleCombatAccountState | null> {
  const conn = connection ?? getConnection();
  const endpointKey = getConnectionCacheKey(conn);
  const key = `combat:${rumbleId}:${endpointKey}`;
  // 5s cache — combat state changes once per turn (~20-30s). 5s is a good
  // balance between freshness and RPC cost savings (~60% reduction).
  return cachedRead(key, 5_000, async () => {
    const [combatStatePda] = deriveCombatStatePda(rumbleId);
    const MIN_COMBAT_ACCOUNT_LEN = 401;
    const info = await conn.getAccountInfo(combatStatePda, "processed");
    if (!info || info.data.length < MIN_COMBAT_ACCOUNT_LEN) return null;

    const data = info.data;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

    const fighterCountOffset = 8 + 8;
    const currentTurnOffset = fighterCountOffset + 1;
    const turnOpenSlotOffset = currentTurnOffset + 4;
    const commitCloseSlotOffset = turnOpenSlotOffset + 8;
    const revealCloseSlotOffset = commitCloseSlotOffset + 8;
    const turnResolvedOffset = revealCloseSlotOffset + 8;
    const remainingFightersOffset = turnResolvedOffset + 1;
    const winnerIndexOffset = remainingFightersOffset + 1;
    const hpOffset = winnerIndexOffset + 1;
    const meterOffset = hpOffset + 16 * 2;
    const eliminationRankOffset = meterOffset + 16;
    const totalDamageDealtOffset = eliminationRankOffset + 16;
    const totalDamageTakenOffset = totalDamageDealtOffset + 16 * 8;
    const vrfSeedOffset = totalDamageTakenOffset + 16 * 8;
    const bumpOffset = vrfSeedOffset + 32;

    const parsedRumbleId = view.getBigUint64(8, true);
    const fighterCount = data[fighterCountOffset] ?? 0;
    const currentTurn = view.getUint32(currentTurnOffset, true);
    const turnOpenSlot = view.getBigUint64(turnOpenSlotOffset, true);
    const commitCloseSlot = view.getBigUint64(commitCloseSlotOffset, true);
    const revealCloseSlot = view.getBigUint64(revealCloseSlotOffset, true);
    const turnResolved = data[turnResolvedOffset] === 1;
    const remainingFighters = data[remainingFightersOffset] ?? 0;
    const winnerIndexRaw = data[winnerIndexOffset] ?? 255;

    const hp: number[] = [];
    for (let i = 0; i < 16; i++) {
      hp.push(view.getUint16(hpOffset + i * 2, true));
    }

    const meter: number[] = [];
    for (let i = 0; i < 16; i++) {
      meter.push(data[meterOffset + i] ?? 0);
    }

    const eliminationRank: number[] = [];
    for (let i = 0; i < 16; i++) {
      eliminationRank.push(data[eliminationRankOffset + i] ?? 0);
    }

    const totalDamageDealt: bigint[] = [];
    for (let i = 0; i < 16; i++) {
      totalDamageDealt.push(view.getBigUint64(totalDamageDealtOffset + i * 8, true));
    }

    const totalDamageTaken: bigint[] = [];
    for (let i = 0; i < 16; i++) {
      totalDamageTaken.push(view.getBigUint64(totalDamageTakenOffset + i * 8, true));
    }

    const bump = data[bumpOffset] ?? 0;
    const winnerIndex = winnerIndexRaw < 16 ? winnerIndexRaw : null;

    return {
      address: combatStatePda,
      rumbleId: parsedRumbleId,
      fighterCount,
      currentTurn,
      turnOpenSlot,
      commitCloseSlot,
      revealCloseSlot,
      turnResolved,
      remainingFighters,
      winnerIndex,
      hp,
      meter,
      eliminationRank,
      totalDamageDealt,
      totalDamageTaken,
      bump,
    };
  });
}

/**
 * Read a bettor account directly from chain.
 * Works with both old and new layouts; missing new fields default to zero.
 */
export async function readBettorAccount(
  bettor: PublicKey,
  rumbleId: bigint | number,
  connection?: Connection,
): Promise<BettorAccountState | null> {
  const conn = connection ?? getConnection();
  const [bettorPda] = deriveBettorPda(rumbleId, bettor);
  const info = await conn.getAccountInfo(bettorPda, "confirmed");
  if (!info || info.data.length < 59) return null;

  const data = info.data;
  let offset = 8; // discriminator

  const authority = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;

  const parsedRumbleId = readU64LE(data, offset);
  offset += 8;

  const fighterIndex = data[offset] ?? 0;
  offset += 1;

  const solDeployedLamports = readU64LE(data, offset);
  offset += 8;

  // Older layouts only had claimed + bump after sol_deployed.
  let claimableLamports = 0n;
  let totalClaimedLamports = 0n;
  let lastClaimTs = 0n;
  let claimed = false;
  let bump = 0;
  const fighterDeploymentsLamports: bigint[] = [];

  if (data.length >= offset + 8 + 8 + 8 + 1 + 1) {
    claimableLamports = readU64LE(data, offset);
    offset += 8;
    totalClaimedLamports = readU64LE(data, offset);
    offset += 8;
    lastClaimTs = readI64LE(data, offset);
    offset += 8;
    claimed = data[offset] === 1;
    offset += 1;
    bump = data[offset] ?? 0;
    offset += 1;
  } else if (data.length >= offset + 1 + 1) {
    claimed = data[offset] === 1;
    offset += 1;
    bump = data[offset] ?? 0;
    offset += 1;
  }

  // New layout appends fighter_deployments: [u64; 16] after bump.
  if (data.length >= offset + 8 * 16) {
    // bump byte is consumed above; deployments start at current offset
    for (let i = 0; i < 16; i++) {
      fighterDeploymentsLamports.push(readU64LE(data, offset));
      offset += 8;
    }
  } else {
    // Legacy fallback: only one fighter index tracked.
    const legacy = Array<bigint>(16).fill(0n);
    if (fighterIndex >= 0 && fighterIndex < 16) {
      legacy[fighterIndex] = solDeployedLamports;
    }
    fighterDeploymentsLamports.push(...legacy);
  }

  return {
    address: bettorPda,
    authority,
    rumbleId: parsedRumbleId,
    fighterIndex,
    solDeployedLamports,
    claimableLamports,
    totalClaimedLamports,
    lastClaimTs,
    claimed,
    bump,
    fighterDeploymentsLamports,
  };
}

// ---------------------------------------------------------------------------
// Provider / Program Construction
// ---------------------------------------------------------------------------

/** ICHOR mint address (set after initialization) */
let _ichorMint: PublicKey | null = null;

export function getIchorMint(): PublicKey {
  if (_ichorMint) return _ichorMint;

  const envMint = process.env.NEXT_PUBLIC_ICHOR_TOKEN_MINT ?? process.env.NEXT_PUBLIC_ICHOR_MINT;
  if (envMint) {
    _ichorMint = new PublicKey(envMint);
    return _ichorMint;
  }

  throw new Error(
    "ICHOR mint address not set. Set NEXT_PUBLIC_ICHOR_TOKEN_MINT env var."
  );
}

export function setIchorMint(mint: PublicKey): void {
  _ichorMint = mint;
}

/**
 * Minimal wallet adapter that satisfies AnchorProvider's Wallet interface.
 * Avoids relying on anchor.Wallet which has webpack resolution issues.
 */
type ProviderWallet = {
  publicKey: PublicKey;
  signTransaction<T extends anchor.web3.Transaction | anchor.web3.VersionedTransaction>(tx: T): Promise<T>;
  signAllTransactions<T extends anchor.web3.Transaction | anchor.web3.VersionedTransaction>(txs: T[]): Promise<T[]>;
};

class NodeWallet implements ProviderWallet {
  constructor(readonly payer: Keypair) {}
  get publicKey() { return this.payer.publicKey; }
  async signTransaction<T extends anchor.web3.Transaction | anchor.web3.VersionedTransaction>(tx: T): Promise<T> {
    if ('sign' in tx) (tx as anchor.web3.Transaction).partialSign(this.payer);
    return tx;
  }
  async signAllTransactions<T extends anchor.web3.Transaction | anchor.web3.VersionedTransaction>(txs: T[]): Promise<T[]> {
    for (const tx of txs) { await this.signTransaction(tx); }
    return txs;
  }
}

function getProvider(
  connection?: Connection,
  wallet?: ProviderWallet
): anchor.AnchorProvider {
  const conn = connection ?? getConnection();
  const w = wallet ?? new NodeWallet(Keypair.generate());
  return new anchor.AnchorProvider(conn, w, {
    commitment: "processed",
    preflightCommitment: "processed",
  });
}

function getFighterRegistryProgram(
  provider: anchor.AnchorProvider
): anchor.Program {
  const idl = {
    ...(fighterRegistryIdl as any),
    address: FIGHTER_REGISTRY_ID.toBase58(),
  };
  return new anchor.Program(idl, provider);
}

function getIchorTokenProgram(
  provider: anchor.AnchorProvider
): anchor.Program {
  const idl = {
    ...(ichorTokenIdl as any),
    address: ICHOR_TOKEN_ID.toBase58(),
  };
  return new anchor.Program(idl, provider);
}

function getRumbleEngineProgram(
  provider: anchor.AnchorProvider,
  programId?: PublicKey,
): anchor.Program {
  const idl = {
    ...(rumbleEngineIdl as any),
    address: (programId ?? RUMBLE_ENGINE_ID).toBase58(),
  };
  return new anchor.Program(idl, provider);
}

// ---------------------------------------------------------------------------
// Admin Keypair (server-side only)
// ---------------------------------------------------------------------------

let _adminKeypair: Keypair | null = null;

function getAdminKeypair(): Keypair | null {
  if (_adminKeypair) return _adminKeypair;

  // Try inline keypair env var first (JSON array or base58)
  const raw = process.env.SOLANA_DEPLOYER_KEYPAIR;
  if (raw) {
    try {
      // Try JSON array format first
      const parsed = JSON.parse(raw);
      _adminKeypair = Keypair.fromSecretKey(Uint8Array.from(parsed));
      return _adminKeypair;
    } catch {
      try {
        // Try base58 format
        const bs58 = require("bs58");
        _adminKeypair = Keypair.fromSecretKey(bs58.decode(raw));
        return _adminKeypair;
      } catch (err) {
        console.warn("[solana-programs] Failed to parse SOLANA_DEPLOYER_KEYPAIR:", err);
      }
    }
  }

  // Try file path env var
  const keypairPath = process.env.SOLANA_DEPLOYER_KEYPAIR_PATH;
  if (keypairPath) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require("fs");
      const fileData = fs.readFileSync(keypairPath, "utf8");
      const secretKey = Uint8Array.from(JSON.parse(fileData));
      _adminKeypair = Keypair.fromSecretKey(secretKey);
      return _adminKeypair;
    } catch (err) {
      console.warn("[solana-programs] Failed to load keypair from path:", err);
    }
  }

  return null;
}

export function getAdminSignerPublicKey(): string | null {
  const kp = getAdminKeypair();
  return kp ? kp.publicKey.toBase58() : null;
}

function getAdminProvider(connection?: Connection): anchor.AnchorProvider | null {
  const keypair = getAdminKeypair();
  if (!keypair) return null;
  const wallet = new NodeWallet(keypair);
  return getProvider(connection, wallet);
}

// ---------------------------------------------------------------------------
// Mainnet Admin Keypair (server-side only, separate from devnet)
// ---------------------------------------------------------------------------

let _mainnetAdminKeypair: Keypair | null = null;

function getMainnetAdminKeypair(): Keypair | null {
  if (_mainnetAdminKeypair) return _mainnetAdminKeypair;

  const raw = process.env.SOLANA_MAINNET_DEPLOYER_KEYPAIR;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      _mainnetAdminKeypair = Keypair.fromSecretKey(Uint8Array.from(parsed));
      return _mainnetAdminKeypair;
    } catch {
      try {
        const bs58 = require("bs58");
        _mainnetAdminKeypair = Keypair.fromSecretKey(bs58.decode(raw));
        return _mainnetAdminKeypair;
      } catch (err) {
        console.warn("[solana-programs] Failed to parse SOLANA_MAINNET_DEPLOYER_KEYPAIR:", err);
      }
    }
  }

  return null;
}

function getMainnetAdminProvider(connection?: Connection): anchor.AnchorProvider | null {
  const keypair = getMainnetAdminKeypair();
  if (!keypair) return null;
  const wallet = new NodeWallet(keypair);
  const conn = connection ?? getBettingConnection();
  return new anchor.AnchorProvider(conn, wallet, {
    commitment: "processed",
    preflightCommitment: "processed",
  });
}

// ---------------------------------------------------------------------------
// Fighter Registry Functions
// ---------------------------------------------------------------------------

/**
 * Register a fighter on-chain. Returns the transaction for the user to sign.
 */
export async function registerFighter(
  authority: PublicKey,
  name: string,
  connection?: Connection
): Promise<Transaction> {
  const provider = getProvider(connection);
  const program = getFighterRegistryProgram(provider);

  const [registryConfigPda] = deriveRegistryConfigPda();
  const [walletStatePda] = deriveWalletStatePda(authority);

  // Determine fighter index from wallet state
  const conn = connection ?? getConnection();
  let fighterIndex = 0;
  try {
    const wsInfo = await conn.getAccountInfo(walletStatePda);
    if (wsInfo) {
      // WalletState: discriminator(8) + authority(32) + fighter_count(1)
      fighterIndex = wsInfo.data[8 + 32];
    }
  } catch {}

  const [fighterPda] = deriveFighterPda(authority, fighterIndex);

  // Encode name as [u8; 32]
  const nameBytes = new Uint8Array(32);
  const encoded = new TextEncoder().encode(name.slice(0, 32));
  nameBytes.set(encoded);

  const accounts: Record<string, PublicKey> = {
    authority,
    walletState: walletStatePda,
    fighter: fighterPda,
    registryConfig: registryConfigPda,
    systemProgram: SystemProgram.programId,
  };

  // Additional fighters (index >= 1) require ICHOR burn
  if (fighterIndex > 0) {
    const ichorMint = getIchorMint();
    const { getAssociatedTokenAddress } = await import("@solana/spl-token");
    const ata = await getAssociatedTokenAddress(ichorMint, authority);
    accounts.ichorTokenAccount = ata;
    accounts.ichorMint = ichorMint;
    accounts.tokenProgram = TOKEN_PROGRAM_ID;
  }

  const tx = await (program.methods as any)
    .registerFighter(Array.from(nameBytes))
    .accounts(accounts)
    .transaction();

  tx.feePayer = authority;
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash(
    "confirmed"
  );
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;

  return tx;
}

// ---------------------------------------------------------------------------
// ICHOR Token Functions
// ---------------------------------------------------------------------------

type EntropySettings = {
  programId: PublicKey;
  varAccount: PublicKey;
  provider: PublicKey;
  varAuthority: PublicKey;
};

let _entropyConfigCacheKey: string | null = null;
let _runtimeEntropySettings: EntropySettings | null = null;
let _entropyRotationInFlight: Promise<EntropySettings> | null = null;

function entropyCacheKey(settings: EntropySettings): string {
  return `${settings.programId.toBase58()}:${settings.varAccount.toBase58()}:${settings.provider.toBase58()}:${settings.varAuthority.toBase58()}`;
}

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function getEntropySettingsFromEnv(): EntropySettings | null {
  if (!isTruthyEnv(process.env.ICHOR_ENTROPY_ENABLED)) {
    return null;
  }

  const programIdRaw = process.env.ICHOR_ENTROPY_PROGRAM_ID;
  const varRaw = process.env.ICHOR_ENTROPY_VAR;
  const providerRaw = process.env.ICHOR_ENTROPY_PROVIDER;
  const authorityRaw = process.env.ICHOR_ENTROPY_AUTHORITY;

  if (!programIdRaw || !varRaw || !providerRaw || !authorityRaw) {
    console.warn(
      "[solana-programs] ICHOR_ENTROPY_ENABLED is true but entropy env vars are incomplete. Falling back to SlotHashes RNG."
    );
    return null;
  }

  try {
    return {
      programId: new PublicKey(programIdRaw),
      varAccount: new PublicKey(varRaw),
      provider: new PublicKey(providerRaw),
      varAuthority: new PublicKey(authorityRaw),
    };
  } catch (err) {
    console.warn("[solana-programs] Invalid entropy public key in env. Falling back to SlotHashes RNG.", err);
    return null;
  }
}

function anchorGlobalDiscriminator(methodName: string): Buffer {
  return createHash("sha256").update(`global:${methodName}`).digest().subarray(0, 8);
}

function u64Buffer(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return buf;
}

function deriveEntropyVarPda(
  authority: PublicKey,
  id: bigint,
  entropyProgramId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [ENTROPY_VAR_SEED, authority.toBuffer(), u64Buffer(id)],
    entropyProgramId
  );
}

function buildEntropyOpenIx(
  entropyProgramId: PublicKey,
  authority: PublicKey,
  payer: PublicKey,
  provider: PublicKey,
  varAccount: PublicKey,
  id: bigint,
  commit: Buffer,
  endAt: bigint
): TransactionInstruction {
  const data = Buffer.concat([
    Buffer.from([0]), // EntropyInstruction::Open
    u64Buffer(id),
    commit,
    u64Buffer(0n), // is_auto = false
    u64Buffer(1n), // samples = 1
    u64Buffer(endAt),
  ]);

  return new TransactionInstruction({
    programId: entropyProgramId,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: provider, isSigner: false, isWritable: false },
      { pubkey: varAccount, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function buildEntropySampleIx(
  entropyProgramId: PublicKey,
  signer: PublicKey,
  varAccount: PublicKey
): TransactionInstruction {
  return new TransactionInstruction({
    programId: entropyProgramId,
    keys: [
      { pubkey: signer, isSigner: true, isWritable: false },
      { pubkey: varAccount, isSigner: false, isWritable: true },
      { pubkey: SLOT_HASHES_SYSVAR_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([5]), // EntropyInstruction::Sample
  });
}

function buildEntropyRevealIx(
  entropyProgramId: PublicKey,
  signer: PublicKey,
  varAccount: PublicKey,
  seed: Buffer
): TransactionInstruction {
  return new TransactionInstruction({
    programId: entropyProgramId,
    keys: [
      { pubkey: signer, isSigner: true, isWritable: false },
      { pubkey: varAccount, isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([
      Buffer.from([4]), // EntropyInstruction::Reveal
      seed,
    ]),
  });
}

async function sendAdminInstructions(
  provider: anchor.AnchorProvider,
  admin: Keypair,
  instructions: TransactionInstruction[]
): Promise<string> {
  const tx = new Transaction().add(...instructions);
  tx.feePayer = admin.publicKey;
  const { blockhash, lastValidBlockHeight } =
    await provider.connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  return await provider.sendAndConfirm(tx, []);
}

function getComputeUnitPriceMicrolamports(): number {
  const raw = Number(process.env.COMPUTE_UNIT_PRICE_MICROLAMPORTS ?? "1000");
  if (!Number.isFinite(raw)) return 1000;
  return Math.max(0, Math.floor(raw));
}

function getComputeUnitPriceIx(
  microLamports: number = getComputeUnitPriceMicrolamports(),
): TransactionInstruction {
  return ComputeBudgetProgram.setComputeUnitPrice({ microLamports });
}

function isAccountAlreadyExistsError(err: unknown): boolean {
  const text = err instanceof Error
    ? `${err.name}: ${err.message}`.toLowerCase()
    : (() => {
        try {
          return JSON.stringify(err).toLowerCase();
        } catch {
          return String(err).toLowerCase();
        }
      })();

  return text.includes("already in use") || text.includes("already been processed");
}


async function waitForSlot(
  connection: Connection,
  targetSlot: bigint,
  timeoutMs = 20_000
): Promise<void> {
  const start = Date.now();
  while (true) {
    const slot = BigInt(await connection.getSlot("confirmed"));
    if (slot >= targetSlot) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for slot ${targetSlot.toString()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

function buildUpsertEntropyConfigIx(
  authority: PublicKey,
  arenaConfig: PublicKey,
  entropyConfig: PublicKey,
  entropySettings: EntropySettings,
): TransactionInstruction {
  const discriminator = anchorGlobalDiscriminator("upsert_entropy_config");
  const data = Buffer.concat([
    discriminator,
    Buffer.from([1]), // enabled = true
    entropySettings.programId.toBuffer(),
    entropySettings.varAccount.toBuffer(),
    entropySettings.provider.toBuffer(),
    entropySettings.varAuthority.toBuffer(),
  ]);

  return new TransactionInstruction({
    programId: ICHOR_TOKEN_ID,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: arenaConfig, isSigner: false, isWritable: false },
      { pubkey: entropyConfig, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

async function ensureEntropyConfig(
  provider: anchor.AnchorProvider,
  admin: Keypair,
): Promise<EntropySettings | null> {
  const entropySettings = _runtimeEntropySettings ?? getEntropySettingsFromEnv();
  if (!entropySettings) return null;

  const cacheKey = entropyCacheKey(entropySettings);
  if (_entropyConfigCacheKey === cacheKey) {
    return entropySettings;
  }

  const [arenaConfigPda] = deriveArenaConfigPda();
  const [entropyConfigPda] = deriveEntropyConfigPda();
  const ix = buildUpsertEntropyConfigIx(
    admin.publicKey,
    arenaConfigPda,
    entropyConfigPda,
    entropySettings,
  );
  await sendAdminInstructions(provider, admin, [ix]);
  _entropyConfigCacheKey = cacheKey;
  _runtimeEntropySettings = entropySettings;
  return entropySettings;
}

async function maybeRotateEntropyVarForSettlement(
  provider: anchor.AnchorProvider,
  admin: Keypair,
  entropySettings: EntropySettings
): Promise<EntropySettings> {
  const pendingShower = await readShowerRequest(provider.connection).catch(() => null);
  if (!pendingShower?.active) return entropySettings;

  const currentSlot = BigInt(await provider.connection.getSlot("confirmed"));
  if (currentSlot < pendingShower.targetSlotB) return entropySettings;

  if (_entropyRotationInFlight) {
    return _entropyRotationInFlight;
  }

  _entropyRotationInFlight = (async () => {
    if (!entropySettings.varAuthority.equals(admin.publicKey)) {
      throw new Error(
        "ICHOR_ENTROPY_AUTHORITY must match SOLANA_DEPLOYER_KEYPAIR_PATH public key for automatic entropy rotation."
      );
    }

    // Keep a small slot buffer so open() validation doesn't race current slot advancement.
    const minFutureEndAt = currentSlot + 8n;
    const endAt =
      pendingShower.targetSlotA > minFutureEndAt
        ? pendingShower.targetSlotA
        : minFutureEndAt;
    const entropyVarId =
      (currentSlot << 16n) ^ BigInt(randomBytes(2).readUInt16LE(0));
    const [entropyVarPda] = deriveEntropyVarPda(
      entropySettings.varAuthority,
      entropyVarId,
      entropySettings.programId
    );

    const seed = randomBytes(32);
    const commit = Buffer.from(keccak_256(seed));
    const openIx = buildEntropyOpenIx(
      entropySettings.programId,
      entropySettings.varAuthority,
      admin.publicKey,
      entropySettings.provider,
      entropyVarPda,
      entropyVarId,
      commit,
      endAt
    );

    await sendAdminInstructions(provider, admin, [openIx]);
    await waitForSlot(provider.connection, endAt);

    const sampleIx = buildEntropySampleIx(
      entropySettings.programId,
      admin.publicKey,
      entropyVarPda
    );
    const revealIx = buildEntropyRevealIx(
      entropySettings.programId,
      admin.publicKey,
      entropyVarPda,
      seed
    );
    await sendAdminInstructions(provider, admin, [sampleIx, revealIx]);

    const rotatedSettings: EntropySettings = {
      ...entropySettings,
      varAccount: entropyVarPda,
    };
    const [arenaConfigPda] = deriveArenaConfigPda();
    const [entropyConfigPda] = deriveEntropyConfigPda();
    const upsertIx = buildUpsertEntropyConfigIx(
      admin.publicKey,
      arenaConfigPda,
      entropyConfigPda,
      rotatedSettings
    );
    await sendAdminInstructions(provider, admin, [upsertIx]);

    _runtimeEntropySettings = rotatedSettings;
    _entropyConfigCacheKey = entropyCacheKey(rotatedSettings);
    return rotatedSettings;
  })();

  try {
    return await _entropyRotationInFlight;
  } finally {
    _entropyRotationInFlight = null;
  }
}

/**
 * Initialize the ICHOR arena with an EXISTING external mint (e.g. pump.fun token).
 * Creates ArenaConfig + distribution vault PDA, but does NOT mint tokens.
 * Admin must fund the vault afterward by transferring purchased tokens to it.
 * Returns tx signature on success, null if admin keypair unavailable.
 */
export async function initializeWithMint(
  existingMint: PublicKey,
  baseReward: bigint | number = 1_000_000_000n, // default 1 ICHOR
  connection?: Connection
): Promise<string | null> {
  const provider = getAdminProvider(connection);
  if (!provider) {
    console.warn("[solana-programs] No admin keypair, skipping initializeWithMint");
    return null;
  }
  const program = getIchorTokenProgram(provider);
  const admin = getAdminKeypair()!;

  const [arenaConfigPda] = deriveArenaConfigPda();
  const [distributionVaultPda] = deriveDistributionVaultPda();

  const tx = await (program.methods as any)
    .initializeWithMint(new anchor.BN(baseReward.toString()))
    .accounts({
      admin: admin.publicKey,
      arenaConfig: arenaConfigPda,
      ichorMint: existingMint,
      distributionVault: distributionVaultPda,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    })
    .rpc();

  // Cache the mint address
  setIchorMint(existingMint);

  return tx;
}

/**
 * Distribute rumble reward from vault to the winner (admin/server-side).
 * Returns tx signature on success, null if admin keypair unavailable.
 */
export async function distributeReward(
  winnerTokenAccount: PublicKey,
  showerVault: PublicKey,
  connection?: Connection
): Promise<string | null> {
  const provider = getAdminProvider(connection);
  if (!provider) {
    console.warn("[solana-programs] No admin keypair, skipping distributeReward");
    return null;
  }
  const program = getIchorTokenProgram(provider);
  const admin = getAdminKeypair()!;

  const [arenaConfigPda] = deriveArenaConfigPda();
  const [distributionVaultPda] = deriveDistributionVaultPda();
  const ichorMint = getIchorMint();

  const method = (program.methods as any)
    .distributeReward()
    .accounts({
      authority: admin.publicKey,
      arenaConfig: arenaConfigPda,
      distributionVault: distributionVaultPda,
      ichorMint,
      winnerTokenAccount,
      showerVault,
      tokenProgram: TOKEN_PROGRAM_ID,
    });

  return await sendAdminTxFireAndForget(method, admin, connection ?? getConnection());
}

/** @deprecated Use distributeReward instead */
export const mintRumbleReward = distributeReward;

/**
 * Check for ichor shower trigger (admin/server-side).
 * Returns tx signature on success, null if admin keypair unavailable.
 */
export async function checkIchorShower(
  recipientTokenAccount: PublicKey,
  showerVault: PublicKey,
  connection?: Connection
): Promise<string | null> {
  const provider = getAdminProvider(connection);
  if (!provider) {
    console.warn("[solana-programs] No admin keypair, skipping checkIchorShower");
    return null;
  }
  const program = getIchorTokenProgram(provider);
  const admin = getAdminKeypair()!;

  const [arenaConfigPda] = deriveArenaConfigPda();
  const [showerRequestPda] = deriveShowerRequestPda();
  const [entropyConfigPda] = deriveEntropyConfigPda();
  const ichorMint = getIchorMint();
  const slotHashesSysvar = SLOT_HASHES_SYSVAR_ID;
  let entropySettings = await ensureEntropyConfig(provider, admin);
  if (entropySettings) {
    entropySettings = await maybeRotateEntropyVarForSettlement(
      provider,
      admin,
      entropySettings
    );
  }

  const accounts: Record<string, PublicKey> = {
    authority: admin.publicKey,
    arenaConfig: arenaConfigPda,
    showerRequest: showerRequestPda,
    ichorMint,
    recipientTokenAccount,
    showerVault,
    slotHashes: slotHashesSysvar,
    systemProgram: SystemProgram.programId,
    tokenProgram: TOKEN_PROGRAM_ID,
  };
  if (entropySettings) {
    accounts.entropyConfig = entropyConfigPda;
    accounts.entropyVar = entropySettings.varAccount;
    accounts.entropyProgram = entropySettings.programId;
  }

  const method = (program.methods as any)
    .checkIchorShower()
    .accountsPartial(accounts);

  return await sendAdminTxFireAndForget(method, admin, connection ?? getConnection());
}

// ---------------------------------------------------------------------------
// Admin Transfer Functions (C-2 fix: two-step admin transfer)
// ---------------------------------------------------------------------------

function derivePendingAdminPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([PENDING_ADMIN_SEED], ICHOR_TOKEN_ID);
}

/**
 * Propose a new admin for the ICHOR program (step 1 of 2).
 * New admin must call acceptAdmin() to complete the transfer.
 */
export async function transferAdmin(
  newAdmin: PublicKey,
  connection?: Connection
): Promise<string | null> {
  const provider = getAdminProvider(connection);
  if (!provider) {
    console.warn("[solana-programs] No admin keypair, skipping transferAdmin");
    return null;
  }
  const program = getIchorTokenProgram(provider);
  const admin = getAdminKeypair()!;

  const [arenaConfigPda] = deriveArenaConfigPda();
  const [pendingAdminPda] = derivePendingAdminPda();

  const tx = await (program.methods as any)
    .transferAdmin(newAdmin)
    .accounts({
      authority: admin.publicKey,
      arenaConfig: arenaConfigPda,
      pendingAdmin: pendingAdminPda,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  return tx;
}

/**
 * Accept a pending admin transfer (step 2 of 2).
 * Must be signed by the proposed new admin keypair.
 */
export async function acceptAdmin(
  newAdminKeypair: Keypair,
  connection?: Connection
): Promise<string | null> {
  const conn = connection ?? getConnection();
  const wallet = new NodeWallet(newAdminKeypair);
  const provider = new anchor.AnchorProvider(conn, wallet, {
    commitment: "confirmed",
  });
  const program = getIchorTokenProgram(provider);

  const [arenaConfigPda] = deriveArenaConfigPda();
  const [pendingAdminPda] = derivePendingAdminPda();

  const tx = await (program.methods as any)
    .acceptAdmin()
    .accounts({
      newAdmin: newAdminKeypair.publicKey,
      arenaConfig: arenaConfigPda,
      pendingAdmin: pendingAdminPda,
    })
    .rpc();

  return tx;
}

// ---------------------------------------------------------------------------
// ICHOR Vault Distribution Functions
// ---------------------------------------------------------------------------

/**
 * Admin: distribute tokens from the vault to any recipient (LP seeding, airdrops, etc).
 * Returns tx signature on success, null if admin keypair unavailable.
 */
export async function adminDistribute(
  recipientTokenAccount: PublicKey,
  amount: bigint | number,
  connection?: Connection
): Promise<string | null> {
  const provider = getAdminProvider(connection);
  if (!provider) {
    console.warn("[solana-programs] No admin keypair, skipping adminDistribute");
    return null;
  }
  const program = getIchorTokenProgram(provider);
  const admin = getAdminKeypair()!;

  const [arenaConfigPda] = deriveArenaConfigPda();
  const [distributionVaultPda] = deriveDistributionVaultPda();

  const method = (program.methods as any)
    .adminDistribute(new anchor.BN(amount.toString()))
    .accounts({
      authority: admin.publicKey,
      arenaConfig: arenaConfigPda,
      distributionVault: distributionVaultPda,
      recipientTokenAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
    });

  return await sendAdminTxFireAndForget(method, admin, connection ?? getConnection());
}

/**
 * Admin: update the on-chain season reward (flat ICHOR per rumble).
 * Returns tx signature on success, null if admin keypair unavailable.
 */
export async function updateSeasonReward(
  newSeasonReward: bigint | number,
  connection?: Connection
): Promise<string | null> {
  const provider = getAdminProvider(connection);
  if (!provider) {
    console.warn("[solana-programs] No admin keypair, skipping updateSeasonReward");
    return null;
  }
  const program = getIchorTokenProgram(provider);
  const admin = getAdminKeypair()!;
  const [arenaConfigPda] = deriveArenaConfigPda();
  const value = BigInt(newSeasonReward);
  const method = (program.methods as any)?.updateSeasonReward;

  // Some local IDLs are stale and may not expose updateSeasonReward yet.
  // Fall back to a raw Anchor instruction payload so this remains callable.
  if (typeof method === "function") {
    return await method(new anchor.BN(value.toString()))
      .accounts({
        authority: admin.publicKey,
        arenaConfig: arenaConfigPda,
      })
      .rpc();
  }

  const data = Buffer.concat([
    anchorGlobalDiscriminator("update_season_reward"),
    u64Buffer(value),
  ]);
  const ix = new TransactionInstruction({
    programId: ICHOR_TOKEN_ID,
    keys: [
      { pubkey: admin.publicKey, isSigner: true, isWritable: true },
      { pubkey: arenaConfigPda, isSigner: false, isWritable: true },
    ],
    data,
  });
  return await sendAdminInstructions(provider, admin, [ix]);
}

/**
 * Admin: migrate legacy ArenaConfig account to V2 layout and set season reward.
 * Use when on-chain account fails to deserialize on updateSeasonReward.
 */
export async function migrateArenaConfigV2(
  seasonReward: bigint | number,
  connection?: Connection
): Promise<string | null> {
  const provider = getAdminProvider(connection);
  if (!provider) {
    console.warn("[solana-programs] No admin keypair, skipping migrateArenaConfigV2");
    return null;
  }
  const program = getIchorTokenProgram(provider);
  const admin = getAdminKeypair()!;
  const [arenaConfigPda] = deriveArenaConfigPda();
  const value = BigInt(seasonReward);
  const method = (program.methods as any)?.migrateArenaConfigV2;

  if (typeof method === "function") {
    return await method(new anchor.BN(value.toString()))
      .accounts({
        authority: admin.publicKey,
        arenaConfig: arenaConfigPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  const data = Buffer.concat([
    anchorGlobalDiscriminator("migrate_arena_config_v2"),
    u64Buffer(value),
  ]);
  const ix = new TransactionInstruction({
    programId: ICHOR_TOKEN_ID,
    keys: [
      { pubkey: admin.publicKey, isSigner: true, isWritable: true },
      { pubkey: arenaConfigPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
  return await sendAdminInstructions(provider, admin, [ix]);
}

/**
 * Admin: permanently revoke mint authority. Supply becomes fixed at 1B.
 * Returns tx signature on success, null if admin keypair unavailable.
 */
export async function revokeMintAuthority(
  connection?: Connection
): Promise<string | null> {
  const provider = getAdminProvider(connection);
  if (!provider) {
    console.warn("[solana-programs] No admin keypair, skipping revokeMintAuthority");
    return null;
  }
  const program = getIchorTokenProgram(provider);
  const admin = getAdminKeypair()!;

  const [arenaConfigPda] = deriveArenaConfigPda();
  const ichorMint = getIchorMint();

  const tx = await (program.methods as any)
    .revokeMintAuthority()
    .accounts({
      authority: admin.publicKey,
      arenaConfig: arenaConfigPda,
      ichorMint,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  return tx;
}

// ---------------------------------------------------------------------------
// Rumble Engine Functions
// ---------------------------------------------------------------------------

/**
 * Create a new rumble (admin/server-side).
 * Returns tx signature on success, null if admin keypair unavailable.
 */
export async function createRumble(
  rumbleId: number,
  fighters: PublicKey[],
  bettingDeadlineUnix: number,
  connection?: Connection
): Promise<string | null> {
  const provider = getAdminProvider(connection);
  if (!provider) {
    console.warn("[solana-programs] No admin keypair, skipping createRumble");
    return null;
  }
  const program = getRumbleEngineProgram(provider);
  const admin = getAdminKeypair()!;

  const [rumbleConfigPda] = deriveRumbleConfigPda();
  const [rumblePda] = deriveRumblePda(rumbleId);
  const nowUnix = Math.floor(Date.now() / 1000);
  const deadlineModeRaw = (process.env.RUMBLE_CREATE_DEADLINE_MODE ?? "slot").trim().toLowerCase();
  const prefersUnixDeadline = deadlineModeRaw === "unix";
  const currentSlot = await provider.connection.getSlot("processed");
  const slotMsEstimateRaw = Number(process.env.RUMBLE_SLOT_MS_ESTIMATE ?? "400");
  const slotMsEstimate = Number.isFinite(slotMsEstimateRaw)
    ? Math.min(1_000, Math.max(250, Math.floor(slotMsEstimateRaw)))
    : 400;
  const minCloseSlotsRaw = Number(process.env.RUMBLE_BETTING_MIN_CLOSE_SLOTS ?? "180");
  const minCloseSlots = Number.isFinite(minCloseSlotsRaw)
    ? Math.min(2_000, Math.max(10, Math.floor(minCloseSlotsRaw)))
    : 180;
  const closeSafetySlotsRaw = Number(process.env.RUMBLE_BETTING_CLOSE_SAFETY_SLOTS ?? "45");
  const closeSafetySlots = Number.isFinite(closeSafetySlotsRaw)
    ? Math.min(1_000, Math.max(0, Math.floor(closeSafetySlotsRaw)))
    : 45;

  let bettingCloseSlot = BigInt(Math.floor(bettingDeadlineUnix));
  if (bettingDeadlineUnix >= nowUnix - 60) {
    const remainingMs = Math.max(1_000, (bettingDeadlineUnix - nowUnix) * 1_000);
    const slotsRemainingBase = Math.ceil(remainingMs / slotMsEstimate);
    const slotsRemaining = Math.max(minCloseSlots, slotsRemainingBase + closeSafetySlots);
    bettingCloseSlot = BigInt(currentSlot) + BigInt(slotsRemaining);
  }
  if (bettingCloseSlot <= BigInt(currentSlot)) {
    bettingCloseSlot = BigInt(currentSlot + minCloseSlots);
  }
  const minCloseSeconds = Math.max(
    15,
    Math.ceil(((minCloseSlots + closeSafetySlots) * slotMsEstimate) / 1_000),
  );
  const bettingCloseUnix = BigInt(Math.max(bettingDeadlineUnix, nowUnix + minCloseSeconds));

  console.log(`[ONCHAIN-CREATE] Sending createRumble for rumble ${rumbleId} (${fighters.length} fighters)...`);
  const createWithDeadline = async (
    closeValue: bigint,
    effectiveMode: "slot" | "unix",
  ): Promise<string> => {
    const method = (program.methods as any)
      .createRumble(
        new anchor.BN(rumbleId),
        fighters,
        new anchor.BN(closeValue.toString())
      )
      .accounts({
        admin: admin.publicKey,
        config: rumbleConfigPda,
        rumble: rumblePda,
        systemProgram: SystemProgram.programId,
      })
;

    try {
      const sig = await sendAdminTxFireAndForget(method, admin, provider.connection);
      console.log(`[ONCHAIN-CREATE] createRumble confirmed for rumble ${rumbleId}: ${sig}`);
      return sig;
    } catch (err: unknown) {
      const context =
        `[solana-programs] createRumble failed` +
        ` rumbleId=${rumbleId}` +
        ` currentSlot=${currentSlot}` +
        ` closeValue=${closeValue.toString()}` +
        ` bettingCloseSlot=${bettingCloseSlot.toString()}` +
        ` bettingCloseUnix=${bettingCloseUnix.toString()}` +
        ` bettingDeadlineUnix=${bettingDeadlineUnix}` +
        ` nowUnix=${nowUnix}` +
        ` deadlineModeRaw=${deadlineModeRaw}` +
        ` effectiveDeadlineMode=${effectiveMode}` +
        ` minCloseSlots=${minCloseSlots}` +
        ` closeSafetySlots=${closeSafetySlots}`;
      if (err instanceof Error) {
        throw new Error(`${context} :: ${err.message}`);
      }
      throw new Error(`${context} :: ${String(err)}`);
    }
  };

  try {
    if (prefersUnixDeadline) {
      return await createWithDeadline(bettingCloseUnix, "unix");
    }

    try {
      return await createWithDeadline(bettingCloseSlot, "slot");
    } catch (slotErr) {
      const message = slotErr instanceof Error ? slotErr.message : String(slotErr);
      const shouldFallbackToUnix = /DeadlineInPast|deadline must be in the future/i.test(message);
      if (!shouldFallbackToUnix) throw slotErr;

      console.warn(
        `[solana-programs] createRumble slot deadline rejected; retrying with unix deadline` +
          ` rumbleId=${rumbleId}` +
          ` bettingCloseSlot=${bettingCloseSlot.toString()}` +
          ` bettingCloseUnix=${bettingCloseUnix.toString()}`,
      );
      return await createWithDeadline(bettingCloseUnix, "unix");
    }
  } catch (finalErr) {
    if (finalErr instanceof Error) throw finalErr;
    throw new Error(String(finalErr));
  }
}

/**
 * Compute on-chain move commitment hash.
 * Mirrors rumble-engine hash: sha256("rumble:v1", rumble_id, turn, fighter_pubkey, move_code, salt32).
 */
export function computeMoveCommitmentHash(
  rumbleId: number | bigint,
  turn: number,
  fighter: PublicKey,
  moveCode: number,
  salt32: Uint8Array,
): Uint8Array {
  if (salt32.length !== 32) {
    throw new Error("salt32 must be exactly 32 bytes");
  }
  const rumbleBuf = Buffer.alloc(8);
  rumbleBuf.writeBigUInt64LE(BigInt(rumbleId));
  const turnBuf = Buffer.alloc(4);
  turnBuf.writeUInt32LE(turn >>> 0);
  const moveBuf = Buffer.from([moveCode & 0xff]);
  const payload = Buffer.concat([
    Buffer.from("rumble:v1"),
    rumbleBuf,
    turnBuf,
    fighter.toBuffer(),
    moveBuf,
    Buffer.from(salt32),
  ]);
  return createHash("sha256").update(payload).digest();
}

/**
 * Build a commit_move transaction for fighter signer flow.
 */
export async function buildCommitMoveTx(
  fighter: PublicKey,
  rumbleId: number,
  turn: number,
  moveHash: Uint8Array | string,
  connection?: Connection,
): Promise<Transaction> {
  if (!Number.isInteger(turn) || turn <= 0) {
    throw new Error("turn must be a positive integer");
  }
  const hashBytes =
    typeof moveHash === "string"
      ? Uint8Array.from(Buffer.from(moveHash.replace(/^0x/i, ""), "hex"))
      : moveHash;
  if (hashBytes.length !== 32) {
    throw new Error("moveHash must be 32 bytes");
  }

  const provider = getProvider(connection);
  const program = getRumbleEngineProgram(provider);
  const [rumblePda] = deriveRumblePda(rumbleId);
  const [combatStatePda] = deriveCombatStatePda(rumbleId);
  const [moveCommitmentPda] = deriveMoveCommitmentPda(rumbleId, fighter, turn);
  const conn = connection ?? getConnection();

  const tx = await (program.methods as any)
    .commitMove(
      new anchor.BN(rumbleId),
      turn,
      Array.from(hashBytes),
    )
    .accounts({
      fighter,
      rumble: rumblePda,
      combatState: combatStatePda,
      moveCommitment: moveCommitmentPda,
      systemProgram: SystemProgram.programId,
    })
    .transaction();

  tx.feePayer = fighter;
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  return tx;
}

/**
 * Build a reveal_move transaction for fighter signer flow.
 */
export async function buildRevealMoveTx(
  fighter: PublicKey,
  rumbleId: number,
  turn: number,
  moveCode: number,
  salt32: Uint8Array | string,
  connection?: Connection,
): Promise<Transaction> {
  if (!Number.isInteger(turn) || turn <= 0) {
    throw new Error("turn must be a positive integer");
  }
  if (!Number.isInteger(moveCode) || moveCode < 0 || moveCode > 255) {
    throw new Error("moveCode must be a u8 value");
  }
  const saltBytes =
    typeof salt32 === "string"
      ? Uint8Array.from(Buffer.from(salt32.replace(/^0x/i, ""), "hex"))
      : salt32;
  if (saltBytes.length !== 32) {
    throw new Error("salt32 must be 32 bytes");
  }

  const provider = getProvider(connection);
  const program = getRumbleEngineProgram(provider);
  const [rumblePda] = deriveRumblePda(rumbleId);
  const [combatStatePda] = deriveCombatStatePda(rumbleId);
  const [moveCommitmentPda] = deriveMoveCommitmentPda(rumbleId, fighter, turn);
  const conn = connection ?? getConnection();

  const tx = await (program.methods as any)
    .revealMove(
      new anchor.BN(rumbleId),
      turn,
      moveCode,
      Array.from(saltBytes),
    )
    .accounts({
      fighter,
      rumble: rumblePda,
      combatState: combatStatePda,
      moveCommitment: moveCommitmentPda,
    })
    .transaction();

  tx.feePayer = fighter;
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  return tx;
}

/**
 * Build a place_bet transaction for the user to sign.
 */
export async function buildPlaceBetTx(
  bettor: PublicKey,
  rumbleId: number,
  fighterIndex: number,
  lamports: number,
  connection?: Connection,
  programId?: PublicKey,
): Promise<Transaction> {
  const provider = getProvider(connection);
  const program = getRumbleEngineProgram(provider, programId);

  const conn = connection ?? getConnection();
  const {
    rumbleConfigPda,
    rumblePda,
    vaultPda,
    treasury,
    fighterPubkeys,
    fighterCount,
  } = await loadRumbleBetContext(rumbleId, conn, programId);
  if (fighterIndex >= fighterCount) {
    throw new Error("Invalid fighter index");
  }
  const fighterPubkey = fighterPubkeys[fighterIndex];
  if (!fighterPubkey) {
    throw new Error(`Invalid fighter index ${fighterIndex} for rumble ${rumbleId}`);
  }
  const useMainnet = programId && !programId.equals(RUMBLE_ENGINE_ID);
  const [sponsorshipPda] = useMainnet ? deriveSponsorshipPdaMainnet(fighterPubkey) : deriveSponsorshipPda(fighterPubkey);
  const [bettorAccountPda] = useMainnet ? deriveBettorPdaMainnet(rumbleId, bettor) : deriveBettorPda(rumbleId, bettor);

  const tx = await (program.methods as any)
    .placeBet(
      new anchor.BN(rumbleId),
      fighterIndex,
      new anchor.BN(lamports)
    )
    .accounts({
      bettor,
      rumble: rumblePda,
      vault: vaultPda,
      treasury,
      config: rumbleConfigPda,
      sponsorshipAccount: sponsorshipPda,
      bettorAccount: bettorAccountPda,
      systemProgram: SystemProgram.programId,
    })
    .transaction();

  tx.feePayer = bettor;
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash(
    "confirmed"
  );
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;

  return tx;
}

/**
 * Build a single transaction containing multiple place_bet instructions.
 * This enables users to bet multiple fighters with one wallet signature.
 */
export async function buildPlaceBetBatchTx(
  bettor: PublicKey,
  rumbleId: number,
  bets: Array<{ fighterIndex: number; lamports: number }>,
  connection?: Connection,
  programId?: PublicKey,
): Promise<Transaction> {
  if (!Array.isArray(bets) || bets.length === 0) {
    throw new Error("At least one bet is required for batch place_bet");
  }

  const provider = getProvider(connection);
  const program = getRumbleEngineProgram(provider, programId);
  const conn = connection ?? getConnection();
  const useMainnet = programId && !programId.equals(RUMBLE_ENGINE_ID);

  const {
    rumbleConfigPda,
    rumblePda,
    vaultPda,
    treasury,
    fighterPubkeys,
    fighterCount,
  } = await loadRumbleBetContext(rumbleId, conn, programId);
  const [bettorAccountPda] = useMainnet ? deriveBettorPdaMainnet(rumbleId, bettor) : deriveBettorPda(rumbleId, bettor);

  const tx = new Transaction();

  for (const leg of bets) {
    if (!Number.isInteger(leg.fighterIndex) || leg.fighterIndex < 0) {
      throw new Error(`Invalid fighterIndex in batch leg: ${String(leg.fighterIndex)}`);
    }
    if (leg.fighterIndex >= fighterCount) {
      throw new Error("Invalid fighter index");
    }
    if (!Number.isFinite(leg.lamports) || leg.lamports <= 0) {
      throw new Error(`Invalid lamports in batch leg for fighter ${leg.fighterIndex}`);
    }

    const fighterPubkey = fighterPubkeys[leg.fighterIndex];
    if (!fighterPubkey) {
      throw new Error(`Fighter index ${leg.fighterIndex} not found in rumble ${rumbleId}`);
    }
    const [sponsorshipPda] = useMainnet ? deriveSponsorshipPdaMainnet(fighterPubkey) : deriveSponsorshipPda(fighterPubkey);

    const ix = await (program.methods as any)
      .placeBet(
        new anchor.BN(rumbleId),
        leg.fighterIndex,
        new anchor.BN(leg.lamports),
      )
      .accounts({
        bettor,
        rumble: rumblePda,
        vault: vaultPda,
        treasury,
        config: rumbleConfigPda,
        sponsorshipAccount: sponsorshipPda,
        bettorAccount: bettorAccountPda,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    tx.add(ix);
  }

  tx.feePayer = bettor;
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  return tx;
}

async function loadRumbleBetContext(
  rumbleId: number,
  conn: Connection,
  programId?: PublicKey,
): Promise<{
  rumbleConfigPda: PublicKey;
  rumblePda: PublicKey;
  vaultPda: PublicKey;
  treasury: PublicKey;
  fighterPubkeys: PublicKey[];
  fighterCount: number;
}> {
  const useMainnet = programId && !programId.equals(RUMBLE_ENGINE_ID);
  const [rumbleConfigPda] = useMainnet ? deriveRumbleConfigPdaMainnet() : deriveRumbleConfigPda();
  const [rumblePda] = useMainnet ? deriveRumblePdaMainnet(rumbleId) : deriveRumblePda(rumbleId);
  const [vaultPda] = useMainnet ? deriveVaultPdaMainnet(rumbleId) : deriveVaultPda(rumbleId);

  const [rumbleInfo, configInfo] = await Promise.all([
    conn.getAccountInfo(rumblePda),
    conn.getAccountInfo(rumbleConfigPda),
  ]);
  if (!rumbleInfo) throw new Error(`Rumble account not found: ${rumblePda}`);
  if (!configInfo) throw new Error("Rumble config not found");

  const fighterOffsetBase = 8 + 8 + 1;
  const fighterCountOffset = fighterOffsetBase + 32 * 16;
  const fighterCount = rumbleInfo.data[fighterCountOffset] ?? 0;
  const fighterPubkeys: PublicKey[] = [];
  for (let i = 0; i < fighterCount; i++) {
    const start = fighterOffsetBase + i * 32;
    if (start + 32 <= rumbleInfo.data.length) {
      fighterPubkeys.push(new PublicKey(rumbleInfo.data.subarray(start, start + 32)));
    }
  }

  // RumbleConfig: discriminator(8) + admin(32) + treasury(32)
  const treasury = new PublicKey(configInfo.data.subarray(8 + 32, 8 + 32 + 32));

  return {
    rumbleConfigPda,
    rumblePda,
    vaultPda,
    treasury,
    fighterPubkeys,
    fighterCount,
  };
}

/**
 * Start combat for a rumble (admin/server-side).
 * Returns tx signature on success, null if admin keypair unavailable.
 */
export async function startCombat(
  rumbleId: number,
  connection?: Connection
): Promise<string | null> {
  const provider = getAdminProvider(connection);
  if (!provider) {
    console.warn("[solana-programs] No admin keypair, skipping startCombat");
    return null;
  }
  const program = getRumbleEngineProgram(provider);
  const admin = getAdminKeypair()!;

  const [rumbleConfigPda] = deriveRumbleConfigPda();
  const [rumblePda] = deriveRumblePda(rumbleId);
  const [combatStatePda] = deriveCombatStatePda(rumbleId);

  console.log(`[ONCHAIN-START] Sending startCombat for rumble ${rumbleId}...`);
  const method = (program.methods as any)
    .startCombat()
    .accounts({
      admin: admin.publicKey,
      config: rumbleConfigPda,
      rumble: rumblePda,
      combatState: combatStatePda,
      systemProgram: SystemProgram.programId,
    });

  const sig = await sendAdminTxFireAndForget(method, admin, connection ?? getConnection());
  console.log(`[ONCHAIN-START] startCombat confirmed for rumble ${rumbleId}: ${sig}`);
  return sig;
}

/**
 * Send an admin-signed transaction without waiting for confirmation.
 * The on-chain state polling loop will pick up results on the next tick.
 */
async function sendAdminTxFireAndForget(
  method: any,
  admin: Keypair,
  connection?: Connection,
): Promise<string> {
  const conn = connection ?? getConnection();
  const isEr = (conn as any)._rpcEndpoint?.includes("magicblock") ||
    conn.rpcEndpoint?.includes("magicblock");
  const routerConn = conn as ErRouterLikeConnection;
  const shouldRetryBlockhash = (err: unknown): boolean => {
    const msg = err instanceof Error ? err.message : String(err);
    return /blockhash not found/i.test(msg);
  };

  const assignBlockhash = async (tx: Transaction): Promise<void> => {
    if (isEr && typeof routerConn.getLatestBlockhashForTransaction === "function") {
      try {
        const { blockhash, lastValidBlockHeight } = await routerConn.getLatestBlockhashForTransaction(tx, {
          commitment: "processed",
        });
        tx.recentBlockhash = blockhash;
        tx.lastValidBlockHeight = lastValidBlockHeight;
        return;
      } catch (error) {
        console.warn("[ER] getLatestBlockhashForTransaction failed; falling back to getLatestBlockhash:", error);
      }
    }
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("processed");
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
  };

  const maxAttempts = isEr ? 3 : 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const tx: Transaction = await method.transaction();
    tx.feePayer = admin.publicKey;
    // ER transactions are feeless — skip compute unit price
    if (!isEr) {
      tx.instructions.unshift(getComputeUnitPriceIx());
    }

    await assignBlockhash(tx);
    tx.sign(admin);
    try {
      return await conn.sendRawTransaction(tx.serialize(), {
        // ER validator rejects preflight for magic_context writable checks — skip it
        skipPreflight: isEr,
        preflightCommitment: isEr ? undefined : "processed",
        maxRetries: 3,
      });
    } catch (error) {
      const retryable = shouldRetryBlockhash(error) && attempt < maxAttempts;
      if (!retryable) throw error;
      const waitMs = 150 * attempt;
      console.warn(
        `[TxSend] Retrying admin tx after blockhash error (attempt ${attempt}/${maxAttempts}):`,
        error,
      );
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
  }

  throw new Error("Failed to send admin transaction after blockhash retries");
}

/**
 * Send an admin-signed transaction and confirm it to "confirmed".
 * Throws on timeout or on-chain error with the signature attached to aid debugging.
 */
async function sendAdminTxWithConfirmation(
  method: any,
  admin: Keypair,
  connection?: Connection,
): Promise<{ signature: string; confirmed: true }> {
  const conn = connection ?? getConnection();
  const signature = await sendAdminTxFireAndForget(method, admin, conn);
  const timeoutMs = 30_000;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Transaction confirmation timed out after ${timeoutMs}ms: ${signature}`));
    }, timeoutMs);
  });

  let confirmation: Awaited<ReturnType<typeof conn.confirmTransaction>>;
  try {
    confirmation = await Promise.race([
      conn.confirmTransaction(signature, "confirmed"),
      timeout,
    ]);
  } catch (err) {
    throw new Error(`Tx confirmation failed for ${signature}: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }

  if (confirmation.value?.err) {
    throw new Error(`Tx ${signature} confirmed with error: ${JSON.stringify(confirmation.value.err)}`);
  }

  return {
    signature,
    confirmed: true,
  };
}

/**
 * Open the first on-chain turn window (permissionless, admin keeper used here).
 */
export async function openTurn(
  rumbleId: number,
  connection?: Connection,
): Promise<string | null> {
  const provider = getAdminProvider(connection);
  if (!provider) {
    console.warn("[solana-programs] No admin keypair, skipping openTurn");
    return null;
  }
  const program = getRumbleEngineProgram(provider);
  const admin = getAdminKeypair()!;
  const [rumblePda] = deriveRumblePda(rumbleId);
  const [combatStatePda] = deriveCombatStatePda(rumbleId);

  console.log(`[ONCHAIN-OPEN-TURN] Sending openTurn for rumble ${rumbleId}...`);
  const method = (program.methods as any)
    .openTurn()
    .accounts({
      keeper: admin.publicKey,
      rumble: rumblePda,
      combatState: combatStatePda,
    });

  const sig = await sendAdminTxFireAndForget(method, admin, connection ?? getConnection());
  console.log(`[ONCHAIN-OPEN-TURN] openTurn confirmed for rumble ${rumbleId}: ${sig}`);
  return sig;
}

/**
 * Resolve the active on-chain turn. Optional remaining accounts can include
 * move commitment PDAs to use revealed moves instead of fallback.
 */
export async function resolveTurnOnChain(
  rumbleId: number,
  moveCommitmentAccounts: PublicKey[] = [],
  connection?: Connection,
): Promise<string | null> {
  const provider = getAdminProvider(connection);
  if (!provider) {
    console.warn("[solana-programs] No admin keypair, skipping resolveTurnOnChain");
    return null;
  }
  const program = getRumbleEngineProgram(provider);
  const admin = getAdminKeypair()!;
  const [rumblePda] = deriveRumblePda(rumbleId);
  const [combatStatePda] = deriveCombatStatePda(rumbleId);

  console.log(`[ONCHAIN-RESOLVE] Sending resolveTurn for rumble ${rumbleId} (${moveCommitmentAccounts.length} move commitments)...`);
  let method = (program.methods as any).resolveTurn();
  if (moveCommitmentAccounts.length > 0) {
    method = method.remainingAccounts(
      moveCommitmentAccounts.map((pubkey) => ({
        pubkey,
        isWritable: false,
        isSigner: false,
      })),
    );
  }

  method = method
    .accounts({
      keeper: admin.publicKey,
      rumble: rumblePda,
      combatState: combatStatePda,
    })
    .preInstructions([
      ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }),
    ]);

  const sig = await sendAdminTxFireAndForget(method, admin, connection ?? getConnection());
  console.log(`[ONCHAIN-RESOLVE] resolveTurn confirmed for rumble ${rumbleId}: ${sig}`);
  return sig;
}

/**
 * Advance to the next on-chain turn window.
 */
export async function advanceTurnOnChain(
  rumbleId: number,
  connection?: Connection,
): Promise<string | null> {
  const provider = getAdminProvider(connection);
  if (!provider) {
    console.warn("[solana-programs] No admin keypair, skipping advanceTurnOnChain");
    return null;
  }
  const program = getRumbleEngineProgram(provider);
  const admin = getAdminKeypair()!;
  const [rumblePda] = deriveRumblePda(rumbleId);
  const [combatStatePda] = deriveCombatStatePda(rumbleId);

  console.log(`[ONCHAIN-ADVANCE] Sending advanceTurn for rumble ${rumbleId}...`);
  const method = (program.methods as any)
    .advanceTurn()
    .accounts({
      keeper: admin.publicKey,
      rumble: rumblePda,
      combatState: combatStatePda,
    });

  const sig = await sendAdminTxFireAndForget(method, admin, connection ?? getConnection());
  console.log(`[ONCHAIN-ADVANCE] advanceTurn confirmed for rumble ${rumbleId}: ${sig}`);
  return sig;
}

/**
 * Finalize rumble result from on-chain combat state.
 */
export async function finalizeRumbleOnChain(
  rumbleId: number,
  connection?: Connection,
): Promise<string | null> {
  const provider = getAdminProvider(connection);
  if (!provider) {
    console.warn("[solana-programs] No admin keypair, skipping finalizeRumbleOnChain");
    return null;
  }
  const program = getRumbleEngineProgram(provider);
  const admin = getAdminKeypair()!;
  const [rumblePda] = deriveRumblePda(rumbleId);
  const [combatStatePda] = deriveCombatStatePda(rumbleId);

  console.log(`[ONCHAIN-FINALIZE] Sending finalizeRumble for rumble ${rumbleId}...`);
  const method = (program.methods as any)
    .finalizeRumble()
    .accounts({
      keeper: admin.publicKey,
      rumble: rumblePda,
      combatState: combatStatePda,
    })
    .preInstructions([
      ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }),
    ]);

  const sig = await sendAdminTxFireAndForget(method, admin, connection ?? getConnection());
  console.log(`[ONCHAIN-FINALIZE] finalizeRumble confirmed for rumble ${rumbleId}: ${sig}`);
  return sig;
}

/**
 * Close a move commitment PDA and reclaim rent (admin/server-side).
 * Returns tx signature on success, null if admin keypair unavailable.
 */
export async function closeMoveCommitmentOnChain(
  rumbleId: number,
  fighter: PublicKey,
  turn: number,
  destination?: PublicKey,
  connection?: Connection,
): Promise<string | null> {
  const provider = getAdminProvider(connection);
  if (!provider) {
    console.warn("[solana-programs] No admin keypair, skipping closeMoveCommitmentOnChain");
    return null;
  }
  const program = getRumbleEngineProgram(provider);
  const admin = getAdminKeypair()!;
  const [rumblePda] = deriveRumblePda(rumbleId);
  const [rumbleConfigPda] = deriveRumbleConfigPda();
  const [moveCommitmentPda] = deriveMoveCommitmentPda(rumbleId, fighter, turn);
  const dest = destination ?? admin.publicKey;

  console.log(`[ONCHAIN-CLOSE-MOVE] Sending closeMoveCommitment for rumble ${rumbleId} fighter ${fighter.toBase58().slice(0, 8)}... turn ${turn}...`);
  const method = (program.methods as any)
    .closeMoveCommitment(new anchor.BN(rumbleId), turn)
    .accounts({
      admin: admin.publicKey,
      config: rumbleConfigPda,
      rumble: rumblePda,
      moveCommitment: moveCommitmentPda,
      fighter: fighter,
      destination: dest,
    });

  const sig = await sendAdminTxFireAndForget(method, admin, connection ?? getConnection());
  console.log(`[ONCHAIN-CLOSE-MOVE] closeMoveCommitment confirmed for rumble ${rumbleId} turn ${turn}: ${sig}`);
  return sig;
}

/**
 * Report rumble result with placements (admin/server-side).
 * Returns tx signature on success, null if admin keypair unavailable.
 */
export async function reportResult(
  rumbleId: number,
  placements: number[],
  winnerIndex: number,
  connection?: Connection
): Promise<string | null> {
  const provider = getAdminProvider(connection);
  if (!provider) {
    console.warn("[solana-programs] No admin keypair, skipping reportResult");
    return null;
  }
  const program = getRumbleEngineProgram(provider);
  const admin = getAdminKeypair()!;

  const [rumbleConfigPda] = deriveRumbleConfigPda();
  const [rumblePda] = deriveRumblePda(rumbleId);

  console.log(`[ONCHAIN-REPORT] Sending reportResult for rumble ${rumbleId} (winnerIndex=${winnerIndex})...`);
  const method = (program.methods as any)
    .reportResult(Buffer.from(placements), winnerIndex)
    .accounts({
      admin: admin.publicKey,
      config: rumbleConfigPda,
      rumble: rumblePda,
    });

  const { signature } = await sendAdminTxWithConfirmation(method, admin, connection ?? getConnection());
  console.log(`[ONCHAIN-REPORT] reportResult confirmed for rumble ${rumbleId}: ${signature}`);
  return signature;
}

/**
 * Build a claim_payout transaction for the bettor to sign.
 */
export async function buildClaimPayoutTx(
  bettor: PublicKey,
  rumbleId: number,
  connection?: Connection,
  programId?: PublicKey,
): Promise<Transaction> {
  const provider = getProvider(connection);
  const program = getRumbleEngineProgram(provider, programId);
  const useMainnet = programId && !programId.equals(RUMBLE_ENGINE_ID);

  const [rumblePda] = useMainnet ? deriveRumblePdaMainnet(rumbleId) : deriveRumblePda(rumbleId);
  const [vaultPda] = useMainnet ? deriveVaultPdaMainnet(rumbleId) : deriveVaultPda(rumbleId);
  const [bettorAccountPda] = useMainnet ? deriveBettorPdaMainnet(rumbleId, bettor) : deriveBettorPda(rumbleId, bettor);

  const conn = connection ?? getConnection();

  const tx = await (program.methods as any)
    .claimPayout()
    .accounts({
      bettor,
      rumble: rumblePda,
      vault: vaultPda,
      bettorAccount: bettorAccountPda,
      systemProgram: SystemProgram.programId,
    })
    .transaction();

  tx.feePayer = bettor;
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash(
    "confirmed"
  );
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;

  return tx;
}

/**
 * Build one transaction with multiple claim_payout instructions so a wallet
 * can claim all ready rumble wins in a single signature.
 */
export async function buildClaimPayoutBatchTx(
  bettor: PublicKey,
  rumbleIds: number[],
  connection?: Connection,
  programId?: PublicKey,
): Promise<Transaction> {
  if (!Array.isArray(rumbleIds) || rumbleIds.length === 0) {
    throw new Error("At least one rumble id is required for batch claim");
  }

  const uniqueRumbleIds = [...new Set(
    rumbleIds.filter((id) => Number.isInteger(id) && id > 0),
  )];
  if (uniqueRumbleIds.length === 0) {
    throw new Error("No valid rumble ids provided for batch claim");
  }

  const provider = getProvider(connection);
  const program = getRumbleEngineProgram(provider, programId);
  const conn = connection ?? getConnection();
  const useMainnet = programId && !programId.equals(RUMBLE_ENGINE_ID);
  const tx = new Transaction();

  // Batch claim instructions can exceed the default compute cap.
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 900_000 }));

  for (const rumbleId of uniqueRumbleIds) {
    const [rumblePda] = useMainnet ? deriveRumblePdaMainnet(rumbleId) : deriveRumblePda(rumbleId);
    const [vaultPda] = useMainnet ? deriveVaultPdaMainnet(rumbleId) : deriveVaultPda(rumbleId);
    const [bettorAccountPda] = useMainnet ? deriveBettorPdaMainnet(rumbleId, bettor) : deriveBettorPda(rumbleId, bettor);

    const ix = await (program.methods as any)
      .claimPayout()
      .accounts({
        bettor,
        rumble: rumblePda,
        vault: vaultPda,
        bettorAccount: bettorAccountPda,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    tx.add(ix);
  }

  tx.feePayer = bettor;
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  return tx;
}

/**
 * Build a claim_sponsorship_revenue transaction for the fighter owner.
 */
export async function buildClaimSponsorshipTx(
  fighterOwner: PublicKey,
  fighterPubkey: PublicKey,
  connection?: Connection
): Promise<Transaction> {
  const provider = getProvider(connection);
  const program = getRumbleEngineProgram(provider);

  const [sponsorshipPda] = deriveSponsorshipPda(fighterPubkey);

  const conn = connection ?? getConnection();

  const tx = await (program.methods as any)
    .claimSponsorshipRevenue()
    .accounts({
      fighterOwner,
      fighter: fighterPubkey,
      sponsorshipAccount: sponsorshipPda,
      systemProgram: SystemProgram.programId,
    })
    .transaction();

  tx.feePayer = fighterOwner;
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash(
    "confirmed"
  );
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;

  return tx;
}

/**
 * Read the fighter account authority from Fighter Registry account data.
 * Returns null if account is missing or malformed.
 */
export async function readFighterAuthority(
  fighterPubkey: PublicKey,
  connection?: Connection,
): Promise<PublicKey | null> {
  const conn = connection ?? getConnection();
  const info = await conn.getAccountInfo(fighterPubkey, "confirmed");
  if (!info || info.data.length < 40) return null;
  if (!info.owner.equals(FIGHTER_REGISTRY_ID)) return null;
  return new PublicKey(info.data.subarray(8, 40));
}

/**
 * Read currently claimable sponsorship lamports for a fighter's sponsorship PDA.
 * Returns max(vault_lamports - rent_exempt_minimum, 0).
 */
export async function readSponsorshipClaimableLamports(
  fighterPubkey: PublicKey,
  connection?: Connection,
): Promise<bigint> {
  const conn = connection ?? getConnection();
  const [sponsorshipPda] = deriveSponsorshipPda(fighterPubkey);
  const [info, rentMin] = await Promise.all([
    conn.getAccountInfo(sponsorshipPda, "confirmed"),
    conn.getMinimumBalanceForRentExemption(0, "confirmed"),
  ]);
  if (!info) return 0n;
  const available = BigInt(info.lamports) - BigInt(rentMin);
  return available > 0n ? available : 0n;
}

/**
 * Complete a rumble (admin/server-side).
 * Returns tx signature on success, null if admin keypair unavailable.
 */
export async function completeRumble(
  rumbleId: number,
  connection?: Connection
): Promise<string | null> {
  const provider = getAdminProvider(connection);
  if (!provider) {
    console.warn("[solana-programs] No admin keypair, skipping completeRumble");
    return null;
  }
  const program = getRumbleEngineProgram(provider);
  const admin = getAdminKeypair()!;

  const [rumbleConfigPda] = deriveRumbleConfigPda();
  const [rumblePda] = deriveRumblePda(rumbleId);

  console.log(`[ONCHAIN-COMPLETE] Sending completeRumble for rumble ${rumbleId}...`);
  const method = (program.methods as any)
    .completeRumble()
    .accounts({
      admin: admin.publicKey,
      config: rumbleConfigPda,
      rumble: rumblePda,
    });

  const { signature } = await sendAdminTxWithConfirmation(method, admin, connection ?? getConnection());
  console.log(`[ONCHAIN-COMPLETE] completeRumble confirmed for rumble ${rumbleId}: ${signature}`);
  return signature;
}

// ---------------------------------------------------------------------------
// Mainnet Admin Functions (betting network)
// ---------------------------------------------------------------------------

/**
 * Create a rumble on mainnet for betting. Same logic as createRumble but uses
 * mainnet admin keypair, mainnet connection, and mainnet program ID.
 */
export async function createRumbleMainnet(
  rumbleId: number,
  fighters: PublicKey[],
  bettingDeadlineUnix: number,
): Promise<string | null> {
  if (!isMainnetConfigured()) {
    console.warn("[solana-programs] Mainnet not configured, skipping");
    return null;
  }

  const provider = getMainnetAdminProvider();
  if (!provider) {
    console.warn("[solana-programs] No mainnet admin keypair, skipping mainnet createRumble");
    return null;
  }
  const program = getRumbleEngineProgram(provider, RUMBLE_ENGINE_ID_MAINNET);
  const admin = getMainnetAdminKeypair()!;

  const [rumbleConfigPda] = deriveRumbleConfigPdaMainnet();
  const [rumblePda] = deriveRumblePdaMainnet(rumbleId);

  const conn = getBettingConnection();
  const nowUnix = Math.floor(Date.now() / 1000);
  const bettingCloseUnix = BigInt(Math.max(bettingDeadlineUnix, nowUnix + 30));

  const method = (program.methods as any)
    .createRumble(
      new anchor.BN(rumbleId),
      fighters,
      new anchor.BN(bettingCloseUnix.toString()),
    )
    .accounts({
      admin: admin.publicKey,
      config: rumbleConfigPda,
      rumble: rumblePda,
      systemProgram: SystemProgram.programId,
    });

  return await sendAdminTxFireAndForget(method, admin, conn);
}

/**
 * Report rumble result on mainnet so bettors can claim payouts.
 * Uses the admin_set_result instruction (replaces the deprecated report_result).
 */
export async function reportResultMainnet(
  rumbleId: number,
  placements: number[],
  winnerIndex: number,
): Promise<string | null> {
  if (!isMainnetConfigured()) {
    console.warn("[solana-programs] Mainnet not configured, skipping");
    return null;
  }

  const provider = getMainnetAdminProvider();
  if (!provider) {
    console.warn("[solana-programs] No mainnet admin keypair, skipping mainnet reportResult");
    return null;
  }
  const program = getRumbleEngineProgram(provider, RUMBLE_ENGINE_ID_MAINNET);
  const admin = getMainnetAdminKeypair()!;

  const [rumbleConfigPda] = deriveRumbleConfigPdaMainnet();
  const [rumblePda] = deriveRumblePdaMainnet(rumbleId);

  const method = (program.methods as any)
    .adminSetResult(Buffer.from(placements), winnerIndex)
    .accounts({
      admin: admin.publicKey,
      config: rumbleConfigPda,
      rumble: rumblePda,
    });

  const { signature } = await sendAdminTxWithConfirmation(method, admin, getBettingConnection());
  return signature;
}

/**
 * Complete a rumble on mainnet (close accounts, reclaim rent).
 */
export async function completeRumbleMainnet(
  rumbleId: number,
): Promise<string | null> {
  if (!isMainnetConfigured()) {
    console.warn("[solana-programs] Mainnet not configured, skipping");
    return null;
  }

  const provider = getMainnetAdminProvider();
  if (!provider) {
    console.warn("[solana-programs] No mainnet admin keypair, skipping mainnet completeRumble");
    return null;
  }
  const program = getRumbleEngineProgram(provider, RUMBLE_ENGINE_ID_MAINNET);
  const admin = getMainnetAdminKeypair()!;

  const [rumbleConfigPda] = deriveRumbleConfigPdaMainnet();
  const [rumblePda] = deriveRumblePdaMainnet(rumbleId);

  const method = (program.methods as any)
    .completeRumble()
    .accounts({
      admin: admin.publicKey,
      config: rumbleConfigPda,
      rumble: rumblePda,
    });

  const { signature } = await sendAdminTxWithConfirmation(method, admin, getBettingConnection());
  return signature;
}

/**
 * Close a completed mainnet Rumble account to reclaim rent back to admin.
 * Requires the rumble to be in Complete state and claim window expired.
 */
export async function closeRumbleMainnet(
  rumbleId: number,
): Promise<string | null> {
  const provider = getMainnetAdminProvider();
  if (!provider) {
    console.warn("[solana-programs] No mainnet admin keypair, skipping mainnet closeRumble");
    return null;
  }
  const program = getRumbleEngineProgram(provider, RUMBLE_ENGINE_ID_MAINNET);
  const admin = getMainnetAdminKeypair()!;

  const [rumbleConfigPda] = deriveRumbleConfigPdaMainnet();
  const [rumblePda] = deriveRumblePdaMainnet(rumbleId);

  const [vaultPda] = deriveVaultPdaMainnet(rumbleId);
  const method = (program.methods as any)
    .closeRumble()
    .accounts({
      admin: admin.publicKey,
      config: rumbleConfigPda,
      rumble: rumblePda,
      vault: vaultPda,
    });

  const { signature } = await sendAdminTxWithConfirmation(method, admin, getBettingConnection());
  return signature;
}

const RENT_RECLAIM_MAX_MUTATIONS_PER_RUN = Math.max(
  1,
  Number(process.env.RENT_RECLAIM_MAX_MUTATIONS_PER_RUN ?? "8"),
);
const RENT_RECLAIM_TX_SPACING_MS = Math.max(
  0,
  Number(process.env.RENT_RECLAIM_TX_SPACING_MS ?? "400"),
);
const RENT_RECLAIM_MAX_SCAN_PER_RUN = Math.max(
  100,
  Number(process.env.RENT_RECLAIM_MAX_SCAN_PER_RUN ?? "1200"),
);
const RENT_RECLAIM_FAILURE_COOLDOWN_MS = Math.max(
  60_000,
  Number(process.env.RENT_RECLAIM_FAILURE_COOLDOWN_MS ?? String(6 * 60 * 60_000)),
);
const RENT_RECLAIM_RATE_LIMIT_COOLDOWN_MS = Math.max(
  60_000,
  Number(process.env.RENT_RECLAIM_RATE_LIMIT_COOLDOWN_MS ?? String(30 * 60_000)),
);
const _rentReclaimRetryAfterByRumble = new Map<number, number>();

function isRpcRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /429|too many requests|rate limit|rate-limited/i.test(msg);
}

function pruneRentReclaimRetryMap(nowMs: number): void {
  if (_rentReclaimRetryAfterByRumble.size === 0) return;
  for (const [rumbleId, retryAfter] of _rentReclaimRetryAfterByRumble.entries()) {
    if (retryAfter <= nowMs) {
      _rentReclaimRetryAfterByRumble.delete(rumbleId);
    }
  }
  if (_rentReclaimRetryAfterByRumble.size > 5000) {
    const sorted = [..._rentReclaimRetryAfterByRumble.entries()].sort((a, b) => a[1] - b[1]);
    const toRemove = _rentReclaimRetryAfterByRumble.size - 3000;
    for (const [rumbleId] of sorted.slice(0, toRemove)) {
      _rentReclaimRetryAfterByRumble.delete(rumbleId);
    }
  }
}

function deferRentReclaim(
  rumbleId: number,
  err: unknown,
): void {
  const cooldownMs = isRpcRateLimitError(err)
    ? RENT_RECLAIM_RATE_LIMIT_COOLDOWN_MS
    : RENT_RECLAIM_FAILURE_COOLDOWN_MS;
  _rentReclaimRetryAfterByRumble.set(rumbleId, Date.now() + cooldownMs);
}

/**
 * Batch reclaim rent from eligible mainnet rumble accounts.
 * 1) complete_rumble for Payout accounts past claim window
 * 2) close_rumble ONLY for rumbles with no bets or no winner bets
 *    (rumbles with unclaimed winning bets are kept alive so users can claim)
 * Returns total lamports reclaimed.
 */
export async function reclaimMainnetRumbleRent(): Promise<{ completed: number; closed: number; swept: number; skipped: number; reclaimedLamports: number }> {
  const provider = getMainnetAdminProvider();
  if (!provider) return { completed: 0, closed: 0, swept: 0, skipped: 0, reclaimedLamports: 0 };

  const conn = getBettingConnection();
  const programId = RUMBLE_ENGINE_ID_MAINNET;
  const accounts = await conn.getProgramAccounts(programId);
  const admin = getMainnetAdminKeypair()!;
  const program = getRumbleEngineProgram(provider, programId);
  const [configPda] = deriveRumbleConfigPdaMainnet();

  // Read treasury address once for sweep calls
  let treasury: PublicKey | null = null;
  try {
    const configInfo = await conn.getAccountInfo(configPda);
    if (configInfo) treasury = new PublicKey(configInfo.data.subarray(8 + 32, 8 + 32 + 32));
  } catch { /* will skip sweeps if treasury unavailable */ }

  let completed = 0;
  let closed = 0;
  let swept = 0;
  let skipped = 0;
  let reclaimedLamports = 0;
  let mutationsIssued = 0;

  const now = Math.floor(Date.now() / 1000);
  const BETTING_STALE_SECONDS = 3600; // 1 hour
  const RENT_EXEMPT_MIN = 890_880; // ~0.00089 SOL for 0-byte account

  // Byte offsets for Rumble account fields (Anchor discriminator = 8 bytes)
  // id(u64) state(u8) fighters([Pubkey;16]) fighter_count(u8) betting_pools([u64;16])
  // total_deployed(u64) admin_fee(u64) sponsorship(u64) placements([u8;16]) winner_index(u8)
  // betting_deadline(i64) combat_started_at(i64) completed_at(i64) bump(u8)
  const BETTING_POOLS_OFFSET = 8 + 8 + 1 + 512 + 1; // 530
  const WINNER_INDEX_OFFSET = BETTING_POOLS_OFFSET + 128 + 8 + 8 + 8 + 16; // 698
  const BETTING_DEADLINE_OFFSET = WINNER_INDEX_OFFSET + 1; // 699
  const COMPLETED_AT_OFFSET = BETTING_DEADLINE_OFFSET + 8 + 8; // 715

  pruneRentReclaimRetryMap(Date.now());

  const canMutate = () => mutationsIssued < RENT_RECLAIM_MAX_MUTATIONS_PER_RUN;
  const noteMutation = async () => {
    mutationsIssued += 1;
    if (RENT_RECLAIM_TX_SPACING_MS > 0) {
      await sleep(RENT_RECLAIM_TX_SPACING_MS);
    }
  };

  const candidates = accounts
    .map((row) => {
      const data = row.account.data;
      if (data.length < 700 || data.length > 730) return null;
      let rumbleId = -1;
      try {
        rumbleId = Number(data.readBigUInt64LE(8));
      } catch {
        return null;
      }
      if (!Number.isSafeInteger(rumbleId) || rumbleId < 0) return null;
      return { row, data, rumbleId };
    })
    .filter((row): row is { row: typeof accounts[number]; data: Buffer; rumbleId: number } => row !== null)
    .sort((a, b) => b.rumbleId - a.rumbleId)
    .slice(0, RENT_RECLAIM_MAX_SCAN_PER_RUN);

  for (const { row: a, data, rumbleId } of candidates) {
    const retryAfter = _rentReclaimRetryAfterByRumble.get(rumbleId);
    if (retryAfter && retryAfter > Date.now()) {
      skipped++;
      continue;
    }
    if (retryAfter) _rentReclaimRetryAfterByRumble.delete(rumbleId);

    const state = data[16];
    const [rumblePda] = deriveRumblePdaMainnet(rumbleId);

    // --- State 0: Betting (stuck) ---
    // Only auto-close if no bets were placed (vault empty).
    // If people bet but fight never started, skip — needs admin review.
    if (state === 0) {
      const bettingDeadline = Number(data.readBigInt64LE(BETTING_DEADLINE_OFFSET));
      const staleBetting = bettingDeadline > 0 && (now - bettingDeadline) > BETTING_STALE_SECONDS;
      if (!staleBetting) { skipped++; continue; }

      // Check vault — if anyone bet, don't auto-close
      const [vaultPda] = deriveVaultPdaMainnet(rumbleId);
      let vaultBalance = 0;
      try {
        vaultBalance = await conn.getBalance(vaultPda);
      } catch (err) {
        skipped++;
        deferRentReclaim(rumbleId, err);
        continue;
      }

      if (vaultBalance > RENT_EXEMPT_MIN) {
        skipped++;
        console.log(`[RentReclaim] SKIP stale betting ${rumbleId}: vault has ${(vaultBalance / 1e9).toFixed(6)} SOL (bets placed, needs admin review)`);
        continue;
      }

      if (!canMutate()) break;

      // No bets — safe to force-complete and close over next cycles
      try {
        const dummyPlacements = Buffer.from(Array.from({ length: 16 }, (_, i) => i));
        const method = (program.methods as any)
          .adminSetResult(dummyPlacements, 0)
          .accounts({ admin: admin.publicKey, config: configPda, rumble: rumblePda });
        const sig = await sendAdminTxFireAndForget(method, admin, conn);
        if (sig) {
          completed++;
          _rentReclaimRetryAfterByRumble.delete(rumbleId);
          console.log(`[RentReclaim] adminSetResult (stale betting, no bets) ${rumbleId}: ${sig}`);
          await noteMutation();
        }
      } catch (err) {
        deferRentReclaim(rumbleId, err);
        console.warn(`[RentReclaim] adminSetResult ${rumbleId} failed:`, (err as Error).message?.slice(0, 80));
      }
      continue;
    }

    const completedAt = Number(data.readBigInt64LE(COMPLETED_AT_OFFSET));
    const pastClaimWindow = completedAt > 0 && (now - completedAt) > 86400;

    // --- State 2: Payout → Complete (safe — winners can still claim in Complete state) ---
    if (state === 2 && pastClaimWindow) {
      if (!canMutate()) break;
      try {
        const method = (program.methods as any).completeRumble().accounts({
          admin: admin.publicKey, config: configPda, rumble: rumblePda,
        });
        const sig = await sendAdminTxFireAndForget(method, admin, conn);
        if (sig) {
          completed++;
          _rentReclaimRetryAfterByRumble.delete(rumbleId);
          console.log(`[RentReclaim] completeRumble ${rumbleId}: ${sig}`);
          await noteMutation();
        }
      } catch (err) {
        deferRentReclaim(rumbleId, err);
        console.warn(`[RentReclaim] completeRumble ${rumbleId} failed:`, (err as Error).message?.slice(0, 80));
      }
      continue; // Next cycle handles sweep + close
    }

    // --- State 3: Complete → Check winners → Sweep/Close ---
    if (state === 3 && pastClaimWindow) {
      // Read winner_index and check if anyone bet on the winner
      const winnerIndex = data[WINNER_INDEX_OFFSET];
      const winnerPoolLamports = Number(data.readBigUInt64LE(BETTING_POOLS_OFFSET + winnerIndex * 8));
      const hasWinningBets = winnerPoolLamports > 0;

      const [vaultPda] = deriveVaultPdaMainnet(rumbleId);
      let vaultBalance = 0;
      try {
        vaultBalance = await conn.getBalance(vaultPda);
      } catch (err) {
        skipped++;
        deferRentReclaim(rumbleId, err);
        continue;
      }
      const hasUnclaimedSol = vaultBalance > RENT_EXEMPT_MIN;

      // If someone bet on the winner and vault still has SOL → leave it alone.
      // Winners can claim whenever they want.
      if (hasWinningBets && hasUnclaimedSol) {
        skipped++;
        console.log(`[RentReclaim] SKIP ${rumbleId}: winners exist, vault has ${(vaultBalance / 1e9).toFixed(6)} SOL (claimable)`);
        continue;
      }

      // No winning bets but vault has SOL → sweep house money to treasury
      if (!hasWinningBets && hasUnclaimedSol) {
        if (!treasury) {
          skipped++;
          console.log(`[RentReclaim] SKIP sweep ${rumbleId}: treasury address unavailable`);
          continue;
        }
        if (!canMutate()) break;
        try {
          const method = (program.methods as any)
            .sweepTreasury()
            .accounts({
              admin: admin.publicKey,
              config: configPda,
              rumble: rumblePda,
              vault: vaultPda,
              treasury,
              systemProgram: SystemProgram.programId,
            });
          const sig = await sendAdminTxFireAndForget(method, admin, conn);
          if (sig) {
            swept++;
            _rentReclaimRetryAfterByRumble.delete(rumbleId);
            console.log(`[RentReclaim] sweepTreasury ${rumbleId} (no winners): ${sig} (${(vaultBalance / 1e9).toFixed(6)} SOL)`);
            await noteMutation();
          }
        } catch (err) {
          deferRentReclaim(rumbleId, err);
          console.warn(`[RentReclaim] sweepTreasury ${rumbleId} failed:`, (err as Error).message?.slice(0, 80));
        }
        continue; // Next cycle closes once vault is empty
      }

      // Vault empty (or winning bets already claimed) — close PDA and reclaim rent
      if (!hasUnclaimedSol) {
        if (!canMutate()) break;
        try {
          const method = (program.methods as any).closeRumble().accounts({
            admin: admin.publicKey, config: configPda, rumble: rumblePda, vault: vaultPda,
          });
          const { signature } = await sendAdminTxWithConfirmation(method, admin, conn);
          if (signature) {
            closed++;
            reclaimedLamports += a.account.lamports;
            _rentReclaimRetryAfterByRumble.delete(rumbleId);
            console.log(`[RentReclaim] closeRumble ${rumbleId}: ${signature} (${a.account.lamports} lamports)`);
            await noteMutation();
          }
        } catch (err) {
          deferRentReclaim(rumbleId, err);
          console.warn(`[RentReclaim] closeRumble ${rumbleId} failed:`, (err as Error).message?.slice(0, 80));
        }
      }
    }
  }

  if (mutationsIssued >= RENT_RECLAIM_MAX_MUTATIONS_PER_RUN) {
    console.log(
      `[RentReclaim] mutation cap reached (${mutationsIssued}/${RENT_RECLAIM_MAX_MUTATIONS_PER_RUN})`,
    );
  }

  return { completed, closed, swept, skipped, reclaimedLamports };
}

/**
 * Read fighter public keys from an on-chain Rumble account.
 * Delegates to cached readRumbleAccountState to avoid duplicate RPC calls
 * (saves 1 credit per call — same PDA, now extracted during state read).
 */
export async function readRumbleFighters(
  rumbleId: bigint | number,
  connection?: Connection,
): Promise<PublicKey[]> {
  const state = await readRumbleAccountState(rumbleId, connection);
  return state?.fighters ?? [];
}

/**
 * Sweep remaining SOL from completed rumble vault to treasury (admin/server-side).
 * Returns tx signature on success, null if admin keypair unavailable.
 */
export async function sweepTreasury(
  rumbleId: number,
  connection?: Connection
): Promise<string | null> {
  const provider = getAdminProvider(connection);
  if (!provider) {
    console.warn("[solana-programs] No admin keypair, skipping sweepTreasury");
    return null;
  }
  const program = getRumbleEngineProgram(provider);
  const admin = getAdminKeypair()!;

  const [rumbleConfigPda] = deriveRumbleConfigPda();
  const [rumblePda] = deriveRumblePda(rumbleId);
  const [vaultPda] = deriveVaultPda(rumbleId);

  // Read treasury from config
  const conn = connection ?? getConnection();
  const configInfo = await conn.getAccountInfo(rumbleConfigPda);
  if (!configInfo) throw new Error("Rumble config not found");
  const treasury = new PublicKey(configInfo.data.subarray(8 + 32, 8 + 32 + 32));

  const method = (program.methods as any)
    .sweepTreasury()
    .accounts({
      admin: admin.publicKey,
      config: rumbleConfigPda,
      rumble: rumblePda,
      vault: vaultPda,
      treasury,
      systemProgram: SystemProgram.programId,
    });

  const { signature } = await sendAdminTxWithConfirmation(method, admin, connection ?? getConnection());
  return signature;
}

/**
 * Sweep remaining SOL from a completed mainnet Rumble's vault to the treasury.
 * Admin-only — requires mainnet admin keypair.
 */
export async function sweepTreasuryMainnet(
  rumbleId: number,
): Promise<string | null> {
  if (!isMainnetConfigured()) {
    console.warn("[solana-programs] Mainnet not configured, skipping");
    return null;
  }

  const provider = getMainnetAdminProvider();
  if (!provider) {
    console.warn("[solana-programs] No mainnet admin keypair, skipping mainnet sweepTreasury");
    return null;
  }
  const program = getRumbleEngineProgram(provider, RUMBLE_ENGINE_ID_MAINNET);
  const admin = getMainnetAdminKeypair()!;

  const [rumbleConfigPda] = deriveRumbleConfigPdaMainnet();
  const [rumblePda] = deriveRumblePdaMainnet(rumbleId);
  const [vaultPda] = deriveVaultPdaMainnet(rumbleId);

  // Read treasury from mainnet config
  const conn = getBettingConnection();
  const configInfo = await conn.getAccountInfo(rumbleConfigPda);
  if (!configInfo) throw new Error("Mainnet rumble config not found");
  const treasury = new PublicKey(configInfo.data.subarray(8 + 32, 8 + 32 + 32));

  const method = (program.methods as any)
    .sweepTreasury()
    .accounts({
      admin: admin.publicKey,
      config: rumbleConfigPda,
      rumble: rumblePda,
      vault: vaultPda,
      treasury,
      systemProgram: SystemProgram.programId,
    });

  const { signature } = await sendAdminTxWithConfirmation(method, admin, conn);
  return signature;
}

// ---------------------------------------------------------------------------
// Fighter Registry - Update Record (admin/server-side)
// ---------------------------------------------------------------------------

/**
 * Update a fighter's combat record on-chain after a Rumble.
 * Returns tx signature on success, null if admin keypair unavailable.
 */
export async function updateFighterRecord(
  fighterPubkey: PublicKey,
  wins: number,
  losses: number,
  damageDealt: number,
  damageTaken: number,
  ichorMined: number,
  rumbleId: number,
  connection?: Connection
): Promise<string | null> {
  const provider = getAdminProvider(connection);
  if (!provider) {
    console.warn("[solana-programs] No admin keypair, skipping updateFighterRecord");
    return null;
  }
  const program = getFighterRegistryProgram(provider);
  const admin = getAdminKeypair()!;

  const [registryConfigPda] = deriveRegistryConfigPda();

  const method = (program.methods as any)
    .updateRecord(
      new anchor.BN(wins),
      new anchor.BN(losses),
      new anchor.BN(damageDealt),
      new anchor.BN(damageTaken),
      new anchor.BN(ichorMined),
      new anchor.BN(rumbleId)
    )
    .accounts({
      authority: admin.publicKey,
      registryConfig: registryConfigPda,
      fighter: fighterPubkey,
    });

  return await sendAdminTxFireAndForget(method, admin, connection ?? getConnection());
}

// ---------------------------------------------------------------------------
// ATA Helper — ensures a token account exists before minting
// ---------------------------------------------------------------------------

/**
 * Create the Associated Token Account for `owner` + `mint` if it doesn't exist.
 * Uses the admin keypair as payer. Returns the ATA address.
 * Set `allowOwnerOffCurve` to true for PDA-owned ATAs (e.g. shower vault).
 */
export async function ensureAta(
  mint: PublicKey,
  owner: PublicKey,
  allowOwnerOffCurve = false,
  connection?: Connection
): Promise<PublicKey | null> {
  const admin = getAdminKeypair();
  if (!admin) {
    console.warn("[solana-programs] No admin keypair, cannot create ATA");
    return null;
  }
  const conn = connection ?? getConnection();
  const {
    getAssociatedTokenAddressSync: getAta,
    createAssociatedTokenAccountInstruction,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  } = await import("@solana/spl-token");

  const ata = getAta(mint, owner, allowOwnerOffCurve);

  // Check if already exists
  const info = await conn.getAccountInfo(ata);
  if (info) return ata;

  // Create ATA
  const ix = createAssociatedTokenAccountInstruction(
    admin.publicKey,
    ata,
    owner,
    mint,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  const tx = new Transaction().add(ix);
  tx.feePayer = admin.publicKey;
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.partialSign(admin);

  try {
    const sig = await conn.sendRawTransaction(tx.serialize());
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    return ata;
  } catch (err) {
    if (isAccountAlreadyExistsError(err)) {
      return ata;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Read-only helpers (for frontend state queries)
// ---------------------------------------------------------------------------

/**
 * Read ArenaConfig state from chain.
 */
export async function readArenaConfig(
  connection?: Connection
): Promise<{
  admin: string;
  ichorMint: string;
  distributionVault: string;
  totalDistributed: bigint;
  totalRumblesCompleted: bigint;
  baseReward: bigint;
  seasonReward: bigint;
  effectiveReward: bigint;
  ichorShowerPool: bigint;
  treasuryVault: bigint;
  bump: number;
  accountDataLen: number;
  /** @deprecated Use totalDistributed */
  totalMinted: bigint;
} | null> {
  return cachedRead('arena', 30000, async () => {
    const conn = connection ?? getConnection();
    const [pda] = deriveArenaConfigPda();
    const info = await conn.getAccountInfo(pda);
    if (!info) return null;

    const d = info.data;
    let offset = 8; // skip discriminator
    const admin = new PublicKey(d.subarray(offset, offset + 32)).toBase58();
    offset += 32;
    const ichorMint = new PublicKey(d.subarray(offset, offset + 32)).toBase58();
    offset += 32;
    const distributionVault = new PublicKey(d.subarray(offset, offset + 32)).toBase58();
    offset += 32;
    const totalDistributed = d.readBigUInt64LE(offset);
    offset += 8;
    const totalRumblesCompleted = d.readBigUInt64LE(offset);
    offset += 8;
    const baseReward = d.readBigUInt64LE(offset);
    offset += 8;
    const ichorShowerPool = d.readBigUInt64LE(offset);
    offset += 8;
    const treasuryVault = d.readBigUInt64LE(offset);
    offset += 8;
    const bump = d[offset];
    // season_reward was added in ArenaConfig V2. Legacy accounts (V1) end at bump.
    const seasonRewardOffset = offset + 1;
    const seasonReward =
      d.length >= seasonRewardOffset + 8 ? d.readBigUInt64LE(seasonRewardOffset) : 0n;
    const effectiveReward = seasonReward > 0n ? seasonReward : baseReward;

    return {
      admin,
      ichorMint,
      distributionVault,
      totalDistributed,
      totalRumblesCompleted,
      baseReward,
      seasonReward,
      effectiveReward,
      ichorShowerPool,
      treasuryVault,
      bump,
      accountDataLen: d.length,
      totalMinted: totalDistributed, // backwards compat alias
    };
  });
}

/**
 * Read ShowerRequest state from chain.
 */
export async function readShowerRequest(
  connection?: Connection
): Promise<{
  initialized: boolean;
  active: boolean;
  bump: number;
  requestNonce: bigint;
  requestedSlot: bigint;
  targetSlotA: bigint;
  targetSlotB: bigint;
  recipientTokenAccount: string;
} | null> {
  const conn = connection ?? getConnection();
  const [pda] = deriveShowerRequestPda();
  const info = await conn.getAccountInfo(pda);
  if (!info) return null;

  const d = info.data;
  let offset = 8; // discriminator

  const initialized = d[offset] !== 0;
  offset += 1;
  const active = d[offset] !== 0;
  offset += 1;
  const bump = d[offset];
  offset += 1;
  const requestNonce = d.readBigUInt64LE(offset);
  offset += 8;
  const requestedSlot = d.readBigUInt64LE(offset);
  offset += 8;
  const targetSlotA = d.readBigUInt64LE(offset);
  offset += 8;
  const targetSlotB = d.readBigUInt64LE(offset);
  offset += 8;
  const recipientTokenAccount = new PublicKey(
    d.subarray(offset, offset + 32)
  ).toBase58();

  return {
    initialized,
    active,
    bump,
    requestNonce,
    requestedSlot,
    targetSlotA,
    targetSlotB,
    recipientTokenAccount,
  };
}

/**
 * Read RumbleConfig state from chain.
 */
export async function readRumbleConfig(
  connection?: Connection
): Promise<{
  admin: string;
  treasury: string;
  totalRumbles: bigint;
  bump: number;
} | null> {
  const conn = connection ?? getConnection();
  const [pda] = deriveRumbleConfigPda();
  const info = await conn.getAccountInfo(pda);
  if (!info) return null;

  const d = info.data;
  let offset = 8;
  const admin = new PublicKey(d.subarray(offset, offset + 32)).toBase58();
  offset += 32;
  const treasury = new PublicKey(d.subarray(offset, offset + 32)).toBase58();
  offset += 32;
  const totalRumbles = d.readBigUInt64LE(offset);
  offset += 8;
  const bump = d[offset];

  return { admin, treasury, totalRumbles, bump };
}

/**
 * Read RegistryConfig state from chain.
 */
export async function readRegistryConfig(
  connection?: Connection
): Promise<{
  admin: string;
  totalFighters: bigint;
  bump: number;
} | null> {
  const conn = connection ?? getConnection();
  const [pda] = deriveRegistryConfigPda();
  const info = await conn.getAccountInfo(pda);
  if (!info) return null;

  const d = info.data;
  let offset = 8;
  const admin = new PublicKey(d.subarray(offset, offset + 32)).toBase58();
  offset += 32;
  const totalFighters = d.readBigUInt64LE(offset);
  offset += 8;
  const bump = d[offset];

  return { admin, totalFighters, bump };
}

/**
 * Read a MoveCommitment PDA to extract the revealed move (if any).
 */
export async function readMoveCommitmentData(
  pda: PublicKey,
  connection?: Connection,
): Promise<{ revealedMove: number | null; fighter: PublicKey } | null> {
  const conn = connection ?? getConnection();
  const info = await conn.getAccountInfo(pda);
  if (!info || !info.data || info.data.length < 8 + 8 + 32 + 4 + 32 + 1) return null;

  // MoveCommitment layout:
  // 8 bytes: discriminator
  // 8 bytes: rumble_id (u64 LE)
  // 32 bytes: fighter (Pubkey)
  // 4 bytes: turn (u32 LE)
  // 32 bytes: commitment (hash)
  // 1 byte: revealed_move Option tag (0=None, 1=Some)
  // 1 byte: revealed_move value (if Some)

  let offset = 8; // skip discriminator
  offset += 8; // skip rumble_id
  const fighter = new PublicKey(info.data.subarray(offset, offset + 32));
  offset += 32; // skip fighter
  offset += 4; // skip turn
  offset += 32; // skip commitment

  const hasMove = info.data[offset] === 1;
  offset += 1;
  const revealedMove = hasMove ? info.data[offset] : null;

  return { revealedMove, fighter };
}

/**
 * Post off-chain-computed turn results on-chain via `post_turn_result`.
 */
export async function postTurnResultOnChain(
  rumbleId: number,
  duelResults: Array<{
    fighterAIdx: number;
    fighterBIdx: number;
    moveA: number;
    moveB: number;
    damageToA: number;
    damageToB: number;
  }>,
  byeFighterIdx: number | null,
  connection?: Connection,
): Promise<string | null> {
  const provider = getAdminProvider(connection);
  if (!provider) {
    console.warn("[solana-programs] No admin keypair, skipping postTurnResultOnChain");
    return null;
  }
  const program = getRumbleEngineProgram(provider);
  const admin = getAdminKeypair()!;
  const [rumblePda] = deriveRumblePda(rumbleId);
  const [combatStatePda] = deriveCombatStatePda(rumbleId);
  const [rumbleConfigPda] = deriveRumbleConfigPda();

  console.log(`[ONCHAIN-POST-TURN] Sending postTurnResult for rumble ${rumbleId} (${duelResults.length} duels, bye=${byeFighterIdx})...`);
  const method = (program.methods as any)
    .postTurnResult(
      duelResults.map(d => ({
        fighterAIdx: d.fighterAIdx,
        fighterBIdx: d.fighterBIdx,
        moveA: d.moveA,
        moveB: d.moveB,
        damageToA: d.damageToA,
        damageToB: d.damageToB,
      })),
      byeFighterIdx,
    )
    .accounts({
      keeper: admin.publicKey,
      rumble: rumblePda,
      combatState: combatStatePda,
      config: rumbleConfigPda,
    })
    .preInstructions([
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    ]);

  const sig = await sendAdminTxFireAndForget(method, admin, connection ?? getConnection());
  console.log(`[ONCHAIN-POST-TURN] postTurnResult confirmed for rumble ${rumbleId}: ${sig}`);
  return sig;
}

// ---------------------------------------------------------------------------
// MagicBlock Ephemeral Rollup — Delegation / Commit / Undelegate
// ---------------------------------------------------------------------------

async function ensureErEscrowFunding(admin: Keypair, connection: Connection): Promise<void> {
  const minLamports = Math.round(ER_ESCROW_MIN_SOL * LAMPORTS_PER_SOL);
  if (!Number.isFinite(minLamports) || minLamports <= 0) return;

  const maxTopUpLamports = Math.round(ER_ESCROW_TOPUP_MAX_SOL * LAMPORTS_PER_SOL);
  if (!Number.isFinite(maxTopUpLamports) || maxTopUpLamports <= 0) return;

  try {
    const escrowPda = escrowPdaFromEscrowAuthority(admin.publicKey);
    const currentLamports = await connection.getBalance(escrowPda, "confirmed");
    if (currentLamports >= minLamports) {
      return;
    }

    const neededLamports = minLamports - currentLamports;
    const topUpLamports = Math.min(neededLamports, maxTopUpLamports);
    if (topUpLamports <= 0) return;

    const ix = createTopUpEscrowInstruction(
      escrowPda,
      admin.publicKey,
      admin.publicKey,
      topUpLamports,
    );
    const tx = new Transaction().add(ix);
    tx.feePayer = admin.publicKey;
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("processed");
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    tx.sign(admin);

    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: "processed",
      maxRetries: 3,
    });
    await connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "confirmed",
    );

    console.log(
      `[ER-DELEGATE] Escrow topped up by ${(topUpLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL (${sig})`,
    );
  } catch (error) {
    console.warn("[ER-DELEGATE] Escrow top-up failed (continuing without blocking):", error);
  }
}

/**
 * Delegate a rumble's combat state PDA to a MagicBlock Ephemeral Rollup.
 * This transfers ownership to the delegation program so the ER can process
 * combat transactions at sub-50ms latency with zero fees.
 *
 * Must be called on L1 (devnet) BEFORE sending combat txs to the ER endpoint.
 */
export async function delegateCombatToEr(
  rumbleId: number,
): Promise<string | null> {
  const provider = getAdminProvider();
  if (!provider) {
    console.warn("[solana-programs] No admin keypair, skipping delegateCombatToEr");
    return null;
  }
  const program = getRumbleEngineProgram(provider);
  const admin = getAdminKeypair()!;
  const [rumbleConfigPda] = deriveRumbleConfigPda();
  const [combatStatePda] = deriveCombatStatePda(rumbleId, program.programId);
  const [bufferPda] = deriveDelegationBufferPda(combatStatePda, program.programId);
  const [delegationRecordPda] = deriveDelegationRecordPda(combatStatePda);
  const [delegationMetadataPda] = deriveDelegationMetadataPda(combatStatePda);

  console.log(`[ER-DELEGATE] Sending delegateCombat for rumble ${rumbleId}...`);
  const method = (program.methods as any)
    .delegateCombat(new anchor.BN(rumbleId))
    .accounts({
      authority: admin.publicKey,
      config: rumbleConfigPda,
      bufferPda,
      delegationRecordPda,
      delegationMetadataPda,
      pda: combatStatePda,
      ownerProgram: program.programId,
      delegationProgram: DELEGATION_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    });

  // Delegate on L1 (devnet), NOT on ER.
  // MUST wait for confirmation before returning — fire-and-forget caused a race
  // condition where the orchestrator set erDelegated=true before the tx landed.
  const conn = getConnection();
  const { signature } = await sendAdminTxWithConfirmation(method, admin, conn);
  console.log(`[ER-DELEGATE] delegateCombat confirmed for rumble ${rumbleId}: ${signature}`);
  await ensureErEscrowFunding(admin, conn);
  // Allow ER validator time to sync the newly-delegated account
  await new Promise(r => setTimeout(r, 3000));
  return signature;
}

/**
 * Commit combat state from ER back to L1 (periodic sync for spectators).
 * Called during combat to keep L1 state updated for frontend reads.
 */
export async function commitCombatFromEr(
  rumbleId: number,
): Promise<string | null> {
  const provider = getAdminProvider(getErConnection());
  if (!provider) {
    console.warn("[solana-programs] No admin keypair, skipping commitCombatFromEr");
    return null;
  }
  const program = getRumbleEngineProgram(provider);
  const admin = getAdminKeypair()!;
  const [combatStatePda] = deriveCombatStatePda(rumbleId);
  const [rumbleConfigPda] = deriveRumbleConfigPda();

  console.log(`[ER-COMMIT] Sending commitCombat for rumble ${rumbleId}...`);
  const method = (program.methods as any)
    .commitCombat()
    .accounts({
      authority: admin.publicKey,
      config: rumbleConfigPda,
      combatState: combatStatePda,
      magicProgram: MAGIC_PROGRAM_ID,
      magicContext: MAGIC_CONTEXT_ID,
    });

  // Commit is called on the ER
  const sig = await sendAdminTxFireAndForget(method, admin, getErConnection());
  console.log(`[ER-COMMIT] commitCombat confirmed for rumble ${rumbleId}: ${sig}`);
  return sig;
}

/**
 * Undelegate combat state from ER back to L1.
 * Commits final state and returns ownership to the rumble_engine program on L1.
 * Called after combat ends (finalize).
 *
 * Uses MagicBlock's GetCommitmentSignature to properly await the L1 commit
 * instead of blindly polling the account owner.
 */
export async function undelegateCombatFromEr(
  rumbleId: number,
  connection?: Connection,
): Promise<string | null> {
  const routing = connection
    ? { txConnection: connection, logConnection: connection, validatorEndpoint: null as string | null }
    : await resolveErRoutingConnections();
  const txConn = routing.txConnection;
  const logConn = routing.logConnection;
  const provider = getAdminProvider(txConn);
  if (!provider) {
    console.warn("[solana-programs] No admin keypair, skipping undelegateCombatFromEr");
    return null;
  }
  const program = getRumbleEngineProgram(provider);
  const admin = getAdminKeypair()!;
  const [combatStatePda] = deriveCombatStatePda(rumbleId);
  const [rumbleConfigPda] = deriveRumbleConfigPda();

  console.log(`[ER-UNDELEGATE] Sending undelegateCombat for rumble ${rumbleId}...`);
  const method = (program.methods as any)
    .undelegateCombat()
    .accounts({
      authority: admin.publicKey,
      config: rumbleConfigPda,
      combatState: combatStatePda,
      magicProgram: MAGIC_PROGRAM_ID,
      magicContext: MAGIC_CONTEXT_ID,
    });

  // Send undelegateCombat to ER and wait for the scheduling tx confirmation.
  // This significantly improves reliability for immediate log parsing.
  let sig: string | null = null;
  try {
    const sent = await sendAdminTxWithConfirmation(method, admin, txConn);
    sig = sent.signature;
    console.log(`[ER-UNDELEGATE] undelegateCombat confirmed on ER for rumble ${rumbleId}: ${sig}`);
  } catch (confirmErr) {
    console.warn(
      `[ER-UNDELEGATE] Confirmation failed for rumble ${rumbleId}, falling back to fire-and-forget:`,
      confirmErr,
    );
    sig = await sendAdminTxFireAndForget(method, admin, txConn);
    console.log(`[ER-UNDELEGATE] undelegateCombat sent on ER for rumble ${rumbleId}: ${sig}`);
  }

  // Use GetCommitmentSignature to await the actual L1 commit.
  // The ER tx logs contain "ScheduledCommitSent signature: <L1_SIG>" which
  // this SDK function parses and waits for.  This is how other ER projects
  // (timebent-arena, craft) properly confirm undelegation instead of polling.
  if (sig) {
    try {
      if (routing.validatorEndpoint) {
        console.log(
          `[ER-UNDELEGATE] Using closest validator ${routing.validatorEndpoint} for commitment log parsing`,
        );
      }
      const maxAttempts = 15;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const l1Sig = await GetCommitmentSignature(sig, logConn);
          console.log(`[ER-UNDELEGATE] L1 commitment confirmed for rumble ${rumbleId}: ${l1Sig}`);
          return l1Sig;
        } catch (err) {
          const isLast = attempt >= maxAttempts;
          if (isLast) {
            console.warn(
              `[ER-UNDELEGATE] GetCommitmentSignature failed for rumble ${rumbleId} after ${attempt} attempts (will fall back to polling):`,
              err,
            );
            break;
          }
          const delayMs = Math.min(5_000, 500 * attempt);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    } catch (commitErr) {
      console.warn(`[ER-UNDELEGATE] GetCommitmentSignature failed for rumble ${rumbleId}:`, commitErr);
    }
  }

  return sig;
}

// ---------------------------------------------------------------------------
// MagicBlock VRF — Matchup Seed & Ichor Shower
// ---------------------------------------------------------------------------

/**
 * Request a VRF-derived matchup seed for fair fighter pairing.
 * Called after combat starts. The VRF oracle callback stores the randomness
 * in the on-chain RumbleCombatState.vrf_seed for turn-based pairing.
 *
 * Returns tx signature on success, null if admin keypair unavailable.
 */
export async function requestMatchupSeed(
  rumbleId: number,
  connection?: Connection,
): Promise<string | null> {
  const provider = getAdminProvider(connection);
  if (!provider) {
    console.warn("[solana-programs] No admin keypair, skipping requestMatchupSeed");
    return null;
  }
  const program = getRumbleEngineProgram(provider);
  const admin = getAdminKeypair()!;
  const conn = connection ?? getConnection();


  const [rumbleConfigPda] = deriveRumbleConfigPda();
  const [combatStatePda] = deriveCombatStatePda(rumbleId);
  const clientSeed = randomBytes(1)[0];
  const programIdentity = deriveVrfProgramIdentityPda(RUMBLE_ENGINE_ID);

  const method = (program.methods as any)
    .requestMatchupSeed(new anchor.BN(rumbleId), clientSeed)
    .accounts({
      payer: admin.publicKey,
      config: rumbleConfigPda,
      combatState: combatStatePda,
      oracleQueue: VRF_DEFAULT_QUEUE,
      programIdentity,
      vrfProgram: VRF_PROGRAM_ID,
      slotHashes: SLOT_HASHES_SYSVAR_ID,
      systemProgram: SystemProgram.programId,
    });

  return await sendAdminTxFireAndForget(method, admin, conn);
}

/**
 * Request a VRF-derived Ichor Shower roll via MagicBlock VRF.
 * Replaces the slot-hash-based checkIchorShower with provably-fair randomness.
 * The VRF oracle callback determines shower trigger and handles token transfers.
 *
 * Returns tx signature on success, null if admin keypair unavailable.
 */
export async function requestIchorShowerVrf(
  recipientTokenAccount: PublicKey,
  showerVault: PublicKey,
  connection?: Connection,
): Promise<string | null> {
  const provider = getAdminProvider(connection);
  if (!provider) {
    console.warn("[solana-programs] No admin keypair, skipping requestIchorShowerVrf");
    return null;
  }
  const program = getIchorTokenProgram(provider);
  const admin = getAdminKeypair()!;
  const conn = connection ?? getConnection();


  const [arenaConfigPda] = deriveArenaConfigPda();
  const [showerRequestPda] = deriveShowerRequestPda();
  const ichorMint = getIchorMint();
  const clientSeed = randomBytes(1)[0];
  const programIdentity = deriveVrfProgramIdentityPda(ICHOR_TOKEN_ID);

  const method = (program.methods as any)
    .requestIchorShowerVrf(clientSeed)
    .accounts({
      payer: admin.publicKey,
      arenaConfig: arenaConfigPda,
      showerRequest: showerRequestPda,
      ichorMint,
      recipientTokenAccount,
      showerVault,
      oracleQueue: VRF_DEFAULT_QUEUE,
      tokenProgram: TOKEN_PROGRAM_ID,
      programIdentity,
      vrfProgram: VRF_PROGRAM_ID,
      slotHashes: SLOT_HASHES_SYSVAR_ID,
      systemProgram: SystemProgram.programId,
    });

  return await sendAdminTxFireAndForget(method, admin, conn);
}
