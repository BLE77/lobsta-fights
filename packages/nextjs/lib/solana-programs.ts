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
const SLOT_HASHES_SYSVAR_ID = new PublicKey(
  "SysvarS1otHashes111111111111111111111111111"
);

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
): Promise<void> {
  const tx = new Transaction().add(...instructions);
  tx.feePayer = admin.publicKey;
  const { blockhash, lastValidBlockHeight } =
    await provider.connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  await provider.sendAndConfirm(tx, []);
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

  const tx = await (program.methods as any)
    .distributeReward()
    .accounts({
      authority: admin.publicKey,
      arenaConfig: arenaConfigPda,
      distributionVault: distributionVaultPda,
      ichorMint,
      winnerTokenAccount,
      showerVault,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  return tx;
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

  const builder = (program.methods as any)
    .checkIchorShower()
    .accountsPartial(accounts);

  const tx = await builder.rpc();

  return tx;
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

  const tx = await (program.methods as any)
    .adminDistribute(new anchor.BN(amount.toString()))
    .accounts({
      authority: admin.publicKey,
      arenaConfig: arenaConfigPda,
      distributionVault: distributionVaultPda,
      recipientTokenAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  return tx;
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

  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return ata;
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
  ichorShowerPool: bigint;
  treasuryVault: bigint;
  bump: number;
  /** @deprecated Use totalDistributed */
  totalMinted: bigint;
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

  return {
    admin,
    ichorMint,
    distributionVault,
    totalDistributed,
    totalRumblesCompleted,
    baseReward,
    ichorShowerPool,
    treasuryVault,
    bump,
    totalMinted: totalDistributed, // backwards compat alias
  };
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
