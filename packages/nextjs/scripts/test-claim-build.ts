import { Connection, PublicKey, SystemProgram } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { Keypair } from "@solana/web3.js";

const RUMBLE_ENGINE_ID = new PublicKey("2TvW4EfbmMe566ZQWZWd8kX34iFR2DM3oBUpjwpRJcqC");
const RUMBLE_SEED = Buffer.from("rumble");
const VAULT_SEED = Buffer.from("vault");
const BETTOR_SEED = Buffer.from("bettor");

const wallet = new PublicKey("4gfVi6MUPC2cG4gg4uarp9EAAqDeBtosvUVX1iGNT1Va");
const rumbleId = 177182383927810;

if (!process.env.HELIUS_API_KEY) {
  throw new Error("HELIUS_API_KEY environment variable is required");
}
const conn = new Connection(
  `https://devnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`,
  "confirmed"
);

function deriveRumblePda(id: number | bigint) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(id));
  return PublicKey.findProgramAddressSync([RUMBLE_SEED, buf], RUMBLE_ENGINE_ID);
}

function deriveVaultPda(id: number | bigint) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(id));
  return PublicKey.findProgramAddressSync([VAULT_SEED, buf], RUMBLE_ENGINE_ID);
}

function deriveBettorPda(id: number | bigint, bettor: PublicKey) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(id));
  return PublicKey.findProgramAddressSync([BETTOR_SEED, buf, bettor.toBuffer()], RUMBLE_ENGINE_ID);
}

async function main() {
  const [rumblePda] = deriveRumblePda(rumbleId);
  const [vaultPda] = deriveVaultPda(rumbleId);
  const [bettorPda] = deriveBettorPda(rumbleId, wallet);

  console.log("Rumble PDA:", rumblePda.toBase58());
  console.log("Vault PDA:", vaultPda.toBase58());
  console.log("Bettor PDA:", bettorPda.toBase58());

  // Load IDL
  const rumbleEngineIdl = require("../lib/idl/rumble_engine.json");
  const idl = { ...rumbleEngineIdl, address: RUMBLE_ENGINE_ID.toBase58() };

  // Create provider with dummy wallet
  const dummyWallet = new (class implements anchor.Wallet {
    publicKey = wallet;
    payer = Keypair.generate();
    async signTransaction(tx: any) { return tx; }
    async signAllTransactions(txs: any[]) { return txs; }
  })();

  const provider = new anchor.AnchorProvider(conn, dummyWallet, {
    commitment: "processed",
    preflightCommitment: "processed",
  });

  const program = new anchor.Program(idl, provider);

  // List available methods
  console.log("\nAvailable methods:", Object.keys(program.methods));

  // Try building with camelCase (current code)
  console.log("\n=== Test 1: camelCase accounts ===");
  try {
    const tx = await (program.methods as any)
      .claimPayout()
      .accounts({
        bettor: wallet,
        rumble: rumblePda,
        vault: vaultPda,
        bettorAccount: bettorPda,
        systemProgram: SystemProgram.programId,
      })
      .transaction();
    console.log("SUCCESS - camelCase works");
  } catch (e: any) {
    console.log("FAIL:", e.message);
  }

  // Try building with snake_case (IDL names)
  console.log("\n=== Test 2: snake_case accounts ===");
  try {
    const tx = await (program.methods as any)
      .claimPayout()
      .accounts({
        bettor: wallet,
        rumble: rumblePda,
        vault: vaultPda,
        bettor_account: bettorPda,
        system_program: SystemProgram.programId,
      })
      .transaction();
    console.log("SUCCESS - snake_case works");
  } catch (e: any) {
    console.log("FAIL:", e.message);
  }

  // Try with minimal accounts (let Anchor resolve PDAs)
  console.log("\n=== Test 3: minimal accounts (PDA auto-resolve) ===");
  try {
    const tx = await (program.methods as any)
      .claimPayout()
      .accounts({
        bettor: wallet,
        rumble: rumblePda,
      })
      .transaction();
    console.log("SUCCESS - minimal works");
  } catch (e: any) {
    console.log("FAIL:", e.message);
  }

  // Try simulation if any build succeeds
  console.log("\n=== Test 4: Build + simulate ===");
  try {
    const tx = await (program.methods as any)
      .claimPayout()
      .accounts({
        bettor: wallet,
        rumble: rumblePda,
        vault: vaultPda,
        bettorAccount: bettorPda,
        systemProgram: SystemProgram.programId,
      })
      .transaction();

    tx.feePayer = wallet;
    const { blockhash } = await conn.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;

    console.log("TX built, simulating...");
    const sim = await conn.simulateTransaction(tx, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: "processed",
    } as any);
    console.log("Sim result:", JSON.stringify(sim.value.err));
    console.log("Sim logs:", sim.value.logs?.slice(-5));
  } catch (e: any) {
    console.log("FAIL:", e.message);
    console.log("Stack:", e.stack?.split("\n").slice(0, 5).join("\n"));
  }
}

main().catch(console.error);
