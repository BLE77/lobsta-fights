/**
 * On-chain transaction verification for spectator bets.
 *
 * Verifies that a submitted tx_signature corresponds to a real SOL transfer
 * from the claimed wallet to our treasury, for the claimed amount.
 */

import { createHash } from "node:crypto";
import { utils as anchorUtils } from "@coral-xyz/anchor";
import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getBettingConnection } from "./solana-connection";
import { getConfiguredTreasuryAddress } from "./treasury";
import { RUMBLE_ENGINE_ID_MAINNET } from "./solana-programs";

/** Tolerance for SOL amount matching (accounts for rounding). */
const AMOUNT_TOLERANCE_SOL = 0.000000001;
const PARSED_TX_MAX_ATTEMPTS = Math.max(4, Number(process.env.RUMBLE_TX_VERIFY_MAX_ATTEMPTS ?? "8"));
const PARSED_TX_BASE_DELAY_MS = Math.max(750, Number(process.env.RUMBLE_TX_VERIFY_DELAY_MS ?? "1500"));

/** Retry getParsedTransaction until the tx is visible (handles fire-and-forget clients). */
async function getParsedTxWithRetry(
  txSignature: string,
  maxAttempts = PARSED_TX_MAX_ATTEMPTS,
  delayMs = PARSED_TX_BASE_DELAY_MS,
) {
  const connection = getBettingConnection();
  for (let i = 0; i < maxAttempts; i++) {
    const tx = await connection.getParsedTransaction(txSignature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    if (tx) return tx;
    if (i < maxAttempts - 1) {
      const backoffMs = Math.min(delayMs * (i + 1), 4_000);
      await new Promise(r => setTimeout(r, backoffMs));
    }
  }
  return null;
}

/** Min/max bet bounds in SOL. */
export const MIN_BET_SOL = 0.02;
export const MAX_BET_SOL = 0.1;

// ---------------------------------------------------------------------------
// Replay protection: in-memory set of used tx signatures
// ---------------------------------------------------------------------------

const usedSignatures = new Set<string>();
let lastCleanup = Date.now();
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const MAX_SIGNATURES = 10_000;

function cleanupSignatures() {
  const now = Date.now();
  if (now - lastCleanup > CLEANUP_INTERVAL_MS || usedSignatures.size > MAX_SIGNATURES) {
    usedSignatures.clear();
    lastCleanup = now;
  }
}

/**
 * Check if a tx signature has already been used for a bet.
 * Returns true if it was already used (replay).
 */
export function markSignatureUsed(sig: string): boolean {
  cleanupSignatures();
  if (usedSignatures.has(sig)) {
    return true; // already used
  }
  usedSignatures.add(sig);
  return false; // first use
}

/**
 * Read-only replay check. Use this before expensive verification.
 */
export function isSignatureUsed(sig: string): boolean {
  cleanupSignatures();
  return usedSignatures.has(sig);
}

/**
 * Remove an in-memory replay lock when bet registration fails and we need to
 * allow safe retry with the same already-confirmed signature.
 */
export function unmarkSignatureUsed(sig: string): void {
  cleanupSignatures();
  usedSignatures.delete(sig);
}

// ---------------------------------------------------------------------------
// Transaction verification
// ---------------------------------------------------------------------------

export interface VerifyResult {
  valid: boolean;
  error?: string;
}

const PLACE_BET_DISCRIMINATOR = createHash("sha256")
  .update("global:place_bet")
  .digest()
  .subarray(0, 8);

interface ParsedPlaceBetInstruction {
  rumbleId: number;
  fighterIndex: number;
  amountLamports: number;
}

/**
 * Verify that a Solana transaction signature corresponds to a real SOL
 * transfer from `expectedWallet` to the treasury for `expectedAmountSol`.
 */
export async function verifyBetTransaction(
  txSignature: string,
  expectedWallet: string,
  expectedAmountSol: number,
): Promise<VerifyResult> {
  try {
    const treasuryAddress = getConfiguredTreasuryAddress();
    try {
      new PublicKey(treasuryAddress);
    } catch {
      return { valid: false, error: "Treasury address is invalid or not configured." };
    }

    const tx = await getParsedTxWithRetry(txSignature);

    if (!tx) {
      return { valid: false, error: "Transaction not found after retries. It may not be confirmed yet." };
    }

    if (tx.meta?.err) {
      return { valid: false, error: "Transaction failed on-chain." };
    }

    // Verify the expected wallet is one of the signers
    const signers = tx.transaction.message.accountKeys
      .filter((k) => k.signer)
      .map((k) => k.pubkey.toBase58());

    if (!signers.includes(expectedWallet)) {
      return {
        valid: false,
        error: "Expected wallet is not a signer of this transaction.",
      };
    }

    // Look for a SOL transfer instruction from expectedWallet to treasury
    const instructions = tx.transaction.message.instructions;
    let foundTransfer = false;
    let transferredLamports = 0;

    for (const ix of instructions) {
      // Parsed system program transfer
      if ("parsed" in ix && ix.program === "system" && ix.parsed?.type === "transfer") {
        const info = ix.parsed.info;
        if (
          info.source === expectedWallet &&
          info.destination === treasuryAddress
        ) {
          foundTransfer = true;
          transferredLamports = info.lamports;
          break;
        }
      }
    }

    // Also check inner instructions (in case of versioned/CPI transfers)
    if (!foundTransfer && tx.meta?.innerInstructions) {
      for (const inner of tx.meta.innerInstructions) {
        for (const ix of inner.instructions) {
          if ("parsed" in ix && ix.program === "system" && ix.parsed?.type === "transfer") {
            const info = ix.parsed.info;
            if (
              info.source === expectedWallet &&
              info.destination === treasuryAddress
            ) {
              foundTransfer = true;
              transferredLamports = info.lamports;
              break;
            }
          }
        }
        if (foundTransfer) break;
      }
    }

    if (!foundTransfer) {
      return {
        valid: false,
        error: "No SOL transfer found from your wallet to the treasury.",
      };
    }

    // Verify amount (within tolerance)
    const transferredSol = transferredLamports / LAMPORTS_PER_SOL;
    const diff = Math.abs(transferredSol - expectedAmountSol);
    if (diff > AMOUNT_TOLERANCE_SOL) {
      return {
        valid: false,
        error: `Transfer amount mismatch: tx has ${transferredSol} SOL, expected ${expectedAmountSol} SOL.`,
      };
    }

    return { valid: true };
  } catch (err: any) {
    return {
      valid: false,
      error: `Verification failed: ${err.message || "unknown error"}`,
    };
  }
}

/**
 * Verify that a transaction includes the expected rumble place_bet instruction.
 */
export async function verifyRumblePlaceBetTransaction(
  txSignature: string,
  expectedWallet: string,
  expectedRumbleId: number,
  expectedFighterIndex: number,
  expectedAmountSol: number,
): Promise<VerifyResult> {
  return verifyRumblePlaceBetBatchTransaction(
    txSignature,
    expectedWallet,
    expectedRumbleId,
    [{ fighterIndex: expectedFighterIndex, amountSol: expectedAmountSol }],
  );
}

/**
 * Verify that a transaction includes all expected rumble place_bet instructions.
 */
export async function verifyRumblePlaceBetBatchTransaction(
  txSignature: string,
  expectedWallet: string,
  expectedRumbleId: number,
  expectedBets: Array<{ fighterIndex: number; amountSol: number }>,
): Promise<VerifyResult> {
  try {
    if (!Array.isArray(expectedBets) || expectedBets.length === 0) {
      return { valid: false, error: "No expected bets provided." };
    }

    const tx = await getParsedTxWithRetry(txSignature);

    if (!tx) {
      return { valid: false, error: "Transaction not found after retries. It may not be confirmed yet." };
    }
    if (tx.meta?.err) {
      return { valid: false, error: "Transaction failed on-chain." };
    }

    const signers = tx.transaction.message.accountKeys
      .filter((k) => k.signer)
      .map((k) => k.pubkey.toBase58());
    if (!signers.includes(expectedWallet)) {
      return {
        valid: false,
        error: "Expected wallet is not a signer of this transaction.",
      };
    }

    const parsedIx = extractRumblePlaceBetInstructions(tx).filter(
      ix => ix.rumbleId === expectedRumbleId,
    );
    if (parsedIx.length === 0) {
      return {
        valid: false,
        error: "No matching rumble place_bet instruction found in this transaction.",
      };
    }

    const toleranceLamports = Math.round(AMOUNT_TOLERANCE_SOL * LAMPORTS_PER_SOL);
    const available = [...parsedIx];

    for (const expected of expectedBets) {
      const expectedLamports = Math.round(expected.amountSol * LAMPORTS_PER_SOL);
      const matchIndex = available.findIndex(ix => {
        if (ix.fighterIndex !== expected.fighterIndex) return false;
        return Math.abs(ix.amountLamports - expectedLamports) <= toleranceLamports;
      });
      if (matchIndex === -1) {
        return {
          valid: false,
          error:
            `Missing expected place_bet leg (fighter=${expected.fighterIndex}, ` +
            `amount=${expectedLamports} lamports) in tx ${txSignature}.`,
        };
      }
      // Consume matched instruction to handle duplicate legs correctly.
      available.splice(matchIndex, 1);
    }

    return { valid: true };
  } catch (err: any) {
    return {
      valid: false,
      error: `Verification failed: ${err.message || "unknown error"}`,
    };
  }
}

function extractRumblePlaceBetInstructions(tx: any): ParsedPlaceBetInstruction[] {
  const out: ParsedPlaceBetInstruction[] = [];
  const expectedProgramId = RUMBLE_ENGINE_ID_MAINNET.toBase58();
  const accountKeys = Array.isArray(tx?.transaction?.message?.accountKeys)
    ? tx.transaction.message.accountKeys
    : [];

  function toBase58(value: unknown): string | null {
    if (!value) return null;
    if (typeof value === "string") return value;
    if (typeof (value as { toBase58?: unknown }).toBase58 === "function") {
      try {
        return (value as { toBase58: () => string }).toBase58();
      } catch {
        return null;
      }
    }
    return null;
  }

  function resolveProgramId(ix: any): string | null {
    const direct = toBase58(ix?.programId);
    if (direct) return direct;
    if (!Number.isInteger(ix?.programIdIndex)) return null;
    const indexed = accountKeys[ix.programIdIndex];
    if (!indexed) return null;
    return toBase58(indexed?.pubkey ?? indexed);
  }

  function decodeData(ix: any): Uint8Array | null {
    const data = ix?.data;
    if (!data) return null;
    if (data instanceof Uint8Array) return data;
    if (Array.isArray(data)) {
      try {
        return Uint8Array.from(data.map((v) => Number(v)));
      } catch {
        return null;
      }
    }
    if (typeof data === "string") {
      try {
        return anchorUtils.bytes.bs58.decode(data);
      } catch {
        try {
          return Uint8Array.from(Buffer.from(data, "base64"));
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  function scanInstruction(ix: any): void {
    try {
      if (resolveProgramId(ix) !== expectedProgramId) return;
      const raw = decodeData(ix);
      if (!raw || raw.length < 25) return;
      if (!Buffer.from(raw.subarray(0, 8)).equals(PLACE_BET_DISCRIMINATOR)) return;

      const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      const rumbleId = Number(view.getBigUint64(8, true));
      const fighterIndex = raw[16] ?? -1;
      const amountLamports = Number(view.getBigUint64(17, true));
      out.push({ rumbleId, fighterIndex, amountLamports });
    } catch {
      // keep scanning
    }
  }

  for (const ix of tx?.transaction?.message?.instructions ?? []) {
    scanInstruction(ix);
  }
  for (const inner of tx?.meta?.innerInstructions ?? []) {
    for (const ix of inner?.instructions ?? []) {
      scanInstruction(ix);
    }
  }
  return out;
}
