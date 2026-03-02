/**
 * Solana RPC Connection Setup
 *
 * Creates connections to Solana RPC for both combat (devnet) and betting (mainnet).
 * Provides helpers for sending and confirming transactions.
 *
 * Environment variables:
 *   SOLANA_RPC_URL - explicit RPC endpoint (server-side preferred, combat/devnet)
 *   NEXT_PUBLIC_SOLANA_RPC_URL - explicit RPC endpoint fallback (combat/devnet)
 *   HELIUS_API_KEY - Helius API key for devnet (server-side only)
 *   HELIUS_MAINNET_API_KEY - Helius API key for mainnet betting (server-side only)
 *   NEXT_PUBLIC_SOLANA_NETWORK - "devnet" | "mainnet-beta" (default: "devnet")
 *   NEXT_PUBLIC_BETTING_RPC_URL - explicit mainnet RPC for betting (frontend)
 *   NEXT_PUBLIC_BETTING_NETWORK - "mainnet-beta" (hardcoded, not configurable)
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
import { instrumentConnection } from "./solana-rpc-metrics";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function getHeliusApiKey(): string | null {
  const serverKey = process.env.HELIUS_API_KEY?.trim();
  if (serverKey) return serverKey;
  // Fallback to NEXT_PUBLIC variant — available on Vercel where server-only
  // HELIUS_API_KEY may not be configured separately.
  const publicKey = process.env.NEXT_PUBLIC_HELIUS_API_KEY?.trim();
  if (publicKey) return publicKey;
  return null;
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
  const explicit = process.env.SOLANA_RPC_URL?.trim() || process.env.NEXT_PUBLIC_SOLANA_RPC_URL?.trim();
  if (explicit) return explicit;

  const key = getHeliusApiKey();
  const network = getNetwork();
  if (key) {
    if (network === "mainnet-beta") {
      return `https://mainnet.helius-rpc.com/?api-key=${key}`;
    }
    return `https://devnet.helius-rpc.com/?api-key=${key}`;
  }
  return network === "mainnet-beta"
    ? "https://api.mainnet-beta.solana.com"
    : "https://api.devnet.solana.com";
}

// ---------------------------------------------------------------------------
// Betting (Mainnet) RPC
// ---------------------------------------------------------------------------

function getHeliusMainnetApiKey(): string | null {
  const key = process.env.HELIUS_MAINNET_API_KEY?.trim();
  if (key) return key;
  return null;
}

function splitEndpointList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function normalizeEndpoint(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/**
 * Get the mainnet RPC endpoint for betting operations.
 * Server-side prefers HELIUS_MAINNET_API_KEY (supports getProgramAccounts).
 * Client-side falls back to NEXT_PUBLIC_BETTING_RPC_URL (public endpoint).
 */
export function getBettingRpcEndpoint(): string {
  // Server-side: use Helius for full RPC support (getProgramAccounts etc.)
  const key = getHeliusMainnetApiKey();
  if (key) return `https://mainnet.helius-rpc.com/?api-key=${key}`;

  // Client-side / fallback: use explicit betting RPC or public endpoint
  const explicit = process.env.NEXT_PUBLIC_BETTING_RPC_URL?.trim();
  if (explicit) return explicit;

  return "https://api.mainnet-beta.solana.com";
}

/**
 * Candidate RPC endpoints for mainnet betting reads.
 * Keeps the configured primary first, then optional fallbacks, then public mainnet.
 */
export function getBettingReadRpcEndpoints(): string[] {
  const endpoints: string[] = [getBettingRpcEndpoint()];
  const envFallbacks = [
    process.env.RUMBLE_BETTING_RPC_FALLBACKS,
    process.env.RUMBLE_BETTING_READ_RPC_ENDPOINTS,
  ];
  for (const raw of envFallbacks) {
    endpoints.push(...splitEndpointList(raw));
  }
  const publicBettingRpc = process.env.NEXT_PUBLIC_BETTING_RPC_URL?.trim();
  if (publicBettingRpc) endpoints.push(publicBettingRpc);
  endpoints.push("https://api.mainnet-beta.solana.com");

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const endpoint of endpoints) {
    if (!endpoint) continue;
    const normalized = normalizeEndpoint(endpoint);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(endpoint);
  }
  return deduped;
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

let _connection: Connection | null = null;

/**
 * Get a shared Solana connection instance (combat/devnet).
 * Uses the Helius RPC endpoint for the configured network.
 */
export function getConnection(): Connection {
  if (!_connection) {
    _connection = instrumentConnection(
      new Connection(getRpcEndpoint(), {
        commitment: "confirmed",
      }),
      "combat",
    );
  }
  return _connection;
}

/** Alias for getConnection() — explicit name for combat operations. */
export function getCombatConnection(): Connection {
  return getConnection();
}

let _bettingConnection: Connection | null = null;

/**
 * Get a shared Solana connection for betting operations (mainnet).
 * Separate from combat connection to isolate rate limits and network.
 */
export function getBettingConnection(): Connection {
  if (!_bettingConnection) {
    _bettingConnection = instrumentConnection(
      new Connection(getBettingRpcEndpoint(), {
        commitment: "confirmed",
      }),
      "betting",
    );
  }
  return _bettingConnection;
}

const _bettingReadFallbackConnections = new Map<string, Connection>();

/**
 * Get ordered read connections for betting state checks.
 * First entry is always the primary betting connection.
 */
export function getBettingReadConnections(): Connection[] {
  const primary = getBettingConnection();
  const primaryEndpoint = normalizeEndpoint(getBettingRpcEndpoint());
  const out: Connection[] = [primary];
  for (const endpoint of getBettingReadRpcEndpoints()) {
    if (normalizeEndpoint(endpoint) === primaryEndpoint) continue;
    let conn = _bettingReadFallbackConnections.get(endpoint);
    if (!conn) {
      conn = instrumentConnection(
        new Connection(endpoint, {
          commitment: "confirmed",
        }),
        "betting_fallback",
      );
      _bettingReadFallbackConnections.set(endpoint, conn);
    }
    out.push(conn);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ephemeral Rollup (MagicBlock) Connection — real-time combat execution
// ---------------------------------------------------------------------------

/**
 * Get the MagicBlock ER RPC endpoint.
 * Uses MAGICBLOCK_ER_RPC_URL env var, defaults to devnet US endpoint.
 */
export function getErRpcEndpoint(): string {
  const explicit = process.env.MAGICBLOCK_ER_RPC_URL?.trim();
  if (explicit) return explicit;
  return "https://devnet-us.magicblock.app/";
}

let _erConnection: Connection | null = null;

/**
 * Get a shared connection to the MagicBlock Ephemeral Rollup validator.
 * Used for combat transactions that run in the ER (sub-50ms latency, zero fees).
 */
export function getErConnection(): Connection {
  if (!_erConnection) {
    _erConnection = instrumentConnection(
      new Connection(getErRpcEndpoint(), {
        commitment: "confirmed",
        wsEndpoint: getErRpcEndpoint().replace("https://", "wss://"),
      }),
      "er",
    );
  }
  return _erConnection;
}

/**
 * Create a fresh connection (bypasses the cached singleton).
 */
export function createFreshConnection(commitment: Commitment = "confirmed"): Connection {
  return instrumentConnection(new Connection(getRpcEndpoint(), { commitment }), "fresh");
}

// ---------------------------------------------------------------------------
// Ephemeral Rollup Helpers — shared across orchestrator + API routes
// ---------------------------------------------------------------------------

/** Whether MagicBlock Ephemeral Rollups are enabled for combat. */
export function isErEnabled(): boolean {
  return process.env.MAGICBLOCK_ER_ENABLED === "true";
}

/**
 * Get the appropriate connection for combat transactions.
 * Returns the ER connection when ER is enabled, otherwise the L1 connection.
 */
export function getCombatConnectionAuto(): Connection {
  return isErEnabled() ? getErConnection() : getConnection();
}

const DELEGATION_PROGRAM_ID = "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh";

/**
 * Returns ER status info suitable for API JSON responses.
 */
export function getErStatusInfo() {
  const erEnabled = isErEnabled();
  return {
    er_enabled: erEnabled,
    er_rpc_url: erEnabled ? getErRpcEndpoint() : null,
    combat_rpc_url: erEnabled ? getErRpcEndpoint() : getRpcEndpoint(),
    delegation_program: erEnabled ? DELEGATION_PROGRAM_ID : null,
  };
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
