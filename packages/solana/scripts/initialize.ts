/**
 * Initialize all three UCF Solana programs on devnet:
 *   1. fighter_registry::initialize
 *   2. ichor_token::initialize (creates ArenaConfig PDA + ICHOR mint)
 *   3. rumble_engine::initialize (creates RumbleConfig PDA)
 *
 * Usage: npx tsx scripts/initialize.ts
 */
import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const DEVNET_URL = "https://api.devnet.solana.com";
const DEPLOYER_KEYPAIR_PATH = path.join(
  process.env.HOME || "~",
  ".config/solana/id.json"
);

// Program IDs (from Anchor.toml / declare_id!)
const FIGHTER_REGISTRY_ID = new PublicKey(
  "2hA6Jvj1yjP2Uj3qrJcsBeYA2R9xPM95mDKw1ncKVExa"
);
const ICHOR_TOKEN_ID = new PublicKey(
  "8CHYSuh1Y3F83PyK95E3F1Uya6pgPk4m3vM3MF3mP5hg"
);
const RUMBLE_ENGINE_ID = new PublicKey(
  "2TvW4EfbmMe566ZQWZWd8kX34iFR2DM3oBUpjwpRJcqC"
);

// PDA seeds (matching the Rust constants)
const ARENA_SEED = Buffer.from("arena_config");
const REGISTRY_SEED = Buffer.from("registry_config");
const CONFIG_SEED = Buffer.from("rumble_config");

// Base reward: 1 ICHOR (1_000_000_000 lamports at 9 decimals)
const BASE_REWARD = new anchor.BN(1_000_000_000);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadKeypair(filePath: string): Keypair {
  const raw = fs.readFileSync(filePath, "utf-8");
  const secret = Uint8Array.from(JSON.parse(raw));
  return Keypair.fromSecretKey(secret);
}

function loadIdl(name: string): any {
  const idlPath = path.join(__dirname, "..", "target", "idl", `${name}.json`);
  return JSON.parse(fs.readFileSync(idlPath, "utf-8"));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Load deployer wallet
  const deployer = loadKeypair(DEPLOYER_KEYPAIR_PATH);
  console.log("Deployer:", deployer.publicKey.toBase58());

  // Connect to devnet
  const connection = new Connection(DEVNET_URL, "confirmed");
  const balance = await connection.getBalance(deployer.publicKey);
  console.log("Balance:", (balance / 1e9).toFixed(4), "SOL");

  // Set up Anchor provider
  const wallet = new anchor.Wallet(deployer);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  anchor.setProvider(provider);

  // ---------------------------------------------------------------------------
  // Derive PDAs
  // ---------------------------------------------------------------------------

  const [registryConfigPda] = PublicKey.findProgramAddressSync(
    [REGISTRY_SEED],
    FIGHTER_REGISTRY_ID
  );
  console.log("\nRegistry Config PDA:", registryConfigPda.toBase58());

  const [arenaConfigPda] = PublicKey.findProgramAddressSync(
    [ARENA_SEED],
    ICHOR_TOKEN_ID
  );
  console.log("Arena Config PDA:", arenaConfigPda.toBase58());

  const [rumbleConfigPda] = PublicKey.findProgramAddressSync(
    [CONFIG_SEED],
    RUMBLE_ENGINE_ID
  );
  console.log("Rumble Config PDA:", rumbleConfigPda.toBase58());

  // ---------------------------------------------------------------------------
  // Load IDLs and create programs
  // ---------------------------------------------------------------------------

  const fighterRegistryIdl = loadIdl("fighter_registry");
  const ichorTokenIdl = loadIdl("ichor_token");
  const rumbleEngineIdl = loadIdl("rumble_engine");

  const fighterRegistry = new anchor.Program(fighterRegistryIdl, provider);
  const ichorToken = new anchor.Program(ichorTokenIdl, provider);
  const rumbleEngine = new anchor.Program(rumbleEngineIdl, provider);

  // ---------------------------------------------------------------------------
  // 1. Initialize Fighter Registry
  // ---------------------------------------------------------------------------
  console.log("\n--- Initializing Fighter Registry ---");
  try {
    const acctInfo = await connection.getAccountInfo(registryConfigPda);
    if (acctInfo) {
      console.log("Fighter Registry already initialized, skipping.");
    } else {
      const tx = await (fighterRegistry.methods as any)
        .initialize()
        .accounts({
          admin: deployer.publicKey,
          registryConfig: registryConfigPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      console.log("Fighter Registry initialized. Tx:", tx);
    }
  } catch (err: any) {
    if (err.message?.includes("already in use")) {
      console.log("Fighter Registry already initialized (account in use).");
    } else {
      console.error("Fighter Registry init failed:", err.message || err);
    }
  }

  // ---------------------------------------------------------------------------
  // 2. Initialize ICHOR Token (ArenaConfig + Mint)
  // ---------------------------------------------------------------------------
  console.log("\n--- Initializing ICHOR Token ---");

  // Generate a new keypair for the ICHOR mint
  const ichorMintKeypair = Keypair.generate();
  console.log("ICHOR Mint (new keypair):", ichorMintKeypair.publicKey.toBase58());

  try {
    const acctInfo = await connection.getAccountInfo(arenaConfigPda);
    if (acctInfo) {
      console.log("ICHOR ArenaConfig already initialized, skipping.");
      // Read existing mint from account data
      // ArenaConfig layout: discriminator(8) + admin(32) + ichor_mint(32) ...
      const data = acctInfo.data;
      const existingMint = new PublicKey(data.subarray(8 + 32, 8 + 32 + 32));
      console.log("Existing ICHOR Mint:", existingMint.toBase58());
    } else {
      const tx = await (ichorToken.methods as any)
        .initialize(BASE_REWARD)
        .accounts({
          admin: deployer.publicKey,
          arenaConfig: arenaConfigPda,
          ichorMint: ichorMintKeypair.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .signers([ichorMintKeypair])
        .rpc();
      console.log("ICHOR Token initialized. Tx:", tx);
      console.log("ICHOR Mint Address:", ichorMintKeypair.publicKey.toBase58());
    }
  } catch (err: any) {
    if (err.message?.includes("already in use")) {
      console.log("ICHOR Token already initialized (account in use).");
    } else {
      console.error("ICHOR Token init failed:", err.message || err);
    }
  }

  // ---------------------------------------------------------------------------
  // 3. Initialize Rumble Engine
  // ---------------------------------------------------------------------------
  console.log("\n--- Initializing Rumble Engine ---");
  try {
    const acctInfo = await connection.getAccountInfo(rumbleConfigPda);
    if (acctInfo) {
      console.log("Rumble Engine already initialized, skipping.");
    } else {
      const tx = await (rumbleEngine.methods as any)
        .initialize()
        .accounts({
          admin: deployer.publicKey,
          config: rumbleConfigPda,
          treasury: deployer.publicKey, // treasury = deployer for now
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      console.log("Rumble Engine initialized. Tx:", tx);
    }
  } catch (err: any) {
    if (err.message?.includes("already in use")) {
      console.log("Rumble Engine already initialized (account in use).");
    } else {
      console.error("Rumble Engine init failed:", err.message || err);
    }
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  console.log("\n========================================");
  console.log("  INITIALIZATION SUMMARY");
  console.log("========================================");
  console.log("Deployer:           ", deployer.publicKey.toBase58());
  console.log("Fighter Registry ID:", FIGHTER_REGISTRY_ID.toBase58());
  console.log("  Registry Config:  ", registryConfigPda.toBase58());
  console.log("ICHOR Token ID:     ", ICHOR_TOKEN_ID.toBase58());
  console.log("  Arena Config PDA: ", arenaConfigPda.toBase58());
  console.log("  ICHOR Mint:       ", ichorMintKeypair.publicKey.toBase58());
  console.log("Rumble Engine ID:   ", RUMBLE_ENGINE_ID.toBase58());
  console.log("  Rumble Config PDA:", rumbleConfigPda.toBase58());
  console.log("  Treasury:         ", deployer.publicKey.toBase58());
  console.log("========================================");

  // Try to read actual mint from ArenaConfig if it was already initialized
  try {
    const arenaInfo = await connection.getAccountInfo(arenaConfigPda);
    if (arenaInfo) {
      const data = arenaInfo.data;
      const actualMint = new PublicKey(data.subarray(8 + 32, 8 + 32 + 32));
      console.log("\nActual ICHOR Mint (from ArenaConfig):", actualMint.toBase58());
    }
  } catch {}

  const finalBalance = await connection.getBalance(deployer.publicKey);
  console.log("Final balance:", (finalBalance / 1e9).toFixed(4), "SOL");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
