/**
 * App-wide constants for the UCF mobile-native app.
 * Extracted from App.tsx monolith — see App.tsx header comment for details.
 */

import { clusterApiUrl } from "@solana/web3.js";

// ---------------------------------------------------------------------------
// Env-safe number parser (needed before constants are computed)
// ---------------------------------------------------------------------------
export function safeEnvNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// ---------------------------------------------------------------------------
// Solana cluster / RPC
// ---------------------------------------------------------------------------
export const SOLANA_CLUSTER = (process.env.EXPO_PUBLIC_SOLANA_CLUSTER ?? "mainnet").trim().toLowerCase();

export const CHAIN_BY_CLUSTER: Record<string, "solana:mainnet" | "solana:devnet"> = {
  mainnet: "solana:mainnet",
  "mainnet-beta": "solana:mainnet",
  devnet: "solana:devnet",
};

export const WEB3_CLUSTER_BY_CLUSTER: Record<string, "mainnet-beta" | "devnet"> = {
  mainnet: "mainnet-beta",
  "mainnet-beta": "mainnet-beta",
  devnet: "devnet",
};

export const chain = CHAIN_BY_CLUSTER[SOLANA_CLUSTER] ?? "solana:mainnet";

export const endpoint =
  process.env.EXPO_PUBLIC_SOLANA_RPC_URL?.trim() ||
  clusterApiUrl(WEB3_CLUSTER_BY_CLUSTER[SOLANA_CLUSTER] ?? "mainnet-beta");

export const identity = {
  name: "Lobsta Fights",
  uri: "https://clawfights.xyz",
  icon: "/favicon.svg",
};

// ---------------------------------------------------------------------------
// State / priority
// ---------------------------------------------------------------------------
export const STATE_PRIORITY: Record<string, number> = {
  combat: 0,
  payout: 1,
  betting: 2,
  idle: 3,
};

// ---------------------------------------------------------------------------
// Program / RPC
// ---------------------------------------------------------------------------
export const PROGRAM_ID = "638DcfW6NaBweznnzmJe4PyxCw51s3CTkykUNskWnxTU";
export const FALLBACK_RPC = endpoint;

// ---------------------------------------------------------------------------
// Asset requires
// ---------------------------------------------------------------------------
export const RUMBLE_ARENA_BG = require("../assets/art/rumble-arena.webp");
export const RUMBLE_CAGE_OVERLAY_PNG = require("../assets/art/transparent-cage.png");
export const CLEANING_BUGS_IMG = require("../assets/art/cleaning-bugs.jpg");
export const BOT_AVATAR_IMG = require("../assets/art/bot-avatar.webp");
export const HUMAN_AVATAR_IMG = require("../assets/art/human-avatar.webp");

export const SND_BG_TRACKS = [
  require("../assets/sounds/ucf-1.mp3"),
  require("../assets/sounds/ucf-2.mp3"),
  require("../assets/sounds/ucf-4.mp3"),
];
export const SND_BET_PLACED = require("../assets/sounds/click.mp3");
export const SND_ROUND_START = require("../assets/sounds/walk-in.mp3");
export const SND_HIT_LIGHT = require("../assets/sounds/hit-3.mp3");
export const SND_HIT_HEAVY = require("../assets/sounds/metal-hit-2.mp3");
export const SND_HIT_SPECIAL = require("../assets/sounds/metal-hit.mp3");
export const SND_BLOCK = require("../assets/sounds/click-4.mp3");
export const SND_DODGE = require("../assets/sounds/click-2.mp3");
export const SND_CATCH = require("../assets/sounds/grab.mp3");
export const SND_KO = require("../assets/sounds/eliminated.mp3");
export const SND_CROWD_CHEER = require("../assets/sounds/crowd-cheer.mp3");
export const SND_CLICK = require("../assets/sounds/click.mp3");
export const SND_CLAIM = require("../assets/sounds/claim.mp3");

// ---------------------------------------------------------------------------
// URLs / networking
// ---------------------------------------------------------------------------
export const EXPLORER_TX = "https://explorer.solana.com/tx";
export const ONCHAIN_FEED_CLUSTER = "mainnet";
export const ONCHAIN_FEED_NETWORK_LABEL = "MAINNET";
export const LIVE_API_BASE = "https://clawfights.xyz";
export const LOCAL_API_BASE = "http://127.0.0.1:3000";

export const WRITE_RETRYABLE_STATUS = new Set([404, 405, 429, 500, 502, 503, 504]);
export const RPC_RATE_LIMIT_COOLDOWN_MS = 15_000;
export const READ_TIMEOUT_MS = 9_000;
export const WRITE_TIMEOUT_MS = 14_000;

// ---------------------------------------------------------------------------
// Polling intervals
// ---------------------------------------------------------------------------
export const STATUS_POLL_INTERVALS_MS = {
  combat: Math.max(2_500, safeEnvNumber(process.env.EXPO_PUBLIC_RUMBLE_STATUS_POLL_COMBAT_MS, 4_000)),
  betting: Math.max(4_000, safeEnvNumber(process.env.EXPO_PUBLIC_RUMBLE_STATUS_POLL_BETTING_MS, 6_000)),
  idle: Math.max(15_000, safeEnvNumber(process.env.EXPO_PUBLIC_RUMBLE_STATUS_POLL_IDLE_MS, 20_000)),
};

export const STATUS_POLL_BACKSTOP_INTERVALS_MS = {
  combat: Math.max(STATUS_POLL_INTERVALS_MS.combat, safeEnvNumber(process.env.EXPO_PUBLIC_RUMBLE_STATUS_POLL_COMBAT_BACKSTOP_MS, 10_000)),
  betting: Math.max(STATUS_POLL_INTERVALS_MS.betting, safeEnvNumber(process.env.EXPO_PUBLIC_RUMBLE_STATUS_POLL_BETTING_BACKSTOP_MS, 12_000)),
  idle: STATUS_POLL_INTERVALS_MS.idle,
};

export const STATUS_POLL_TRANSITION_LEAD_MS = {
  combat: Math.max(1_500, safeEnvNumber(process.env.EXPO_PUBLIC_RUMBLE_STATUS_POLL_COMBAT_LEAD_MS, 2_500)),
  betting: Math.max(2_000, safeEnvNumber(process.env.EXPO_PUBLIC_RUMBLE_STATUS_POLL_BETTING_LEAD_MS, 5_000)),
};

export const STATUS_POLL_ERROR_RETRY_MS = 5_000;
export const STATUS_REALTIME_REFRESH_DEBOUNCE_MS = 350;
export const CHAT_POLL_ACTIVE_MS = 30_000;
export const TX_FEED_POLL_ACTIVE_MS = 45_000;
export const WALLET_POLL_ACTIVE_MS = 75_000;
