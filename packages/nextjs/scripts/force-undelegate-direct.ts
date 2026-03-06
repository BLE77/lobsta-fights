#!/usr/bin/env npx tsx
/**
 * Force-undelegate a stuck combat state PDA by calling MagicBlock's
 * commitAndUndelegate instruction DIRECTLY (bypasses rumble_engine program).
 *
 * This avoids the AccountDiscriminatorNotFound error that occurs when
 * the ER validator can't read non-delegated accounts (like config).
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/force-undelegate-direct.ts --rumble-id 6193
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { deriveCombatStatePda } from "../lib/solana-programs";
import { getConnection, getErRpcEndpoint, getRpcEndpoint } from "../lib/solana-connection";
import bs58 from "bs58";
import fs from "fs";

function getAdminKeypair(): Keypair | null {
  const raw = process.env.SOLANA_DEPLOYER_KEYPAIR?.trim();
  if (!raw) {
    const path = process.env.SOLANA_DEPLOYER_KEYPAIR_PATH?.trim();
    if (path) {
      const data = JSON.parse(fs.readFileSync(path, "utf-8"));
      return Keypair.fromSecretKey(new Uint8Array(data));
    }
    return null;
  }
  if (raw.startsWith("[")) {
    return Keypair.fromSecretKey(new Uint8Array(JSON.parse(raw)));
  }
  return Keypair.fromSecretKey(bs58.decode(raw));
}

const MAGIC_PROGRAM_ID = new PublicKey("Magic11111111111111111111111111111111111111");
const MAGIC_CONTEXT_ID = new PublicKey("MagicContext1111111111111111111111111111111");
const DELEGATION_PROGRAM_ID = "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh";

function createCommitAndUndelegateInstruction(
  payer: PublicKey,
  accountsToUndelegate: PublicKey[],
): TransactionInstruction {
  const accounts = [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: MAGIC_CONTEXT_ID, isSigner: false, isWritable: true },
    ...accountsToUndelegate.map((account) => ({
      pubkey: account,
      isSigner: false,
      isWritable: true,
    })),
  ];
  const data = Buffer.alloc(4);
  data.writeUInt32LE(2, 0);
  return new TransactionInstruction({
    keys: accounts,
    programId: MAGIC_PROGRAM_ID,
    data,
  });
}

function parseArgs(): { rumbleId: number } {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--rumble-id" || argv[i] === "-r") {
      const val = Number(argv[i + 1]);
      if (!Number.isInteger(val) || val < 0) throw new Error(`Invalid rumble id: ${argv[i + 1]}`);
      return { rumbleId: val };
    }
  }
  throw new Error("Usage: --rumble-id <id>");
}

async function readL1Owner(conn: Connection, pda: PublicKey): Promise<string | null> {
  try {
    const info = await conn.getAccountInfo(pda, "confirmed");
    return info?.owner.toBase58() ?? null;
  } catch {
    return null;
  }
}

async function tryUndelegate(
  label: string,
  endpoint: string,
  admin: Keypair,
  combatStatePda: PublicKey,
  l1Conn: Connection,
): Promise<boolean> {
  console.log(`\n-- ${label}: ${endpoint}`);
  const ownerBefore = await readL1Owner(l1Conn, combatStatePda);
  console.log(`   L1 owner before: ${ownerBefore}`);
  const isDelegated = ownerBefore === DELEGATION_PROGRAM_ID;
  if (!isDelegated) {
    console.log("   NOT delegated — skipping");
    return true;
  }

  const conn = new Connection(endpoint, {
    commitment: "confirmed",
    wsEndpoint: endpoint.replace("https://", "wss://"),
  });

  const ix = createCommitAndUndelegateInstruction(admin.publicKey, [combatStatePda]);
  const tx = new Transaction().add(ix);
  tx.feePayer = admin.publicKey;

  try {
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("processed");
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    tx.sign(admin);

    const sig = await conn.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
      maxRetries: 3,
    });
    console.log(`   Sent: ${sig}`);

    // Try to confirm
    try {
      const confirmation = await Promise.race([
        conn.confirmTransaction(sig, "confirmed"),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 30_000)),
      ]);
      if (confirmation.value?.err) {
        console.log(`   Confirmed with error: ${JSON.stringify(confirmation.value.err)}`);
      } else {
        console.log(`   Confirmed successfully!`);
      }
    } catch (e) {
      console.log(`   Confirmation: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Wait a bit and check L1
    await new Promise((r) => setTimeout(r, 3000));
    const ownerAfter = await readL1Owner(l1Conn, combatStatePda);
    console.log(`   L1 owner after: ${ownerAfter}`);
    const undelegated = ownerAfter !== DELEGATION_PROGRAM_ID;
    console.log(`   Undelegated: ${undelegated}`);
    return undelegated;
  } catch (e) {
    console.log(`   Error: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

async function main() {
  const { rumbleId } = parseArgs();
  const admin = getAdminKeypair();
  if (!admin) throw new Error("No admin keypair");

  const [combatStatePda] = deriveCombatStatePda(rumbleId);
  const l1Conn = getConnection();

  console.log("== Force-undelegate (direct MagicBlock program call) ==");
  console.log(`rumble_id: ${rumbleId}`);
  console.log(`admin: ${admin.publicKey.toBase58()}`);
  console.log(`combat_state_pda: ${combatStatePda.toBase58()}`);
  console.log(`l1_rpc: ${getRpcEndpoint()}`);

  const endpoints = [
    { label: "devnet.magicblock.app", url: "https://devnet.magicblock.app" },
    { label: "devnet-us.magicblock.app", url: "https://devnet-us.magicblock.app" },
    { label: "devnet-router.magicblock.app", url: "https://devnet-router.magicblock.app" },
  ];

  // Also add configured ER endpoint if different
  const configuredEr = getErRpcEndpoint();
  if (!endpoints.some((e) => e.url === configuredEr)) {
    endpoints.unshift({ label: `configured: ${configuredEr}`, url: configuredEr });
  }

  for (const { label, url } of endpoints) {
    const success = await tryUndelegate(label, url, admin, combatStatePda, l1Conn);
    if (success) {
      console.log(`\n== SUCCESS: Undelegated via ${label} ==`);
      return;
    }
  }

  console.log("\n== FAILED: No endpoint could undelegate ==");
  console.log("Contact MagicBlock Discord with this output.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
