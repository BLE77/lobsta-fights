#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

const ICHOR_PROGRAM_ID = new PublicKey(
  "925GAeqjKMX4B5MDANB91SZCvrx8HpEgmPJwHJzxKJx1",
);
const ARENA_SEED = Buffer.from("arena_config");
const ENTROPY_CONFIG_SEED = Buffer.from("entropy_config");
const DEFAULT_PUBKEY = new PublicKey("11111111111111111111111111111111");
const EXPECTED_ENTROPY_CONFIG_SPACE = 8 + 131;

function usage() {
  console.log(`Configure ICHOR entropy settings on-chain (upsert_entropy_config).

Required for enable mode:
  ICHOR_ENTROPY_ENABLED=true
  ICHOR_ENTROPY_PROGRAM_ID=<pubkey>
  ICHOR_ENTROPY_VAR=<pubkey>
  ICHOR_ENTROPY_PROVIDER=<pubkey>
  ICHOR_ENTROPY_AUTHORITY=<pubkey>

Optional:
  SOLANA_RPC_URL=<rpc url> (default: https://api.devnet.solana.com)
  SOLANA_DEPLOYER_KEYPAIR_PATH=<path> (default: ~/.config/solana/id.json)

Disable mode:
  ICHOR_ENTROPY_ENABLED=false

Example:
  ICHOR_ENTROPY_ENABLED=true \\
  ICHOR_ENTROPY_PROGRAM_ID=... \\
  ICHOR_ENTROPY_VAR=... \\
  ICHOR_ENTROPY_PROVIDER=... \\
  ICHOR_ENTROPY_AUTHORITY=... \\
  node ./scripts/configure-entropy.mjs
`);
}

function parseBoolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;

  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;

  throw new Error(
    `Invalid boolean for ${name}: "${raw}". Use true/false, 1/0, yes/no, on/off.`,
  );
}

function requiredPubkeyEnv(name) {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  try {
    return new PublicKey(raw.trim());
  } catch {
    throw new Error(`Invalid pubkey in ${name}: "${raw}"`);
  }
}

function loadKeypair(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const secret = Uint8Array.from(JSON.parse(raw));
  return Keypair.fromSecretKey(secret);
}

function anchorGlobalDiscriminator(methodName) {
  return createHash("sha256")
    .update(`global:${methodName}`)
    .digest()
    .subarray(0, 8);
}

function decodeArenaAdmin(arenaData) {
  if (arenaData.length < 40) {
    throw new Error("Arena config account data too short");
  }
  // ArenaConfig: discriminator(8) + admin(32) + ...
  return new PublicKey(arenaData.subarray(8, 40));
}

function decodeEntropyConfig(data) {
  if (data.length < EXPECTED_ENTROPY_CONFIG_SPACE) {
    throw new Error(
      `Entropy config account too short (${data.length} bytes, expected >= ${EXPECTED_ENTROPY_CONFIG_SPACE})`,
    );
  }
  return {
    initialized: data[8] === 1,
    enabled: data[9] === 1,
    bump: data[10],
    entropyProgramId: new PublicKey(data.subarray(11, 43)),
    entropyVar: new PublicKey(data.subarray(43, 75)),
    provider: new PublicKey(data.subarray(75, 107)),
    varAuthority: new PublicKey(data.subarray(107, 139)),
  };
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    usage();
    return;
  }

  const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
  const keypairPath =
    process.env.SOLANA_DEPLOYER_KEYPAIR_PATH ||
    path.join(os.homedir(), ".config/solana/id.json");
  const enabled = parseBoolEnv("ICHOR_ENTROPY_ENABLED", true);

  const entropyProgramId = enabled
    ? requiredPubkeyEnv("ICHOR_ENTROPY_PROGRAM_ID")
    : DEFAULT_PUBKEY;
  const entropyVar = enabled ? requiredPubkeyEnv("ICHOR_ENTROPY_VAR") : DEFAULT_PUBKEY;
  const entropyProvider = enabled
    ? requiredPubkeyEnv("ICHOR_ENTROPY_PROVIDER")
    : DEFAULT_PUBKEY;
  const entropyAuthority = enabled
    ? requiredPubkeyEnv("ICHOR_ENTROPY_AUTHORITY")
    : DEFAULT_PUBKEY;

  const connection = new Connection(rpcUrl, "confirmed");
  const payer = loadKeypair(keypairPath);
  const [arenaConfigPda] = PublicKey.findProgramAddressSync(
    [ARENA_SEED],
    ICHOR_PROGRAM_ID,
  );
  const [entropyConfigPda] = PublicKey.findProgramAddressSync(
    [ENTROPY_CONFIG_SEED],
    ICHOR_PROGRAM_ID,
  );

  console.log(`RPC: ${rpcUrl}`);
  console.log(`Authority: ${payer.publicKey.toBase58()}`);
  console.log(`Arena config PDA: ${arenaConfigPda.toBase58()}`);
  console.log(`Entropy config PDA: ${entropyConfigPda.toBase58()}`);
  console.log(`Entropy enabled target: ${enabled}`);

  const arenaAccount = await connection.getAccountInfo(arenaConfigPda, "confirmed");
  if (!arenaAccount) {
    throw new Error(`Arena config PDA not found: ${arenaConfigPda.toBase58()}`);
  }
  if (!arenaAccount.owner.equals(ICHOR_PROGRAM_ID)) {
    throw new Error(
      `Arena config owner mismatch: expected ${ICHOR_PROGRAM_ID.toBase58()}, got ${arenaAccount.owner.toBase58()}`,
    );
  }

  const arenaAdmin = decodeArenaAdmin(arenaAccount.data);
  if (!arenaAdmin.equals(payer.publicKey)) {
    throw new Error(
      `Authority mismatch. Arena admin=${arenaAdmin.toBase58()}, signer=${payer.publicKey.toBase58()}`,
    );
  }

  const data = Buffer.concat([
    anchorGlobalDiscriminator("upsert_entropy_config"),
    Buffer.from([enabled ? 1 : 0]),
    entropyProgramId.toBuffer(),
    entropyVar.toBuffer(),
    entropyProvider.toBuffer(),
    entropyAuthority.toBuffer(),
  ]);

  const ix = new TransactionInstruction({
    programId: ICHOR_PROGRAM_ID,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: arenaConfigPda, isSigner: false, isWritable: false },
      { pubkey: entropyConfigPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  const tx = new Transaction().add(ix);
  const signature = await sendAndConfirmTransaction(connection, tx, [payer], {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  console.log(`upsert_entropy_config tx: ${signature}`);

  const entropyAccount = await connection.getAccountInfo(entropyConfigPda, "confirmed");
  if (!entropyAccount) {
    throw new Error(`Entropy config account missing after tx: ${entropyConfigPda.toBase58()}`);
  }
  if (!entropyAccount.owner.equals(ICHOR_PROGRAM_ID)) {
    throw new Error(
      `Entropy config owner mismatch: expected ${ICHOR_PROGRAM_ID.toBase58()}, got ${entropyAccount.owner.toBase58()}`,
    );
  }

  const decoded = decodeEntropyConfig(entropyAccount.data);
  console.log(`initialized: ${decoded.initialized}`);
  console.log(`enabled: ${decoded.enabled}`);
  console.log(`bump: ${decoded.bump}`);
  console.log(`entropy_program_id: ${decoded.entropyProgramId.toBase58()}`);
  console.log(`entropy_var: ${decoded.entropyVar.toBase58()}`);
  console.log(`provider: ${decoded.provider.toBase58()}`);
  console.log(`var_authority: ${decoded.varAuthority.toBase58()}`);
}

main().catch((err) => {
  console.error(`configure-entropy failed: ${err.message || err}`);
  process.exit(1);
});
