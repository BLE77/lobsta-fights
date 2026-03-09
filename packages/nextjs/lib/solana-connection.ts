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
const _slotCache = new Map<string, { slot: number; at: number }>();
const DEFAULT_SLOT_CACHE_TTL_MS = (() => {
  const raw = Number(process.env.RUMBLE_RPC_SLOT_CACHE_MS ?? "1500");
  if (!Number.isFinite(raw)) return 1_500;
  return Math.min(10_000, Math.max(250, Math.floor(raw)));
})();

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

async function getCachedSlotForConnection(
  cacheKey: string,
  connection: Connection,
  commitment: Commitment = "processed",
  ttlMs = DEFAULT_SLOT_CACHE_TTL_MS,
): Promise<number | null> {
  const now = Date.now();
  const key = `${cacheKey}:${commitment}`;
  const cached = _slotCache.get(key);
  if (cached && now - cached.at < ttlMs) {
    return cached.slot;
  }
  const slot = await connection.getSlot(commitment).catch(() => null);
  if (slot !== null) {
    _slotCache.set(key, { slot, at: now });
  }
  return slot;
}

export async function getCachedCombatSlot(
  commitment: Commitment = "processed",
  ttlMs = DEFAULT_SLOT_CACHE_TTL_MS,
): Promise<number | null> {
  return getCachedSlotForConnection("combat", getConnection(), commitment, ttlMs);
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

export async function getCachedBettingSlot(
  commitment: Commitment = "processed",
  ttlMs = DEFAULT_SLOT_CACHE_TTL_MS,
): Promise<number | null> {
  return getCachedSlotForConnection("betting", getBettingConnection(), commitment, ttlMs);
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
 * Uses MAGICBLOCK_ER_RPC_URL env var, defaults to devnet ER endpoint.
 * NOTE: devnet-us.magicblock.app is DEPRECATED — use devnet-router.magicblock.app
 */
export function getErRpcEndpoint(): string {
  const explicit = process.env.MAGICBLOCK_ER_RPC_URL?.trim();
  if (explicit) return explicit;
  return "https://devnet-router.magicblock.app";
}

let _erConnection: Connection | null = null;
let _erConnectionKind: "router" | "plain" | null = null;
let _erRouterLoadWarned = false;
let _erRouterRequireWarned = false;

type ConnectionMagicRouterCtor = new (
  endpoint: string,
  config?: { commitment?: Commitment; wsEndpoint?: string },
) => Connection;

function getRuntimeRequire(): NodeRequire | null {
  if (typeof window !== "undefined") return null;

  const globalRequire = (globalThis as { require?: NodeRequire }).require;
  if (typeof globalRequire === "function") {
    return globalRequire;
  }

  const proc = process as typeof process & {
    getBuiltinModule?: (
      id: string,
    ) => { createRequire?: (filename: string) => NodeRequire } | undefined;
  };

  if (typeof proc.getBuiltinModule === "function") {
    try {
      const moduleBuiltin = proc.getBuiltinModule("module");
      if (typeof moduleBuiltin?.createRequire === "function") {
        return moduleBuiltin.createRequire(`${process.cwd()}/package.json`);
      }
    } catch (error) {
      if (!_erRouterRequireWarned) {
        _erRouterRequireWarned = true;
        console.warn(
          "[solana-connection] Failed to create a runtime require for ConnectionMagicRouter.",
          error,
        );
      }
    }
  }

  return null;
}

function tryCreateMagicRouterConnection(endpoint: string): Connection | null {
  if (typeof window !== "undefined") return null;
  try {
    const runtimeRequire = getRuntimeRequire();
    if (!runtimeRequire) {
      if (!_erRouterLoadWarned) {
        _erRouterLoadWarned = true;
        console.warn(
          "[solana-connection] ConnectionMagicRouter unavailable in this runtime. Falling back to plain Connection.",
        );
      }
      return null;
    }
    const sdk = runtimeRequire("@magicblock-labs/ephemeral-rollups-sdk") as {
      ConnectionMagicRouter?: ConnectionMagicRouterCtor;
    };
    const RouterCtor = sdk?.ConnectionMagicRouter;
    if (!RouterCtor) return null;
    return new RouterCtor(endpoint, {
      commitment: "confirmed",
      wsEndpoint: endpoint.replace("https://", "wss://"),
    });
  } catch (error) {
    if (!_erRouterLoadWarned) {
      _erRouterLoadWarned = true;
      console.warn(
        "[solana-connection] Failed to initialize ConnectionMagicRouter. Falling back to plain Connection.",
        error,
      );
    }
    return null;
  }
}

/**
 * Get a shared connection to the MagicBlock Ephemeral Rollup validator.
 * Used for combat transactions that run in the ER (sub-50ms latency, zero fees).
 */
export function getErConnection(): Connection {
  if (!_erConnection) {
    const endpoint = getErRpcEndpoint();
    const routerConnection = tryCreateMagicRouterConnection(endpoint);
    _erConnectionKind = routerConnection ? "router" : "plain";
    _erConnection = instrumentConnection(
      routerConnection ??
        new Connection(endpoint, {
          commitment: "confirmed",
          wsEndpoint: endpoint.replace("https://", "wss://"),
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
// Lightweight RPC caches (blockhash + balance)
// ---------------------------------------------------------------------------

const DEFAULT_BLOCKHASH_CACHE_TTL_MS = Math.max(
  250,
  Number(process.env.RUMBLE_BLOCKHASH_CACHE_TTL_MS ?? "1200"),
);
const DEFAULT_BALANCE_CACHE_TTL_MS = Math.max(
  1_000,
  Number(process.env.RUMBLE_BALANCE_CACHE_TTL_MS ?? "20000"),
);

type BlockhashWithExpiry = Awaited<ReturnType<Connection["getLatestBlockhash"]>>;
type CacheOptions = { ttlMs?: number; forceRefresh?: boolean };
type BalanceCacheOptions = CacheOptions & { commitment?: Commitment };

const _connectionCacheIds = new WeakMap<Connection, number>();
let _nextConnectionCacheId = 1;

const _blockhashCache = new Map<string, { at: number; value: BlockhashWithExpiry }>();
const _blockhashInFlight = new Map<string, Promise<BlockhashWithExpiry>>();

const _balanceCache = new Map<string, { at: number; lamports: number }>();
const _balanceInFlight = new Map<string, Promise<number>>();

function connectionCacheId(connection: Connection): number {
  const existing = _connectionCacheIds.get(connection);
  if (existing) return existing;
  const id = _nextConnectionCacheId++;
  _connectionCacheIds.set(connection, id);
  return id;
}

function pruneRpcCaches(now: number): void {
  if (_blockhashCache.size > 200) {
    for (const [key, entry] of _blockhashCache.entries()) {
      if (now - entry.at > DEFAULT_BLOCKHASH_CACHE_TTL_MS * 4) {
        _blockhashCache.delete(key);
      }
    }
  }
  if (_balanceCache.size > 2000) {
    for (const [key, entry] of _balanceCache.entries()) {
      if (now - entry.at > DEFAULT_BALANCE_CACHE_TTL_MS * 4) {
        _balanceCache.delete(key);
      }
    }
  }
}

/**
 * Cached getLatestBlockhash with in-flight dedupe.
 * Reduces duplicate RPC calls during high-concurrency transaction bursts.
 */
export async function getLatestBlockhashCached(
  connection: Connection = getConnection(),
  commitment: Commitment = "confirmed",
  options: CacheOptions = {},
): Promise<BlockhashWithExpiry> {
  const ttlMs = options.ttlMs ?? DEFAULT_BLOCKHASH_CACHE_TTL_MS;
  const key = `${connectionCacheId(connection)}:${commitment}`;
  const now = Date.now();

  if (!options.forceRefresh) {
    const cached = _blockhashCache.get(key);
    if (cached && now - cached.at < ttlMs) return cached.value;
    const inFlight = _blockhashInFlight.get(key);
    if (inFlight) return inFlight;
  }

  const promise = connection
    .getLatestBlockhash(commitment)
    .then((value) => {
      const at = Date.now();
      _blockhashCache.set(key, { at, value });
      pruneRpcCaches(at);
      return value;
    })
    .finally(() => {
      _blockhashInFlight.delete(key);
    });

  _blockhashInFlight.set(key, promise);
  return promise;
}

/**
 * Cached getBalance with in-flight dedupe.
 * Useful for API polling and repeated wallet balance refreshes.
 */
export async function getCachedBalance(
  connection: Connection,
  publicKey: PublicKey,
  options: BalanceCacheOptions = {},
): Promise<number> {
  const commitment = options.commitment ?? "confirmed";
  const ttlMs = options.ttlMs ?? DEFAULT_BALANCE_CACHE_TTL_MS;
  const key = `${connectionCacheId(connection)}:${commitment}:${publicKey.toBase58()}`;
  const now = Date.now();

  if (!options.forceRefresh) {
    const cached = _balanceCache.get(key);
    if (cached && now - cached.at < ttlMs) return cached.lamports;
    const inFlight = _balanceInFlight.get(key);
    if (inFlight) return inFlight;
  }

  const promise = connection
    .getBalance(publicKey, commitment)
    .then((lamports) => {
      const at = Date.now();
      _balanceCache.set(key, { at, lamports });
      pruneRpcCaches(at);
      return lamports;
    })
    .finally(() => {
      _balanceInFlight.delete(key);
    });

  _balanceInFlight.set(key, promise);
  return promise;
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

function readOptionalEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value || null;
}

/**
 * Returns ER status info suitable for API JSON responses.
 */
export function getErStatusInfo() {
  const erEnabled = isErEnabled();
  const erConn = erEnabled ? getErConnection() : null;
  const endpoint = erEnabled ? getErRpcEndpoint() : null;
  const mode = erEnabled ? (_erConnectionKind ?? "plain") : null;
  return {
    er_enabled: erEnabled,
    er_rpc_url: endpoint,
    combat_rpc_url: erEnabled ? endpoint : getRpcEndpoint(),
    er_connection_mode: mode,
    er_runtime_rpc_url: erConn
      ? ((erConn as unknown as { rpcEndpoint?: string }).rpcEndpoint ?? endpoint)
      : null,
    er_validator_pubkey: erEnabled ? readOptionalEnv("MAGICBLOCK_ER_VALIDATOR_PUBKEY") : null,
    er_validator_rpc_url: erEnabled
      ? (readOptionalEnv("MAGICBLOCK_ER_VALIDATOR_RPC_URL") ?? readOptionalEnv("MAGICBLOCK_ER_REGION_RPC_URL"))
      : null,
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

  const { blockhash, lastValidBlockHeight } = await getLatestBlockhashCached(
    connection,
    "confirmed",
  );

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
  context?: { blockhash: string; lastValidBlockHeight: number },
): Promise<boolean> {
  const connection = getConnection();

  const { blockhash, lastValidBlockHeight } =
    context ??
    (await getLatestBlockhashCached(connection, "confirmed"));

  const resultPromise = connection.confirmTransaction(
    {
      signature,
      blockhash,
      lastValidBlockHeight,
    },
    "confirmed",
  );
  const result = (() => {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return resultPromise;
    }
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error(`Transaction confirmation timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    return Promise.race([resultPromise, timeoutPromise]).finally(() => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    });
  })();
  const settled = await result;

  if (settled.value.err) {
    throw new Error(`Transaction failed: ${JSON.stringify(settled.value.err)}`);
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
  const hasTxContext =
    typeof signedTransaction.recentBlockhash === "string" &&
    typeof signedTransaction.lastValidBlockHeight === "number";
  await confirmTransaction(
    signature,
    30_000,
    hasTxContext
      ? {
          blockhash: signedTransaction.recentBlockhash!,
          lastValidBlockHeight: signedTransaction.lastValidBlockHeight!,
        }
      : undefined,
  );
  return signature;
}

/**
 * Get the current SOL balance for a public key (in SOL, not lamports).
 */
export async function getSolBalance(publicKey: PublicKey): Promise<number> {
  const connection = getConnection();
  const lamports = await getCachedBalance(connection, publicKey, {
    commitment: "confirmed",
  });
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
