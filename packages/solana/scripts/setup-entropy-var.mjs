#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { keccak_256 } from "@noble/hashes/sha3";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_SLOT_HASHES_PUBKEY,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

const DEFAULT_RPC = "https://api.devnet.solana.com";
const DEFAULT_ENTROPY_PROGRAM_ID = "7gMbCEuZQ2E3tEs3ZU6m7aZNkkVDyJJDEyr49dzq8BRD";
const VAR_SEED = Buffer.from("var");
const U64_MAX = 0xffff_ffff_ffff_ffffn;

function expandHome(inputPath) {
  if (!inputPath.startsWith("~")) return inputPath;
  return path.join(os.homedir(), inputPath.slice(1));
}

function loadKeypairFromFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const secret = Uint8Array.from(JSON.parse(raw));
  return Keypair.fromSecretKey(secret);
}

function toU64Le(value) {
  const n = BigInt(value);
  if (n < 0n || n > U64_MAX) throw new Error(`u64 out of range: ${value}`);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(n, 0);
  return buf;
}

function parseU64Le(data, offset) {
  return data.readBigUInt64LE(offset);
}

function decodeVar(data) {
  if (data.length < 232) throw new Error(`entropy var account too small: ${data.length}`);
  const base = data.length >= 240 ? 8 : 0;
  if (data.length < base + 232) throw new Error(`entropy var layout mismatch: ${data.length}`);

  const readPk = (offset) => new PublicKey(data.subarray(base + offset, base + offset + 32));
  const read32 = (offset) => Buffer.from(data.subarray(base + offset, base + offset + 32));
  const readU64 = (offset) => parseU64Le(data, base + offset);

  return {
    authority: readPk(0),
    id: readU64(32),
    provider: readPk(40),
    commit: read32(72),
    seed: read32(104),
    slotHash: read32(136),
    value: read32(168),
    samples: readU64(200),
    isAuto: readU64(208),
    startAt: readU64(216),
    endAt: readU64(224),
  };
}

function isZero32(buf) {
  for (let i = 0; i < 32; i += 1) {
    if (buf[i] !== 0) return false;
  }
  return true;
}

function hex32(buf) {
  return Buffer.from(buf).toString("hex");
}

async function sendIx(connection, payer, ix) {
  const tx = new Transaction().add(ix);
  tx.feePayer = payer.publicKey;
  const sig = await sendAndConfirmTransaction(connection, tx, [payer], {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  return sig;
}

async function waitUntilSlot(connection, targetSlot) {
  const target = Number(targetSlot);
  while (true) {
    const current = await connection.getSlot("confirmed");
    if (current >= target) return current;
    const remaining = target - current;
    console.log(`Waiting for target slot ${target} (current ${current}, +${remaining})...`);
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

async function main() {
  const rpcUrl = process.env.SOLANA_RPC_URL || DEFAULT_RPC;
  const keypairPath = expandHome(
    process.env.SOLANA_KEYPAIR_PATH || process.env.KEYPAIR || "~/.config/solana/id.json",
  );
  const entropyProgramId = new PublicKey(
    process.env.ENTROPY_PROGRAM_ID ||
      process.env.ICHOR_ENTROPY_PROGRAM_ID ||
      DEFAULT_ENTROPY_PROGRAM_ID,
  );

  const payer = loadKeypairFromFile(keypairPath);
  const connection = new Connection(rpcUrl, "confirmed");

  const varAuthority = new PublicKey(
    process.env.ENTROPY_VAR_AUTHORITY || process.env.ICHOR_ENTROPY_AUTHORITY || payer.publicKey,
  );
  const provider = new PublicKey(
    process.env.ENTROPY_VAR_PROVIDER || process.env.ICHOR_ENTROPY_PROVIDER || payer.publicKey,
  );

  const varId = BigInt(process.env.ENTROPY_VAR_ID || "1");
  const samples = BigInt(process.env.ENTROPY_VAR_SAMPLES || "999998");
  const endDelay = BigInt(process.env.ENTROPY_END_SLOT_DELAY || "20");
  const requestedSeedHex = process.env.ENTROPY_SEED_HEX || "";
  const seed = requestedSeedHex
    ? Buffer.from(requestedSeedHex.replace(/^0x/, ""), "hex")
    : randomBytes(32);
  if (seed.length !== 32) throw new Error("ENTROPY_SEED_HEX must be 32 bytes");

  const [varPda] = PublicKey.findProgramAddressSync(
    [VAR_SEED, varAuthority.toBuffer(), toU64Le(varId)],
    entropyProgramId,
  );

  console.log(`RPC: ${rpcUrl}`);
  console.log(`Payer: ${payer.publicKey.toBase58()}`);
  console.log(`Entropy Program: ${entropyProgramId.toBase58()}`);
  console.log(`Var PDA: ${varPda.toBase58()}`);
  console.log(`Authority: ${varAuthority.toBase58()}`);
  console.log(`Provider: ${provider.toBase58()}`);

  let accountInfo = await connection.getAccountInfo(varPda, "confirmed");
  if (!accountInfo) {
    if (!varAuthority.equals(payer.publicKey)) {
      throw new Error("ENTROPY_VAR_AUTHORITY must equal payer for this setup script");
    }

    const currentSlot = BigInt(await connection.getSlot("confirmed"));
    const endAt = currentSlot + endDelay;
    const commit = Buffer.from(keccak_256(seed));

    const openData = Buffer.concat([
      Buffer.from([0]), // EntropyInstruction::Open
      toU64Le(varId),
      commit,
      toU64Le(0n), // is_auto = false
      toU64Le(samples),
      toU64Le(endAt),
    ]);

    const openIx = new TransactionInstruction({
      programId: entropyProgramId,
      keys: [
        { pubkey: varAuthority, isSigner: true, isWritable: false },
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: provider, isSigner: false, isWritable: false },
        { pubkey: varPda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: openData,
    });

    const openSig = await sendIx(connection, payer, openIx);
    console.log(`Open tx: ${openSig}`);
    console.log(`Committed seed hash: ${hex32(commit)}`);
    console.log(`Raw seed (store safely): ${hex32(seed)}`);

    await waitUntilSlot(connection, endAt);
    accountInfo = await connection.getAccountInfo(varPda, "confirmed");
  }

  if (!accountInfo) throw new Error("Entropy var account missing after open");
  if (!accountInfo.owner.equals(entropyProgramId)) {
    throw new Error(
      `Entropy var owner mismatch: expected ${entropyProgramId.toBase58()}, got ${accountInfo.owner.toBase58()}`,
    );
  }

  let varState = decodeVar(accountInfo.data);
  if (isZero32(varState.slotHash)) {
    const currentSlot = BigInt(await connection.getSlot("confirmed"));
    if (currentSlot < varState.endAt) {
      await waitUntilSlot(connection, varState.endAt);
    }
    const sampleIx = new TransactionInstruction({
      programId: entropyProgramId,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: false },
        { pubkey: varPda, isSigner: false, isWritable: true },
        { pubkey: SYSVAR_SLOT_HASHES_PUBKEY, isSigner: false, isWritable: false },
      ],
      data: Buffer.from([5]), // EntropyInstruction::Sample
    });
    const sampleSig = await sendIx(connection, payer, sampleIx);
    console.log(`Sample tx: ${sampleSig}`);
    accountInfo = await connection.getAccountInfo(varPda, "confirmed");
    if (!accountInfo) throw new Error("Entropy var account disappeared after sample");
    varState = decodeVar(accountInfo.data);
  }

  if (isZero32(varState.seed)) {
    const commitFromSeed = Buffer.from(keccak_256(seed));
    if (hex32(commitFromSeed) !== hex32(varState.commit)) {
      throw new Error(
        "Cannot reveal: provided seed does not match var commit. Set ENTROPY_SEED_HEX to the original seed used at open.",
      );
    }
    const revealData = Buffer.concat([
      Buffer.from([4]), // EntropyInstruction::Reveal
      seed,
    ]);
    const revealIx = new TransactionInstruction({
      programId: entropyProgramId,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: false },
        { pubkey: varPda, isSigner: false, isWritable: true },
      ],
      data: revealData,
    });
    const revealSig = await sendIx(connection, payer, revealIx);
    console.log(`Reveal tx: ${revealSig}`);
    accountInfo = await connection.getAccountInfo(varPda, "confirmed");
    if (!accountInfo) throw new Error("Entropy var account disappeared after reveal");
    varState = decodeVar(accountInfo.data);
  }

  if (isZero32(varState.value)) {
    throw new Error("Entropy var value is still zero after setup");
  }

  console.log("Entropy var finalized:");
  console.log(`  var: ${varPda.toBase58()}`);
  console.log(`  authority: ${varState.authority.toBase58()}`);
  console.log(`  provider: ${varState.provider.toBase58()}`);
  console.log(`  end_at: ${varState.endAt.toString()}`);
  console.log(`  value: ${hex32(varState.value)}`);
  console.log("");
  console.log("Use these env values:");
  console.log(`  ICHOR_ENTROPY_ENABLED=true`);
  console.log(`  ICHOR_ENTROPY_PROGRAM_ID=${entropyProgramId.toBase58()}`);
  console.log(`  ICHOR_ENTROPY_VAR=${varPda.toBase58()}`);
  console.log(`  ICHOR_ENTROPY_PROVIDER=${varState.provider.toBase58()}`);
  console.log(`  ICHOR_ENTROPY_AUTHORITY=${varState.authority.toBase58()}`);
}

main().catch((err) => {
  console.error(`setup-entropy-var failed: ${err.message || err}`);
  process.exit(1);
});
