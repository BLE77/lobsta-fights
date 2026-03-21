/**
 * Sweep stuck mainnet vaults — finds completed rumbles with unclaimed SOL
 * and sweeps them to the treasury.
 *
 * Usage:
 *   cd packages/nextjs
 *   npx tsx --env-file=.env.local ../solana/scripts/sweep-mainnet-vaults.ts
 */

import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, SystemProgram, Transaction } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { createHash } from "node:crypto";
import * as fs from "node:fs";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const HELIUS_KEY = process.env.HELIUS_MAINNET_API_KEY?.trim() ?? process.env.NEXT_PUBLIC_HELIUS_API_KEY?.trim();
const RPC_URL = HELIUS_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`
  : process.env.NEXT_PUBLIC_BETTING_RPC_URL?.trim() ?? "https://api.mainnet-beta.solana.com";

const PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_RUMBLE_ENGINE_MAINNET ??
  process.env.RUMBLE_ENGINE_MAINNET_PROGRAM_ID ??
  "2TvW4EfbmMe566ZQWZWd8kX34iFR2DM3oBUpjwpRJcqC"
);

const SEND_TO_ADDRESS = process.argv[2]; // optional: forward swept SOL to this address

// Seeds (must match Rust constants)
const CONFIG_SEED = Buffer.from("rumble_config");
const RUMBLE_SEED = Buffer.from("rumble");
const VAULT_SEED = Buffer.from("vault");
const RUMBLE_DISCRIMINATOR = createHash("sha256").update("account:Rumble").digest().subarray(0, 8);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadAdminKeypair(): Keypair {
  // Try env var first (JSON array)
  const raw = process.env.SOLANA_MAINNET_DEPLOYER_KEYPAIR;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      return Keypair.fromSecretKey(Uint8Array.from(parsed));
    } catch {}
  }
  // Fallback to file
  const path = `${process.env.HOME}/.config/solana/mainnet-admin.json`;
  if (fs.existsSync(path)) {
    const data = JSON.parse(fs.readFileSync(path, "utf-8"));
    return Keypair.fromSecretKey(Uint8Array.from(data));
  }
  throw new Error("No admin keypair found (set SOLANA_MAINNET_DEPLOYER_KEYPAIR or create ~/.config/solana/mainnet-admin.json)");
}

function deriveConfigPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([CONFIG_SEED], PROGRAM_ID);
}

function deriveRumblePda(rumbleId: number): [PublicKey, number] {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(rumbleId));
  return PublicKey.findProgramAddressSync([RUMBLE_SEED, buf], PROGRAM_ID);
}

function deriveVaultPda(rumbleId: number): [PublicKey, number] {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(rumbleId));
  return PublicKey.findProgramAddressSync([VAULT_SEED, buf], PROGRAM_ID);
}

function readU64LE(data: Uint8Array, offset: number): bigint {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return view.getBigUint64(offset, true);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const connection = new Connection(RPC_URL, { commitment: "confirmed" });
  const admin = loadAdminKeypair();
  console.log(`Admin pubkey: ${admin.publicKey.toBase58()}`);
  console.log(`Program ID:   ${PROGRAM_ID.toBase58()}`);
  console.log(`RPC:          ${RPC_URL.replace(/api[_-]key=[^&]+/, "api-key=***")}`);
  if (SEND_TO_ADDRESS) console.log(`Forward to:   ${SEND_TO_ADDRESS}`);
  console.log();

  // 1. Find all Rumble accounts
  console.log("Scanning for Rumble accounts on mainnet...");
  const rumbleAccounts = await connection.getProgramAccounts(PROGRAM_ID, {
    filters: [
      { memcmp: { offset: 0, bytes: anchor.utils.bytes.bs58.encode(RUMBLE_DISCRIMINATOR) } },
    ],
  });

  console.log(`Found ${rumbleAccounts.length} rumble accounts\n`);

  const [configPda] = deriveConfigPda();
  const configInfo = await connection.getAccountInfo(configPda);
  if (!configInfo) throw new Error("RumbleConfig not found on mainnet");
  const treasury = new PublicKey(configInfo.data.subarray(8 + 32, 8 + 32 + 32));
  console.log(`Treasury:     ${treasury.toBase58()}\n`);

  // Load IDL for sweep
  const idlPath = `${process.cwd()}/lib/idl/rumble_engine.json`;
  let idlJson: any;
  try {
    idlJson = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  } catch {
    throw new Error(`IDL not found at ${idlPath} — run from packages/nextjs`);
  }

  const wallet = {
    publicKey: admin.publicKey,
    signTransaction: async (tx: Transaction) => { tx.partialSign(admin); return tx; },
    signAllTransactions: async (txs: Transaction[]) => { txs.forEach(tx => tx.partialSign(admin)); return txs; },
  };
  const provider = new anchor.AnchorProvider(connection, wallet as any, { commitment: "confirmed" });
  const idl = { ...idlJson, address: PROGRAM_ID.toBase58() };
  const program = new anchor.Program(idl, provider);

  let totalSwept = 0;
  let sweptCount = 0;

  for (const account of rumbleAccounts) {
    const data = account.account.data;
    if (data.length < 40) continue;

    const rumbleId = Number(readU64LE(data, 8));
    // Read state byte — find it after the fixed fields
    // state is at offset 8(disc) + 8(id) + 1(state) = 17
    const stateVal = data[16];
    const stateNames = ["betting", "combat", "payout", "complete"];
    const state = stateNames[stateVal] ?? `unknown(${stateVal})`;

    // Only sweep completed/payout rumbles
    if (state !== "payout" && state !== "complete") {
      continue;
    }

    const [vaultPda] = deriveVaultPda(rumbleId);
    const vaultBalance = await connection.getBalance(vaultPda);
    const vaultSol = vaultBalance / LAMPORTS_PER_SOL;

    if (vaultBalance <= 890_880) { // rent-exempt minimum
      continue;
    }

    const sweepableSol = (vaultBalance - 890_880) / LAMPORTS_PER_SOL;
    console.log(`Rumble ${rumbleId}: state=${state}, vault=${vaultSol.toFixed(6)} SOL (sweepable: ${sweepableSol.toFixed(6)} SOL)`);

    // Sweep it
    try {
      const [rumblePda] = deriveRumblePda(rumbleId);
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

      const tx = await method.transaction();
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.lastValidBlockHeight = lastValidBlockHeight;
      tx.feePayer = admin.publicKey;
      tx.sign(admin);
      const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
      console.log(`  -> Swept! tx: ${sig}`);
      totalSwept += sweepableSol;
      sweptCount++;
    } catch (err: any) {
      console.error(`  -> Sweep failed: ${err?.message ?? err}`);
    }
  }

  console.log(`\nSwept ${sweptCount} vaults, total: ${totalSwept.toFixed(6)} SOL -> treasury (${treasury.toBase58()})`);

  // Optionally forward to another address
  if (SEND_TO_ADDRESS && totalSwept > 0) {
    const dest = new PublicKey(SEND_TO_ADDRESS);
    const treasuryBalance = await connection.getBalance(treasury);
    // Leave 0.005 SOL for future tx fees
    const transferLamports = Math.max(0, treasuryBalance - 5_000_000);
    if (transferLamports > 0) {
      console.log(`\nForwarding ${(transferLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL from treasury to ${dest.toBase58()}...`);
      const transferTx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: treasury,
          toPubkey: dest,
          lamports: transferLamports,
        })
      );
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      transferTx.recentBlockhash = blockhash;
      transferTx.lastValidBlockHeight = lastValidBlockHeight;
      transferTx.feePayer = admin.publicKey;
      transferTx.sign(admin);
      const sig = await connection.sendRawTransaction(transferTx.serialize());
      console.log(`  -> Transfer tx: ${sig}`);
    }
  }

  console.log("\nDone!");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
