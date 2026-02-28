/**
 * Helius Webhook Helpers
 *
 * Utilities for registering and managing Helius Enhanced Webhooks,
 * and for parsing incoming webhook payloads to identify bet transactions.
 *
 * Supports both devnet (combat) and mainnet (betting) webhooks.
 */

import { RUMBLE_ENGINE_ID, RUMBLE_ENGINE_ID_MAINNET } from "./solana-programs";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Returns the mainnet Helius API key (used for betting webhook).
 * Falls back to generic HELIUS_API_KEY if mainnet-specific key not set.
 */
function getMainnetApiKey(): string {
  const key =
    process.env.HELIUS_MAINNET_API_KEY?.trim() ||
    process.env.HELIUS_API_KEY?.trim();
  if (!key) throw new Error("Missing HELIUS_MAINNET_API_KEY or HELIUS_API_KEY");
  return key;
}

function getDevnetApiKey(): string {
  const key = process.env.HELIUS_API_KEY?.trim();
  if (!key) throw new Error("Missing HELIUS_API_KEY");
  return key;
}

/**
 * Secret used to authenticate incoming Helius webhooks.
 * Set HELIUS_WEBHOOK_SECRET in your environment. Helius sends this
 * in the `Authorization` header as a Bearer token.
 */
export function getWebhookSecret(): string {
  return process.env.HELIUS_WEBHOOK_SECRET?.trim() ?? "";
}

// ---------------------------------------------------------------------------
// Webhook Registration
// ---------------------------------------------------------------------------

export interface HeliusWebhookConfig {
  webhookURL: string;
  transactionTypes: string[];
  accountAddresses: string[];
  webhookType: "enhanced" | "enhancedDevnet" | "raw" | "rawDevnet" | "discord" | "discordDevnet";
}

export interface HeliusWebhookResponse {
  webhookID: string;
  wallet: string;
  webhookURL: string;
  transactionTypes: string[];
  accountAddresses: string[];
  webhookType: string;
}

/**
 * Register a MAINNET Enhanced Webhook with Helius to receive transaction
 * notifications for the Rumble Engine program (betting operations).
 *
 * Uses "enhanced" type (mainnet) and filters only successful txs.
 */
export async function registerHeliusWebhook(
  webhookURL: string,
  extraAccountAddresses: string[] = [],
): Promise<HeliusWebhookResponse> {
  const apiKey = getMainnetApiKey();

  const accountAddresses = [
    RUMBLE_ENGINE_ID_MAINNET.toBase58(),
    ...extraAccountAddresses,
  ];

  const secret = getWebhookSecret();

  const body: Record<string, unknown> = {
    webhookURL,
    transactionTypes: ["Any"],
    accountAddresses,
    webhookType: "enhanced", // "enhanced" = mainnet
    txnStatus: "success",   // Only notify on successful txs
  };

  // Helius supports authHeader for webhook authentication
  if (secret) {
    body.authHeader = `Bearer ${secret}`;
  }

  // Mainnet API endpoint
  const res = await fetch(`https://api.helius.xyz/v0/webhooks?api-key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Helius webhook registration failed (${res.status}): ${errText}`);
  }

  return res.json();
}

/**
 * Register a DEVNET Enhanced Webhook (for combat-related notifications).
 */
export async function registerDevnetWebhook(
  webhookURL: string,
  extraAccountAddresses: string[] = [],
): Promise<HeliusWebhookResponse> {
  const apiKey = getDevnetApiKey();

  const accountAddresses = [
    RUMBLE_ENGINE_ID.toBase58(),
    ...extraAccountAddresses,
  ];

  const secret = getWebhookSecret();

  const body: Record<string, unknown> = {
    webhookURL,
    transactionTypes: ["Any"],
    accountAddresses,
    webhookType: "enhancedDevnet", // "enhancedDevnet" = devnet
    txnStatus: "success",
  };

  if (secret) {
    body.authHeader = `Bearer ${secret}`;
  }

  const res = await fetch(`https://api-devnet.helius.xyz/v0/webhooks?api-key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Helius devnet webhook registration failed (${res.status}): ${errText}`);
  }

  return res.json();
}

/**
 * List all registered Helius webhooks for this API key.
 * Checks both mainnet and devnet keys.
 */
export async function listHeliusWebhooks(): Promise<HeliusWebhookResponse[]> {
  const results: HeliusWebhookResponse[] = [];

  // Try mainnet
  try {
    const mainnetKey = getMainnetApiKey();
    const res = await fetch(`https://api.helius.xyz/v0/webhooks?api-key=${mainnetKey}`);
    if (res.ok) {
      const mainnetHooks = await res.json();
      results.push(...mainnetHooks);
    }
  } catch { /* no mainnet key */ }

  // Try devnet (may be same key)
  try {
    const devnetKey = getDevnetApiKey();
    if (devnetKey !== (process.env.HELIUS_MAINNET_API_KEY?.trim() ?? "")) {
      const res = await fetch(`https://api-devnet.helius.xyz/v0/webhooks?api-key=${devnetKey}`);
      if (res.ok) {
        const devnetHooks = await res.json();
        results.push(...devnetHooks);
      }
    }
  } catch { /* no devnet key */ }

  return results;
}

/**
 * Delete a Helius webhook by ID. Tries both mainnet and devnet APIs.
 */
export async function deleteHeliusWebhook(webhookId: string): Promise<void> {
  // Try mainnet first
  try {
    const mainnetKey = getMainnetApiKey();
    const res = await fetch(`https://api.helius.xyz/v0/webhooks/${webhookId}?api-key=${mainnetKey}`, {
      method: "DELETE",
    });
    if (res.ok) return;
  } catch { /* try devnet */ }

  // Try devnet
  const devnetKey = getDevnetApiKey();
  const res = await fetch(`https://api-devnet.helius.xyz/v0/webhooks/${webhookId}?api-key=${devnetKey}`, {
    method: "DELETE",
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Helius delete webhook failed (${res.status}): ${errText}`);
  }
}

// ---------------------------------------------------------------------------
// Webhook Payload Parsing
// ---------------------------------------------------------------------------

/**
 * A parsed rumble event extracted from a Helius enhanced webhook payload.
 */
export interface ParsedRumbleEvent {
  signature: string;
  slot: number;
  timestamp: number;
  feePayer: string;
  /** The program that processed this instruction */
  programId: string;
  /** Whether this involves the Rumble Engine program */
  isRumbleEngine: boolean;
  /** Account keys involved in the transaction */
  accountKeys: string[];
  /** Raw transaction type from Helius */
  type: string;
  /** SOL balance changes from the tx (for detecting payouts/bets) */
  nativeTransfers: Array<{
    fromUserAccount: string;
    toUserAccount: string;
    amount: number;
  }>;
  /** Full enhanced transaction data for further inspection */
  raw: unknown;
}

/** @deprecated Use ParsedRumbleEvent */
export type ParsedBetEvent = ParsedRumbleEvent;

/**
 * Parse a Helius enhanced webhook payload array into structured events.
 *
 * Helius sends an array of enhanced transaction objects. We filter for
 * transactions that involve the Rumble Engine program (on either network).
 */
export function parseHeliusWebhookPayload(
  payload: unknown[],
): ParsedRumbleEvent[] {
  const events: ParsedRumbleEvent[] = [];
  const programIds = new Set([
    RUMBLE_ENGINE_ID.toBase58(),
    RUMBLE_ENGINE_ID_MAINNET.toBase58(),
  ]);

  for (const item of payload) {
    if (!item || typeof item !== "object") continue;
    const tx = item as Record<string, unknown>;

    const signature = typeof tx.signature === "string" ? tx.signature : "";
    const slot = typeof tx.slot === "number" ? tx.slot : 0;
    const timestamp = typeof tx.timestamp === "number" ? tx.timestamp : 0;
    const feePayer = typeof tx.feePayer === "string" ? tx.feePayer : "";
    const type = typeof tx.type === "string" ? tx.type : "UNKNOWN";

    // Extract account keys
    const accountKeys: string[] = [];
    const accountData = (tx as any).accountData;
    if (Array.isArray(accountData)) {
      for (const acc of accountData) {
        if (acc && typeof acc.account === "string") {
          accountKeys.push(acc.account);
        }
      }
    }

    // Extract native SOL transfers
    const nativeTransfers: ParsedRumbleEvent["nativeTransfers"] = [];
    const rawTransfers = (tx as any).nativeTransfers;
    if (Array.isArray(rawTransfers)) {
      for (const t of rawTransfers) {
        if (t && typeof t.fromUserAccount === "string") {
          nativeTransfers.push({
            fromUserAccount: t.fromUserAccount,
            toUserAccount: t.toUserAccount ?? "",
            amount: typeof t.amount === "number" ? t.amount : 0,
          });
        }
      }
    }

    // Check instructions for Rumble Engine involvement
    let isRumbleEngine = false;
    let programId = "";

    const instructions = (tx as any).instructions;
    if (Array.isArray(instructions)) {
      for (const ix of instructions) {
        if (ix && typeof ix.programId === "string" && programIds.has(ix.programId)) {
          isRumbleEngine = true;
          programId = ix.programId;
          break;
        }
      }
    }

    // Also check inner instructions
    if (!isRumbleEngine) {
      const innerInstructions = (tx as any).innerInstructions;
      if (Array.isArray(innerInstructions)) {
        for (const inner of innerInstructions) {
          const innerIxs = Array.isArray(inner?.instructions) ? inner.instructions : [];
          for (const ix of innerIxs) {
            if (ix && typeof ix.programId === "string" && programIds.has(ix.programId)) {
              isRumbleEngine = true;
              programId = ix.programId;
              break;
            }
          }
          if (isRumbleEngine) break;
        }
      }
    }

    // Also check if any account key references the program
    if (!isRumbleEngine) {
      for (const pk of programIds) {
        if (accountKeys.includes(pk)) {
          isRumbleEngine = true;
          programId = pk;
          break;
        }
      }
    }

    // Only include transactions that involve our program
    if (!isRumbleEngine) continue;

    events.push({
      signature,
      slot,
      timestamp,
      feePayer,
      programId,
      isRumbleEngine,
      accountKeys,
      type,
      nativeTransfers,
      raw: tx,
    });
  }

  return events;
}
