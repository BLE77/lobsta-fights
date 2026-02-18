/**
 * Helius Webhook Helpers
 *
 * Utilities for registering and managing Helius Enhanced Webhooks,
 * and for parsing incoming webhook payloads to identify bet transactions.
 */

import { RUMBLE_ENGINE_ID } from "./solana-programs";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function getHeliusApiKey(): string {
  const key =
    process.env.HELIUS_API_KEY?.trim() ||
    process.env.NEXT_PUBLIC_HELIUS_API_KEY?.trim();
  if (!key) throw new Error("Missing HELIUS_API_KEY or NEXT_PUBLIC_HELIUS_API_KEY");
  return key;
}

function getNetwork(): "devnet" | "mainnet-beta" {
  const net = process.env.NEXT_PUBLIC_SOLANA_NETWORK;
  if (net === "mainnet-beta") return "mainnet-beta";
  return "devnet";
}

function getHeliusApiBaseUrl(): string {
  const network = getNetwork();
  if (network === "mainnet-beta") {
    return "https://api.helius.xyz";
  }
  return "https://api-devnet.helius.xyz";
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
  webhookType: "enhanced" | "raw" | "discord";
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
 * Register a new Enhanced Webhook with Helius to receive transaction
 * notifications for the Rumble Engine program.
 */
export async function registerHeliusWebhook(
  webhookURL: string,
  extraAccountAddresses: string[] = [],
): Promise<HeliusWebhookResponse> {
  const apiKey = getHeliusApiKey();
  const baseUrl = getHeliusApiBaseUrl();

  const accountAddresses = [
    RUMBLE_ENGINE_ID.toBase58(),
    ...extraAccountAddresses,
  ];

  const secret = getWebhookSecret();

  const body: Record<string, unknown> = {
    webhookURL,
    transactionTypes: ["Any"],
    accountAddresses,
    webhookType: "enhanced",
  };

  // Helius supports authHeader for webhook authentication
  if (secret) {
    body.authHeader = `Bearer ${secret}`;
  }

  const res = await fetch(`${baseUrl}/v0/webhooks?api-key=${apiKey}`, {
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
 * List all registered Helius webhooks for this API key.
 */
export async function listHeliusWebhooks(): Promise<HeliusWebhookResponse[]> {
  const apiKey = getHeliusApiKey();
  const baseUrl = getHeliusApiBaseUrl();

  const res = await fetch(`${baseUrl}/v0/webhooks?api-key=${apiKey}`, {
    method: "GET",
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Helius list webhooks failed (${res.status}): ${errText}`);
  }

  return res.json();
}

/**
 * Delete a Helius webhook by ID.
 */
export async function deleteHeliusWebhook(webhookId: string): Promise<void> {
  const apiKey = getHeliusApiKey();
  const baseUrl = getHeliusApiBaseUrl();

  const res = await fetch(`${baseUrl}/v0/webhooks/${webhookId}?api-key=${apiKey}`, {
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
 * A parsed bet event extracted from a Helius enhanced webhook payload.
 */
export interface ParsedBetEvent {
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
  /** Full enhanced transaction data for further inspection */
  raw: unknown;
}

/**
 * Parse a Helius enhanced webhook payload array into structured bet events.
 *
 * Helius sends an array of enhanced transaction objects. We filter for
 * transactions that involve the Rumble Engine program.
 */
export function parseHeliusWebhookPayload(
  payload: unknown[],
): ParsedBetEvent[] {
  const events: ParsedBetEvent[] = [];

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

    // Check instructions for Rumble Engine involvement
    let isRumbleEngine = false;
    let programId = "";

    const instructions = (tx as any).instructions;
    if (Array.isArray(instructions)) {
      for (const ix of instructions) {
        if (ix && typeof ix.programId === "string") {
          if (ix.programId === RUMBLE_ENGINE_ID.toBase58()) {
            isRumbleEngine = true;
            programId = ix.programId;
            break;
          }
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
            if (ix && typeof ix.programId === "string") {
              if (ix.programId === RUMBLE_ENGINE_ID.toBase58()) {
                isRumbleEngine = true;
                programId = ix.programId;
                break;
              }
            }
          }
          if (isRumbleEngine) break;
        }
      }
    }

    // Also check if any account key references the program
    if (!isRumbleEngine && accountKeys.includes(RUMBLE_ENGINE_ID.toBase58())) {
      isRumbleEngine = true;
      programId = RUMBLE_ENGINE_ID.toBase58();
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
      raw: tx,
    });
  }

  return events;
}
