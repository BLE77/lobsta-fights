/**
 * End-to-end claim flow test against running Next.js APIs.
 *
 * Prereqs:
 * - Next.js app running (default http://localhost:3000)
 * - wallet has a pending claimable rumble payout
 * - CLAIM_TEST_SECRET_KEY set (JSON array secret key)
 *
 * Usage:
 *   CLAIM_TEST_SECRET_KEY='[1,2,...]' node scripts/test-rumble-claim-flow.mjs
 *   API_URL=http://localhost:3000 CLAIM_TEST_RUMBLE_ID=<uuid> node scripts/test-rumble-claim-flow.mjs
 */

import { Connection, Keypair, Transaction } from "@solana/web3.js";
import fs from "node:fs";
import path from "node:path";

function loadDotEnvLocal() {
  const envPath = path.resolve(process.cwd(), ".env.local");
  if (!fs.existsSync(envPath)) return;
  const contents = fs.readFileSync(envPath, "utf8");
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    while (
      value.length >= 2 &&
      ((value.startsWith("\"") && value.endsWith("\"")) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function keypairFromEnv(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("not array");
    return Keypair.fromSecretKey(Uint8Array.from(parsed));
  } catch {
    throw new Error("CLAIM_TEST_SECRET_KEY must be a JSON array secret key");
  }
}

async function readJson(res) {
  return await res.json();
}

async function main() {
  loadDotEnvLocal();

  const apiUrl = process.env.API_URL ?? "http://localhost:3000";
  const rpcEndpoint = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
  const claimTargetRumbleId = process.env.CLAIM_TEST_RUMBLE_ID ?? null;
  const payer = keypairFromEnv(requireEnv("CLAIM_TEST_SECRET_KEY"));
  const wallet = payer.publicKey.toBase58();

  const connection = new Connection(rpcEndpoint, "confirmed");

  console.log(`[ClaimTest] wallet=${wallet}`);
  console.log(`[ClaimTest] api=${apiUrl}`);
  console.log(`[ClaimTest] rpc=${rpcEndpoint}`);

  const balanceBeforeRes = await fetch(
    `${apiUrl}/api/rumble/balance?wallet=${encodeURIComponent(wallet)}`,
    { method: "GET", headers: { "Content-Type": "application/json" } },
  );
  const balanceBefore = await readJson(balanceBeforeRes);
  if (!balanceBeforeRes.ok) {
    throw new Error(`[ClaimTest] balance before failed: ${balanceBefore?.error ?? balanceBeforeRes.status}`);
  }
  console.log(
    `[ClaimTest] before claimable=${Number(balanceBefore.claimable_sol).toFixed(6)} claimed=${Number(balanceBefore.claimed_sol).toFixed(6)}`,
  );

  const prepareRes = await fetch(`${apiUrl}/api/rumble/claim/prepare`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      wallet_address: wallet,
      rumble_id: claimTargetRumbleId,
    }),
  });
  const prepared = await readJson(prepareRes);
  if (!prepareRes.ok) {
    throw new Error(`[ClaimTest] prepare failed: ${prepared?.error ?? prepareRes.status}`);
  }
  console.log(
    `[ClaimTest] prepared rumble=${prepared.rumble_id} claimable=${Number(prepared.claimable_sol).toFixed(6)} SOL`,
  );

  const tx = Transaction.from(Buffer.from(prepared.transaction_base64, "base64"));
  tx.feePayer = payer.publicKey;
  tx.sign(payer);

  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });

  let blockhash = tx.recentBlockhash;
  let lastValidBlockHeight = tx.lastValidBlockHeight;
  if (!blockhash || typeof lastValidBlockHeight !== "number") {
    const latest = await connection.getLatestBlockhash("confirmed");
    blockhash = latest.blockhash;
    lastValidBlockHeight = latest.lastValidBlockHeight;
  }

  await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    "confirmed",
  );
  console.log(`[ClaimTest] on-chain claim tx confirmed: ${sig}`);

  const confirmRes = await fetch(`${apiUrl}/api/rumble/claim/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      wallet_address: wallet,
      rumble_id: prepared.rumble_id,
      tx_signature: sig,
    }),
  });
  const confirmed = await readJson(confirmRes);
  if (!confirmRes.ok) {
    throw new Error(`[ClaimTest] confirm failed: ${confirmed?.error ?? confirmRes.status}`);
  }
  console.log(
    `[ClaimTest] confirmed on-chain claims=${Number(confirmed.claims_confirmed ?? 0)}`,
  );

  const balanceAfterRes = await fetch(
    `${apiUrl}/api/rumble/balance?wallet=${encodeURIComponent(wallet)}`,
    { method: "GET", headers: { "Content-Type": "application/json" } },
  );
  const balanceAfter = await readJson(balanceAfterRes);
  if (!balanceAfterRes.ok) {
    throw new Error(`[ClaimTest] balance after failed: ${balanceAfter?.error ?? balanceAfterRes.status}`);
  }
  console.log(
    `[ClaimTest] after claimable=${Number(balanceAfter.claimable_sol).toFixed(6)} claimed=${Number(balanceAfter.claimed_sol).toFixed(6)}`,
  );
}

main().catch(error => {
  console.error("[ClaimTest] Fatal:", error);
  process.exit(1);
});
