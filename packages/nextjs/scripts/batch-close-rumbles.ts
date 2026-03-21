/**
 * Batch close stale mainnet rumble PDAs to reclaim rent.
 *
 * Flow per rumble:
 *   Betting (state=0) + empty vault → adminSetResult
 *   Payout  (state=2) + past claim  → completeRumble → closeRumble
 *   Complete(state=3) + empty vault → closeRumble
 *
 * Usage:
 *   npx tsx scripts/batch-close-rumbles.ts [--dry-run] [--batch-size 20]
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import fs from "fs";
import path from "path";
import crypto from "crypto";

// ── Config ──────────────────────────────────────────────────────────────
const PROGRAM_ID = new PublicKey("2TvW4EfbmMe566ZQWZWd8kX34iFR2DM3oBUpjwpRJcqC");
const RPC_URL = "https://guillemette-gux70e-fast-mainnet.helius-rpc.com";
const KEYPAIR_PATH = "/Users/bless/.config/solana/mainnet-admin.json";
const RENT_EXEMPT_MIN = 890_880;
const CLAIM_WINDOW_SECS = 86_400; // 24 hours
const BETTING_STALE_SECS = 3_600; // 1 hour
const TX_DELAY_MS = 400; // delay between txs to avoid rate limits

const CONFIG_SEED = Buffer.from("rumble_config");
const RUMBLE_SEED = Buffer.from("rumble");
const VAULT_SEED = Buffer.from("vault");
const RUMBLE_DISCRIMINATOR = crypto
  .createHash("sha256")
  .update("account:Rumble")
  .digest()
  .subarray(0, 8);

// Field offsets (after 8-byte Anchor discriminator)
const BETTING_POOLS_OFFSET = 8 + 8 + 1 + 512 + 1; // 530
const WINNER_INDEX_OFFSET = BETTING_POOLS_OFFSET + 128 + 8 + 8 + 8 + 16; // 698
const BETTING_DEADLINE_OFFSET = WINNER_INDEX_OFFSET + 1; // 699
const COMPLETED_AT_OFFSET = BETTING_DEADLINE_OFFSET + 8 + 8; // 715

// ── Helpers ─────────────────────────────────────────────────────────────

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

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const batchIdx = args.indexOf("--batch-size");
  const batchSize = batchIdx >= 0 ? parseInt(args[batchIdx + 1], 10) : 50;

  console.log(`\n=== Batch Close Mainnet Rumbles ===`);
  console.log(`Dry run: ${dryRun}, Batch size: ${batchSize}\n`);

  // Load keypair
  const keypairData = JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf-8"));
  const admin = Keypair.fromSecretKey(Uint8Array.from(keypairData));
  console.log(`Admin: ${admin.publicKey.toBase58()}`);

  // Connection & provider
  const conn = new Connection(RPC_URL, "confirmed");
  const wallet = new anchor.Wallet(admin);
  const provider = new anchor.AnchorProvider(conn, wallet, {
    commitment: "confirmed",
  });

  // Load IDL
  const idlPath = path.resolve(__dirname, "../lib/idl/rumble_engine.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  const program = new anchor.Program(
    {
      ...idl,
      address: PROGRAM_ID.toBase58(),
    },
    provider,
  );

  const [configPda] = deriveConfigPda();
  const adminBalance = await conn.getBalance(admin.publicKey);
  console.log(`Admin balance: ${(adminBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

  // Read treasury from config
  const configInfo = await conn.getAccountInfo(configPda);
  if (!configInfo) {
    console.error("Config PDA not found!");
    return;
  }
  const treasury = new PublicKey(configInfo.data.subarray(8 + 32, 8 + 32 + 32));
  console.log(`Treasury: ${treasury.toBase58()}`);

  // Fetch all program accounts
  console.log("\nFetching program accounts...");
  const accounts = await conn.getProgramAccounts(PROGRAM_ID);
  console.log(`Found ${accounts.length} accounts\n`);

  const now = Math.floor(Date.now() / 1000);
  const stateNames: Record<number, string> = {
    0: "betting",
    1: "combat",
    2: "payout",
    3: "complete",
  };

  // Parse and classify
type Candidate = {
    rumbleId: number;
    state: number;
    stateName: string;
    pda: PublicKey;
    lamports: number;
    fighterCount: number;
    bettingDeadline: number;
    completedAt: number;
    winnerIndex: number;
    winnerPoolLamports: number;
  };

  const candidates: Candidate[] = [];

  for (const acct of accounts) {
    const data = acct.account.data;
    if (data.length < 700 || data.length > 730) continue;
    if (!data.subarray(0, 8).equals(RUMBLE_DISCRIMINATOR)) continue;

    let rumbleId: number;
    try {
      rumbleId = Number(data.readBigUInt64LE(8));
    } catch {
      continue;
    }
    if (!Number.isSafeInteger(rumbleId) || rumbleId < 0) continue;

    const state = data[16];
    const stateName = stateNames[state] ?? `unknown(${state})`;
    const fighterCount = data[8 + 8 + 1 + 512];
    const bettingDeadline = state === 0 ? Number(data.readBigInt64LE(BETTING_DEADLINE_OFFSET)) : 0;
    const completedAt = Number(data.readBigInt64LE(COMPLETED_AT_OFFSET));
    const winnerIndex = data[WINNER_INDEX_OFFSET];
    let winnerPoolLamports = 0;
    try {
      winnerPoolLamports = Number(data.readBigUInt64LE(BETTING_POOLS_OFFSET + winnerIndex * 8));
    } catch {}

    candidates.push({
      rumbleId,
      state,
      stateName,
      pda: acct.pubkey,
      lamports: acct.account.lamports,
      fighterCount,
      bettingDeadline,
      completedAt,
      winnerIndex,
      winnerPoolLamports,
    });
  }

  candidates.sort((a, b) => a.rumbleId - b.rumbleId);

  // Batch-fetch vault balances using getMultipleAccounts (100 at a time)
  console.log("Batch-fetching vault balances...");
  const vaultBalanceMap = new Map<number, number>();
  const VAULT_BATCH = 100;
  for (let i = 0; i < candidates.length; i += VAULT_BATCH) {
    const chunk = candidates.slice(i, i + VAULT_BATCH);
    const vaultKeys = chunk.map((c) => deriveVaultPda(c.rumbleId)[0]);
    try {
      const infos = await conn.getMultipleAccountsInfo(vaultKeys);
      for (let j = 0; j < chunk.length; j++) {
        vaultBalanceMap.set(chunk[j].rumbleId, infos[j]?.lamports ?? 0);
      }
    } catch {
      // fallback: mark all as 0
      for (const c of chunk) vaultBalanceMap.set(c.rumbleId, 0);
    }
    if (i + VAULT_BATCH < candidates.length) await sleep(200);
  }
  console.log(`Fetched ${vaultBalanceMap.size} vault balances\n`);

  // Classify actions
  type Action = {
    candidate: Candidate;
    steps: string[];
    vaultBalance: number;
  };

  const actions: Action[] = [];

  for (const c of candidates) {
    const vaultBalance = vaultBalanceMap.get(c.rumbleId) ?? 0;
    const hasUnclaimedSol = vaultBalance > RENT_EXEMPT_MIN;

    // State 0: Betting
    if (c.state === 0) {
      const staleBetting =
        c.bettingDeadline > 0 && now - c.bettingDeadline > BETTING_STALE_SECS;
      if (!staleBetting) continue;
      if (hasUnclaimedSol) continue; // has real bets, skip

      actions.push({
        candidate: c,
        steps: ["adminSetResult"],
        vaultBalance,
      });
    }

    // State 2: Payout past claim window
    if (c.state === 2) {
      const pastClaim = c.completedAt > 0 && now - c.completedAt > CLAIM_WINDOW_SECS;
      if (!pastClaim) continue;

      if (hasUnclaimedSol && c.winnerPoolLamports > 0) continue; // winners haven't claimed

      const steps: string[] = [];
      if (hasUnclaimedSol && c.winnerPoolLamports === 0) {
        steps.push("sweepTreasury");
      }
      steps.push("completeRumble", "closeRumble");
      actions.push({ candidate: c, steps, vaultBalance });
    }

    // State 3: Complete past claim window
    if (c.state === 3) {
      const pastClaim = c.completedAt > 0 && now - c.completedAt > CLAIM_WINDOW_SECS;
      if (!pastClaim) continue;

      if (hasUnclaimedSol && c.winnerPoolLamports > 0) continue;

      const steps: string[] = [];
      if (hasUnclaimedSol && c.winnerPoolLamports === 0) {
        steps.push("sweepTreasury");
      }
      steps.push("closeRumble");
      actions.push({ candidate: c, steps, vaultBalance });
    }
  }

  actions.sort((a, b) => {
    const priority = (state: number) => {
      if (state === 3) return 0;
      if (state === 2) return 1;
      if (state === 0) return 2;
      return 3;
    };
    return priority(a.candidate.state) - priority(b.candidate.state) || a.candidate.rumbleId - b.candidate.rumbleId;
  });

  console.log(`\nActionable rumbles: ${actions.length}`);
  const totalRentRecoverable = actions.reduce((s, a) => s + a.candidate.lamports, 0);
  console.log(
    `Total rent tied to actionable rumbles: ${(totalRentRecoverable / LAMPORTS_PER_SOL).toFixed(4)} SOL\n`,
  );

  // State breakdown
  const breakdown: Record<string, number> = {};
  for (const a of actions) {
    breakdown[a.candidate.stateName] = (breakdown[a.candidate.stateName] ?? 0) + 1;
  }
  for (const [state, count] of Object.entries(breakdown)) {
    console.log(`  ${state}: ${count}`);
  }

  if (dryRun) {
    console.log("\n[DRY RUN] Would process these rumbles:");
    for (const a of actions.slice(0, 20)) {
      console.log(
        `  #${a.candidate.rumbleId} (${a.candidate.stateName}) → ${a.steps.join(" → ")} | rent: ${(a.candidate.lamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`,
      );
    }
    if (actions.length > 20) console.log(`  ... and ${actions.length - 20} more`);
    return;
  }

  // Execute in batches
  const batch = actions.slice(0, batchSize);
  let closed = 0;
  let swept = 0;
  let advanced = 0;
  let failed = 0;
  let reclaimedLamports = 0;

  console.log(`\nProcessing ${batch.length} rumbles...\n`);

  for (const action of batch) {
    const { candidate: c, steps } = action;
    const [rumblePda] = deriveRumblePda(c.rumbleId);
    const [vaultPda] = deriveVaultPda(c.rumbleId);

    process.stdout.write(`  #${c.rumbleId} (${c.stateName}): `);

    let ok = true;

    for (const step of steps) {
      if (!ok) break;

      let method: any;

      if (step === "adminSetResult") {
        const placements = Buffer.from(
          Array.from({ length: c.fighterCount }, (_, i) => i + 1),
        );
        method = (program.methods as any)
          .adminSetResult(placements, 0)
          .accounts({
            admin: admin.publicKey,
            config: configPda,
            rumble: rumblePda,
            vault: vaultPda,
            treasury,
            systemProgram: SystemProgram.programId,
          });
      } else if (step === "completeRumble") {
        method = (program.methods as any)
          .completeRumble()
          .accounts({ admin: admin.publicKey, config: configPda, rumble: rumblePda });
      } else if (step === "sweepTreasury") {
        method = (program.methods as any).sweepTreasury().accounts({
          admin: admin.publicKey,
          config: configPda,
          rumble: rumblePda,
          vault: vaultPda,
          treasury,
          systemProgram: SystemProgram.programId,
        });
      } else if (step === "closeRumble") {
        method = (program.methods as any).closeRumble().accounts({
          admin: admin.publicKey,
          config: configPda,
          rumble: rumblePda,
          vault: vaultPda,
          treasury,
          systemProgram: SystemProgram.programId,
        });
      }

      const sig = await sendTx(method, admin, conn);
      if (sig) {
        process.stdout.write(`${step}(ok) `);
        if (step === "sweepTreasury") swept++;
        await sleep(TX_DELAY_MS);
      } else {
        process.stdout.write(`${step}(FAIL) `);
        ok = false;
        failed++;
      }
    }

    if (ok) {
      if (steps.includes("closeRumble")) {
        closed++;
        reclaimedLamports += c.lamports;
        process.stdout.write(`✓ reclaimed ${(c.lamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
      } else {
        advanced++;
        process.stdout.write(`✓ moved to payout window`);
      }
    }
    console.log();
  }

  const finalBalance = await conn.getBalance(admin.publicKey);
  console.log(`\n=== Results ===`);
  console.log(`Closed: ${closed}, Swept: ${swept}, Advanced: ${advanced}, Failed: ${failed}`);
  console.log(`Rent reclaimed: ~${(reclaimedLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  console.log(`Admin balance: ${(finalBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
}

main().catch(console.error);
