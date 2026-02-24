/**
 * Register existing UCF fighters on-chain via the Fighter Registry program.
 *
 * For each fighter:
 *   1. Generate a Solana keypair (the fighter's "owner" wallet)
 *   2. Fund it with 0.05 SOL from the deployer
 *   3. Call registerFighter on-chain
 *   4. Print the mapping: name → wallet pubkey → fighter PDA
 *
 * Run: npx ts-node --esm scripts/register-fighters.ts
 */

import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  sendAndConfirmTransaction,
  Transaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

if (!process.env.HELIUS_API_KEY) {
  throw new Error("HELIUS_API_KEY environment variable is required");
}
const RPC_URL = `https://devnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
const FIGHTER_REGISTRY_ID = new PublicKey("2hA6Jvj1yjP2Uj3qrJcsBeYA2R9xPM95mDKw1ncKVExa");

const FIGHTERS = [
  { name: "THECLAWBOSS", supabaseId: "56c6bbf8-47eb-4c66-95b8-dde361fb74ec" },
  { name: "IRON-TANK-9000", supabaseId: "3815f1dd-0e4d-4674-a99c-42fc3b323e77" },
  { name: "CHAOS-REAPER", supabaseId: "00c29d7f-82eb-4bc6-b8ab-7b3d761551fc" },
  { name: "ORACLE-UNIT-7", supabaseId: "70b66f68-6245-4b8b-b68d-673a26128440" },
  { name: "PHANTOM-STRIKER", supabaseId: "36dd7d85-3050-44f2-bf92-d4f9014c41a5" },
  { name: "7UPA-RING-LEADER", supabaseId: "66757591-4e48-48dc-aafc-6f89eddf9607" },
  { name: "7UPA-CLAW-MASTER", supabaseId: "8fdbdae0-92c9-466c-b3a5-6a912f95d795" },
  { name: "NEURAL-ANVIL-9000", supabaseId: "949c69a3-1bef-4125-a923-d1c94a1aadec" },
  { name: "SOCKS-PRIME", supabaseId: "c1831b3c-f63c-4db7-98f2-5a5d79398447" },
];

const FIGHTER_SEED = Buffer.from("fighter");
const WALLET_STATE_SEED = Buffer.from("wallet_state");
const REGISTRY_SEED = Buffer.from("registry_config");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deriveFighterPda(authority: PublicKey, index: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [FIGHTER_SEED, authority.toBuffer(), Buffer.from([index])],
    FIGHTER_REGISTRY_ID
  );
}

function deriveWalletStatePda(authority: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [WALLET_STATE_SEED, authority.toBuffer()],
    FIGHTER_REGISTRY_ID
  );
}

function deriveRegistryConfigPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([REGISTRY_SEED], FIGHTER_REGISTRY_ID);
}

function loadDeployerKeypair(): Keypair {
  const keypairPath = path.resolve(
    process.env.HOME || "~",
    ".config/solana/id.json"
  );
  const raw = fs.readFileSync(keypairPath, "utf8");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const deployer = loadDeployerKeypair();
  console.log(`Deployer: ${deployer.publicKey.toBase58()}`);

  const balance = await connection.getBalance(deployer.publicKey);
  console.log(`Balance: ${balance / LAMPORTS_PER_SOL} SOL\n`);

  // Load IDL
  const idlPath = path.resolve(__dirname, "../../nextjs/lib/idl/fighter_registry.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));

  const wallet = new anchor.Wallet(deployer);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  const program = new anchor.Program(idl, provider);

  const [registryConfigPda] = deriveRegistryConfigPda();
  const results: Array<{
    name: string;
    supabaseId: string;
    wallet: string;
    fighterPda: string;
    keypairSecret: number[];
  }> = [];

  for (const fighter of FIGHTERS) {
    console.log(`\n--- Registering ${fighter.name} ---`);

    // Generate keypair for this fighter
    const fighterKeypair = Keypair.generate();
    console.log(`  Wallet: ${fighterKeypair.publicKey.toBase58()}`);

    // Fund with 0.05 SOL
    const fundTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: deployer.publicKey,
        toPubkey: fighterKeypair.publicKey,
        lamports: 0.05 * LAMPORTS_PER_SOL,
      })
    );
    const fundSig = await sendAndConfirmTransaction(connection, fundTx, [deployer]);
    console.log(`  Funded: ${fundSig}`);

    // Derive PDAs
    const [walletStatePda] = deriveWalletStatePda(fighterKeypair.publicKey);
    const [fighterPda] = deriveFighterPda(fighterKeypair.publicKey, 0);
    console.log(`  Fighter PDA: ${fighterPda.toBase58()}`);

    // Encode name as [u8; 32]
    const nameBytes = new Uint8Array(32);
    const encoded = new TextEncoder().encode(fighter.name.slice(0, 32));
    nameBytes.set(encoded);

    // Register on-chain
    // First fighter per wallet (index 0) is free — pass null for optional ICHOR accounts
    try {
      const sig = await (program.methods as any)
        .registerFighter(Array.from(nameBytes))
        .accounts({
          authority: fighterKeypair.publicKey,
          walletState: walletStatePda,
          fighter: fighterPda,
          registryConfig: registryConfigPda,
          ichorTokenAccount: null,
          ichorMint: null,
          tokenProgram: null,
          systemProgram: SystemProgram.programId,
        })
        .signers([fighterKeypair])
        .rpc();
      console.log(`  Registered: ${sig}`);
    } catch (err: any) {
      console.error(`  ERROR: ${err.message}`);
      // Still save the keypair mapping even if registration fails
    }

    results.push({
      name: fighter.name,
      supabaseId: fighter.supabaseId,
      wallet: fighterKeypair.publicKey.toBase58(),
      fighterPda: fighterPda.toBase58(),
      keypairSecret: Array.from(fighterKeypair.secretKey),
    });
  }

  // Save mappings
  const outputPath = path.resolve(__dirname, "fighter-mappings.json");
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`\n\nSaved fighter mappings to ${outputPath}`);

  // Print SQL to update Supabase
  console.log("\n--- SQL to update Supabase wallet_address ---");
  for (const r of results) {
    console.log(
      `UPDATE ucf_fighters SET wallet_address = '${r.wallet}' WHERE id = '${r.supabaseId}';`
    );
  }
}

main().catch(console.error);
