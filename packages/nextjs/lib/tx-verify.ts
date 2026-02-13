/**
 * On-chain transaction verification for spectator bets.
 *
 * Verifies that a submitted tx_signature corresponds to a real SOL transfer
 * from the claimed wallet to our treasury, for the claimed amount.
 */

import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getConnection } from "./solana-connection";

const TREASURY_ADDRESS = "FXvriUM1dTwDeVXaWTSqGo14jPQk7363FQsQaUP1tvdE";

/** Tolerance for SOL amount matching (accounts for rounding). */
const AMOUNT_TOLERANCE_SOL = 0.001;

/** Min/max bet bounds in SOL. */
export const MIN_BET_SOL = 0.001;
export const MAX_BET_SOL = 100;

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

// ---------------------------------------------------------------------------
// Transaction verification
// ---------------------------------------------------------------------------

export interface VerifyResult {
  valid: boolean;
  error?: string;
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
    const connection = getConnection();

    const tx = await connection.getParsedTransaction(txSignature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });

    if (!tx) {
      return { valid: false, error: "Transaction not found. It may not be confirmed yet." };
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
          info.destination === TREASURY_ADDRESS
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
              info.destination === TREASURY_ADDRESS
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
