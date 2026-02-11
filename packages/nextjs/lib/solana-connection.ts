/**
 * Solana RPC Connection Setup
 *
 * Creates a connection to Solana via Helius RPC endpoints.
 * Provides helpers for sending and confirming transactions.
 *
 * Environment variables:
 *   NEXT_PUBLIC_HELIUS_API_KEY - Helius API key
 *   NEXT_PUBLIC_SOLANA_NETWORK - "devnet" | "mainnet-beta" (default: "devnet")
 *
 * Dependencies needed (not yet installed):
 *   @solana/web3.js
 */

import {
  Connection,
  Transaction,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  type TransactionSignature,
  type SendOptions,
  type Commitment,
} from "@solana/web3.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function getHeliusApiKey(): string {
  const key = process.env.NEXT_PUBLIC_HELIUS_API_KEY;
  if (!key) throw new Error("Missing NEXT_PUBLIC_HELIUS_API_KEY");
  return key;
}

function getNetwork(): "devnet" | "mainnet-beta" {
  const net = process.env.NEXT_PUBLIC_SOLANA_NETWORK;
  if (net === "mainnet-beta") return "mainnet-beta";
  return "devnet";
}

/**
 * Get the Helius RPC endpoint URL for the configured network.
 */
export function getRpcEndpoint(): string {
  const key = getHeliusApiKey();
  const network = getNetwork();
  if (network === "mainnet-beta") {
    return `https://mainnet.helius-rpc.com/?api-key=${key}`;
  }
  return `https://devnet.helius-rpc.com/?api-key=${key}`;
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

let _connection: Connection | null = null;

/**
 * Get a shared Solana connection instance.
 * Uses the Helius RPC endpoint for the configured network.
 */
export function getConnection(): Connection {
  if (!_connection) {
    _connection = new Connection(getRpcEndpoint(), {
      commitment: "confirmed",
    });
  }
  return _connection;
}

/**
 * Create a fresh connection (bypasses the cached singleton).
 */
export function createFreshConnection(commitment: Commitment = "confirmed"): Connection {
  return new Connection(getRpcEndpoint(), { commitment });
}

// ---------------------------------------------------------------------------
// Transaction Helpers
// ---------------------------------------------------------------------------

/**
 * Build a SOL transfer transaction.
 *
 * @param from - Sender public key
 * @param to - Recipient public key
 * @param solAmount - Amount in SOL (not lamports)
 * @returns Transaction ready to be signed
 */
export async function buildSolTransfer(
  from: PublicKey,
  to: PublicKey,
  solAmount: number,
): Promise<Transaction> {
  const connection = getConnection();
  const lamports = Math.round(solAmount * LAMPORTS_PER_SOL);

  const transaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: from,
      toPubkey: to,
      lamports,
    }),
  );

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");

  transaction.recentBlockhash = blockhash;
  transaction.lastValidBlockHeight = lastValidBlockHeight;
  transaction.feePayer = from;

  return transaction;
}

/**
 * Send a signed transaction to the network.
 *
 * @param signedTransaction - A fully-signed Transaction
 * @param opts - Optional send options
 * @returns Transaction signature
 */
export async function sendTransaction(
  signedTransaction: Transaction,
  opts?: SendOptions,
): Promise<TransactionSignature> {
  const connection = getConnection();
  const rawTransaction = signedTransaction.serialize();

  const signature = await connection.sendRawTransaction(rawTransaction, {
    skipPreflight: false,
    preflightCommitment: "confirmed",
    ...opts,
  });

  return signature;
}

/**
 * Confirm a transaction with timeout.
 *
 * @param signature - Transaction signature to confirm
 * @param timeoutMs - Timeout in milliseconds (default 30s)
 * @returns True if confirmed, throws on failure/timeout
 */
export async function confirmTransaction(
  signature: TransactionSignature,
  timeoutMs: number = 30_000,
): Promise<boolean> {
  const connection = getConnection();

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");

  const result = await connection.confirmTransaction(
    {
      signature,
      blockhash,
      lastValidBlockHeight,
    },
    "confirmed",
  );

  if (result.value.err) {
    throw new Error(`Transaction failed: ${JSON.stringify(result.value.err)}`);
  }

  return true;
}

/**
 * Send a signed transaction and wait for confirmation.
 * Combines sendTransaction + confirmTransaction.
 *
 * @param signedTransaction - A fully-signed Transaction
 * @returns Transaction signature
 */
export async function sendAndConfirmTransaction(
  signedTransaction: Transaction,
): Promise<TransactionSignature> {
  const signature = await sendTransaction(signedTransaction);
  await confirmTransaction(signature);
  return signature;
}

/**
 * Get the current SOL balance for a public key (in SOL, not lamports).
 */
export async function getSolBalance(publicKey: PublicKey): Promise<number> {
  const connection = getConnection();
  const lamports = await connection.getBalance(publicKey, "confirmed");
  return lamports / LAMPORTS_PER_SOL;
}

// ---------------------------------------------------------------------------
// Vault address for Rumble bets
// ---------------------------------------------------------------------------

/**
 * Get the Rumble vault public key where bets are sent.
 * Uses NEXT_PUBLIC_RUMBLE_VAULT_ADDRESS env var.
 */
export function getRumbleVaultPublicKey(): PublicKey {
  const address = process.env.NEXT_PUBLIC_RUMBLE_VAULT_ADDRESS;
  if (!address) throw new Error("Missing NEXT_PUBLIC_RUMBLE_VAULT_ADDRESS");
  return new PublicKey(address);
}
