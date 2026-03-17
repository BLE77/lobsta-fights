#!/usr/bin/env tsx
/**
 * recover-stuck-bettors.ts
 *
 * Recover 25 stuck BettorAccount PDAs on Solana mainnet for the UCF system.
 *
 * Problem:
 *   - 25 bettor PDAs exist for wallet 4gfVi6MUPC2cG4gg4uarp9EAAqDeBtosvUVX1iGNT1Va
 *   - 13 have rumbles still in "betting" state (never progressed to combat)
 *   - 12 have rumbles already swept/closed (GONE — rumble PDA no longer exists)
 *   - claim_payout only works on payout/complete state rumbles
 *   - Total rent locked: ~0.059 SOL
 *
 * Strategy:
 *   Category A (13 betting-state rumbles):
 *     1. admin_set_result → moves rumble from betting to payout
 *     2. complete_rumble  → moves rumble from payout to complete
 *     3. claim_payout     → bettor signs to claim (returns bet + any winnings from vault)
 *        NOTE: claim_payout does NOT close the bettor PDA. The rent stays locked.
 *     4. close_rumble     → admin closes the rumble PDA itself
 *
 *   Category B (12 GONE rumbles — parent rumble already closed):
 *     - claim_payout requires the Rumble account to exist on-chain (Anchor validation).
 *     - No close_bettor instruction exists in the program.
 *     - These bettor PDAs are UNRECOVERABLE with the current program.
 *     - A program upgrade adding a `force_close_bettor` instruction is needed.
 *
 * Usage:
 *   npx tsx scripts/recover-stuck-bettors.ts                          # dry-run scan
 *   npx tsx scripts/recover-stuck-bettors.ts --execute                # admin: set results + complete rumbles
 *   npx tsx scripts/recover-stuck-bettors.ts --wallet <ADDR>          # scan a different wallet
 *
 * The --execute flag uses the admin keypair to advance betting-state rumbles
 * through admin_set_result and complete_rumble so that claim_payout becomes
 * available. The bettor wallet owner must then call claim_payout separately
 * (this script does NOT sign as the bettor).
 */

import {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  Keypair,
  SystemProgram,
} from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PROGRAM_ID = new PublicKey("2TvW4EfbmMe566ZQWZWd8kX34iFR2DM3oBUpjwpRJcqC");
const DEFAULT_WALLET = "4gfVi6MUPC2cG4gg4uarp9EAAqDeBtosvUVX1iGNT1Va";
const ADMIN_KEYPAIR_PATH = `${process.env.HOME}/.config/solana/mainnet-admin.json`;
const TX_DELAY_MS = 500;

function getRpcUrl(): string {
  const explicit = process.env.HELIUS_MAINNET_RPC_URL?.trim();
  if (explicit) return explicit;
  const key =
    process.env.HELIUS_MAINNET_API_KEY?.trim() ||
    process.env.NEXT_PUBLIC_HELIUS_MAINNET_API_KEY?.trim();
  if (key) return `https://mainnet.helius-rpc.com/?api-key=${key}`;
  return "https://api.mainnet-beta.solana.com";
}

// ---------------------------------------------------------------------------
// Discriminators & Seeds
// ---------------------------------------------------------------------------

function discriminator(name: string): Buffer {
  return createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
}

const BETTOR_DISC = discriminator("BettorAccount");
const RUMBLE_DISC = discriminator("Rumble");

const CONFIG_SEED = Buffer.from("rumble_config");
const RUMBLE_SEED = Buffer.from("rumble");
const VAULT_SEED = Buffer.from("vault");
const BETTOR_SEED = Buffer.from("bettor");

// Rumble account layout offsets
const STATE_OFFSET = 16; // u8 after disc(8) + id(8)
const FIGHTER_COUNT_OFFSET = 8 + 8 + 1 + 512; // 529
const BETTING_POOLS_OFFSET = FIGHTER_COUNT_OFFSET + 1; // 530
const WINNER_INDEX_OFFSET = BETTING_POOLS_OFFSET + 128 + 8 + 8 + 8 + 16; // 698

const STATE_NAMES: Record<number, string> = {
  0: "betting",
  1: "combat",
  2: "payout",
  3: "complete",
};

// ---------------------------------------------------------------------------
// PDA derivation
// ---------------------------------------------------------------------------

function rumbleIdBuf(rumbleId: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(rumbleId));
  return buf;
}

function deriveRumblePda(rumbleId: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([RUMBLE_SEED, rumbleIdBuf(rumbleId)], PROGRAM_ID);
}

function deriveVaultPda(rumbleId: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([VAULT_SEED, rumbleIdBuf(rumbleId)], PROGRAM_ID);
}

function deriveBettorPda(rumbleId: number, bettor: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [BETTOR_SEED, rumbleIdBuf(rumbleId), bettor.toBuffer()],
    PROGRAM_ID,
  );
}

// ---------------------------------------------------------------------------
// Parse bettor account
// ---------------------------------------------------------------------------

interface BettorInfo {
  pda: PublicKey;
  authority: PublicKey;
  rumbleId: number;
  fighterIndex: number;
  solDeployed: number;
  claimableLamports: number;
  claimed: boolean;
  rentLamports: number;
}

function parseBettorAccount(pubkey: PublicKey, data: Buffer, lamports: number): BettorInfo {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let off = 8; // discriminator
  const authorityBytes = data.subarray(off, off + 32);
  const authority = new PublicKey(authorityBytes);
  off += 32;
  const rumbleId = Number(view.getBigUint64(off, true));
  off += 8;
  const fighterIndex = data[off]!;
  off += 1;
  const solDeployed = Number(view.getBigUint64(off, true)) / LAMPORTS_PER_SOL;
  off += 8;
  const claimableLamports = Number(view.getBigUint64(off, true));
  off += 8;
  off += 8; // total_claimed_lamports
  off += 8; // last_claim_ts
  const claimed = data[off] === 1;

  return {
    pda: pubkey,
    authority,
    rumbleId,
    fighterIndex,
    solDeployed,
    claimableLamports,
    claimed,
    rentLamports: lamports,
  };
}

// ---------------------------------------------------------------------------
// Transaction helper (same pattern as sweep/batch-close scripts)
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sendTx(
  method: any,
  admin: Keypair,
  conn: Connection,
): Promise<string | null> {
  try {
    const tx = await method.transaction();
    const latest = await conn.getLatestBlockhash("confirmed");
    tx.feePayer = admin.publicKey;
    tx.recentBlockhash = latest.blockhash;
    tx.sign(admin);
    const sig = await conn.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
      maxRetries: 5,
    });
    const confirmation = await conn.confirmTransaction(
      {
        signature: sig,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      },
      "confirmed",
    );
    if (confirmation.value.err) {
      throw new Error(`confirmation failed: ${JSON.stringify(confirmation.value.err)}`);
    }
    return sig;
  } catch (err: any) {
    const msg = err?.message?.slice(0, 120) ?? String(err);
    console.error(`    TX error: ${msg}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const execute = args.includes("--execute");
  const walletIdx = args.indexOf("--wallet");
  const walletAddr = walletIdx >= 0 ? args[walletIdx + 1]! : DEFAULT_WALLET;

  const bettorWallet = new PublicKey(walletAddr);
  const rpcUrl = getRpcUrl();
  const conn = new Connection(rpcUrl, "confirmed");

  console.log("=".repeat(70));
  console.log("  UCF Stuck Bettor PDA Recovery");
  console.log(`  Mode: ${execute ? "EXECUTE" : "DRY RUN"}`);
  console.log(`  Bettor wallet: ${bettorWallet.toBase58()}`);
  console.log(`  Program: ${PROGRAM_ID.toBase58()}`);
  console.log(`  RPC: ${rpcUrl.replace(/api-key=.*/, "api-key=***")}`);
  console.log("=".repeat(70));
  console.log();

  // 1. Fetch all bettor PDAs for this wallet
  console.log("Scanning bettor accounts...");
  const bettorAccounts = await conn.getProgramAccounts(PROGRAM_ID, {
    filters: [
      { memcmp: { offset: 0, bytes: anchor.utils.bytes.bs58.encode(BETTOR_DISC) } },
      { memcmp: { offset: 8, bytes: bettorWallet.toBase58() } },
    ],
  });

  if (bettorAccounts.length === 0) {
    console.log("No bettor accounts found for this wallet.");
    return;
  }

  const bettors: BettorInfo[] = bettorAccounts.map((a) =>
    parseBettorAccount(a.pubkey, a.account.data as Buffer, a.account.lamports),
  );

  console.log(`Found ${bettors.length} bettor accounts\n`);

  // 2. Check which rumbles still exist on-chain
  const rumbleIds = [...new Set(bettors.map((b) => b.rumbleId))];
  console.log(`Checking ${rumbleIds.length} unique rumble PDAs...`);

  const rumblePdas = rumbleIds.map((id) => deriveRumblePda(id)[0]);
  const BATCH = 100;
  const rumbleInfoMap = new Map<number, { exists: boolean; state: number; fighterCount: number; winnerPool: number }>();

  for (let i = 0; i < rumblePdas.length; i += BATCH) {
    const chunk = rumblePdas.slice(i, i + BATCH);
    const chunkIds = rumbleIds.slice(i, i + BATCH);
    const infos = await conn.getMultipleAccountsInfo(chunk);
    for (let j = 0; j < chunk.length; j++) {
      const info = infos[j];
      if (info && info.data.length >= WINNER_INDEX_OFFSET + 1) {
        const data = info.data;
        const state = data[STATE_OFFSET];
        const fighterCount = data[FIGHTER_COUNT_OFFSET];
        const winnerIndex = data[WINNER_INDEX_OFFSET];
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        let winnerPool = 0;
        try {
          winnerPool = Number(view.getBigUint64(BETTING_POOLS_OFFSET + winnerIndex * 8, true));
        } catch {}
        rumbleInfoMap.set(chunkIds[j], { exists: true, state, fighterCount, winnerPool });
      } else {
        rumbleInfoMap.set(chunkIds[j], { exists: false, state: -1, fighterCount: 0, winnerPool: 0 });
      }
    }
    if (i + BATCH < rumblePdas.length) await sleep(300);
  }

  // 3. Classify bettor accounts
  interface ClassifiedBettor extends BettorInfo {
    rumbleExists: boolean;
    rumbleState: string;
    category: "A_BETTING" | "A_COMBAT" | "A_PAYOUT" | "A_COMPLETE" | "B_GONE";
    actionNeeded: string;
  }

  const classified: ClassifiedBettor[] = bettors.map((b) => {
    const rInfo = rumbleInfoMap.get(b.rumbleId)!;
    let category: ClassifiedBettor["category"];
    let actionNeeded: string;

    if (!rInfo.exists) {
      category = "B_GONE";
      actionNeeded = "UNRECOVERABLE — rumble PDA gone, no close_bettor instruction exists";
    } else {
      const stateName = STATE_NAMES[rInfo.state] ?? `unknown(${rInfo.state})`;
      switch (rInfo.state) {
        case 0: // betting
          category = "A_BETTING";
          actionNeeded = "admin_set_result -> complete_rumble -> claim_payout available";
          break;
        case 1: // combat
          category = "A_COMBAT";
          actionNeeded = "admin_set_result -> complete_rumble -> claim_payout available";
          break;
        case 2: // payout
          category = "A_PAYOUT";
          actionNeeded = "complete_rumble -> claim_payout available (already in payout)";
          break;
        case 3: // complete
          category = "A_COMPLETE";
          actionNeeded = b.claimed
            ? "Already claimed. Bettor PDA rent still locked (no close instruction)."
            : "claim_payout available now (rumble already complete)";
          break;
        default:
          category = "A_BETTING";
          actionNeeded = `Unknown state ${rInfo.state}`;
      }
    }

    return {
      ...b,
      rumbleExists: rInfo.exists,
      rumbleState: rInfo.exists ? (STATE_NAMES[rInfo.state] ?? `unknown(${rInfo.state})`) : "GONE",
      category,
      actionNeeded,
    };
  });

  classified.sort((a, b) => {
    const order = { A_COMPLETE: 0, A_PAYOUT: 1, A_BETTING: 2, A_COMBAT: 3, B_GONE: 4 };
    return (order[a.category] ?? 9) - (order[b.category] ?? 9) || a.rumbleId - b.rumbleId;
  });

  // 4. Print report
  const catA = classified.filter((c) => c.category.startsWith("A_"));
  const catB = classified.filter((c) => c.category === "B_GONE");
  const catABetting = classified.filter((c) => c.category === "A_BETTING" || c.category === "A_COMBAT");
  const catAPayout = classified.filter((c) => c.category === "A_PAYOUT");
  const catAComplete = classified.filter((c) => c.category === "A_COMPLETE");

  const totalRent = classified.reduce((s, c) => s + c.rentLamports, 0);
  const catARent = catA.reduce((s, c) => s + c.rentLamports, 0);
  const catBRent = catB.reduce((s, c) => s + c.rentLamports, 0);

  console.log();
  console.log("=".repeat(70));
  console.log("  BETTOR PDA RECOVERY REPORT");
  console.log("=".repeat(70));

  console.log();
  console.log("  CATEGORY A — Rumble exists on-chain (recoverable via admin actions):");
  console.log(`  Total: ${catA.length} accounts, ${(catARent / LAMPORTS_PER_SOL).toFixed(6)} SOL rent`);
  if (catABetting.length > 0) {
    console.log(`\n    Betting/Combat state (need admin_set_result + complete_rumble): ${catABetting.length}`);
    for (const c of catABetting) {
      console.log(
        `      Rumble #${String(c.rumbleId).padEnd(6)} fighter=${c.fighterIndex}  bet=${c.solDeployed.toFixed(4)} SOL  rent=${(c.rentLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL  ${c.pda.toBase58().slice(0, 16)}...`,
      );
    }
  }
  if (catAPayout.length > 0) {
    console.log(`\n    Payout state (need complete_rumble): ${catAPayout.length}`);
    for (const c of catAPayout) {
      console.log(
        `      Rumble #${String(c.rumbleId).padEnd(6)} fighter=${c.fighterIndex}  bet=${c.solDeployed.toFixed(4)} SOL  rent=${(c.rentLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL  ${c.pda.toBase58().slice(0, 16)}...`,
      );
    }
  }
  if (catAComplete.length > 0) {
    console.log(`\n    Complete state (claim_payout available now): ${catAComplete.length}`);
    for (const c of catAComplete) {
      const status = c.claimed ? "CLAIMED" : "UNCLAIMED";
      console.log(
        `      Rumble #${String(c.rumbleId).padEnd(6)} fighter=${c.fighterIndex}  bet=${c.solDeployed.toFixed(4)} SOL  rent=${(c.rentLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL  ${status}  ${c.pda.toBase58().slice(0, 16)}...`,
      );
    }
  }

  console.log();
  console.log("  CATEGORY B — Rumble PDA gone (UNRECOVERABLE with current program):");
  console.log(`  Total: ${catB.length} accounts, ${(catBRent / LAMPORTS_PER_SOL).toFixed(6)} SOL rent`);
  for (const c of catB) {
    console.log(
      `      Rumble #${String(c.rumbleId).padEnd(6)} fighter=${c.fighterIndex}  bet=${c.solDeployed.toFixed(4)} SOL  rent=${(c.rentLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL  ${c.pda.toBase58().slice(0, 16)}...`,
    );
  }

  console.log();
  console.log("  SUMMARY:");
  console.log(`    Total bettor PDAs:           ${classified.length}`);
  console.log(`    Total rent locked:           ${(totalRent / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
  console.log(`    Category A (recoverable):    ${catA.length} accounts, ${(catARent / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
  console.log(`    Category B (unrecoverable):  ${catB.length} accounts, ${(catBRent / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
  console.log();
  console.log("  IMPORTANT NOTES:");
  console.log("    - claim_payout does NOT close the bettor PDA. Rent stays locked.");
  console.log("    - The program has no close_bettor / force_close_bettor instruction.");
  console.log("    - To reclaim bettor PDA rent, a program upgrade is required to add");
  console.log("      a force_close_bettor admin instruction.");
  console.log("    - Category B accounts need the same upgrade — without the parent");
  console.log("      rumble on-chain, no existing instruction can touch them.");

  if (!execute) {
    console.log();
    console.log("  DRY RUN — use --execute to advance betting-state rumbles.");
    console.log();
    return;
  }

  // ---------------------------------------------------------------------------
  // Execute: advance betting-state rumbles so claim_payout becomes available
  // ---------------------------------------------------------------------------

  console.log();
  console.log("=".repeat(70));
  console.log("  EXECUTING: Advancing rumbles for Category A bettors");
  console.log("=".repeat(70));

  // Load admin keypair
  if (!fs.existsSync(ADMIN_KEYPAIR_PATH)) {
    console.error(`ERROR: Admin keypair not found at ${ADMIN_KEYPAIR_PATH}`);
    process.exit(1);
  }
  const adminSecret = JSON.parse(fs.readFileSync(ADMIN_KEYPAIR_PATH, "utf-8"));
  const adminKeypair = Keypair.fromSecretKey(Uint8Array.from(adminSecret));
  console.log(`  Admin: ${adminKeypair.publicKey.toBase58()}`);

  // Verify admin matches config
  const [configPda] = PublicKey.findProgramAddressSync([CONFIG_SEED], PROGRAM_ID);
  const configInfo = await conn.getAccountInfo(configPda);
  if (!configInfo) {
    console.error("ERROR: Config PDA not found on mainnet.");
    process.exit(1);
  }
  const configAdmin = new PublicKey(configInfo.data.subarray(8, 8 + 32));
  const treasury = new PublicKey(configInfo.data.subarray(8 + 32, 8 + 32 + 32));

  if (!configAdmin.equals(adminKeypair.publicKey)) {
    console.error(`  ERROR: Admin key mismatch!`);
    console.error(`    Config admin: ${configAdmin.toBase58()}`);
    console.error(`    Our key:      ${adminKeypair.publicKey.toBase58()}`);
    process.exit(1);
  }
  console.log(`  Admin key matches config.`);
  console.log(`  Treasury: ${treasury.toBase58()}`);

  const adminBalance = await conn.getBalance(adminKeypair.publicKey);
  console.log(`  Admin balance: ${(adminBalance / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
  if (adminBalance < 1_000_000) {
    console.error(`  ERROR: Admin balance too low for tx fees.`);
    process.exit(1);
  }

  // Load IDL & program
  const idlPath = path.resolve(__dirname, "../lib/idl/rumble_engine.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  const wallet = new anchor.Wallet(adminKeypair);
  const provider = new anchor.AnchorProvider(conn, wallet, { commitment: "confirmed" });
  const program = new anchor.Program({ ...idl, address: PROGRAM_ID.toBase58() }, provider);

  // Deduplicate rumble IDs that need advancing
  const rumblesToAdvance = new Map<number, { state: number; fighterCount: number }>();
  for (const c of catABetting) {
    const rInfo = rumbleInfoMap.get(c.rumbleId)!;
    if (!rumblesToAdvance.has(c.rumbleId)) {
      rumblesToAdvance.set(c.rumbleId, { state: rInfo.state, fighterCount: rInfo.fighterCount });
    }
  }
  for (const c of catAPayout) {
    const rInfo = rumbleInfoMap.get(c.rumbleId)!;
    if (!rumblesToAdvance.has(c.rumbleId)) {
      rumblesToAdvance.set(c.rumbleId, { state: rInfo.state, fighterCount: rInfo.fighterCount });
    }
  }

  let advanced = 0;
  let failed = 0;

  console.log(`\n  ${rumblesToAdvance.size} unique rumbles to advance\n`);

  for (const [rumbleId, info] of rumblesToAdvance) {
    const [rumblePda] = deriveRumblePda(rumbleId);
    const [vaultPda] = deriveVaultPda(rumbleId);

    process.stdout.write(`  Rumble #${rumbleId} (${STATE_NAMES[info.state] ?? "?"}): `);

    // Step 1: admin_set_result if betting or combat
    if (info.state === 0 || info.state === 1) {
      // Use fighter index 0 as winner with sequential placements
      const placements = Buffer.from(
        Array.from({ length: info.fighterCount }, (_, i) => i + 1),
      );

      const method = (program.methods as any)
        .adminSetResult(placements, 0)
        .accounts({
          admin: adminKeypair.publicKey,
          config: configPda,
          rumble: rumblePda,
          vault: vaultPda,
          treasury,
          systemProgram: SystemProgram.programId,
        });

      const sig = await sendTx(method, adminKeypair, conn);
      if (sig) {
        process.stdout.write("adminSetResult(ok) ");
      } else {
        process.stdout.write("adminSetResult(FAIL) ");
        failed++;
        console.log();
        await sleep(TX_DELAY_MS);
        continue;
      }
      await sleep(TX_DELAY_MS);
    }

    // Step 2: complete_rumble
    {
      const method = (program.methods as any)
        .completeRumble()
        .accounts({
          admin: adminKeypair.publicKey,
          config: configPda,
          rumble: rumblePda,
        });

      const sig = await sendTx(method, adminKeypair, conn);
      if (sig) {
        process.stdout.write("completeRumble(ok) ");
        advanced++;
      } else {
        process.stdout.write("completeRumble(FAIL) ");
        failed++;
      }
    }

    console.log();
    await sleep(TX_DELAY_MS);
  }

  // Summary
  const finalAdminBalance = await conn.getBalance(adminKeypair.publicKey);
  console.log();
  console.log("=".repeat(70));
  console.log("  EXECUTION COMPLETE");
  console.log("=".repeat(70));
  console.log(`  Rumbles advanced to complete: ${advanced}`);
  console.log(`  Failed:                       ${failed}`);
  console.log(`  Admin balance:                ${(finalAdminBalance / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
  console.log();

  if (advanced > 0) {
    console.log("  NEXT STEPS:");
    console.log(`    The bettor wallet (${bettorWallet.toBase58().slice(0, 16)}...) can now`);
    console.log("    call claim_payout on the advanced rumbles to recover bet amounts");
    console.log("    from the vault. Use the recover-stuck-bets.ts script to build the");
    console.log("    unsigned claim transactions.");
    console.log();
    console.log("    HOWEVER: claim_payout does NOT close bettor PDAs.");
    console.log("    The ~0.059 SOL in bettor PDA rent is NOT recoverable without a");
    console.log("    program upgrade adding a force_close_bettor instruction.");
  }

  if (catB.length > 0) {
    console.log();
    console.log("  CATEGORY B (GONE rumbles):");
    console.log(`    ${catB.length} bettor PDAs with ${(catBRent / LAMPORTS_PER_SOL).toFixed(6)} SOL rent`);
    console.log("    are permanently stuck. To recover this rent, add this instruction");
    console.log("    to the rumble_engine program:");
    console.log();
    console.log("    pub fn force_close_bettor(ctx: Context<ForceCloseBettor>) -> Result<()>");
    console.log("    // Admin-only. Closes a BettorAccount PDA and returns rent to authority.");
    console.log("    // Does NOT require the parent Rumble to exist.");
    console.log("    // Accounts:");
    console.log("    //   admin: Signer (must match config.admin)");
    console.log("    //   config: RumbleConfig PDA");
    console.log("    //   bettor_account: BettorAccount PDA (close = destination)");
    console.log("    //   destination: bettor_account.authority (receives rent)");
  }

  console.log();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
