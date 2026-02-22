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
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  Transaction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { getConnection } from "./solana-connection";
import { createHash, randomBytes } from "node:crypto";
import { keccak_256 } from "@noble/hashes/sha3";

// IDLs (imported as JSON)
import fighterRegistryIdl from "./idl/fighter_registry.json";
import ichorTokenIdl from "./idl/ichor_token.json";
import rumbleEngineIdl from "./idl/rumble_engine.json";

// ---------------------------------------------------------------------------
// Program IDs
// ---------------------------------------------------------------------------

export const FIGHTER_REGISTRY_ID = new PublicKey(
  "2hA6Jvj1yjP2Uj3qrJcsBeYA2R9xPM95mDKw1ncKVExa"
);
export const ICHOR_TOKEN_ID = new PublicKey(
  "925GAeqjKMX4B5MDANB91SZCvrx8HpEgmPJwHJzxKJx1"
);
export const RUMBLE_ENGINE_ID = new PublicKey(
  "2TvW4EfbmMe566ZQWZWd8kX34iFR2DM3oBUpjwpRJcqC"
);

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
const SLOT_HASHES_SYSVAR_ID = new PublicKey(
  "SysvarS1otHashes111111111111111111111111111"
);

// ---------------------------------------------------------------------------
// Time-based read cache — reduces RPC calls for hot on-chain reads
// ---------------------------------------------------------------------------

const _readCache = new Map<string, { data: unknown; expiresAt: number }>();

function cachedRead<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = _readCache.get(key);
  if (hit && hit.expiresAt > now) return Promise.resolve(hit.data as T);
  return fn().then(r => {
    _readCache.set(key, { data: r, expiresAt: now + ttlMs });
    if (_readCache.size > 200) {
      for (const [k, v] of _readCache) { if (v.expiresAt <= now) _readCache.delete(k); }
    }
    return r;
  });
}

export function invalidateReadCache(prefix?: string) {
  if (!prefix) { _readCache.clear(); return; }
  for (const k of _readCache.keys()) { if (k.startsWith(prefix)) _readCache.delete(k); }
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

export function deriveCombatStatePda(rumbleId: bigint | number): [PublicKey, number] {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(rumbleId));
  return PublicKey.findProgramAddressSync(
    [COMBAT_STATE_SEED, buf],
    RUMBLE_ENGINE_ID,
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
  placements: number[];
  winnerIndex: number | null;
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

/**
 * Read a rumble account's current state directly from chain.
 */
export async function readRumbleAccountState(
  rumbleId: bigint | number,
  connection?: Connection,
): Promise<RumbleAccountState | null> {
  const key = `rumble:${rumbleId}`;
  return cachedRead(key, 3000, async () => {
    const conn = connection ?? getConnection();
    const [rumblePda] = deriveRumblePda(rumbleId);
    // Use processed commitment to minimize stale reads around betting close.
    const info = await conn.getAccountInfo(rumblePda, "processed");
    if (!info || info.data.length < 17) return null;

    const data = info.data;
    const parsedRumbleId = readU64LE(data, 8);
    const rawState = data[16] ?? 0;
    const state = ONCHAIN_RUMBLE_STATES[rawState];
    if (!state) return null;

    const fightersOffset = 8 + 8 + 1;
    const fighterCountOffset = fightersOffset + 32 * 16;
    const fighterCount = data[fighterCountOffset] ?? 0;
    const bettingPoolsOffset = fighterCountOffset + 1;
    const totalDeployedOffset = bettingPoolsOffset + 8 * 16;
    const adminFeeCollectedOffset = totalDeployedOffset + 8;
    const sponsorshipPaidOffset = adminFeeCollectedOffset + 8;
    const placementsOffset = sponsorshipPaidOffset + 8;
    const winnerIndexOffset = placementsOffset + 16;
    const bettingDeadlineOffset = winnerIndexOffset + 1;
    const combatStartedAtOffset = bettingDeadlineOffset + 8;
    const completedAtOffset = combatStartedAtOffset + 8;

    const winnerIndexRaw = data.length > winnerIndexOffset ? data[winnerIndexOffset] : undefined;
    const winnerIndex =
      typeof winnerIndexRaw === "number" && winnerIndexRaw < 16 ? winnerIndexRaw : null;
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
      placements,
      winnerIndex,
      bettingCloseSlot,
      bettingDeadlineTs: bettingDeadlineRaw,
      combatStartedAtTs,
      completedAtTs,
    };
  });
}

/**
 * Read the combat state PDA for a rumble directly from chain.
 */
export async function readRumbleCombatState(
  rumbleId: bigint | number,
  connection?: Connection,
): Promise<RumbleCombatAccountState | null> {
  const key = `combat:${rumbleId}`;
  return cachedRead(key, 2000, async () => {
    const conn = connection ?? getConnection();
    const [combatStatePda] = deriveCombatStatePda(rumbleId);
    const info = await conn.getAccountInfo(combatStatePda, "processed");
    if (!info || info.data.length < 8 + 8 + 1 + 4 + 8 + 8 + 8 + 1 + 1 + 1) return null;

    const data = info.data;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let offset = 8; // discriminator

    const parsedRumbleId = view.getBigUint64(offset, true);
    offset += 8;
    const fighterCount = data[offset] ?? 0;
    offset += 1;
    const currentTurn = view.getUint32(offset, true);
    offset += 4;
    const turnOpenSlot = view.getBigUint64(offset, true);
    offset += 8;
    const commitCloseSlot = view.getBigUint64(offset, true);
    offset += 8;
    const revealCloseSlot = view.getBigUint64(offset, true);
    offset += 8;
    const turnResolved = data[offset] === 1;
    offset += 1;
    const remainingFighters = data[offset] ?? 0;
    offset += 1;
    const winnerIndexRaw = data[offset] ?? 255;
    offset += 1;

    const hp: number[] = [];
    for (let i = 0; i < 16; i++) {
      hp.push(view.getUint16(offset, true));
      offset += 2;
    }

    const meter: number[] = [];
    for (let i = 0; i < 16; i++) {
      meter.push(data[offset] ?? 0);
      offset += 1;
    }

    const eliminationRank: number[] = [];
    for (let i = 0; i < 16; i++) {
      eliminationRank.push(data[offset] ?? 0);
      offset += 1;
    }

    const totalDamageDealt: bigint[] = [];
    for (let i = 0; i < 16; i++) {
      totalDamageDealt.push(view.getBigUint64(offset, true));
      offset += 8;
    }

    const totalDamageTaken: bigint[] = [];
    for (let i = 0; i < 16; i++) {
      totalDamageTaken.push(view.getBigUint64(offset, true));
      offset += 8;
    }

    const bump = data[offset] ?? 0;
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
  provider: anchor.AnchorProvider
): anchor.Program {
  const idl = {
    ...(rumbleEngineIdl as any),
    address: RUMBLE_ENGINE_ID.toBase58(),
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
      return await sendAdminTxFireAndForget(method, admin, provider.connection);
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
  connection?: Connection
): Promise<Transaction> {
  const provider = getProvider(connection);
  const program = getRumbleEngineProgram(provider);

  const conn = connection ?? getConnection();
  const {
    rumbleConfigPda,
    rumblePda,
    vaultPda,
    treasury,
    fighterPubkeys,
  } = await loadRumbleBetContext(rumbleId, conn);
  const fighterPubkey = fighterPubkeys[fighterIndex];
  if (!fighterPubkey) {
    throw new Error(`Invalid fighter index ${fighterIndex} for rumble ${rumbleId}`);
  }
  const [sponsorshipPda] = deriveSponsorshipPda(fighterPubkey);
  const [bettorAccountPda] = deriveBettorPda(rumbleId, bettor);

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
): Promise<Transaction> {
  if (!Array.isArray(bets) || bets.length === 0) {
    throw new Error("At least one bet is required for batch place_bet");
  }

  const provider = getProvider(connection);
  const program = getRumbleEngineProgram(provider);
  const conn = connection ?? getConnection();

  const {
    rumbleConfigPda,
    rumblePda,
    vaultPda,
    treasury,
    fighterPubkeys,
  } = await loadRumbleBetContext(rumbleId, conn);
  const [bettorAccountPda] = deriveBettorPda(rumbleId, bettor);

  const tx = new Transaction();

  for (const leg of bets) {
    if (!Number.isInteger(leg.fighterIndex) || leg.fighterIndex < 0) {
      throw new Error(`Invalid fighterIndex in batch leg: ${String(leg.fighterIndex)}`);
    }
    if (!Number.isFinite(leg.lamports) || leg.lamports <= 0) {
      throw new Error(`Invalid lamports in batch leg for fighter ${leg.fighterIndex}`);
    }

    const fighterPubkey = fighterPubkeys[leg.fighterIndex];
    if (!fighterPubkey) {
      throw new Error(`Fighter index ${leg.fighterIndex} not found in rumble ${rumbleId}`);
    }
    const [sponsorshipPda] = deriveSponsorshipPda(fighterPubkey);

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
): Promise<{
  rumbleConfigPda: PublicKey;
  rumblePda: PublicKey;
  vaultPda: PublicKey;
  treasury: PublicKey;
  fighterPubkeys: PublicKey[];
}> {
  const [rumbleConfigPda] = deriveRumbleConfigPda();
  const [rumblePda] = deriveRumblePda(rumbleId);
  const [vaultPda] = deriveVaultPda(rumbleId);

  const [rumbleInfo, configInfo] = await Promise.all([
    conn.getAccountInfo(rumblePda),
    conn.getAccountInfo(rumbleConfigPda),
  ]);
  if (!rumbleInfo) throw new Error(`Rumble account not found: ${rumblePda}`);
  if (!configInfo) throw new Error("Rumble config not found");

  // Rumble layout: discriminator(8) + id(8) + state(1) + fighters(32*16=512)
  const fighterOffsetBase = 8 + 8 + 1;
  const fighterPubkeys: PublicKey[] = [];
  for (let i = 0; i < 16; i++) {
    const start = fighterOffsetBase + i * 32;
    fighterPubkeys.push(new PublicKey(rumbleInfo.data.subarray(start, start + 32)));
  }

  // RumbleConfig: discriminator(8) + admin(32) + treasury(32)
  const treasury = new PublicKey(configInfo.data.subarray(8 + 32, 8 + 32 + 32));

  return {
    rumbleConfigPda,
    rumblePda,
    vaultPda,
    treasury,
    fighterPubkeys,
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

  const method = (program.methods as any)
    .startCombat()
    .accounts({
      admin: admin.publicKey,
      config: rumbleConfigPda,
      rumble: rumblePda,
      combatState: combatStatePda,
      systemProgram: SystemProgram.programId,
    });

  return await sendAdminTxFireAndForget(method, admin, connection ?? getConnection());
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
  const tx: Transaction = await method.transaction();
  tx.feePayer = admin.publicKey;
  const { blockhash } = await conn.getLatestBlockhash("processed");
  tx.recentBlockhash = blockhash;
  tx.instructions.unshift(getComputeUnitPriceIx());
  tx.sign(admin);
  const signature = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: "processed",
    maxRetries: 3,
  });
  return signature;
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

  const method = (program.methods as any)
    .openTurn()
    .accounts({
      keeper: admin.publicKey,
      rumble: rumblePda,
      combatState: combatStatePda,
    });

  return await sendAdminTxFireAndForget(method, admin, connection ?? getConnection());
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

  return await sendAdminTxFireAndForget(method, admin, connection ?? getConnection());
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

  const method = (program.methods as any)
    .advanceTurn()
    .accounts({
      keeper: admin.publicKey,
      rumble: rumblePda,
      combatState: combatStatePda,
    });

  return await sendAdminTxFireAndForget(method, admin, connection ?? getConnection());
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

  return await sendAdminTxFireAndForget(method, admin, connection ?? getConnection());
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

  return await sendAdminTxFireAndForget(method, admin, connection ?? getConnection());
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

  const method = (program.methods as any)
    .reportResult(Buffer.from(placements), winnerIndex)
    .accounts({
      admin: admin.publicKey,
      config: rumbleConfigPda,
      rumble: rumblePda,
    });

  return await sendAdminTxFireAndForget(method, admin, connection ?? getConnection());
}

/**
 * Build a claim_payout transaction for the bettor to sign.
 */
export async function buildClaimPayoutTx(
  bettor: PublicKey,
  rumbleId: number,
  connection?: Connection
): Promise<Transaction> {
  const provider = getProvider(connection);
  const program = getRumbleEngineProgram(provider);

  const [rumblePda] = deriveRumblePda(rumbleId);
  const [vaultPda] = deriveVaultPda(rumbleId);
  const [bettorAccountPda] = deriveBettorPda(rumbleId, bettor);

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
  const program = getRumbleEngineProgram(provider);
  const conn = connection ?? getConnection();
  const tx = new Transaction();

  // Batch claim instructions can exceed the default compute cap.
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 900_000 }));

  for (const rumbleId of uniqueRumbleIds) {
    const [rumblePda] = deriveRumblePda(rumbleId);
    const [vaultPda] = deriveVaultPda(rumbleId);
    const [bettorAccountPda] = deriveBettorPda(rumbleId, bettor);

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

  const method = (program.methods as any)
    .completeRumble()
    .accounts({
      admin: admin.publicKey,
      config: rumbleConfigPda,
      rumble: rumblePda,
    });

  return await sendAdminTxFireAndForget(method, admin, connection ?? getConnection());
}

/**
 * Read fighter public keys from an on-chain Rumble account.
 * Returns an array of PublicKeys for the registered fighters.
 */
export async function readRumbleFighters(
  rumbleId: bigint | number,
  connection?: Connection,
): Promise<PublicKey[]> {
  const conn = connection ?? getConnection();
  const [rumblePda] = deriveRumblePda(rumbleId);
  const info = await conn.getAccountInfo(rumblePda, "processed");
  if (!info || info.data.length < 17) return [];

  const data = info.data;
  // Layout: 8 (discriminator) + 8 (id) + 1 (state) + [32 * 16] (fighters) + 1 (fighter_count)
  const fightersOffset = 8 + 8 + 1; // = 17
  const fighterCountOffset = fightersOffset + 32 * 16; // = 529
  const fighterCount = data[fighterCountOffset] ?? 0;

  const fighters: PublicKey[] = [];
  for (let i = 0; i < fighterCount; i++) {
    const start = fightersOffset + i * 32;
    const pubkeyBytes = data.slice(start, start + 32);
    const pk = new PublicKey(pubkeyBytes);
    // Skip zero/default pubkeys
    if (!pk.equals(PublicKey.default)) {
      fighters.push(pk);
    }
  }
  return fighters;
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

  return await sendAdminTxFireAndForget(method, admin, connection ?? getConnection());
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

  return await sendAdminTxFireAndForget(method, admin, connection ?? getConnection());
}
