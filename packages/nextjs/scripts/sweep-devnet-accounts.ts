#!/usr/bin/env tsx
/**
 * sweep-devnet-accounts.ts
 *
 * CLI script to scan both old and new rumble-engine program accounts on devnet,
 * report SOL locked in each, and optionally sweep/close recoverable accounts.
 *
 * Usage:
 *   npx tsx scripts/sweep-devnet-accounts.ts              # dry-run (default)
 *   npx tsx scripts/sweep-devnet-accounts.ts --execute     # actually sweep
 *   npx tsx scripts/sweep-devnet-accounts.ts --program OLD # scan only old program
 *   npx tsx scripts/sweep-devnet-accounts.ts --program NEW # scan only new program
 */

import { Connection, PublicKey, LAMPORTS_PER_SOL, Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Program IDs
// ---------------------------------------------------------------------------

const OLD_PROGRAM_ID = new PublicKey("2TvW4EfbmMe566ZQWZWd8kX34iFR2DM3oBUpjwpRJcqC");
const NEW_PROGRAM_ID = new PublicKey("638DcfW6NaBweznnzmJe4PyxCw51s3CTkykUNskWnxTU");

// ---------------------------------------------------------------------------
// Account discriminators (Anchor SHA-256 prefix)
// ---------------------------------------------------------------------------

function discriminator(name: string): Buffer {
  return createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
}

const RUMBLE_DISC = discriminator("Rumble");
const COMBAT_STATE_DISC = discriminator("RumbleCombatState");

// ---------------------------------------------------------------------------
// RPC Setup
// ---------------------------------------------------------------------------

function getRpcUrl(): string {
  const explicit = process.env.SOLANA_RPC_URL?.trim() || process.env.NEXT_PUBLIC_SOLANA_RPC_URL?.trim();
  if (explicit) return explicit;
  const heliusKey = process.env.HELIUS_API_KEY?.trim();
  if (heliusKey) return `https://devnet.helius-rpc.com/?api-key=${heliusKey}`;
  return "https://api.devnet.solana.com";
}

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

interface AccountReport {
  address: string;
  programId: string;
  programLabel: string;
  type: string;
  dataSize: number;
  lamports: number;
  sol: number;
  rumbleId?: number;
  state?: string;
  sweepable: boolean;
  action?: string;
}

// PDA seeds (must match on-chain program)
const CONFIG_SEED = Buffer.from("rumble_config");
const RUMBLE_SEED = Buffer.from("rumble");
const VAULT_SEED = Buffer.from("vault");
const COMBAT_STATE_SEED = Buffer.from("combat_state");

function deriveVaultPdaForProgram(rumbleId: bigint | number, programId: PublicKey): PublicKey {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(rumbleId));
  return PublicKey.findProgramAddressSync([VAULT_SEED, buf], programId)[0];
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
      // Small delay between batches to avoid rate limits
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return result;
}

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
  const { blockhash } = await conn.getLatestBlockhash("processed");
  tx.recentBlockhash = blockhash;
  // Add compute unit price for devnet priority
  tx.instructions.unshift(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
  );
  tx.sign(admin);
  const sig = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
    maxRetries: 3,
  });
  // Wait for confirmation with 30s timeout
  const timeout = 30_000;
  await Promise.race([
    conn.confirmTransaction(sig, "confirmed"),
    new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), timeout)),
  ]);
  return sig;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const execute = args.includes("--execute");
  const programFilter = args.find((a, i) => args[i - 1] === "--program")?.toUpperCase();

  console.log("=".repeat(70));
  console.log("  UCF Devnet Account Sweep Scanner");
  console.log(`  Mode: ${execute ? "EXECUTE (will send transactions)" : "DRY RUN (scan only)"}`);
  console.log(`  RPC:  ${getRpcUrl().replace(/api-key=.*/, "api-key=***")}`);
  console.log("=".repeat(70));
  console.log();

  const conn = new Connection(getRpcUrl(), "confirmed");
  const allReports: AccountReport[] = [];

  const programs: Array<{ id: PublicKey; label: string }> = [];
  if (!programFilter || programFilter === "OLD") {
    programs.push({ id: OLD_PROGRAM_ID, label: "OLD" });
  }
  if (!programFilter || programFilter === "NEW") {
    programs.push({ id: NEW_PROGRAM_ID, label: "NEW" });
  }

  for (const { id: programId, label } of programs) {
    console.log(`--- Scanning ${label} program: ${programId.toBase58()} ---`);

    // 1. Fetch ALL accounts owned by this program
    let allAccounts;
    try {
      allAccounts = await conn.getProgramAccounts(programId);
    } catch (err: any) {
      console.error(`  Failed to fetch accounts: ${err.message}`);
      continue;
    }

    console.log(`  Found ${allAccounts.length} total accounts`);

    const rumbleReportsThisProgram: AccountReport[] = [];

    for (const acct of allAccounts) {
      const data = acct.account.data;
      const address = acct.pubkey.toBase58();
      const lamports = acct.account.lamports;
      const sol = lamports / LAMPORTS_PER_SOL;

      let type = "unknown";
      let rumbleId: number | undefined;
      let state: string | undefined;
      let sweepable = false;
      let action: string | undefined;

      if (data.length >= 8) {
        const disc = Buffer.from(data.subarray(0, 8));

        if (disc.equals(RUMBLE_DISC)) {
          type = "Rumble";
          if (data.length >= 17) {
            rumbleId = Number(readU64LE(data, 8));
            const stateVal = data[16];
            state = STATE_NAMES[stateVal] ?? `unknown(${stateVal})`;

            if (state === "complete") {
              sweepable = true;
              action = "close_rumble (rent reclaimable)";
            } else if (state === "betting") {
              sweepable = true;
              action = "report_result → complete_rumble → sweep_treasury → close_rumble";
            } else if (state === "payout") {
              sweepable = true;
              action = "complete_rumble → sweep_treasury → close_rumble (if claim window expired)";
            }
          }
        } else if (disc.equals(COMBAT_STATE_DISC)) {
          type = "CombatState";
          if (data.length >= 16) {
            rumbleId = Number(readU64LE(data, 8));
          }
          sweepable = true;
          action = "close_combat_state (rent reclaimable)";
        } else {
          type = `other (${data.length}B)`;
        }
      }

      const report: AccountReport = {
        address,
        programId: programId.toBase58(),
        programLabel: label,
        type,
        dataSize: data.length,
        lamports,
        sol,
        rumbleId,
        state,
        sweepable,
        action,
      };

      allReports.push(report);
      if (type === "Rumble" && rumbleId !== undefined) {
        rumbleReportsThisProgram.push(report);
      }
    }

    // 2. Batch vault balance lookups for Rumble accounts
    if (rumbleReportsThisProgram.length > 0) {
      const vaultPdas = rumbleReportsThisProgram.map((r) =>
        deriveVaultPdaForProgram(r.rumbleId!, programId),
      );
      console.log(`  Checking ${vaultPdas.length} vault balances (batched)...`);
      const balances = await batchGetBalances(conn, vaultPdas);

      for (let i = 0; i < rumbleReportsThisProgram.length; i++) {
        const report = rumbleReportsThisProgram[i];
        const vaultAddr = vaultPdas[i].toBase58();
        const vaultBalance = balances.get(vaultAddr) ?? 0;
        if (vaultBalance > 0) {
          allReports.push({
            address: vaultAddr,
            programId: "system",
            programLabel: label,
            type: "Vault",
            dataSize: 0,
            lamports: vaultBalance,
            sol: vaultBalance / LAMPORTS_PER_SOL,
            rumbleId: report.rumbleId,
            state: report.state,
            sweepable: report.state === "complete" || report.state === "betting",
            action: vaultBalance > 890_880 ? "sweep_treasury" : "rent-exempt only",
          });
        }
      }
    }

    console.log();
  }

  // ---------------------------------------------------------------------------
  // Print Report
  // ---------------------------------------------------------------------------

  console.log("=".repeat(70));
  console.log("  ACCOUNT REPORT");
  console.log("=".repeat(70));

  for (const label of ["OLD", "NEW"]) {
    const group = allReports.filter((r) => r.programLabel === label);
    if (group.length === 0) continue;

    console.log();
    console.log(`  [${label} PROGRAM]`);

    // Summarize large programs
    const byType: Record<string, { count: number; lamports: number }> = {};
    const byState: Record<string, { count: number; lamports: number }> = {};
    for (const r of group) {
      if (!byType[r.type]) byType[r.type] = { count: 0, lamports: 0 };
      byType[r.type].count++;
      byType[r.type].lamports += r.lamports;
      const s = r.state ?? "n/a";
      if (!byState[s]) byState[s] = { count: 0, lamports: 0 };
      byState[s].count++;
      byState[s].lamports += r.lamports;
    }

    console.log(`  (${group.length} accounts)`);
    console.log();
    console.log(`  By Type:`);
    for (const [type, { count, lamports }] of Object.entries(byType).sort((a, b) => b[1].lamports - a[1].lamports)) {
      console.log(`    ${type.padEnd(20)} ${String(count).padStart(6)} accounts   ${(lamports / LAMPORTS_PER_SOL).toFixed(6).padStart(12)} SOL`);
    }
    console.log();
    console.log(`  By State:`);
    for (const [state, { count, lamports }] of Object.entries(byState).sort((a, b) => b[1].lamports - a[1].lamports)) {
      console.log(`    ${state.padEnd(20)} ${String(count).padStart(6)} accounts   ${(lamports / LAMPORTS_PER_SOL).toFixed(6).padStart(12)} SOL`);
    }

    // Show sweepable accounts detail
    const sweepable = group.filter((r) => r.sweepable);
    if (sweepable.length > 0 && sweepable.length <= 200) {
      console.log();
      console.log(`  Sweepable accounts (${sweepable.length}):`);
      console.log(`  ${"Address".padEnd(20)} ${"Type".padEnd(14)} ${"State".padEnd(10)} ${"SOL".padStart(12)}  Action`);
      console.log(`  ${"-".repeat(20)} ${"-".repeat(14)} ${"-".repeat(10)} ${"-".repeat(12)}  ----------`);
      for (const r of sweepable.slice(0, 100)) {
        const addr = r.address.slice(0, 6) + ".." + r.address.slice(-4);
        console.log(
          `  ${addr.padEnd(20)} ${r.type.padEnd(14)} ${(r.state ?? "-").padEnd(10)} ${r.sol.toFixed(6).padStart(12)}  ${r.action ?? "-"}`,
        );
      }
      if (sweepable.length > 100) {
        console.log(`  ... and ${sweepable.length - 100} more`);
      }
    } else if (sweepable.length > 200) {
      console.log();
      console.log(`  ${sweepable.length} sweepable accounts (too many to list)`);
      const sweepLamports = sweepable.reduce((s, r) => s + r.lamports, 0);
      console.log(`  Total sweepable: ${(sweepLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
    }
  }

  // Totals
  const totalLamports = allReports.reduce((s, r) => s + r.lamports, 0);
  const sweepableLamports = allReports.filter((r) => r.sweepable).reduce((s, r) => s + r.lamports, 0);
  const oldLamports = allReports.filter((r) => r.programLabel === "OLD").reduce((s, r) => s + r.lamports, 0);
  const newLamports = allReports.filter((r) => r.programLabel === "NEW").reduce((s, r) => s + r.lamports, 0);

  console.log();
  console.log("=".repeat(70));
  console.log("  SUMMARY");
  console.log("=".repeat(70));
  console.log(`  Total accounts:     ${allReports.length}`);
  console.log(`  Old program:        ${allReports.filter((r) => r.programLabel === "OLD").length} accounts, ${(oldLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
  console.log(`  New program:        ${allReports.filter((r) => r.programLabel === "NEW").length} accounts, ${(newLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
  console.log(`  Total SOL locked:   ${(totalLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
  console.log(`  Sweepable SOL:      ${(sweepableLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`);

  if (!execute) {
    console.log();
    console.log("  DRY RUN — no transactions sent. Use --execute to sweep.");
    console.log();
    return;
  }

  // ---------------------------------------------------------------------------
  // Execute Sweep — both programs
  // ---------------------------------------------------------------------------

  console.log();
  console.log("=".repeat(70));
  console.log("  EXECUTING SWEEP");
  console.log("=".repeat(70));

  // Load admin keypair — supports inline JSON/base58 or file path
  const adminKeyRaw = process.env.SOLANA_DEPLOYER_KEYPAIR?.trim();
  const adminKeyPath = process.env.SOLANA_DEPLOYER_KEYPAIR_PATH?.trim();

  let adminKeypairBytes: Uint8Array;
  if (adminKeyRaw) {
    try {
      const parsed = JSON.parse(adminKeyRaw);
      adminKeypairBytes = Uint8Array.from(parsed);
    } catch {
      adminKeypairBytes = anchor.utils.bytes.bs58.decode(adminKeyRaw);
    }
  } else if (adminKeyPath) {
    const fs = await import("node:fs");
    try {
      const raw = fs.readFileSync(adminKeyPath, "utf-8");
      const parsed = JSON.parse(raw);
      adminKeypairBytes = Uint8Array.from(parsed);
      console.log(`  Loaded keypair from ${adminKeyPath}`);
    } catch (err: any) {
      console.error(`  ERROR: Failed to read keypair from ${adminKeyPath}: ${err.message}`);
      process.exit(1);
    }
  } else {
    console.error("  ERROR: Set SOLANA_DEPLOYER_KEYPAIR or SOLANA_DEPLOYER_KEYPAIR_PATH. Cannot execute sweep.");
    process.exit(1);
  }

  const adminKeypair = anchor.web3.Keypair.fromSecretKey(adminKeypairBytes);
  console.log(`  Admin: ${adminKeypair.publicKey.toBase58()}`);

  // Load IDL
  let idl: any;
  try {
    idl = require("../lib/idl/rumble_engine.json");
  } catch {
    console.error("  ERROR: Could not load rumble_engine.json IDL");
    process.exit(1);
  }

  const wallet = new anchor.Wallet(adminKeypair);
  const provider = new anchor.AnchorProvider(conn, wallet, {
    commitment: "confirmed",
    skipPreflight: true,
  });

  let totalSwept = 0;
  let totalErrors = 0;
  let totalSolRecovered = 0;

  for (const { id: programId, label } of programs) {
    // Create program instance with the right program ID
    const programIdl = { ...idl, address: programId.toBase58() };
    const program = new anchor.Program(programIdl, provider);

    const [configPda] = PublicKey.findProgramAddressSync([CONFIG_SEED], programId);

    // Check if config exists for this program
    let treasury: PublicKey;
    try {
      const configInfo = await conn.getAccountInfo(configPda);
      if (!configInfo) {
        console.log(`\n  [${label}] Config PDA not found — skipping program`);
        continue;
      }
      treasury = new PublicKey(configInfo.data.subarray(8 + 32, 8 + 32 + 32));
      console.log(`\n  [${label}] Config found. Treasury: ${treasury.toBase58()}`);
    } catch (err: any) {
      console.log(`\n  [${label}] Failed to read config: ${err.message?.slice(0, 80)} — skipping`);
      continue;
    }

    // Verify admin matches
    try {
      const configInfo = await conn.getAccountInfo(configPda);
      if (configInfo) {
        const configAdmin = new PublicKey(configInfo.data.subarray(8, 8 + 32));
        if (!configAdmin.equals(adminKeypair.publicKey)) {
          console.log(`  [${label}] Admin mismatch! Config admin: ${configAdmin.toBase58()}`);
          console.log(`  [${label}] Our admin:    ${adminKeypair.publicKey.toBase58()}`);
          console.log(`  [${label}] Skipping — cannot sweep with wrong admin key`);
          continue;
        }
        console.log(`  [${label}] Admin key matches config.`);
      }
    } catch {}

    let swept = 0;
    let errors = 0;

    // --- Sweep Rumble accounts ---
    const sweepableRumbles = allReports.filter(
      (r) => r.type === "Rumble" && r.programLabel === label && r.sweepable && r.rumbleId !== undefined,
    );
    console.log(`  [${label}] ${sweepableRumbles.length} sweepable Rumble accounts`);

    for (const report of sweepableRumbles) {
      const rumbleId = report.rumbleId!;
      const rumbleBuf = Buffer.alloc(8);
      rumbleBuf.writeBigUInt64LE(BigInt(rumbleId));
      const [rumblePda] = PublicKey.findProgramAddressSync([RUMBLE_SEED, rumbleBuf], programId);
      const [vaultPda] = PublicKey.findProgramAddressSync([VAULT_SEED, rumbleBuf], programId);

      const stateTag = report.state ?? "?";
      process.stdout.write(`  [${label}] Rumble ${rumbleId} (${stateTag})... `);

      // Step 1: If betting, report dummy result
      if (report.state === "betting") {
        try {
          const data = (await conn.getAccountInfo(rumblePda))?.data;
          const fighterCount = data && data.length >= 18 ? data[17] : 12;
          const placements = Array.from({ length: fighterCount }, (_, i) => (i === 0 ? 1 : i + 1));

          const method = (program.methods as any)
            .reportResult(Buffer.from(placements), 0)
            .accounts({ admin: adminKeypair.publicKey, config: configPda, rumble: rumblePda });

          const sig = await sendTx(method, adminKeypair, conn);
          process.stdout.write(`reportResult OK → `);
        } catch (err: any) {
          console.log(`reportResult FAILED: ${err.message?.slice(0, 80)}`);
          errors++;
          continue;
        }
        await sleep(1500);
      }

      // Step 2: Complete rumble (from betting→payout or payout→complete)
      if (report.state === "betting" || report.state === "payout") {
        try {
          const method = (program.methods as any)
            .completeRumble()
            .accounts({ admin: adminKeypair.publicKey, config: configPda, rumble: rumblePda });

          const sig = await sendTx(method, adminKeypair, conn);
          process.stdout.write(`complete OK → `);
        } catch (err: any) {
          const msg = err.message ?? "";
          if (msg.includes("ClaimWindowActive")) {
            console.log(`BLOCKED (claim window active)`);
          } else {
            console.log(`complete FAILED: ${msg.slice(0, 80)}`);
            errors++;
          }
          continue;
        }
        await sleep(1000);
      }

      // Step 3: Sweep treasury
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
          totalSolRecovered += vaultBalance / LAMPORTS_PER_SOL;
          process.stdout.write(`sweep ${(vaultBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL → `);
          await sleep(500);
        }
      } catch (err: any) {
        process.stdout.write(`sweep FAILED → `);
      }

      // Step 4: Close rumble PDA
      try {
        const method = (program.methods as any)
          .closeRumble()
          .accounts({ admin: adminKeypair.publicKey, config: configPda, rumble: rumblePda, vault: vaultPda });

        await provider.sendAndConfirm(await method.transaction(), [adminKeypair], {
          skipPreflight: true,
        });
        const rentRecovered = report.lamports / LAMPORTS_PER_SOL;
        totalSolRecovered += rentRecovered;
        console.log(`closed (${rentRecovered.toFixed(4)} SOL rent)`);
        swept++;
      } catch (err: any) {
        console.log(`close FAILED: ${err.message?.slice(0, 60)}`);
        errors++;
      }
    }

    // --- Close orphaned CombatState PDAs ---
    const combatStates = allReports.filter(
      (r) => r.type === "CombatState" && r.programLabel === label,
    );
    if (combatStates.length > 0) {
      console.log(`  [${label}] ${combatStates.length} CombatState accounts to close`);
    }

    for (const report of combatStates) {
      const rumbleId = report.rumbleId;
      if (rumbleId === undefined) continue;

      const rumbleBuf = Buffer.alloc(8);
      rumbleBuf.writeBigUInt64LE(BigInt(rumbleId));
      const [rumblePda] = PublicKey.findProgramAddressSync([RUMBLE_SEED, rumbleBuf], programId);
      const [combatStatePda] = PublicKey.findProgramAddressSync([COMBAT_STATE_SEED, rumbleBuf], programId);

      try {
        const method = (program.methods as any)
          .closeCombatState()
          .accounts({
            admin: adminKeypair.publicKey,
            config: configPda,
            rumble: rumblePda,
            combatState: combatStatePda,
          });

        await provider.sendAndConfirm(await method.transaction(), [adminKeypair], {
          skipPreflight: true,
        });
        const rentRecovered = report.lamports / LAMPORTS_PER_SOL;
        totalSolRecovered += rentRecovered;
        swept++;
        if (swept % 50 === 0) {
          console.log(`    ... closed ${swept} accounts so far (${totalSolRecovered.toFixed(4)} SOL recovered)`);
        }
      } catch (err: any) {
        errors++;
      }
    }

    console.log(`  [${label}] Done: ${swept} swept, ${errors} errors`);
    totalSwept += swept;
    totalErrors += errors;
  }

  console.log();
  console.log("=".repeat(70));
  console.log("  EXECUTION COMPLETE");
  console.log("=".repeat(70));
  console.log(`  Total accounts swept: ${totalSwept}`);
  console.log(`  Total errors:         ${totalErrors}`);
  console.log(`  SOL recovered:        ~${totalSolRecovered.toFixed(6)} SOL`);
  console.log();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
