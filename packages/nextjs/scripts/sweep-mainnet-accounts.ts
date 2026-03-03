#!/usr/bin/env tsx
/**
 * sweep-mainnet-accounts.ts
 *
 * Scan and recover SOL from mainnet rumble-engine PDA accounts.
 * Does NOT touch the program binary or config PDA.
 *
 * Usage:
 *   npx tsx scripts/sweep-mainnet-accounts.ts              # dry-run (default, skips accounts with winning bets)
 *   npx tsx scripts/sweep-mainnet-accounts.ts --execute     # sweep no-winner accounts only
 *   npx tsx scripts/sweep-mainnet-accounts.ts --execute --force  # sweep ALL accounts (including winner vaults)
 */

import {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  Transaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { createHash } from "node:crypto";
import * as fs from "node:fs";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PROGRAM_ID = new PublicKey("2TvW4EfbmMe566ZQWZWd8kX34iFR2DM3oBUpjwpRJcqC");
const ADMIN_KEYPAIR_PATH = `${process.env.HOME}/.config/solana/mainnet-admin.json`;

// Use Helius mainnet RPC
function getRpcUrl(): string {
  const explicit = process.env.HELIUS_MAINNET_RPC_URL?.trim();
  if (explicit) return explicit;
  const key =
    process.env.HELIUS_MAINNET_API_KEY?.trim() ||
    process.env.NEXT_PUBLIC_HELIUS_MAINNET_API_KEY?.trim();
  if (key) return `https://mainnet.helius-rpc.com/?api-key=${key}`;
  // Fallback — will be slow but works
  return "https://api.mainnet-beta.solana.com";
}

// ---------------------------------------------------------------------------
// Account discriminators (Anchor SHA-256 prefix)
// ---------------------------------------------------------------------------

function discriminator(name: string): Buffer {
  return createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
}

const RUMBLE_DISC = discriminator("Rumble");
const COMBAT_STATE_DISC = discriminator("RumbleCombatState");

// ---------------------------------------------------------------------------
// PDA Seeds
// ---------------------------------------------------------------------------

const CONFIG_SEED = Buffer.from("rumble_config");
const RUMBLE_SEED = Buffer.from("rumble");
const VAULT_SEED = Buffer.from("vault");
const COMBAT_STATE_SEED = Buffer.from("combat_state");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readU64LE(data: Uint8Array, offset: number): bigint {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return view.getBigUint64(offset, true);
}

const STATE_NAMES: Record<number, string> = {
  0: "betting",
  1: "combat",
  2: "payout",
  3: "complete",
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Build, sign, and send a transaction from an Anchor method builder */
async function sendTx(
  method: any,
  admin: anchor.web3.Keypair,
  conn: Connection,
): Promise<string> {
  const tx: Transaction = await method.transaction();
  tx.feePayer = admin.publicKey;
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  // Mainnet priority fee
  tx.instructions.unshift(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
  );
  tx.sign(admin);
  const sig = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
    maxRetries: 3,
  });
  const timeout = 60_000; // 60s for mainnet
  await Promise.race([
    conn.confirmTransaction(sig, "confirmed"),
    new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), timeout)),
  ]);
  return sig;
}

/** Batch getMultipleAccounts in chunks of 100 */
async function batchGetBalances(
  conn: Connection,
  addresses: PublicKey[],
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  const BATCH = 100;
  for (let i = 0; i < addresses.length; i += BATCH) {
    const chunk = addresses.slice(i, i + BATCH);
    const infos = await conn.getMultipleAccountsInfo(chunk);
    for (let j = 0; j < chunk.length; j++) {
      const info = infos[j];
      if (info) {
        result.set(chunk[j].toBase58(), info.lamports);
      }
    }
    if (i + BATCH < addresses.length) {
      await sleep(300);
    }
  }
  return result;
}

interface AccountInfo {
  address: string;
  type: string;
  dataSize: number;
  lamports: number;
  rumbleId?: number;
  state?: string;
  sweepable: boolean;
  hasWinningBets?: boolean;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const execute = args.includes("--execute");
  const force = args.includes("--force");

  const rpcUrl = getRpcUrl();

  console.log("=".repeat(70));
  console.log("  UCF MAINNET Account Sweep");
  console.log(`  Mode: ${execute ? (force ? "EXECUTE --force (sweeping ALL accounts)" : "EXECUTE (no-winner accounts only)") : "DRY RUN (scan only)"}`);
  console.log(`  Program: ${PROGRAM_ID.toBase58()}`);
  console.log(`  RPC: ${rpcUrl.replace(/api-key=.*/, "api-key=***")}`);
  console.log("=".repeat(70));
  console.log();

  const conn = new Connection(rpcUrl, "confirmed");

  // 1. Check config PDA exists
  const [configPda] = PublicKey.findProgramAddressSync([CONFIG_SEED], PROGRAM_ID);
  const configInfo = await conn.getAccountInfo(configPda);
  if (!configInfo) {
    console.error("ERROR: Config PDA not found on mainnet. Is the program initialized?");
    process.exit(1);
  }

  const configAdmin = new PublicKey(configInfo.data.subarray(8, 8 + 32));
  const treasury = new PublicKey(configInfo.data.subarray(8 + 32, 8 + 32 + 32));
  console.log(`Config PDA:  ${configPda.toBase58()}`);
  console.log(`Config Admin: ${configAdmin.toBase58()}`);
  console.log(`Treasury:     ${treasury.toBase58()}`);
  console.log();

  // 2. Fetch ALL program accounts
  console.log("Scanning mainnet program accounts...");
  const allAccounts = await conn.getProgramAccounts(PROGRAM_ID);
  console.log(`Found ${allAccounts.length} accounts`);

  const reports: AccountInfo[] = [];
  const rumbleReports: AccountInfo[] = [];

  for (const acct of allAccounts) {
    const data = acct.account.data;
    const address = acct.pubkey.toBase58();
    const lamports = acct.account.lamports;

    let type = `other (${data.length}B)`;
    let rumbleId: number | undefined;
    let state: string | undefined;
    let sweepable = false;
    let hasWinningBets: boolean | undefined;

    if (data.length >= 8) {
      const disc = Buffer.from(data.subarray(0, 8));

      if (disc.equals(RUMBLE_DISC) && data.length >= 17) {
        type = "Rumble";
        rumbleId = Number(readU64LE(data, 8));
        state = STATE_NAMES[data[16]] ?? `unknown(${data[16]})`;
        sweepable = state === "complete" || state === "betting" || state === "payout";

        // Check if anyone bet on the winner
        // betting_pools starts at offset 530, winner_index at 698
        if (data.length >= 700) {
          const winnerIndex = data[698];
          const winnerPool = Number(readU64LE(data, 530 + winnerIndex * 8));
          hasWinningBets = winnerPool > 0;
        }
      } else if (disc.equals(COMBAT_STATE_DISC)) {
        type = "CombatState";
        if (data.length >= 16) rumbleId = Number(readU64LE(data, 8));
        sweepable = true;
      }
    }

    // Don't sweep config
    if (acct.pubkey.equals(configPda)) {
      type = "Config";
      sweepable = false;
    }

    const report: AccountInfo = { address, type, dataSize: data.length, lamports, rumbleId, state, sweepable, hasWinningBets };
    reports.push(report);
    if (type === "Rumble" && rumbleId !== undefined) {
      rumbleReports.push(report);
    }
  }

  // 3. Check vault balances
  // Build a set of rumble IDs whose vaults have real SOL (bets placed)
  const rumbleIdsWithVaultSol = new Set<number>();
  if (rumbleReports.length > 0) {
    console.log(`Checking ${rumbleReports.length} vault balances...`);
    const vaultPdas = rumbleReports.map((r) => {
      const buf = Buffer.alloc(8);
      buf.writeBigUInt64LE(BigInt(r.rumbleId!));
      return PublicKey.findProgramAddressSync([VAULT_SEED, buf], PROGRAM_ID)[0];
    });
    const balances = await batchGetBalances(conn, vaultPdas);

    for (let i = 0; i < rumbleReports.length; i++) {
      const vaultAddr = vaultPdas[i].toBase58();
      const vaultBalance = balances.get(vaultAddr) ?? 0;
      if (vaultBalance > 890_880) {
        rumbleIdsWithVaultSol.add(rumbleReports[i].rumbleId!);
      }
      if (vaultBalance > 0) {
        reports.push({
          address: vaultAddr,
          type: "Vault",
          dataSize: 0,
          lamports: vaultBalance,
          rumbleId: rumbleReports[i].rumbleId,
          state: rumbleReports[i].state,
          sweepable: true,
          hasWinningBets: rumbleReports[i].hasWinningBets,
        });
      }
    }

    // Protect betting-state rumbles whose vaults have real bets (people's SOL).
    // These need admin review / refunds, not auto-sweep.
    for (const r of rumbleReports) {
      if (r.state === "betting" && rumbleIdsWithVaultSol.has(r.rumbleId!)) {
        r.sweepable = false;
        r.hasWinningBets = true; // mark as protected
      }
    }
    // Also protect vault entries for those rumbles
    for (const r of reports) {
      if (r.type === "Vault" && r.state === "betting" && rumbleIdsWithVaultSol.has(r.rumbleId!)) {
        r.sweepable = false;
        r.hasWinningBets = true;
      }
    }
  }

  // 4. Print report
  console.log();
  console.log("=".repeat(70));
  console.log("  MAINNET ACCOUNT REPORT");
  console.log("=".repeat(70));

  const byType: Record<string, { count: number; lamports: number }> = {};
  const byState: Record<string, { count: number; lamports: number }> = {};
  for (const r of reports) {
    if (!byType[r.type]) byType[r.type] = { count: 0, lamports: 0 };
    byType[r.type].count++;
    byType[r.type].lamports += r.lamports;
    const s = r.state ?? "n/a";
    if (!byState[s]) byState[s] = { count: 0, lamports: 0 };
    byState[s].count++;
    byState[s].lamports += r.lamports;
  }

  console.log();
  console.log("  By Type:");
  for (const [type, { count, lamports }] of Object.entries(byType).sort((a, b) => b[1].lamports - a[1].lamports)) {
    console.log(`    ${type.padEnd(20)} ${String(count).padStart(6)} accounts   ${(lamports / LAMPORTS_PER_SOL).toFixed(6).padStart(12)} SOL`);
  }

  console.log();
  console.log("  By State:");
  for (const [state, { count, lamports }] of Object.entries(byState).sort((a, b) => b[1].lamports - a[1].lamports)) {
    console.log(`    ${state.padEnd(20)} ${String(count).padStart(6)} accounts   ${(lamports / LAMPORTS_PER_SOL).toFixed(6).padStart(12)} SOL`);
  }

  const sweepable = reports.filter((r) => r.sweepable);
  const sweepableLamports = sweepable.reduce((s, r) => s + r.lamports, 0);

  console.log();
  const withWinners = sweepable.filter((r) => r.hasWinningBets);
  const noWinners = sweepable.filter((r) => !r.hasWinningBets);

  console.log(`  Sweepable accounts (no winners — safe to auto-sweep): ${noWinners.length}`);
  for (const r of noWinners) {
    const addr = r.address.slice(0, 8) + ".." + r.address.slice(-4);
    console.log(
      `    ${addr.padEnd(16)} ${r.type.padEnd(14)} ${(r.state ?? "-").padEnd(10)} ${(r.lamports / LAMPORTS_PER_SOL).toFixed(6).padStart(12)} SOL  rumble=${r.rumbleId ?? "-"}`,
    );
  }

  if (withWinners.length > 0) {
    const winnerLamports = withWinners.reduce((s, r) => s + r.lamports, 0);
    console.log();
    console.log(`  Accounts WITH winning bets (protected — use --force to override): ${withWinners.length}`);
    for (const r of withWinners) {
      const addr = r.address.slice(0, 8) + ".." + r.address.slice(-4);
      console.log(
        `    ${addr.padEnd(16)} ${r.type.padEnd(14)} ${(r.state ?? "-").padEnd(10)} ${(r.lamports / LAMPORTS_PER_SOL).toFixed(6).padStart(12)} SOL  rumble=${r.rumbleId ?? "-"}  ** HAS WINNERS **`,
      );
    }
    console.log(`  Protected SOL:      ${(winnerLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
  }

  console.log();
  const totalLamports = reports.reduce((s, r) => s + r.lamports, 0);
  console.log(`  Total PDA accounts: ${reports.length}`);
  console.log(`  Total SOL in PDAs:  ${(totalLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
  console.log(`  Sweepable:          ${sweepable.length} accounts, ${(sweepableLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
  console.log(`  (Program binary rent NOT included — keeping program deployed)`);

  if (!execute) {
    console.log();
    console.log("  DRY RUN — no transactions sent. Use --execute to sweep.");
    console.log();
    return;
  }

  // ---------------------------------------------------------------------------
  // Execute Sweep
  // ---------------------------------------------------------------------------

  console.log();
  console.log("=".repeat(70));
  console.log("  EXECUTING MAINNET SWEEP");
  console.log("=".repeat(70));

  // Load admin keypair
  if (!fs.existsSync(ADMIN_KEYPAIR_PATH)) {
    console.error(`ERROR: Admin keypair not found at ${ADMIN_KEYPAIR_PATH}`);
    process.exit(1);
  }
  const adminSecret = JSON.parse(fs.readFileSync(ADMIN_KEYPAIR_PATH, "utf-8"));
  const adminKeypair = anchor.web3.Keypair.fromSecretKey(Uint8Array.from(adminSecret));
  console.log(`  Admin: ${adminKeypair.publicKey.toBase58()}`);

  // Verify admin matches config
  if (!configAdmin.equals(adminKeypair.publicKey)) {
    console.error(`  ERROR: Admin key mismatch!`);
    console.error(`    Config admin: ${configAdmin.toBase58()}`);
    console.error(`    Our key:      ${adminKeypair.publicKey.toBase58()}`);
    process.exit(1);
  }
  console.log(`  Admin key matches config.`);

  // Check admin has enough SOL for tx fees
  const adminBalance = await conn.getBalance(adminKeypair.publicKey);
  console.log(`  Admin balance: ${(adminBalance / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
  if (adminBalance < 1_000_000) {
    console.error(`  ERROR: Admin balance too low for tx fees. Need at least 0.001 SOL.`);
    process.exit(1);
  }

  // Load IDL
  const idl = require("../lib/idl/rumble_engine.json");
  const programIdl = { ...idl, address: PROGRAM_ID.toBase58() };
  const wallet = new anchor.Wallet(adminKeypair);
  const provider = new anchor.AnchorProvider(conn, wallet, { commitment: "confirmed" });
  const program = new anchor.Program(programIdl, provider);

  let totalSwept = 0;
  let totalErrors = 0;
  let totalSolRecovered = 0;

  // --- Sweep Rumble accounts ---
  const sweepableRumbles = reports.filter(
    (r) => r.type === "Rumble" && r.sweepable && r.rumbleId !== undefined && (force || !r.hasWinningBets),
  );
  const protectedCount = reports.filter((r) => r.type === "Rumble" && r.sweepable && r.hasWinningBets).length;
  console.log(`\n  ${sweepableRumbles.length} sweepable Rumble accounts${!force && protectedCount > 0 ? ` (${protectedCount} with winners PROTECTED — use --force to include)` : ""}`);

  for (const report of sweepableRumbles) {
    const rumbleId = report.rumbleId!;
    const rumbleBuf = Buffer.alloc(8);
    rumbleBuf.writeBigUInt64LE(BigInt(rumbleId));
    const [rumblePda] = PublicKey.findProgramAddressSync([RUMBLE_SEED, rumbleBuf], PROGRAM_ID);
    const [vaultPda] = PublicKey.findProgramAddressSync([VAULT_SEED, rumbleBuf], PROGRAM_ID);

    process.stdout.write(`  Rumble ${rumbleId} (${report.state})... `);

    // Step 1: If betting, report dummy result
    if (report.state === "betting") {
      try {
        const data = (await conn.getAccountInfo(rumblePda))?.data;
        const fighterCount = data && data.length >= 18 ? data[17] : 12;
        const placements = Array.from({ length: fighterCount }, (_, i) => (i === 0 ? 1 : i + 1));

        const method = (program.methods as any)
          .reportResult(Buffer.from(placements), 0)
          .accounts({ admin: adminKeypair.publicKey, config: configPda, rumble: rumblePda });

        await sendTx(method, adminKeypair, conn);
        process.stdout.write(`reportResult OK → `);
      } catch (err: any) {
        console.log(`reportResult FAILED: ${err.message?.slice(0, 80)}`);
        totalErrors++;
        continue;
      }
      await sleep(2000); // Mainnet needs more time
    }

    // Step 2: Complete rumble
    if (report.state === "betting" || report.state === "payout") {
      try {
        const method = (program.methods as any)
          .completeRumble()
          .accounts({ admin: adminKeypair.publicKey, config: configPda, rumble: rumblePda });

        await sendTx(method, adminKeypair, conn);
        process.stdout.write(`complete OK → `);
      } catch (err: any) {
        console.log(`complete FAILED: ${err.message?.slice(0, 80)}`);
        totalErrors++;
        continue;
      }
      await sleep(1500);
    }

    // Step 3: Sweep treasury (vault SOL)
    try {
      const vaultBalance = await conn.getBalance(vaultPda);
      if (vaultBalance > 890_880) {
        const method = (program.methods as any)
          .sweepTreasury()
          .accounts({
            admin: adminKeypair.publicKey,
            config: configPda,
            rumble: rumblePda,
            vault: vaultPda,
            treasury,
            systemProgram: anchor.web3.SystemProgram.programId,
          });

        await sendTx(method, adminKeypair, conn);
        const swept = vaultBalance / LAMPORTS_PER_SOL;
        totalSolRecovered += swept;
        process.stdout.write(`sweep ${swept.toFixed(4)} SOL → `);
        await sleep(1000);
      }
    } catch {
      process.stdout.write(`sweep FAILED → `);
    }

    // Step 4: Close rumble PDA (reclaim rent)
    try {
      const method = (program.methods as any)
        .closeRumble()
        .accounts({ admin: adminKeypair.publicKey, config: configPda, rumble: rumblePda, vault: vaultPda });

      await sendTx(method, adminKeypair, conn);
      const rentRecovered = report.lamports / LAMPORTS_PER_SOL;
      totalSolRecovered += rentRecovered;
      console.log(`closed (${rentRecovered.toFixed(4)} SOL rent)`);
      totalSwept++;
    } catch (err: any) {
      const msg = err.message ?? "";
      if (msg.includes("ClaimWindow")) {
        console.log(`close BLOCKED (24h claim window — re-run tomorrow)`);
      } else {
        console.log(`close FAILED: ${msg.slice(0, 60)}`);
      }
      totalErrors++;
    }

    // Rate limit: don't spam mainnet
    await sleep(500);
  }

  // --- Close CombatState PDAs ---
  const combatStates = reports.filter((r) => r.type === "CombatState");
  if (combatStates.length > 0) {
    console.log(`\n  ${combatStates.length} CombatState accounts to close`);
  }

  for (const report of combatStates) {
    const rumbleId = report.rumbleId;
    if (rumbleId === undefined) continue;

    const rumbleBuf = Buffer.alloc(8);
    rumbleBuf.writeBigUInt64LE(BigInt(rumbleId));
    const [rumblePda] = PublicKey.findProgramAddressSync([RUMBLE_SEED, rumbleBuf], PROGRAM_ID);
    const [combatStatePda] = PublicKey.findProgramAddressSync([COMBAT_STATE_SEED, rumbleBuf], PROGRAM_ID);

    try {
      const method = (program.methods as any)
        .closeCombatState()
        .accounts({
          admin: adminKeypair.publicKey,
          config: configPda,
          rumble: rumblePda,
          combatState: combatStatePda,
        });

      await sendTx(method, adminKeypair, conn);
      const rentRecovered = report.lamports / LAMPORTS_PER_SOL;
      totalSolRecovered += rentRecovered;
      totalSwept++;
      process.stdout.write(".");
    } catch {
      totalErrors++;
    }
    await sleep(500);
  }
  if (combatStates.length > 0) console.log();

  // Final summary
  console.log();
  console.log("=".repeat(70));
  console.log("  MAINNET SWEEP COMPLETE");
  console.log("=".repeat(70));
  console.log(`  Accounts closed:    ${totalSwept}`);
  console.log(`  Errors:             ${totalErrors}`);
  console.log(`  SOL recovered:      ~${totalSolRecovered.toFixed(6)} SOL`);
  console.log();

  const finalBalance = await conn.getBalance(adminKeypair.publicKey);
  console.log(`  Admin final balance: ${(finalBalance / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
  console.log();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
