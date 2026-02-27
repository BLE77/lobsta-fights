/**
 * Initialize RumbleConfig on MAINNET (betting-only).
 * One-time script — creates the config PDA that stores admin + treasury.
 *
 * Usage: npx tsx scripts/initialize-mainnet.ts
 */
import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const MAINNET_URL = "https://mainnet.helius-rpc.com/?api-key=f531d309-f3ed-4e05-b15b-a192810be1ca";
const DEPLOYER_KEYPAIR_PATH = path.join(
  process.env.HOME || "~",
  ".config/solana/mainnet-admin.json"
);

// Mainnet program ID (same as devnet since same keypair was used)
const RUMBLE_ENGINE_ID = new PublicKey(
  "2TvW4EfbmMe566ZQWZWd8kX34iFR2DM3oBUpjwpRJcqC"
);

// PDA seed (must match Rust constant)
const CONFIG_SEED = Buffer.from("rumble_config");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadKeypair(filePath: string): Keypair {
  const raw = fs.readFileSync(filePath, "utf-8");
  const secret = Uint8Array.from(JSON.parse(raw));
  return Keypair.fromSecretKey(secret);
}

function loadIdl(): any {
  const idlPath = path.join(__dirname, "..", "target", "idl", "rumble_engine.json");
  return JSON.parse(fs.readFileSync(idlPath, "utf-8"));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Load deployer wallet
  const deployer = loadKeypair(DEPLOYER_KEYPAIR_PATH);
  console.log("Deployer (mainnet admin):", deployer.publicKey.toBase58());

  // Connect to mainnet
  const connection = new Connection(MAINNET_URL, "confirmed");
  const balance = await connection.getBalance(deployer.publicKey);
  console.log("Balance:", (balance / 1e9).toFixed(4), "SOL");

  // Set up Anchor provider
  const wallet = new anchor.Wallet(deployer);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  anchor.setProvider(provider);

  // Derive RumbleConfig PDA
  const [rumbleConfigPda] = PublicKey.findProgramAddressSync(
    [CONFIG_SEED],
    RUMBLE_ENGINE_ID
  );
  console.log("\nRumble Config PDA:", rumbleConfigPda.toBase58());
  console.log("Program ID:", RUMBLE_ENGINE_ID.toBase58());

  // Load IDL and create program
  const rumbleEngineIdl = loadIdl();
  const rumbleEngine = new anchor.Program(rumbleEngineIdl, provider);

  // Initialize Rumble Engine on mainnet
  console.log("\n--- Initializing Rumble Engine on MAINNET ---");
  try {
    const acctInfo = await connection.getAccountInfo(rumbleConfigPda);
    if (acctInfo) {
      console.log("Rumble Engine already initialized on mainnet, skipping.");
      // Read existing config
      const data = acctInfo.data;
      const admin = new PublicKey(data.subarray(8, 8 + 32));
      const treasury = new PublicKey(data.subarray(8 + 32, 8 + 64));
      console.log("  Admin:", admin.toBase58());
      console.log("  Treasury:", treasury.toBase58());
    } else {
      // Treasury = deployer address (admin fees go here)
      const treasury = deployer.publicKey;
      console.log("Treasury:", treasury.toBase58());

      const tx = await (rumbleEngine.methods as any)
        .initialize()
        .accounts({
          admin: deployer.publicKey,
          config: rumbleConfigPda,
          treasury: treasury,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      console.log("Rumble Engine initialized on MAINNET! Tx:", tx);
      console.log("Explorer: https://solscan.io/tx/" + tx);
    }
  } catch (err: any) {
    if (err.message?.includes("already in use")) {
      console.log("Rumble Engine already initialized (account in use).");
    } else {
      console.error("Rumble Engine init failed:", err.message || err);
      console.error(err);
    }
  }

  // Summary
  console.log("\n========================================");
  console.log("  MAINNET INITIALIZATION SUMMARY");
  console.log("========================================");
  console.log("Network:            MAINNET-BETA");
  console.log("Program ID:         ", RUMBLE_ENGINE_ID.toBase58());
  console.log("Admin:              ", deployer.publicKey.toBase58());
  console.log("Treasury:           ", deployer.publicKey.toBase58());
  console.log("Rumble Config PDA:  ", rumbleConfigPda.toBase58());
  console.log("========================================");

  const finalBalance = await connection.getBalance(deployer.publicKey);
  console.log("Final balance:", (finalBalance / 1e9).toFixed(4), "SOL");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
