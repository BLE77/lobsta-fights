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
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { getConnection } from "./solana-connection";

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
  "8CHYSuh1Y3F83PyK95E3F1Uya6pgPk4m3vM3MF3mP5hg"
);
export const RUMBLE_ENGINE_ID = new PublicKey(
  "2TvW4EfbmMe566ZQWZWd8kX34iFR2DM3oBUpjwpRJcqC"
);

// ---------------------------------------------------------------------------
// PDA Seeds
// ---------------------------------------------------------------------------

const ARENA_SEED = Buffer.from("arena_config");
const REGISTRY_SEED = Buffer.from("registry_config");
const CONFIG_SEED = Buffer.from("rumble_config");
const FIGHTER_SEED = Buffer.from("fighter");
const WALLET_STATE_SEED = Buffer.from("wallet_state");
const RUMBLE_SEED = Buffer.from("rumble");
const VAULT_SEED = Buffer.from("vault");
const BETTOR_SEED = Buffer.from("bettor");
const SPONSORSHIP_SEED = Buffer.from("sponsorship");

// ---------------------------------------------------------------------------
// PDA Derivation Helpers (exported for frontend use)
// ---------------------------------------------------------------------------

export function deriveArenaConfigPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([ARENA_SEED], ICHOR_TOKEN_ID);
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
  bettor: PublicKey,
  fighterIndex: number
): [PublicKey, number] {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(rumbleId));
  return PublicKey.findProgramAddressSync(
    [BETTOR_SEED, buf, bettor.toBuffer(), Buffer.from([fighterIndex])],
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

function getProvider(
  connection?: Connection,
  wallet?: anchor.Wallet
): anchor.AnchorProvider {
  const conn = connection ?? getConnection();
  const w = wallet ?? anchor.Wallet.local();
  return new anchor.AnchorProvider(conn, w, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
}

function getFighterRegistryProgram(
  provider: anchor.AnchorProvider
): anchor.Program {
  return new anchor.Program(fighterRegistryIdl as any, provider);
}

function getIchorTokenProgram(
  provider: anchor.AnchorProvider
): anchor.Program {
  return new anchor.Program(ichorTokenIdl as any, provider);
}

function getRumbleEngineProgram(
  provider: anchor.AnchorProvider
): anchor.Program {
  return new anchor.Program(rumbleEngineIdl as any, provider);
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

function getAdminProvider(connection?: Connection): anchor.AnchorProvider | null {
  const keypair = getAdminKeypair();
  if (!keypair) return null;
  const wallet = new anchor.Wallet(keypair);
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

/**
 * Mint rumble reward to the winner (admin/server-side).
 * Returns tx signature on success, null if admin keypair unavailable.
 */
export async function mintRumbleReward(
  winnerTokenAccount: PublicKey,
  showerVault: PublicKey,
  connection?: Connection
): Promise<string | null> {
  const provider = getAdminProvider(connection);
  if (!provider) {
    console.warn("[solana-programs] No admin keypair, skipping mintRumbleReward");
    return null;
  }
  const program = getIchorTokenProgram(provider);
  const admin = getAdminKeypair()!;

  const [arenaConfigPda] = deriveArenaConfigPda();
  const ichorMint = getIchorMint();

  const tx = await (program.methods as any)
    .mintRumbleReward()
    .accounts({
      authority: admin.publicKey,
      arenaConfig: arenaConfigPda,
      ichorMint,
      winnerTokenAccount,
      showerVault,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  return tx;
}

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
  const ichorMint = getIchorMint();
  const slotHashesSysvar = new PublicKey(
    "SysvarS1otHashes111111111111111111111111111"
  );

  const tx = await (program.methods as any)
    .checkIchorShower()
    .accounts({
      authority: admin.publicKey,
      arenaConfig: arenaConfigPda,
      ichorMint,
      recipientTokenAccount,
      showerVault,
      slotHashes: slotHashesSysvar,
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

  const tx = await (program.methods as any)
    .createRumble(
      new anchor.BN(rumbleId),
      fighters,
      new anchor.BN(bettingDeadlineUnix)
    )
    .accounts({
      admin: admin.publicKey,
      config: rumbleConfigPda,
      rumble: rumblePda,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

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

  const [rumbleConfigPda] = deriveRumbleConfigPda();
  const [rumblePda] = deriveRumblePda(rumbleId);
  const [vaultPda] = deriveVaultPda(rumbleId);
  const [bettorAccountPda] = deriveBettorPda(rumbleId, bettor, fighterIndex);

  // Read the rumble account to get the fighter pubkey for sponsorship PDA
  const conn = connection ?? getConnection();
  const rumbleInfo = await conn.getAccountInfo(rumblePda);
  if (!rumbleInfo) throw new Error(`Rumble account not found: ${rumblePda}`);

  // Rumble layout: discriminator(8) + id(8) + state(1) + fighters(32*16=512)
  // Fighter at index: offset = 8 + 8 + 1 + (fighterIndex * 32)
  const fighterOffset = 8 + 8 + 1 + fighterIndex * 32;
  const fighterPubkey = new PublicKey(
    rumbleInfo.data.subarray(fighterOffset, fighterOffset + 32)
  );

  const [sponsorshipPda] = deriveSponsorshipPda(fighterPubkey);

  // Read config to get treasury
  const configInfo = await conn.getAccountInfo(rumbleConfigPda);
  if (!configInfo) throw new Error("Rumble config not found");
  // RumbleConfig: discriminator(8) + admin(32) + treasury(32)
  const treasury = new PublicKey(configInfo.data.subarray(8 + 32, 8 + 32 + 32));

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

  const tx = await (program.methods as any)
    .startCombat()
    .accounts({
      admin: admin.publicKey,
      config: rumbleConfigPda,
      rumble: rumblePda,
    })
    .rpc();

  return tx;
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

  const tx = await (program.methods as any)
    .reportResult(Buffer.from(placements), winnerIndex)
    .accounts({
      admin: admin.publicKey,
      config: rumbleConfigPda,
      rumble: rumblePda,
    })
    .rpc();

  return tx;
}

/**
 * Build a claim_payout transaction for the bettor to sign.
 */
export async function buildClaimPayoutTx(
  bettor: PublicKey,
  rumbleId: number,
  fighterIndex: number,
  connection?: Connection
): Promise<Transaction> {
  const provider = getProvider(connection);
  const program = getRumbleEngineProgram(provider);

  const [rumblePda] = deriveRumblePda(rumbleId);
  const [vaultPda] = deriveVaultPda(rumbleId);
  const [bettorAccountPda] = deriveBettorPda(rumbleId, bettor, fighterIndex);

  const conn = connection ?? getConnection();

  const tx = await (program.methods as any)
    .claimPayout()
    .accounts({
      bettor,
      rumble: rumblePda,
      vault: vaultPda,
      bettorAccount: bettorAccountPda,
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

  const tx = await (program.methods as any)
    .completeRumble()
    .accounts({
      admin: admin.publicKey,
      config: rumbleConfigPda,
      rumble: rumblePda,
    })
    .rpc();

  return tx;
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

  const tx = await (program.methods as any)
    .sweepTreasury()
    .accounts({
      admin: admin.publicKey,
      config: rumbleConfigPda,
      rumble: rumblePda,
      vault: vaultPda,
      treasury,
    })
    .rpc();

  return tx;
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

  const tx = await (program.methods as any)
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
    })
    .rpc();

  return tx;
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
  totalMinted: bigint;
  totalRumblesCompleted: bigint;
  baseReward: bigint;
  ichorShowerPool: bigint;
  treasuryVault: bigint;
  bump: number;
} | null> {
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
  const totalMinted = d.readBigUInt64LE(offset);
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

  return {
    admin,
    ichorMint,
    totalMinted,
    totalRumblesCompleted,
    baseReward,
    ichorShowerPool,
    treasuryVault,
    bump,
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
