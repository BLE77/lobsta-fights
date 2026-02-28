/**
 * Repair stuck mainnet rumbles.
 *
 * All mainnet rumbles are stuck in "betting" state because reportResultMainnet
 * was sending 16-element placements arrays when the on-chain program expected
 * fighter_count elements. This script reads devnet results and replays them
 * on mainnet with the correct array size.
 *
 * Usage: npx tsx scripts/repair-mainnet-rumbles.ts
 */

import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import * as fs from "fs";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PROGRAM_ID = new PublicKey("2TvW4EfbmMe566ZQWZWd8kX34iFR2DM3oBUpjwpRJcqC");

const MAINNET_RPC = `https://mainnet.helius-rpc.com/?api-key=3e5c5b12-216f-46b2-bbd6-2546d3eab793`;
const DEVNET_RPC = `https://devnet.helius-rpc.com/?api-key=f531d309-f3ed-4e05-b15b-a192810be1ca`;

const ADMIN_KEYPAIR_PATH = `${process.env.HOME}/.config/solana/mainnet-admin.json`;

const CONFIG_SEED = Buffer.from("rumble_config");
const RUMBLE_SEED = Buffer.from("rumble");
const VAULT_SEED = Buffer.from("vault");

// On-chain state indices
const STATE_BETTING = 0;
const STATE_COMBAT = 1;
const STATE_PAYOUT = 2;
const STATE_COMPLETE = 3;
const STATE_NAMES = ["betting", "combat", "payout", "complete"];

// Account layout offsets
const DISCRIMINATOR_SIZE = 8;
const RUMBLE_ID_OFFSET = 8;
const STATE_OFFSET = 16;
const FIGHTERS_OFFSET = 17;
const FIGHTER_COUNT_OFFSET = FIGHTERS_OFFSET + 32 * 16; // 529
const BETTING_POOLS_OFFSET = FIGHTER_COUNT_OFFSET + 1; // 530
const TOTAL_DEPLOYED_OFFSET = BETTING_POOLS_OFFSET + 8 * 16; // 658
const PLACEMENTS_OFFSET = TOTAL_DEPLOYED_OFFSET + 8 + 8 + 8; // skip total_deployed, admin_fee, sponsorship = 682
const WINNER_INDEX_OFFSET = PLACEMENTS_OFFSET + 16; // 698

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readU64LE(buf: Buffer, offset: number): bigint {
  return buf.readBigUInt64LE(offset);
}

function deriveRumblePda(rumbleId: number | bigint, programId: PublicKey = PROGRAM_ID): [PublicKey, number] {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(rumbleId));
  return PublicKey.findProgramAddressSync([RUMBLE_SEED, buf], programId);
}

function deriveVaultPda(rumbleId: number | bigint, programId: PublicKey = PROGRAM_ID): [PublicKey, number] {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(rumbleId));
  return PublicKey.findProgramAddressSync([VAULT_SEED, buf], programId);
}

function deriveConfigPda(programId: PublicKey = PROGRAM_ID): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([CONFIG_SEED], programId);
}

interface RumbleInfo {
  address: PublicKey;
  rumbleId: bigint;
  state: number;
  fighterCount: number;
  placements: number[];
  winnerIndex: number;
  totalDeployed: bigint;
  bettingPools: bigint[];
}

function parseRumbleAccount(address: PublicKey, data: Buffer): RumbleInfo | null {
  if (data.length < WINNER_INDEX_OFFSET + 1) return null;

  const rumbleId = readU64LE(data, RUMBLE_ID_OFFSET);
  const state = data[STATE_OFFSET];
  const fighterCount = data[FIGHTER_COUNT_OFFSET];

  const bettingPools: bigint[] = [];
  for (let i = 0; i < 16; i++) {
    bettingPools.push(readU64LE(data, BETTING_POOLS_OFFSET + i * 8));
  }

  const totalDeployed = readU64LE(data, TOTAL_DEPLOYED_OFFSET);

  const placements: number[] = [];
  for (let i = 0; i < 16; i++) {
    placements.push(data[PLACEMENTS_OFFSET + i]);
  }

  const winnerIndex = data[WINNER_INDEX_OFFSET];

  return {
    address,
    rumbleId,
    state,
    fighterCount,
    placements,
    winnerIndex,
    totalDeployed,
    bettingPools,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Load admin keypair
  if (!fs.existsSync(ADMIN_KEYPAIR_PATH)) {
    console.error(`Admin keypair not found at ${ADMIN_KEYPAIR_PATH}`);
    process.exit(1);
  }
  const adminSecret = JSON.parse(fs.readFileSync(ADMIN_KEYPAIR_PATH, "utf-8"));
  const admin = Keypair.fromSecretKey(Uint8Array.from(adminSecret));
  console.log(`Admin: ${admin.publicKey.toBase58()}`);

  const mainnetConn = new Connection(MAINNET_RPC, "confirmed");
  const devnetConn = new Connection(DEVNET_RPC, "confirmed");

  // Load IDL
  const idlPath = `${__dirname}/../lib/idl/rumble_engine.json`;
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));

  const wallet = new anchor.Wallet(admin);
  const mainnetProvider = new anchor.AnchorProvider(mainnetConn, wallet, {
    commitment: "confirmed",
  });
  const program = new anchor.Program(idl as any, mainnetProvider);

  const [configPda] = deriveConfigPda();
  console.log(`Config PDA: ${configPda.toBase58()}`);

  // 1. Fetch all rumble accounts on mainnet
  console.log("\n--- Scanning mainnet rumble accounts ---");
  // Rumble struct: 8 (disc) + 8 + 1 + 512 + 1 + 128 + 8 + 8 + 8 + 16 + 1 + 8 + 8 + 8 + 1 = 724
  const allAccounts = await mainnetConn.getProgramAccounts(PROGRAM_ID, {
    filters: [{ dataSize: 724 }],
  });
  console.log(`Found ${allAccounts.length} rumble accounts on mainnet`);

  // Parse and filter for stuck ones
  const stuckRumbles: RumbleInfo[] = [];
  const allRumbles: RumbleInfo[] = [];

  for (const { pubkey, account } of allAccounts) {
    const info = parseRumbleAccount(pubkey, account.data as Buffer);
    if (!info) continue;
    allRumbles.push(info);
    if (info.state === STATE_BETTING || info.state === STATE_COMBAT) {
      stuckRumbles.push(info);
    }
  }

  console.log(`Total parsed: ${allRumbles.length}`);
  console.log(`Stuck (betting/combat): ${stuckRumbles.length}`);

  // Show state distribution
  const stateCounts = [0, 0, 0, 0];
  for (const r of allRumbles) {
    if (r.state < 4) stateCounts[r.state]++;
  }
  console.log(`State distribution: ${STATE_NAMES.map((s, i) => `${s}=${stateCounts[i]}`).join(", ")}`);

  if (stuckRumbles.length === 0) {
    console.log("No stuck rumbles to repair!");
    return;
  }

  // 2. Check which stuck rumbles have actual bets (non-zero totalDeployed)
  const withBets = stuckRumbles.filter((r) => r.totalDeployed > 0n);
  const withoutBets = stuckRumbles.filter((r) => r.totalDeployed === 0n);
  console.log(`\nWith bets (need result + claim): ${withBets.length}`);
  console.log(`Without bets (just need cleanup): ${withoutBets.length}`);

  if (withBets.length > 0) {
    console.log("\nRumbles WITH bets:");
    for (const r of withBets) {
      const [vaultPda] = deriveVaultPda(r.rumbleId);
      const vaultBalance = await mainnetConn.getBalance(vaultPda);
      console.log(
        `  Rumble #${r.rumbleId}: fighters=${r.fighterCount}, deployed=${Number(r.totalDeployed) / 1e9} SOL, vault=${vaultBalance / 1e9} SOL`,
      );
    }
  }

  // 3. For stuck rumbles, read devnet state to get correct results
  console.log("\n--- Reading devnet results ---");
  let repairCount = 0;
  let skipCount = 0;
  let errorCount = 0;

  for (const stuck of stuckRumbles) {
    const rumbleId = Number(stuck.rumbleId);
    const [devnetPda] = deriveRumblePda(rumbleId);

    const devnetInfo = await devnetConn.getAccountInfo(devnetPda, "confirmed");
    if (!devnetInfo || devnetInfo.data.length < WINNER_INDEX_OFFSET + 1) {
      console.log(`  Rumble #${rumbleId}: no devnet account, skipping`);
      skipCount++;
      continue;
    }

    const devnetData = devnetInfo.data as Buffer;
    const devnetState = devnetData[STATE_OFFSET];

    if (devnetState !== STATE_PAYOUT && devnetState !== STATE_COMPLETE) {
      console.log(
        `  Rumble #${rumbleId}: devnet state=${STATE_NAMES[devnetState] ?? devnetState}, not ready, skipping`,
      );
      skipCount++;
      continue;
    }

    // Read devnet placements and winner
    const devFighterCount = devnetData[FIGHTER_COUNT_OFFSET];
    const devPlacements: number[] = [];
    for (let i = 0; i < devFighterCount; i++) {
      devPlacements.push(devnetData[PLACEMENTS_OFFSET + i]);
    }
    const devWinnerIndex = devnetData[WINNER_INDEX_OFFSET];

    // Validate
    if (devWinnerIndex >= devFighterCount) {
      console.log(`  Rumble #${rumbleId}: invalid winner_index ${devWinnerIndex} >= ${devFighterCount}, skipping`);
      skipCount++;
      continue;
    }
    if (devPlacements[devWinnerIndex] !== 1) {
      console.log(`  Rumble #${rumbleId}: winner placement != 1 (got ${devPlacements[devWinnerIndex]}), skipping`);
      skipCount++;
      continue;
    }

    // Verify mainnet fighter count matches
    if (stuck.fighterCount !== devFighterCount) {
      console.log(
        `  Rumble #${rumbleId}: fighter count mismatch mainnet=${stuck.fighterCount} devnet=${devFighterCount}, skipping`,
      );
      skipCount++;
      continue;
    }

    console.log(
      `  Rumble #${rumbleId}: fighters=${devFighterCount}, winner_idx=${devWinnerIndex}, placements=[${devPlacements.join(",")}]`,
    );

    // 4. Call admin_set_result on mainnet
    try {
      const [rumblePda] = deriveRumblePda(rumbleId);

      const method = (program.methods as any)
        .adminSetResult(Buffer.from(devPlacements), devWinnerIndex)
        .accounts({
          admin: admin.publicKey,
          config: configPda,
          rumble: rumblePda,
        });

      const tx: Transaction = await method.transaction();
      tx.feePayer = admin.publicKey;
      const { blockhash } = await mainnetConn.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.instructions.unshift(
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
      );
      tx.sign(admin);

      const sig = await mainnetConn.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        preflightCommitment: "confirmed",
        maxRetries: 3,
      });

      // Wait for confirmation
      await mainnetConn.confirmTransaction(sig, "confirmed");

      console.log(`  ✓ Rumble #${rumbleId} → payout (tx: ${sig})`);
      repairCount++;

      // Small delay to avoid rate limits
      await new Promise((r) => setTimeout(r, 500));
    } catch (err: any) {
      console.error(`  ✗ Rumble #${rumbleId} failed: ${err.message?.slice(0, 120)}`);
      errorCount++;
    }
  }

  console.log(`\n--- Repair Summary ---`);
  console.log(`Repaired: ${repairCount}`);
  console.log(`Skipped:  ${skipCount}`);
  console.log(`Errors:   ${errorCount}`);
  console.log(`Total:    ${stuckRumbles.length}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
