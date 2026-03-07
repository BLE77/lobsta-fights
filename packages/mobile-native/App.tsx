import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StatusBar } from "expo-status-bar";
import { Audio } from "expo-av";
import * as Haptics from "expo-haptics";
import { Image as ExpoImage } from "expo-image";
import {
  ActivityIndicator,
  Animated,
  Easing,
  ImageBackground,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  Vibration,
  View,
} from "react-native";
import { useFonts } from "expo-font";
import {
  clusterApiUrl,
  Connection,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import { Buffer } from "buffer";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  MobileWalletProvider,
  fromUint8Array,
  toUint8Array,
  transact,
  useMobileWallet,
} from "@wallet-ui/react-native-web3js";

const SOLANA_CLUSTER = (process.env.EXPO_PUBLIC_SOLANA_CLUSTER ?? "mainnet").trim().toLowerCase();
const CHAIN_BY_CLUSTER: Record<string, "solana:mainnet" | "solana:devnet"> = {
  mainnet: "solana:mainnet",
  "mainnet-beta": "solana:mainnet",
  devnet: "solana:devnet",
};
const WEB3_CLUSTER_BY_CLUSTER: Record<string, "mainnet-beta" | "devnet"> = {
  mainnet: "mainnet-beta",
  "mainnet-beta": "mainnet-beta",
  devnet: "devnet",
};
const chain = CHAIN_BY_CLUSTER[SOLANA_CLUSTER] ?? "solana:mainnet";
const endpoint =
  process.env.EXPO_PUBLIC_SOLANA_RPC_URL?.trim() ||
  clusterApiUrl(WEB3_CLUSTER_BY_CLUSTER[SOLANA_CLUSTER] ?? "mainnet-beta");
const identity = {
  name: "Lobsta Fights",
  uri: "https://clawfights.xyz",
  icon: "/favicon.svg",
};

const STATE_PRIORITY: Record<string, number> = {
  combat: 0,
  payout: 1,
  betting: 2,
  idle: 3,
};

const PROGRAM_ID = "638DcfW6NaBweznnzmJe4PyxCw51s3CTkykUNskWnxTU";
const FALLBACK_RPC = endpoint;
const RUMBLE_ARENA_BG = require("./assets/art/rumble-arena.webp");
const RUMBLE_CAGE_OVERLAY_PNG = require("./assets/art/transparent-cage.png");
const CLEANING_BUGS_IMG = require("./assets/art/cleaning-bugs.jpg");
const BOT_AVATAR_IMG = require("./assets/art/bot-avatar.webp");
const HUMAN_AVATAR_IMG = require("./assets/art/human-avatar.webp");
const SND_BG_MUSIC = require("./assets/sounds/ucf-1.mp3");
const SND_BET_PLACED = require("./assets/sounds/click.mp3");
const SND_ROUND_START = require("./assets/sounds/walk-in.mp3");
const SND_HIT_LIGHT = require("./assets/sounds/hit-3.mp3");
const SND_HIT_HEAVY = require("./assets/sounds/metal-hit-2.mp3");
const SND_HIT_SPECIAL = require("./assets/sounds/metal-hit.mp3");
const SND_BLOCK = require("./assets/sounds/click-4.mp3");
const SND_DODGE = require("./assets/sounds/click-2.mp3");
const SND_CATCH = require("./assets/sounds/grab.mp3");
const SND_KO = require("./assets/sounds/eliminated.mp3");
const SND_CROWD_CHEER = require("./assets/sounds/crowd-cheer.mp3");
const SND_CLICK = require("./assets/sounds/click.mp3");
const SND_CLAIM = require("./assets/sounds/claim.mp3");
const EXPLORER_TX = "https://explorer.solana.com/tx";
const ONCHAIN_FEED_CLUSTER = "mainnet";
const ONCHAIN_FEED_NETWORK_LABEL = "MAINNET";
const LIVE_API_BASE = "https://clawfights.xyz";
const LOCAL_API_BASE = "http://127.0.0.1:3000";
const WRITE_RETRYABLE_STATUS = new Set([404, 405, 429, 500, 502, 503, 504]);
const RPC_RATE_LIMIT_COOLDOWN_MS = 15_000;
const READ_TIMEOUT_MS = 9_000;
const WRITE_TIMEOUT_MS = 14_000;
let preferredApiBase: string | null = null;

type NonceResponse = {
  nonce: string;
  issuedAt: string;
  expiresAt: string;
};

type VerifyResponse = {
  ok: boolean;
  walletAddress: string;
  domain: string;
};

type RumbleSlotFighter = {
  id?: string;
  fighterId?: string;
  name?: string;
  hp?: number;
  maxHp?: number;
  imageUrl?: string | null;
  totalDamageDealt?: number;
  placement?: number;
};

type RumbleTurnPairing = {
  fighterA?: string;
  fighterB?: string;
  fighterAName?: string;
  fighterBName?: string;
  damageToA?: number;
  damageToB?: number;
  moveA?: string;
  moveB?: string;
};

type RumbleTurn = {
  turnNumber?: number;
  pairings?: RumbleTurnPairing[];
  eliminations?: string[];
  bye?: string;
};

type RumbleSlotOdds = {
  fighterId?: string;
  fighterName?: string;
  imageUrl?: string | null;
  hp?: number;
  solDeployed?: number;
  betCount?: number;
  impliedProbability?: number;
  potentialReturn?: number;
};

type SlotPayout = {
  winnerBettorsPayout?: number;
  placeBettorsPayout?: number;
  showBettorsPayout?: number;
  treasuryVault?: number;
  totalPool?: number;
  ichorMined?: number;
  ichorShowerTriggered?: boolean;
  ichorShowerAmount?: number;
};

type RumbleSlot = {
  slotIndex?: number;
  rumbleId?: string;
  rumbleNumber?: number | null;
  state?: "idle" | "betting" | "combat" | "payout";
  fighters?: RumbleSlotFighter[];
  odds?: RumbleSlotOdds[];
  totalPool?: number;
  bettingDeadline?: string | null;
  currentTurn?: number;
  remainingFighters?: number | null;
  turns?: RumbleTurn[];
  fighterNames?: Record<string, string>;
  payout?: SlotPayout | null;
};

type QueueFighter = {
  fighterId?: string;
  name?: string;
  imageUrl?: string | null;
  position?: number;
};

type RumbleStatusResponse = {
  slots?: RumbleSlot[];
  queue?: QueueFighter[];
  queueLength?: number;
  nextRumbleIn?: string | null;
  bettingCloseGuardMs?: number;
  ichorShower?: {
    currentPool?: number;
    rumblesSinceLastTrigger?: number;
  };
};

type ClaimBalanceResponse = {
  payout_mode?: "instant" | "accrue_claim";
  claimable_sol?: number;
  claimed_sol?: number;
  onchain_pending_not_ready_sol?: number;
  onchain_claim_ready?: boolean;
  pending_rumbles?: Array<{
    rumble_id?: string;
    claimable_sol?: number;
    claim_method?: "onchain" | "offchain";
    onchain_payout_ready?: boolean;
  }>;
};

type ChatMessage = {
  id: string;
  user_id: string;
  username: string;
  message: string;
  created_at: string;
};

type TxEntry = {
  signature: string;
  blockTime: number | null;
  confirmationStatus: string | null;
  err: boolean;
};

type TabKey = "arena" | "chat" | "queue";

type MyBetsResponse = {
  slots?: Array<{
    slot_index?: number;
    rumble_id?: string;
    bets?: Array<{
      fighter_id?: string;
      sol_amount?: number;
    }>;
  }>;
};

type PrepareBetLeg = {
  fighter_id: string;
  fighter_index?: number;
  sol_amount: number;
};

type PrepareBetResponse = {
  slot_index?: number;
  rumble_id?: string;
  rumble_id_num?: number;
  tx_kind?: string;
  transaction_base64: string;
  bets?: PrepareBetLeg[];
  guard_ms?: number;
  guard_slots?: number;
  onchain_betting_close_slot?: string | number | null;
  onchain_betting_deadline?: string | null;
};

function safeNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isCancellationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /cancel|declin|reject|abort|denied|dismiss/i.test(message);
}

function isRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b429\b|too many requests|rate limit/i.test(message);
}

function shortAddress(value: string, start = 4, end = 4): string {
  if (!value) return value;
  if (value.length <= start + end + 3) return value;
  return `${value.slice(0, start)}...${value.slice(-end)}`;
}

function getStateColor(state: string | undefined): string {
  if (state === "combat") return "#ef4444";
  if (state === "betting") return "#f59e0b";
  if (state === "payout") return "#22c55e";
  return "#71717a";
}

function isStrikeMove(move: unknown): boolean {
  const value = String(move ?? "").toUpperCase();
  return value === "HIGH_STRIKE" || value === "MID_STRIKE" || value === "LOW_STRIKE" || value === "SPECIAL";
}

function isGuardMove(move: unknown): boolean {
  return String(move ?? "").toUpperCase().startsWith("GUARD");
}

function pickPairingSfx(pair: RumbleTurnPairing): number {
  const moveA = String(pair.moveA ?? "").toUpperCase();
  const moveB = String(pair.moveB ?? "").toUpperCase();
  const damageToA = safeNumber(pair.damageToA, 0);
  const damageToB = safeNumber(pair.damageToB, 0);
  const totalDamage = damageToA + damageToB;

  if ((moveA === "SPECIAL" && damageToB > 0) || (moveB === "SPECIAL" && damageToA > 0)) return SND_HIT_SPECIAL;
  if (moveA === "CATCH" || moveB === "CATCH") return SND_CATCH;
  if ((moveA === "DODGE" || moveB === "DODGE") && totalDamage <= 0) return SND_DODGE;

  if (((isGuardMove(moveA) && isStrikeMove(moveB)) || (isGuardMove(moveB) && isStrikeMove(moveA))) && totalDamage <= 5) {
    return SND_BLOCK;
  }
  if (isGuardMove(moveA) && isGuardMove(moveB)) return SND_BLOCK;
  if (damageToA >= 18 || damageToB >= 18) return SND_HIT_HEAVY;
  if (totalDamage > 0) return SND_HIT_LIGHT;
  return SND_HIT_LIGHT;
}

function formatCountdown(deadlineIso: string | null | undefined): string {
  if (!deadlineIso) return "--:--";
  const ms = new Date(deadlineIso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "00:00";
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatAge(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 10) return "now";
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  return `${Math.floor(diff / 3600)}h`;
}

function formatTxAge(ts: number | null): string {
  if (!ts) return "--";
  const diff = Math.floor((Date.now() - ts * 1000) / 1000);
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

function formatPct(value: unknown): string {
  const n = safeNumber(value, 0);
  const pct = n > 1 ? n : n * 100;
  return `${Math.max(0, pct).toFixed(0)}%`;
}

function getFighterId(fighter: RumbleSlotFighter | RumbleSlotOdds | QueueFighter | null | undefined): string {
  if (!fighter) return "";
  return String((fighter as any).id ?? (fighter as any).fighterId ?? "").trim();
}

function getFighterName(fighter: RumbleSlotFighter | RumbleSlotOdds | QueueFighter | null | undefined): string {
  if (!fighter) return "Unknown";
  return String((fighter as any).name ?? (fighter as any).fighterName ?? getFighterId(fighter) ?? "Unknown");
}

function decodeBase64Tx(base64: string): Transaction {
  return Transaction.from(Buffer.from(base64, "base64"));
}

function getApiBaseCandidates(): string[] {
  const explicit = process.env.EXPO_PUBLIC_API_BASE_URL?.trim();
  const allowLocalFallback = process.env.EXPO_PUBLIC_ALLOW_LOCAL_API_FALLBACK === "1";
  const explicitIsLocal = !!explicit && /^http:\/\/(127\.0\.0\.1|localhost)/i.test(explicit);
  const raw = __DEV__
    ? [explicit, LIVE_API_BASE, allowLocalFallback || explicitIsLocal ? LOCAL_API_BASE : null]
    : [explicit, LIVE_API_BASE];
  const unique = new Set<string>();
  for (const base of raw) {
    if (!base) continue;
    unique.add(base.replace(/\/+$/, ""));
  }
  return [...unique];
}

function getOrderedApiBaseCandidates(): string[] {
  const candidates = getApiBaseCandidates();
  if (!preferredApiBase) return candidates;
  return [preferredApiBase, ...candidates.filter(base => base !== preferredApiBase)];
}

async function fetchApiWithFallback(
  path: string,
  init?: RequestInit,
  mode: "read" | "write" = "read",
): Promise<Response> {
  const baseTimeoutMs = mode === "write" ? WRITE_TIMEOUT_MS : READ_TIMEOUT_MS;
  const method = String(init?.method ?? "GET").toUpperCase();
  const allowHttpFallback = mode === "read" && method === "GET";
  const supportsAbort = typeof AbortController !== "undefined";
  let lastError: Error | null = null;
  let fallbackResponse: Response | null = null;

  for (const base of getOrderedApiBaseCandidates()) {
    const isLocalCandidate = /^http:\/\/(127\.0\.0\.1|localhost)/i.test(base);
    const candidateTimeoutMs = isLocalCandidate ? Math.min(baseTimeoutMs, 1500) : baseTimeoutMs;
    try {
      const res = supportsAbort
        ? await (() => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), candidateTimeoutMs);
          return fetch(`${base}${path}`, { ...init, signal: controller.signal })
            .finally(() => clearTimeout(timer));
        })()
        : await fetch(`${base}${path}`, init);
      if (res.ok) {
        preferredApiBase = base;
        return res;
      }

      const canRetryWrite = mode === "write" && WRITE_RETRYABLE_STATUS.has(res.status);
      if (allowHttpFallback || canRetryWrite) {
        fallbackResponse = res;
        continue;
      }

      preferredApiBase = base;
      return res;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const normalized = /abort/i.test(message)
        ? new Error(`Request timed out after ${candidateTimeoutMs}ms`)
        : error instanceof Error
          ? error
          : new Error(String(error));
      lastError = normalized;
    }
  }

  if (fallbackResponse) return fallbackResponse;
  throw lastError ?? new Error(`Request failed: ${path}`);
}

async function fetchJsonFromCandidates<T>(path: string): Promise<T> {
  const res = await fetchApiWithFallback(path, undefined, "read");
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return (await res.json()) as T;
}

function postJsonWithFallback(path: string, body: unknown): Promise<Response> {
  return fetchApiWithFallback(
    path,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    "write",
  );
}

function normalizeWalletAddress(accountLike: unknown): string | null {
  const account = accountLike as any;
  const candidates = [account?.publicKey, account?.address, account?.addressBase64];

  for (const candidate of candidates) {
    if (!candidate) continue;

    if (typeof candidate === "string") {
      try {
        return new PublicKey(candidate).toBase58();
      } catch {
        try {
          return new PublicKey(toUint8Array(candidate)).toBase58();
        } catch {
          continue;
        }
      }
    }

    if (typeof candidate?.toBase58 === "function") {
      try {
        return candidate.toBase58();
      } catch {
        continue;
      }
    }

    if (typeof candidate?.toBytes === "function") {
      try {
        return new PublicKey(candidate.toBytes()).toBase58();
      } catch {
        continue;
      }
    }
  }

  return null;
}

function WalletHeader({
  walletAddress,
  busy,
  solBalance,
  onConnect,
  onDisconnect,
}: {
  walletAddress: string | null;
  busy: boolean;
  solBalance: number | null;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  return (
    <View style={styles.walletHeaderRow}>
      {walletAddress ? (
        <View style={styles.walletChip}>
          <Text style={styles.walletBalanceText}>{solBalance !== null ? `${solBalance.toFixed(3)} SOL` : "..."}</Text>
          <Text style={styles.walletChipText}>{shortAddress(walletAddress)}</Text>
          <Pressable onPress={onDisconnect} disabled={busy} style={({ pressed }) => [styles.walletChipClose, pressed ? styles.pressablePressed : null]}>
            <Text style={styles.walletChipCloseText}>[X]</Text>
          </Pressable>
        </View>
      ) : (
        <Pressable onPress={onConnect} disabled={busy} style={({ pressed }) => [styles.connectBtn, busy && styles.btnDisabled, pressed ? styles.pressablePressed : null]}>
          <Text style={styles.connectBtnText}>{busy ? "CONNECTING..." : "CONNECT WALLET"}</Text>
        </Pressable>
      )}
    </View>
  );
}

function SoundControls({
  musicEnabled,
  sfxEnabled,
  hapticsEnabled,
  onToggleMusic,
  onToggleSfx,
  onToggleHaptics,
}: {
  musicEnabled: boolean;
  sfxEnabled: boolean;
  hapticsEnabled: boolean;
  onToggleMusic: () => void;
  onToggleSfx: () => void;
  onToggleHaptics: () => void;
}) {
  return (
    <View style={styles.soundControlsRow}>
      <Pressable onPress={onToggleSfx} style={({ pressed }) => [styles.soundBtn, sfxEnabled ? styles.soundBtnOn : styles.soundBtnOff, pressed ? styles.pressablePressed : null]}>
        <Text style={[styles.soundBtnText, sfxEnabled ? styles.soundBtnTextOn : styles.soundBtnTextOff]}>
          {sfxEnabled ? "SFX ON" : "SFX OFF"}
        </Text>
      </Pressable>
      <Pressable onPress={onToggleMusic} style={({ pressed }) => [styles.soundBtn, musicEnabled ? styles.soundBtnOn : styles.soundBtnOff, pressed ? styles.pressablePressed : null]}>
        <Text style={[styles.soundBtnText, musicEnabled ? styles.soundBtnTextOn : styles.soundBtnTextOff]}>
          {musicEnabled ? "MUSIC ON" : "MUSIC OFF"}
        </Text>
      </Pressable>
      <Pressable onPress={onToggleHaptics} style={({ pressed }) => [styles.soundBtn, hapticsEnabled ? styles.soundBtnOn : styles.soundBtnOff, pressed ? styles.pressablePressed : null]}>
        <Text style={[styles.soundBtnText, hapticsEnabled ? styles.soundBtnTextOn : styles.soundBtnTextOff]}>
          {hapticsEnabled ? "HAPTIC ON" : "HAPTIC OFF"}
        </Text>
      </Pressable>
    </View>
  );
}

function StatTile({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <View style={styles.statTile}>
      <Text style={styles.statTileLabel}>{label}</Text>
      <Text style={[styles.statTileValue, valueColor ? { color: valueColor } : null]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

function ActionButton({
  title,
  onPress,
  disabled,
  danger,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.actionBtn,
        danger ? styles.actionBtnDanger : styles.actionBtnPrimary,
        disabled ? styles.btnDisabled : null,
        pressed ? styles.pressablePressed : null,
      ]}
    >
      <Text style={styles.actionBtnText}>{title}</Text>
    </Pressable>
  );
}

export default function App() {
  const [fontsLoaded] = useFonts({
    MostWazted: require("./assets/fonts/Mostwasted.ttf"),
  });

  if (!fontsLoaded) {
    return (
      <SafeAreaView style={styles.root}>
        <View style={styles.fontLoadingWrap}>
          <ActivityIndicator color="#f59e0b" />
        </View>
        <StatusBar style="light" />
      </SafeAreaView>
    );
  }

  return (
    <MobileWalletProvider chain={chain} endpoint={endpoint} identity={identity}>
      <SafeAreaView style={styles.root}>
        <RumbleNativeScreen />
        <StatusBar style="light" />
      </SafeAreaView>
    </MobileWalletProvider>
  );
}

function RumbleNativeScreen() {
  const {
    account,
    connect,
    disconnect,
    signMessage,
    signTransaction,
    store,
  } = useMobileWallet();

  const [activeTab, setActiveTab] = useState<TabKey>("arena");

  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [statusText, setStatusText] = useState("Ready");

  const [rumbleStatus, setRumbleStatus] = useState<RumbleStatusResponse | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [lastStatusAt, setLastStatusAt] = useState<number | null>(null);

  const [claimBalance, setClaimBalance] = useState<ClaimBalanceResponse | null>(null);
  const [claimLoading, setClaimLoading] = useState(false);
  const [claimPending, setClaimPending] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(true);
  const [chatSending, setChatSending] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);

  const [txFeed, setTxFeed] = useState<TxEntry[]>([]);
  const [txLoading, setTxLoading] = useState(true);
  const [txError, setTxError] = useState<string | null>(null);
  const [txFeedMinimized, setTxFeedMinimized] = useState(true);

  const [solBalance, setSolBalance] = useState<number | null>(null);
  const [myBetsBySlot, setMyBetsBySlot] = useState<Record<number, Record<string, number>>>({});
  const [betDrafts, setBetDrafts] = useState<Record<string, string>>({});
  const [betPending, setBetPending] = useState(false);
  const [betError, setBetError] = useState<string | null>(null);
  const [lastBetSig, setLastBetSig] = useState<string | null>(null);
  const [musicEnabled, setMusicEnabled] = useState(true);
  const [sfxEnabled, setSfxEnabled] = useState(true);
  const [hapticsEnabled, setHapticsEnabled] = useState(true);
  const [turnAnimationTurn, setTurnAnimationTurn] = useState<number | null>(null);
  const [recentEliminations, setRecentEliminations] = useState<string[]>([]);
  const bgMusicRef = useRef<Audio.Sound | null>(null);
  const audioInitializedRef = useRef(false);
  const musicEnabledRef = useRef(musicEnabled);
  const turnAnim = useRef(new Animated.Value(0)).current;
  const slotShakeAnim = useRef(new Animated.Value(0)).current;
  const contentRevealAnim = useRef(new Animated.Value(1)).current;
  const betTileSelectAnimRef = useRef<Record<string, Animated.Value>>({});
  const betTilePressAnimRef = useRef<Record<string, Animated.Value>>({});
  const lastAnimatedTurnRef = useRef<string>("");
  const lastStateToneRef = useRef<{ rumbleId: string; state: string } | null>(null);
  const clearElimsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusRequestInFlightRef = useRef(false);
  const chatRequestInFlightRef = useRef(false);
  const statusRetryAfterRef = useRef(0);
  const chatRetryAfterRef = useRef(0);

  const txRetryAfterRef = useRef(0);
  const balanceRetryAfterRef = useRef(0);
  const fallbackSendConnectionRef = useRef<Connection | null>(null);

  const walletAddress = useMemo(() => normalizeWalletAddress(account), [account]);
  const isBusy = busyAction !== null;

  const playSfx = useCallback(
    async (source: number) => {
      if (!sfxEnabled) return;
      try {
        const { sound } = await Audio.Sound.createAsync(source, {
          shouldPlay: true,
          volume: 0.8,
        });
        sound.setOnPlaybackStatusUpdate(status => {
          if (!status.isLoaded) return;
          if (status.didJustFinish) {
            void sound.unloadAsync();
          }
        });
      } catch {
        // Ignore transient playback failures.
      }
    },
    [sfxEnabled],
  );

  const triggerHaptic = useCallback(
    async (kind: "selection" | "impact" | "success" | "error" = "selection") => {
      if (!hapticsEnabled) return;
      try {
        if (kind === "selection") {
          await Haptics.selectionAsync();
          return;
        }
        if (kind === "impact") {
          await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          return;
        }
        if (kind === "success") {
          await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          return;
        }
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      } catch {
        if (kind === "error") {
          Vibration.vibrate([0, 35, 45, 35]);
        } else if (kind === "success") {
          Vibration.vibrate([0, 25, 30, 45]);
        } else {
          Vibration.vibrate(18);
        }
      }
    },
    [hapticsEnabled],
  );

  const getSendConnection = useCallback(() => {
    if (!fallbackSendConnectionRef.current) {
      const rpc = process.env.EXPO_PUBLIC_SOLANA_SEND_RPC_URL?.trim()
        || process.env.EXPO_PUBLIC_SOLANA_RPC_URL?.trim()
        || FALLBACK_RPC;
      fallbackSendConnectionRef.current = new Connection(rpc, {
        commitment: "confirmed",
        disableRetryOnRateLimit: true,
      });
    }
    return fallbackSendConnectionRef.current;
  }, []);

  useEffect(() => {
    musicEnabledRef.current = musicEnabled;
  }, [musicEnabled]);

  useEffect(() => {
    let cancelled = false;

    const initAudio = async () => {
      if (audioInitializedRef.current) return;
      audioInitializedRef.current = true;
      try {
        await Audio.setAudioModeAsync({
          playsInSilentModeIOS: true,
          staysActiveInBackground: false,
          shouldDuckAndroid: true,
          interruptionModeAndroid: 1,
          interruptionModeIOS: 1,
        });
        const { sound } = await Audio.Sound.createAsync(SND_BG_MUSIC, {
          isLooping: true,
          volume: 0.3,
          shouldPlay: false,
        });
        if (cancelled) {
          await sound.unloadAsync();
          return;
        }
        bgMusicRef.current = sound;
        if (musicEnabledRef.current) {
          await sound.playAsync();
        } else {
          await sound.pauseAsync();
        }
      } catch {
        audioInitializedRef.current = false;
      }
    };

    void initAudio();

    return () => {
      cancelled = true;
      const current = bgMusicRef.current;
      bgMusicRef.current = null;
      if (current) {
        void current.unloadAsync();
      }
    };
  }, []);

  useEffect(() => {
    const current = bgMusicRef.current;
    if (!current) return;
    if (musicEnabled) {
      void current.playAsync();
    } else {
      void current.pauseAsync();
    }
  }, [musicEnabled]);

  const featuredSlot = useMemo(() => {
    const slots = Array.isArray(rumbleStatus?.slots) ? [...rumbleStatus.slots] : [];
    if (slots.length === 0) return null;
    slots.sort((a, b) => {
      const aPriority = STATE_PRIORITY[a.state ?? "idle"] ?? 9;
      const bPriority = STATE_PRIORITY[b.state ?? "idle"] ?? 9;
      return aPriority - bPriority;
    });
    return slots[0] ?? null;
  }, [rumbleStatus]);

  const activeSlots = useMemo(
    () => (rumbleStatus?.slots ?? []).filter(slot => slot.state && slot.state !== "idle"),
    [rumbleStatus],
  );

  const allIdle = !featuredSlot || featuredSlot.state === "idle";

  const featuredFighters = useMemo(() => {
    const source = Array.isArray(featuredSlot?.fighters) ? featuredSlot.fighters : [];
    return source.slice().sort((a, b) => safeNumber(b.hp) - safeNumber(a.hp));
  }, [featuredSlot]);

  const featuredFightersById = useMemo(() => {
    const lookup = new Map<string, RumbleSlotFighter>();
    for (const fighter of featuredFighters) {
      const id = getFighterId(fighter).trim();
      if (!id) continue;
      lookup.set(id, fighter);
      lookup.set(id.toLowerCase(), fighter);
    }
    return lookup;
  }, [featuredFighters]);

  const fighterNameLookup = useMemo(() => {
    const lookup = new Map<string, string>();
    for (const fighter of featuredFighters) {
      const id = getFighterId(fighter).trim();
      const name = getFighterName(fighter).trim();
      if (id) lookup.set(id.toLowerCase(), name || id);
      if (name) lookup.set(name.toLowerCase(), name);
    }
    const slotNames = featuredSlot?.fighterNames ?? {};
    for (const [fighterId, fighterName] of Object.entries(slotNames)) {
      const id = String(fighterId).trim();
      const name = String(fighterName ?? "").trim();
      if (id && name) lookup.set(id.toLowerCase(), name);
    }
    return lookup;
  }, [featuredFighters, featuredSlot?.fighterNames]);

  const resolveFighterName = useCallback((token: unknown): string => {
    const raw = String(token ?? "").trim();
    if (!raw) return "UNKNOWN";
    const normalized = raw.toLowerCase();
    const byLookup = fighterNameLookup.get(normalized);
    if (byLookup) return byLookup;

    const numericIndex = Number(raw);
    if (Number.isInteger(numericIndex)) {
      const direct = featuredFighters[numericIndex];
      if (direct) return getFighterName(direct);
      if (numericIndex > 0) {
        const oneBased = featuredFighters[numericIndex - 1];
        if (oneBased) return getFighterName(oneBased);
      }
    }

    return raw;
  }, [fighterNameLookup, featuredFighters]);

  const resolveFighterDisplayName = useCallback((idToken: unknown, nameToken: unknown): string => {
    const idRaw = String(idToken ?? "").trim();
    const nameRaw = String(nameToken ?? "").trim();
    const resolvedFromName = nameRaw ? resolveFighterName(nameRaw) : "";
    if (resolvedFromName && resolvedFromName !== "UNKNOWN") {
      const sameAsId = idRaw && resolvedFromName.trim().toLowerCase() === idRaw.toLowerCase();
      const numericLike = /^\d+$/.test(nameRaw);
      if (!sameAsId && !numericLike) return resolvedFromName;
    }
    return resolveFighterName(idRaw || nameRaw || "UNKNOWN");
  }, [resolveFighterName]);

  const featuredOdds = useMemo(() => {
    const source = Array.isArray(featuredSlot?.odds) ? featuredSlot.odds : [];
    return source.slice().sort((a, b) => safeNumber(b.solDeployed) - safeNumber(a.solDeployed));
  }, [featuredSlot]);

  const featuredTurns = useMemo(() => {
    const turns = Array.isArray(featuredSlot?.turns) ? featuredSlot.turns : [];
    return turns.slice().sort((a, b) => safeNumber(a.turnNumber, 0) - safeNumber(b.turnNumber, 0));
  }, [featuredSlot]);

  const activeTurnData = useMemo(() => {
    if (featuredTurns.length === 0) return null;
    const currentTurn = safeNumber(featuredSlot?.currentTurn, 0);
    const exact = featuredTurns.find(turn => safeNumber(turn.turnNumber, -1) === currentTurn);
    return exact ?? featuredTurns[featuredTurns.length - 1] ?? null;
  }, [featuredTurns, featuredSlot]);

  const activePairings = useMemo(() => {
    if (!activeTurnData || !Array.isArray(activeTurnData.pairings)) return [];
    return activeTurnData.pairings.filter(pair => getFighterId({ id: pair.fighterA }) && getFighterId({ id: pair.fighterB }));
  }, [activeTurnData]);

  const combatBench = useMemo(() => {
    if (activePairings.length === 0) return [];
    const activeIds = new Set<string>();
    for (const pair of activePairings) {
      const left = String(pair.fighterA ?? "").trim();
      const right = String(pair.fighterB ?? "").trim();
      if (left) activeIds.add(left);
      if (right) activeIds.add(right);
    }
    return featuredFighters.filter(fighter => !activeIds.has(getFighterId(fighter)));
  }, [activePairings, featuredFighters]);

  const recentTurns = useMemo(() => featuredTurns.slice(-8).reverse(), [featuredTurns]);

  const recentEliminationTokenSet = useMemo(
    () => new Set(recentEliminations.map(value => String(value).trim().toLowerCase()).filter(Boolean)),
    [recentEliminations],
  );

  const isRecentlyEliminatedFighter = useCallback(
    (fighter: RumbleSlotFighter | null | undefined): boolean => {
      if (!fighter || recentEliminationTokenSet.size === 0) return false;
      const idToken = getFighterId(fighter).trim().toLowerCase();
      const nameToken = getFighterName(fighter).trim().toLowerCase();
      return (!!idToken && recentEliminationTokenSet.has(idToken)) || (!!nameToken && recentEliminationTokenSet.has(nameToken));
    },
    [recentEliminationTokenSet],
  );

  useEffect(() => {
    const activeState = String(featuredSlot?.state ?? "idle");
    if (activeState !== "combat" || !activeTurnData) return;
    const turnNumber = safeNumber(activeTurnData.turnNumber, safeNumber(featuredSlot?.currentTurn, 0));
    if (turnNumber <= 0) return;

    const turnKey = `${String(featuredSlot?.rumbleId ?? "")}:${turnNumber}`;
    if (lastAnimatedTurnRef.current === turnKey) return;
    lastAnimatedTurnRef.current = turnKey;

    setTurnAnimationTurn(turnNumber);
    turnAnim.stopAnimation();
    turnAnim.setValue(0);
    Animated.timing(turnAnim, {
      toValue: 1,
      duration: 520,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) {
        setTurnAnimationTurn(current => (current === turnNumber ? null : current));
      }
    });

    const pairings = Array.isArray(activeTurnData.pairings) ? activeTurnData.pairings : [];
    const hasImpact = pairings.some(pair => safeNumber(pair.damageToA, 0) >= 10 || safeNumber(pair.damageToB, 0) >= 10);
    const elimTokens = (activeTurnData.eliminations ?? []).map(value => String(value ?? "").trim()).filter(Boolean);

    if (elimTokens.length > 0) {
      void playSfx(SND_KO);
    } else if (pairings.length > 0) {
      const loudestPairing = pairings.reduce((best, current) => {
        const bestDamage = safeNumber(best.damageToA, 0) + safeNumber(best.damageToB, 0);
        const currentDamage = safeNumber(current.damageToA, 0) + safeNumber(current.damageToB, 0);
        return currentDamage > bestDamage ? current : best;
      }, pairings[0] as RumbleTurnPairing);
      void playSfx(pickPairingSfx(loudestPairing));
    } else {
      void playSfx(SND_ROUND_START);
    }

    if (hasImpact || elimTokens.length > 0) {
      slotShakeAnim.stopAnimation();
      slotShakeAnim.setValue(0);
      Animated.timing(slotShakeAnim, {
        toValue: 1,
        duration: 360,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }).start(() => {
        slotShakeAnim.setValue(0);
      });
    }

    if (elimTokens.length > 0) {
      setRecentEliminations(elimTokens);
      if (clearElimsTimeoutRef.current) clearTimeout(clearElimsTimeoutRef.current);
      clearElimsTimeoutRef.current = setTimeout(() => {
        setRecentEliminations([]);
      }, 1800);
    }
  }, [activeTurnData, featuredSlot?.currentTurn, featuredSlot?.rumbleId, featuredSlot?.state, slotShakeAnim, turnAnim, playSfx]);

  useEffect(() => {
    const rumbleId = String(featuredSlot?.rumbleId ?? "");
    const state = String(featuredSlot?.state ?? "idle");
    if (!rumbleId) return;

    const prev = lastStateToneRef.current;
    lastStateToneRef.current = { rumbleId, state };
    if (!prev) return;

    const stateChanged = prev.rumbleId !== rumbleId || prev.state !== state;
    if (!stateChanged) return;

    if (state === "combat") {
      void playSfx(SND_ROUND_START);
    } else if (state === "payout") {
      void playSfx(SND_CROWD_CHEER);
    }
  }, [featuredSlot?.rumbleId, featuredSlot?.state, playSfx]);

  useEffect(() => {
    return () => {
      if (clearElimsTimeoutRef.current) clearTimeout(clearElimsTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    contentRevealAnim.setValue(0);
    Animated.timing(contentRevealAnim, {
      toValue: 1,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [activeTab, featuredSlot?.rumbleId, featuredSlot?.state, contentRevealAnim]);

  const payoutPlacements = useMemo(() => {
    if (!featuredSlot || !Array.isArray(featuredSlot.fighters)) return [];
    return featuredSlot.fighters
      .filter(fighter => safeNumber(fighter.placement, 0) > 0)
      .slice()
      .sort((a, b) => safeNumber(a.placement, 0) - safeNumber(b.placement, 0));
  }, [featuredSlot]);

  const queuePreview = useMemo(() => {
    const source = Array.isArray(rumbleStatus?.queue) ? rumbleStatus.queue : [];
    return source.slice(0, 24);
  }, [rumbleStatus]);

  const selectedBets = useMemo(
    () => Object.entries(betDrafts)
      .map(([fighterId, amountText]) => ({ fighterId, amount: Number(amountText) }))
      .filter(entry => Number.isFinite(entry.amount) && entry.amount > 0),
    [betDrafts],
  );

  const getBetTileSelectAnim = useCallback((fighterId: string) => {
    const existing = betTileSelectAnimRef.current[fighterId];
    if (existing) return existing;
    const created = new Animated.Value(0);
    betTileSelectAnimRef.current[fighterId] = created;
    return created;
  }, []);

  const getBetTilePressAnim = useCallback((fighterId: string) => {
    const existing = betTilePressAnimRef.current[fighterId];
    if (existing) return existing;
    const created = new Animated.Value(0);
    betTilePressAnimRef.current[fighterId] = created;
    return created;
  }, []);

  const handleBetTilePressIn = useCallback((fighterId: string) => {
    const pressAnim = getBetTilePressAnim(fighterId);
    Animated.timing(pressAnim, {
      toValue: 1,
      duration: 80,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
  }, [getBetTilePressAnim]);

  const handleBetTilePressOut = useCallback((fighterId: string) => {
    const pressAnim = getBetTilePressAnim(fighterId);
    Animated.timing(pressAnim, {
      toValue: 0,
      duration: 130,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [getBetTilePressAnim]);

  useEffect(() => {
    const visibleFighterIds = new Set(
      featuredOdds.slice(0, 12).map((odd, idx) => String(odd.fighterId ?? `fighter_${idx}`)),
    );

    for (const fighterId of Object.keys(betTileSelectAnimRef.current)) {
      if (!visibleFighterIds.has(fighterId)) {
        betTileSelectAnimRef.current[fighterId]?.stopAnimation();
        delete betTileSelectAnimRef.current[fighterId];
      }
    }

    for (const fighterId of Object.keys(betTilePressAnimRef.current)) {
      if (!visibleFighterIds.has(fighterId)) {
        betTilePressAnimRef.current[fighterId]?.stopAnimation();
        delete betTilePressAnimRef.current[fighterId];
      }
    }

    for (const fighterId of visibleFighterIds) {
      const selectAnim = getBetTileSelectAnim(fighterId);
      const isSelected = Object.prototype.hasOwnProperty.call(betDrafts, fighterId);
      Animated.spring(selectAnim, {
        toValue: isSelected ? 1 : 0,
        stiffness: 260,
        damping: 18,
        mass: 0.8,
        useNativeDriver: true,
      }).start();
    }
  }, [featuredOdds, betDrafts, getBetTileSelectAnim]);

  const selectedBetTotal = useMemo(
    () => selectedBets.reduce((sum, bet) => sum + bet.amount, 0),
    [selectedBets],
  );

  const featuredSlotIndex = safeNumber(featuredSlot?.slotIndex, 0);
  const myBetsInFeaturedSlot = myBetsBySlot[featuredSlotIndex] ?? {};
  const hpBoardFighters = useMemo(() => {
    const betFighterIds = new Set(
      Object.entries(myBetsInFeaturedSlot)
        .filter(([, amount]) => safeNumber(amount, 0) > 0)
        .map(([fighterId]) => fighterId.trim().toLowerCase())
        .filter(Boolean),
    );
    if (betFighterIds.size === 0) return [];
    return featuredFighters.filter(fighter => betFighterIds.has(getFighterId(fighter).trim().toLowerCase()));
  }, [featuredFighters, myBetsInFeaturedSlot]);

  const runWalletAction = useCallback(
    async (label: string, fn: () => Promise<void>) => {
      if (isBusy) return;
      setBusyAction(label);
      try {
        await fn();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = (error as { code?: unknown } | null)?.code;
        const userInfo = (error as { userInfo?: unknown } | null)?.userInfo;
        console.error(`[wallet-action:${label}]`, {
          message,
          code,
          userInfo,
          raw: error,
        });
        if (isCancellationError(error)) {
          setStatusText("Cancelled by user");
          void triggerHaptic("selection");
          return;
        }
        setStatusText(`Error: ${message}`);
        void triggerHaptic("error");
      } finally {
        setBusyAction(null);
      }
    },
    [isBusy, triggerHaptic],
  );

  const fetchStatus = useCallback(async (force = false) => {
    const now = Date.now();
    if (!force && now < statusRetryAfterRef.current) return;
    if (statusRequestInFlightRef.current) return;
    statusRequestInFlightRef.current = true;

    try {
      const data = await fetchJsonFromCandidates<RumbleStatusResponse>(`/api/rumble/status?_t=${Date.now()}`);
      setRumbleStatus(data);
      setLastStatusAt(Date.now());
      setStatusError(null);
      statusRetryAfterRef.current = 0;
      if (statusText.startsWith("Network issue:")) {
        setStatusText("Ready");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isRateLimitError(error)) {
        const retryMs = 5_000;
        statusRetryAfterRef.current = Date.now() + retryMs;
        setStatusError(`Rate limited (429). Retrying in ${Math.ceil(retryMs / 1000)}s.`);
        setStatusText(`Rate limited. Retrying in ${Math.ceil(retryMs / 1000)}s...`);
        return;
      }
      setStatusError(message);
      if (!rumbleStatus) {
        setStatusText(`Network issue: ${message}`);
      }
    } finally {
      statusRequestInFlightRef.current = false;
      setStatusLoading(false);
    }
  }, [rumbleStatus, statusText]);

  const fetchClaimBalance = useCallback(async () => {
    if (!walletAddress) {
      setClaimBalance(null);
      setClaimError(null);
      return;
    }

    setClaimLoading(true);
    try {
      const body = await fetchJsonFromCandidates<ClaimBalanceResponse>(
        `/api/rumble/balance?wallet=${encodeURIComponent(walletAddress)}&_t=${Date.now()}`,
      );
      setClaimBalance(body as ClaimBalanceResponse);
      setClaimError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setClaimError(message);
    } finally {
      setClaimLoading(false);
    }
  }, [walletAddress]);

  const fetchMyBets = useCallback(async (includeOnchain = false) => {
    if (!walletAddress) {
      setMyBetsBySlot({});
      return;
    }
    try {
      const payload = await fetchJsonFromCandidates<MyBetsResponse>(
        `/api/rumble/my-bets?wallet=${encodeURIComponent(walletAddress)}${includeOnchain ? "&include_onchain=1" : ""}&_t=${Date.now()}`,
      );
      const mapped: Record<number, Record<string, number>> = {};
      for (const slot of payload.slots ?? []) {
        const slotIndex = safeNumber(slot.slot_index, -1);
        if (slotIndex < 0) continue;
        mapped[slotIndex] = {};
        for (const bet of slot.bets ?? []) {
          const fighterId = String(bet.fighter_id ?? "").trim();
          if (!fighterId) continue;
          const amount = safeNumber(bet.sol_amount, 0);
          if (amount > 0) mapped[slotIndex][fighterId] = amount;
        }
      }
      setMyBetsBySlot(mapped);
    } catch {
      // keep previous values on fetch failure
    }
  }, [walletAddress]);

  const fetchChat = useCallback(async (force = false) => {
    const now = Date.now();
    if (!force && now < chatRetryAfterRef.current) return;
    if (chatRequestInFlightRef.current) return;
    chatRequestInFlightRef.current = true;

    try {
      const rows = await fetchJsonFromCandidates<ChatMessage[]>(`/api/chat?_t=${Date.now()}`);
      setMessages(Array.isArray(rows) ? rows : []);
      setChatError(null);
      chatRetryAfterRef.current = 0;
    } catch (error) {
      if (isRateLimitError(error)) {
        const retryMs = 8_000;
        chatRetryAfterRef.current = Date.now() + retryMs;
        setChatError(`Chat rate limited (429). Retrying in ${Math.ceil(retryMs / 1000)}s.`);
      } else {
        setChatError("Failed to refresh chat feed");
      }
    } finally {
      chatRequestInFlightRef.current = false;
      setChatLoading(false);
    }
  }, []);

  const fetchTxFeed = useCallback(async () => {
    const now = Date.now();
    if (now < txRetryAfterRef.current) return;

    try {
      const data = await fetchJsonFromCandidates<{ signatures: TxEntry[] }>(`/api/rumble/tx-feed?_t=${Date.now()}`);
      setTxFeed(Array.isArray(data.signatures) ? data.signatures : []);
      setTxError(null);
      txRetryAfterRef.current = 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isRateLimitError(error)) {
        txRetryAfterRef.current = Date.now() + RPC_RATE_LIMIT_COOLDOWN_MS;
        setTxError(`Rate limited. Retrying in ${Math.ceil(RPC_RATE_LIMIT_COOLDOWN_MS / 1000)}s.`);
        return;
      }
      setTxError(message);
    } finally {
      setTxLoading(false);
    }
  }, []);

  const fetchSolBalance = useCallback(async () => {
    if (!walletAddress) {
      setSolBalance(null);
      return;
    }

    const now = Date.now();
    if (now < balanceRetryAfterRef.current) return;

    try {
      const data = await fetchJsonFromCandidates<{ sol: number }>(
        `/api/rumble/sol-balance?address=${walletAddress}&_t=${Date.now()}`,
      );
      setSolBalance(data.sol ?? null);
      balanceRetryAfterRef.current = 0;
    } catch (error) {
      if (isRateLimitError(error)) {
        balanceRetryAfterRef.current = Date.now() + RPC_RATE_LIMIT_COOLDOWN_MS;
        return;
      }
      setSolBalance(null);
    }
  }, [walletAddress]);

  useEffect(() => {
    void fetchStatus();
    void fetchChat();
    void fetchTxFeed();
  }, [fetchStatus, fetchChat, fetchTxFeed]);

  useEffect(() => {
    const hasCombat = (rumbleStatus?.slots ?? []).some(slot => slot.state === "combat");
    const hasBetting = (rumbleStatus?.slots ?? []).some(slot => slot.state === "betting");
    const intervalMs = hasCombat ? 2000 : hasBetting ? 4000 : 12000;
    const timer = setInterval(() => void fetchStatus(), intervalMs);
    return () => clearInterval(timer);
  }, [fetchStatus, rumbleStatus]);

  useEffect(() => {
    const timer = setInterval(() => void fetchChat(), 6000);
    return () => clearInterval(timer);
  }, [fetchChat]);

  useEffect(() => {
    const timer = setInterval(() => void fetchTxFeed(), 45_000);
    return () => clearInterval(timer);
  }, [fetchTxFeed]);

  useEffect(() => {
    void fetchClaimBalance();
    void fetchMyBets(false);
    void fetchSolBalance();
  }, [fetchClaimBalance, fetchMyBets, fetchSolBalance]);

  useEffect(() => {
    const timer = setInterval(() => {
      void fetchClaimBalance();
      void fetchMyBets(false);
      void fetchSolBalance();
    }, 60_000);
    return () => clearInterval(timer);
  }, [fetchClaimBalance, fetchMyBets, fetchSolBalance]);

  useEffect(() => {
    setBetDrafts({});
  }, [featuredSlot?.rumbleId]);

  const onConnect = useCallback(() => {
    void runWalletAction("connect", async () => {
      const connected = await connect();
      const address = normalizeWalletAddress(connected);
      setStatusText(address ? `Connected: ${shortAddress(address, 6, 6)}` : "Connected");
      void playSfx(SND_ROUND_START);
      void triggerHaptic("success");
      await Promise.all([fetchClaimBalance(), fetchMyBets(true), fetchSolBalance()]);
    });
  }, [connect, runWalletAction, fetchClaimBalance, fetchMyBets, fetchSolBalance, playSfx, triggerHaptic]);

  const onDisconnect = useCallback(() => {
    void runWalletAction("disconnect", async () => {
      await disconnect();
      setStatusText("Disconnected");
      setClaimBalance(null);
      setMyBetsBySlot({});
      setSolBalance(null);
      void triggerHaptic("selection");
    });
  }, [disconnect, runWalletAction, triggerHaptic]);

  const onSignMessage = useCallback(() => {
    void runWalletAction("sign-message", async () => {
      if (!walletAddress) throw new Error("Connect a wallet first.");
      const payload = `Lobsta Fights wallet check ${new Date().toISOString()}`;
      const bytes = new TextEncoder().encode(payload);
      const signature = await signMessage(bytes);
      const base64 = fromUint8Array(signature);
      setStatusText(`Signed message: ${base64.slice(0, 24)}...`);
    });
  }, [walletAddress, signMessage, runWalletAction]);

  const onSignIn = useCallback(() => {
    void runWalletAction("sign-in", async () => {
      if (!walletAddress) throw new Error("Connect a wallet first.");

      const noncePayload = await fetchJsonFromCandidates<NonceResponse>(`/api/mobile-auth/nonce`);

      const signInPayload = {
        domain: "clawfights.xyz",
        statement: "Sign in to Lobsta Fights",
        uri: "https://clawfights.xyz",
        version: "1",
        nonce: noncePayload.nonce,
        issuedAt: noncePayload.issuedAt,
      };

      const authToken = store.$authToken.get();
      const authorizationResult = await transact(async wallet => {
        return await wallet.authorize({
          chain,
          identity,
          auth_token: authToken,
          sign_in_payload: signInPayload,
        });
      });

      await connect();

      const signInResult = (authorizationResult as any)?.sign_in_result;
      if (!signInResult) throw new Error("Wallet did not return sign-in proof");

      const verifyRes = await postJsonWithFallback("/api/mobile-auth/verify", {
        walletAddress,
        signInPayload,
        signInResult,
      });

      if (!verifyRes.ok) {
        const text = await verifyRes.text();
        throw new Error(`SIWS verify failed (${verifyRes.status}): ${text}`);
      }

      const verifyPayload = (await verifyRes.json()) as VerifyResponse;
      if (!verifyPayload.ok) throw new Error("SIWS verification rejected");
      setStatusText(`SIWS verified: ${shortAddress(verifyPayload.walletAddress, 6, 6)}`);
    });
  }, [walletAddress, runWalletAction, store, connect]);

  const onSendChat = useCallback(() => {
    void runWalletAction("chat-send", async () => {
      if (!walletAddress) throw new Error("Connect wallet to chat");
      const message = chatInput.trim();
      if (!message) return;
      if (message.length > 500) throw new Error("Max 500 chars");

      setChatSending(true);
      setChatError(null);

      try {
        const timestamp = String(Date.now());
        const verifyText = `UCF Chat: ${timestamp}`;
        const signatureBytes = await signMessage(new TextEncoder().encode(verifyText));
        const signature = fromUint8Array(signatureBytes);

        const res = await postJsonWithFallback("/api/chat", {
          wallet_address: walletAddress,
          message,
          signature,
          timestamp,
        });

        const body = await res.json();
        if (!res.ok) {
          throw new Error(String((body as any)?.error ?? `Chat ${res.status}`));
        }

        setChatInput("");
        setMessages(prev => [...prev, body as ChatMessage].slice(-50));
        void triggerHaptic("selection");
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        setChatError(text);
      } finally {
        setChatSending(false);
      }
    });
  }, [walletAddress, chatInput, signMessage, runWalletAction, triggerHaptic]);

  const submitBets = useCallback(async (slotIndex: number, bets: Array<{ fighterId: string; amount: number }>) => {
    if (!walletAddress) {
      setBetError("Connect wallet first to place bets.");
      throw new Error("Wallet not connected");
    }

    if (!bets.length) {
      throw new Error("No bets selected.");
    }

    for (const bet of bets) {
      if (!Number.isFinite(bet.amount) || bet.amount < 0.02 || bet.amount > 10) {
        throw new Error("Each bet must be between 0.02 and 10 SOL.");
      }
    }

    const slotData = (rumbleStatus?.slots ?? []).find(slot => safeNumber(slot.slotIndex, -1) === slotIndex);
    if (!slotData || slotData.state !== "betting") {
      throw new Error("Betting is not open for this slot.");
    }

    setBetPending(true);
    setBetError(null);

    try {
      const prepareRes = await postJsonWithFallback("/api/rumble/bet/prepare", {
        slot_index: slotIndex,
        wallet_address: walletAddress,
        bets: bets.map(bet => ({ fighter_id: bet.fighterId, sol_amount: bet.amount })),
      });

      const prepared = (await prepareRes.json()) as PrepareBetResponse & { error?: string };
      if (!prepareRes.ok) {
        throw new Error(prepared.error ?? `Prepare failed (${prepareRes.status})`);
      }

      const onchainDeadlineMs = prepared.onchain_betting_deadline
        ? new Date(String(prepared.onchain_betting_deadline)).getTime()
        : Number.NaN;
      const guardMs = safeNumber(prepared.guard_ms, safeNumber(rumbleStatus?.bettingCloseGuardMs, 12_000));
      if (Number.isFinite(onchainDeadlineMs) && Date.now() >= onchainDeadlineMs - Math.max(1_000, guardMs)) {
        throw new Error("Betting just closed on-chain. Wait for next rumble.");
      }

      const closeSlotRaw = Number(prepared.onchain_betting_close_slot);
      const guardSlotsRaw = Number(prepared.guard_slots);
      const sendConnection = getSendConnection();
      const checkWindowOpen = async () => {
        if (!Number.isFinite(closeSlotRaw) || closeSlotRaw <= 0 || !Number.isFinite(guardSlotsRaw)) return;
        const latestSlot = await sendConnection.getSlot("processed");
        if (latestSlot + guardSlotsRaw >= closeSlotRaw) {
          throw new Error("Betting just closed on-chain. Wait for next rumble.");
        }
      };

      await checkWindowOpen();

      const tx = decodeBase64Tx(prepared.transaction_base64);
      tx.feePayer = new PublicKey(walletAddress);

      const signedTx = (await signTransaction(tx as any)) as Transaction;

      await checkWindowOpen();

      const raw = signedTx.serialize();
      const txSig = await sendConnection.sendRawTransaction(raw, {
        skipPreflight: false,
        preflightCommitment: "processed",
      });

      const preparedLegs: Array<{ fighter_id: string; sol_amount: number; fighter_index?: number }> =
        Array.isArray(prepared.bets) && prepared.bets.length > 0
          ? prepared.bets
          : bets.map(bet => ({ fighter_id: bet.fighterId, sol_amount: bet.amount }));

      const registerRes = await postJsonWithFallback("/api/rumble/bet", {
        slot_index: slotIndex,
        fighter_id: preparedLegs[0]?.fighter_id,
        sol_amount: preparedLegs[0]?.sol_amount,
        bets: preparedLegs,
        wallet_address: walletAddress,
        tx_signature: txSig,
        tx_kind: prepared.tx_kind ?? "rumble_place_bet",
        rumble_id: prepared.rumble_id,
        rumble_id_num: prepared.rumble_id_num,
        fighter_index: preparedLegs[0]?.fighter_index,
      });

      const registerBody = await registerRes.json().catch(() => ({}));
      if (!registerRes.ok) {
        throw new Error(String((registerBody as any)?.error ?? "Bet registered on-chain but API write failed."));
      }

      setLastBetSig(txSig);
      setBetDrafts({});
      setStatusText(`Bet placed: ${shortAddress(txSig, 8, 8)}`);
      void playSfx(SND_BET_PLACED);
      void triggerHaptic("success");

      await Promise.all([
        fetchStatus(),
        fetchClaimBalance(),
        fetchMyBets(true),
        fetchSolBalance(),
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setBetError(message || "Failed to place bet");
      throw error;
    } finally {
      setBetPending(false);
    }
  }, [walletAddress, rumbleStatus, signTransaction, getSendConnection, fetchStatus, fetchClaimBalance, fetchMyBets, fetchSolBalance, playSfx, triggerHaptic]);

  const onDeploySelectedBets = useCallback(() => {
    void runWalletAction("deploy-bets", async () => {
      if (!featuredSlot) throw new Error("No featured slot available.");
      const slotIndex = safeNumber(featuredSlot.slotIndex, -1);
      if (slotIndex < 0) throw new Error("Invalid slot index.");
      if (selectedBets.length === 0) throw new Error("No bets selected.");
      void triggerHaptic("impact");
      await submitBets(slotIndex, selectedBets);
    });
  }, [runWalletAction, featuredSlot, selectedBets, submitBets, triggerHaptic]);

  const onClaimWinnings = useCallback(() => {
    void runWalletAction("claim", async () => {
      if (!walletAddress) throw new Error("Connect wallet first.");
      if (!claimBalance?.onchain_claim_ready || safeNumber(claimBalance.claimable_sol, 0) <= 0) {
        throw new Error("No on-chain claimable payout is ready yet.");
      }

      setClaimPending(true);
      setClaimError(null);

      let totalClaimed = 0;
      let batchNum = 0;
      const maxBatches = 5;
      const sendConnection = getSendConnection();

      try {
        while (batchNum < maxBatches) {
          batchNum += 1;

          const prepareRes = await postJsonWithFallback("/api/rumble/claim/prepare", {
            wallet_address: walletAddress,
          });
          const prepared = await prepareRes.json();

          if (!prepareRes.ok) {
            const reason = String((prepared as any)?.reason ?? "");
            if (batchNum > 1 && (reason === "none_ready" || reason === "vaults_underfunded" || prepareRes.status === 404)) {
              break;
            }
            throw new Error(String((prepared as any)?.error ?? "Failed to prepare claim transaction"));
          }

          const tx = decodeBase64Tx(String((prepared as any).transaction_base64 ?? ""));
          tx.feePayer = new PublicKey(walletAddress);

          const signed = (await signTransaction(tx as any)) as Transaction;
          const raw = signed.serialize();
          const txSig = await sendConnection.sendRawTransaction(raw, {
            skipPreflight: false,
            preflightCommitment: "processed",
          });

          const confirmRes = await postJsonWithFallback("/api/rumble/claim/confirm", {
            wallet_address: walletAddress,
            rumble_id: (prepared as any).rumble_id,
            rumble_ids: Array.isArray((prepared as any).rumble_ids)
              ? (prepared as any).rumble_ids
              : [String((prepared as any).rumble_id ?? "")].filter(Boolean),
            tx_signature: txSig,
          });
          const confirmPayload = await confirmRes.json();
          if (!confirmRes.ok) {
            if (totalClaimed > 0) break;
            throw new Error(String((confirmPayload as any)?.error ?? "Failed to confirm claim"));
          }

          totalClaimed += safeNumber((prepared as any).claim_count, 1);

          const skippedEligible = safeNumber((prepared as any).skipped_eligible_claims, 0);
          if (skippedEligible <= 0) break;

          await new Promise(resolve => setTimeout(resolve, 2000));
        }

        if (totalClaimed > 0) {
          setStatusText(`Claimed ${totalClaimed} rumble payout(s)`);
          void playSfx(SND_CLAIM);
          void triggerHaptic("success");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setClaimError(message);
      } finally {
        setClaimPending(false);
        await Promise.all([fetchClaimBalance(), fetchStatus(), fetchSolBalance()]);
      }
    });
  }, [walletAddress, claimBalance, runWalletAction, getSendConnection, signTransaction, fetchClaimBalance, fetchStatus, fetchSolBalance, triggerHaptic]);

  const setQuickBetAmount = useCallback((fighterId: string, amount: number) => {
    setBetDrafts(prev => ({ ...prev, [fighterId]: String(amount) }));
  }, []);

  const toggleBetSelection = useCallback((fighterId: string) => {
    void triggerHaptic("selection");
    setBetDrafts(prev => {
      if (Object.prototype.hasOwnProperty.call(prev, fighterId)) {
        const next = { ...prev };
        delete next[fighterId];
        return next;
      }
      return { ...prev, [fighterId]: "0.02" };
    });
  }, [triggerHaptic]);

  const updateBetAmount = useCallback((fighterId: string, amountText: string) => {
    const normalized = amountText.replace(/[^0-9.]/g, "");
    setBetDrafts(prev => ({ ...prev, [fighterId]: normalized }));
  }, []);

  const clearBetError = useCallback(() => setBetError(null), []);

  const handleTabChange = useCallback((tab: TabKey) => {
    setActiveTab(prev => {
      if (prev === tab) return prev;
      void playSfx(SND_CLICK);
      void triggerHaptic("selection");
      return tab;
    });
  }, [playSfx, triggerHaptic]);

  const handleToggleMusic = useCallback(() => {
    void playSfx(SND_CLICK);
    void triggerHaptic("selection");
    setMusicEnabled(prev => !prev);
  }, [playSfx, triggerHaptic]);

  const handleToggleSfx = useCallback(() => {
    if (sfxEnabled) void playSfx(SND_CLICK);
    void triggerHaptic("selection");
    setSfxEnabled(prev => !prev);
  }, [playSfx, sfxEnabled, triggerHaptic]);

  const handleToggleHaptics = useCallback(() => {
    setHapticsEnabled(prev => {
      const next = !prev;
      if (next) {
        void Haptics.selectionAsync().catch(() => {
          Vibration.vibrate(16);
        });
      }
      return next;
    });
  }, []);

  const featuredState = String(featuredSlot?.state ?? "idle");
  const stateColor = getStateColor(featuredSlot?.state);
  const signalLive = lastStatusAt !== null && Date.now() - lastStatusAt < 8000;

  const queueLength = safeNumber(rumbleStatus?.queueLength, queuePreview.length);
  const ichorPool = safeNumber(rumbleStatus?.ichorShower?.currentPool, 0);
  const activeTurn = safeNumber(featuredSlot?.currentTurn, 0);

  const claimableSol = safeNumber(claimBalance?.claimable_sol, 0);
  const claimedSol = safeNumber(claimBalance?.claimed_sol, 0);
  const pendingNotReady = safeNumber(claimBalance?.onchain_pending_not_ready_sol, 0);
  const combatAliveCount = safeNumber(
    featuredSlot?.remainingFighters,
    featuredFighters.filter(fighter => safeNumber(fighter.hp, 0) > 0).length,
  );

  const payoutMode = claimBalance?.payout_mode ?? "accrue_claim";
  const canClaim =
    payoutMode === "accrue_claim" &&
    !!claimBalance?.onchain_claim_ready &&
    claimableSol > 0 &&
    !claimPending;

  const combatShakeTranslateX = slotShakeAnim.interpolate({
    inputRange: [0, 0.2, 0.4, 0.6, 0.8, 1],
    outputRange: [0, -8, 7, -5, 3, 0],
  });

  return (
    <ImageBackground source={RUMBLE_ARENA_BG} style={styles.bgImage} imageStyle={styles.bgImageStyle}>
      <View style={styles.bgOverlay} />


      <View style={styles.screen}>
        <View style={styles.header}>
          <View style={styles.headerTitleWrap}>
            <Text
              style={styles.title}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.72}
              allowFontScaling={false}
            >
              RUMBLE
            </Text>
            <Text style={styles.subTitle}>BATTLE ROYALE // 8-16 FIGHTERS // LAST BOT STANDING</Text>
          </View>
          <View style={styles.headerRight}>
            <View style={styles.liveRow}>
              <View style={[styles.liveDot, signalLive ? styles.liveDotOn : styles.liveDotOff]} />
              <Text style={styles.liveText}>{signalLive ? "LIVE" : "POLLING"}</Text>
            </View>
            <SoundControls
              musicEnabled={musicEnabled}
              sfxEnabled={sfxEnabled}
              hapticsEnabled={hapticsEnabled}
              onToggleMusic={handleToggleMusic}
              onToggleSfx={handleToggleSfx}
              onToggleHaptics={handleToggleHaptics}
            />
            <WalletHeader
              walletAddress={walletAddress}
              busy={isBusy}
              solBalance={solBalance}
              onConnect={onConnect}
              onDisconnect={onDisconnect}
            />
          </View>
        </View>

        {betError ? (
          <Pressable onPress={clearBetError} style={({ pressed }) => [styles.betErrorToast, pressed ? styles.pressablePressed : null]}>
            <Text style={styles.betErrorToastText}>{betError}</Text>
          </Pressable>
        ) : null}

        {statusLoading && !rumbleStatus ? (
          <View style={styles.statusBanner}>
            <ActivityIndicator color="#f59e0b" size="small" />
            <Text style={styles.statusText}>Loading live rumble...</Text>
          </View>
        ) : null}

        {!statusLoading && statusError ? (
          <Pressable
            onPress={() => {
              setStatusLoading(true);
              void fetchStatus(true);
            }}
            style={({ pressed }) => [styles.statusBannerWarn, pressed ? styles.pressablePressed : null]}
          >
            <Text style={styles.statusText}>Network issue. Tap to retry.</Text>
            <Text style={styles.statusErrorDetail} numberOfLines={2}>{statusError}</Text>
          </Pressable>
        ) : null}

        {statusText !== "Ready" && !statusError ? (
          <View style={styles.statusBannerMuted}>
            <Text style={styles.statusText}>{statusText}</Text>
          </View>
        ) : null}

        <View style={styles.contentWrap}>
          <ScrollView
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            <Animated.View
              style={{
                opacity: contentRevealAnim,
                transform: [
                  {
                    translateY: contentRevealAnim.interpolate({
                      inputRange: [0, 1],
                      outputRange: [8, 0],
                    }),
                  },
                ],
              }}
            >
            {activeTab === "arena" ? (
              <>
                {activeSlots.length > 1 ? (
                  <View style={styles.slotPillRow}>
                    {activeSlots.map(slot => {
                      const slotState = String(slot.state ?? "idle");
                      const isFeatured = slot.rumbleId === featuredSlot?.rumbleId;
                      return (
                        <View key={`${slot.rumbleId ?? "slot"}_${slot.slotIndex ?? 0}`} style={[styles.slotPill, isFeatured ? styles.slotPillActive : null]}>
                          <Text style={[styles.slotPillText, { color: getStateColor(slotState) }]}>
                            [{slotState.toUpperCase()}]
                          </Text>
                        </View>
                      );
                    })}
                  </View>
                ) : null}

                {allIdle ? (
                  <View style={styles.panel}>
                    <View style={styles.idleArenaWrap}>
                      <ExpoImage source={RUMBLE_ARENA_BG} style={styles.idleArenaImage} contentFit="cover" />
                      <ExpoImage source={RUMBLE_CAGE_OVERLAY_PNG} style={styles.idleCageImage} contentFit="cover" />
                      <View style={styles.idleArenaShade} />
                      <View style={styles.idleArenaTextWrap}>
                        <Text style={styles.idleArenaTitle}>THE CAGE AWAITS</Text>
                        <Text style={styles.idleArenaSub}>
                          {queueLength > 0
                            ? `${queueLength} fighter${queueLength !== 1 ? "s" : ""} in queue`
                            : "No fighters queued"}
                        </Text>
                        <Text style={styles.idleArenaHint}>
                          {queueLength >= 8 ? "NEXT RUMBLE STARTING SOON" : "Need 8+ fighters to start a rumble"}
                        </Text>
                      </View>
                    </View>
                  </View>
                ) : null}

                {!allIdle ? (
                  <View style={styles.panel}>
                    <View style={styles.panelTopRow}>
                      <Text style={[styles.panelState, { color: stateColor }]}>
                        [{featuredState.toUpperCase()}]
                      </Text>
                    </View>
                    <Text style={styles.panelMuted}>{rumbleStatus?.nextRumbleIn ?? "Need fighters in queue"}</Text>

                    {featuredState === "betting" ? (
                      <>
                        <View style={styles.timerCard}>
                          <Text style={styles.timerLabel}>BETTING OPEN</Text>
                          <Text style={styles.timerValue}>{formatCountdown(featuredSlot?.bettingDeadline)}</Text>
                        </View>
                        {featuredOdds.length === 0 ? (
                          <Text style={styles.emptyText}>Odds data not available yet.</Text>
                        ) : (
                          <View style={styles.betTileGrid}>
                            {featuredOdds.slice(0, 12).map((odd, idx) => {
                              const fighterId = String(odd.fighterId ?? `fighter_${idx}`);
                              const isSelected = Object.prototype.hasOwnProperty.call(betDrafts, fighterId);
                              const myStake = myBetsInFeaturedSlot[fighterId] ?? 0;
                              const amountText = betDrafts[fighterId] ?? "0.02";
                              const deployed = safeNumber(odd.solDeployed, 0);
                              return (
                                <Animated.View
                                  key={`${fighterId}_${idx}`}
                                  style={[
                                    styles.betTile,
                                    isSelected ? styles.betTileSelected : null,
                                    {
                                      transform: [
                                        {
                                          translateY: getBetTileSelectAnim(fighterId).interpolate({
                                            inputRange: [0, 1],
                                            outputRange: [0, -4],
                                          }),
                                        },
                                        {
                                          scale: Animated.multiply(
                                            getBetTileSelectAnim(fighterId).interpolate({
                                              inputRange: [0, 1],
                                              outputRange: [1, 1.035],
                                            }),
                                            getBetTilePressAnim(fighterId).interpolate({
                                              inputRange: [0, 1],
                                              outputRange: [1, 0.975],
                                            }),
                                          ),
                                        },
                                      ],
                                    },
                                  ]}
                                >
                                  <Pressable
                                    onPress={() => toggleBetSelection(fighterId)}
                                    onPressIn={() => handleBetTilePressIn(fighterId)}
                                    onPressOut={() => handleBetTilePressOut(fighterId)}
                                    style={styles.betTileTap}
                                  >
                                    <ExpoImage
                                      source={odd.imageUrl ? { uri: odd.imageUrl } : BOT_AVATAR_IMG}
                                      style={styles.betTileImage}
                                      contentFit="cover"
                                      transition={120}
                                    />
                                    <View style={styles.betTileBody}>
                                      <View style={styles.rowTopLine}>
                                        <Text style={styles.rowName} numberOfLines={1}>{getFighterName(odd)}</Text>
                                        {myStake > 0 ? <Text style={styles.myBetTag}>BET</Text> : null}
                                      </View>
                                      <Text style={styles.rowSub}>Return {safeNumber(odd.potentialReturn, 0).toFixed(1)}x</Text>
                                      <Text style={styles.rowSub}>Win {formatPct(odd.impliedProbability)} // Pool {deployed.toFixed(2)} SOL</Text>
                                      {myStake > 0 ? <Text style={styles.rowSubStrong}>You: {myStake.toFixed(2)} SOL</Text> : null}
                                    </View>
                                  </Pressable>
                                  {isSelected ? (
                                    <View style={styles.betControlsWrap}>
                                      <View style={styles.quickAmountRow}>
                                        {[0.02, 0.05, 0.075, 0.1].map(amount => (
                                          <Pressable
                                            key={`${fighterId}_${amount}`}
                                            onPress={() => setQuickBetAmount(fighterId, amount)}
                                            style={[
                                              styles.quickAmountBtn,
                                              Number(amountText) === amount ? styles.quickAmountBtnActive : null,
                                            ]}
                                          >
                                            <Text style={styles.quickAmountText}>{amount}</Text>
                                          </Pressable>
                                        ))}
                                      </View>
                                      <TextInput
                                        value={amountText}
                                        onChangeText={text => updateBetAmount(fighterId, text)}
                                        keyboardType="decimal-pad"
                                        placeholder="SOL..."
                                        placeholderTextColor="#57534e"
                                        style={styles.betAmountInput}
                                      />
                                    </View>
                                  ) : null}
                                </Animated.View>
                              );
                            })}
                          </View>
                        )}
                        {lastBetSig ? (
                          <Pressable onPress={() => setLastBetSig(null)} style={({ pressed }) => [styles.lastSigCard, pressed ? styles.pressablePressed : null]}>
                            <Text style={styles.lastSigText}>
                              View on Explorer: {shortAddress(lastBetSig, 8, 8)}
                            </Text>
                          </Pressable>
                        ) : null}
                        {selectedBets.length > 0 ? (
                          <Pressable
                            onPress={onDeploySelectedBets}
                            disabled={isBusy || betPending || featuredSlot?.state !== "betting"}
                            style={({ pressed }) => [
                              styles.deployBtn,
                              (isBusy || betPending || featuredSlot?.state !== "betting") && styles.btnDisabled,
                              pressed ? styles.pressablePressed : null,
                            ]}
                          >
                            <Text style={styles.deployBtnText}>
                              {betPending
                                ? "DEPLOYING..."
                                : selectedBets.length === 1
                                  ? `DEPLOY (${selectedBetTotal.toFixed(2)} SOL)`
                                  : `DEPLOY (${selectedBets.length} fighters · ${selectedBetTotal.toFixed(2)} SOL)`}
                            </Text>
                          </Pressable>
                        ) : null}
                        <Text style={styles.panelFootnote}>Select one or more fighters · 1% admin + 5% sponsorship deducted.</Text>
                      </>
                    ) : null}

                    {featuredState === "combat" ? (
                      <>
                        <View style={styles.timerCard}>
                          <Text style={styles.timerLabel}>LIVE MATCHUPS</Text>
                          <Text style={styles.timerValue}>TURN {activeTurn}</Text>
                        </View>
                        <View style={styles.combatHeaderRow}>
                          <Text style={styles.sectionLabel}>LIVE MATCHUPS // TURN {safeNumber(activeTurnData?.turnNumber, activeTurn)}</Text>
                          <Text style={styles.panelMeta}>({combatAliveCount} alive)</Text>
                        </View>
                        {recentEliminations.length > 0 ? (
                          <View style={styles.eliminationFeed}>
                            {recentEliminations.slice(0, 2).map((token, idx) => {
                              const normalized = String(token).trim().toLowerCase();
                              const label = resolveFighterName(token);
                              return (
                                <Text key={`${normalized}_${idx}`} style={styles.eliminationFeedItem}>
                                  ELIMINATED // {label.toUpperCase()}
                                </Text>
                              );
                            })}
                          </View>
                        ) : null}
                        {activePairings.length === 0 ? (
                          <Text style={styles.emptyText}>Deploying fighters...</Text>
                        ) : (
                          <Animated.View style={{ transform: [{ translateX: combatShakeTranslateX }] }}>
                            <View style={styles.combatPairsStack}>
                              {activePairings.map((pair, idx) => {
                                const leftId = String(pair.fighterA ?? "");
                                const rightId = String(pair.fighterB ?? "");
                                const left = featuredFightersById.get(leftId) ?? featuredFightersById.get(leftId.trim().toLowerCase());
                                const right = featuredFightersById.get(rightId) ?? featuredFightersById.get(rightId.trim().toLowerCase());
                                const leftHp = safeNumber(left?.hp, 0);
                                const rightHp = safeNumber(right?.hp, 0);
                                const leftMax = Math.max(1, safeNumber(left?.maxHp, 100));
                                const rightMax = Math.max(1, safeNumber(right?.maxHp, 100));
                                const leftEliminated = leftHp <= 0;
                                const rightEliminated = rightHp <= 0;
                                const turnNumber = safeNumber(activeTurnData?.turnNumber, activeTurn);
                                const isTurnAnimating = turnAnimationTurn === turnNumber;
                                const leftMove = String(pair.moveA ?? "").toUpperCase();
                                const rightMove = String(pair.moveB ?? "").toUpperCase();
                                const leftStrikes = isStrikeMove(leftMove);
                                const rightStrikes = isStrikeMove(rightMove);
                                const totalDamage = safeNumber(pair.damageToA, 0) + safeNumber(pair.damageToB, 0);

                                const leftAnimStyle = isTurnAnimating
                                  ? leftStrikes && !rightStrikes
                                    ? {
                                        transform: [
                                          {
                                            translateX: turnAnim.interpolate({
                                              inputRange: [0, 0.45, 1],
                                              outputRange: [0, 8, 0],
                                            }),
                                          },
                                          {
                                            scale: turnAnim.interpolate({
                                              inputRange: [0, 0.45, 1],
                                              outputRange: [1, 1.05, 1],
                                            }),
                                          },
                                        ],
                                      }
                                    : rightStrikes && !leftStrikes
                                      ? {
                                          transform: [
                                            {
                                              translateX: turnAnim.interpolate({
                                                inputRange: [0, 0.45, 1],
                                                outputRange: [0, -7, 0],
                                              }),
                                            },
                                          ],
                                        }
                                      : leftStrikes && rightStrikes
                                        ? {
                                            transform: [
                                              {
                                                translateX: turnAnim.interpolate({
                                                  inputRange: [0, 0.45, 1],
                                                  outputRange: [0, 6, 0],
                                                }),
                                              },
                                            ],
                                          }
                                        : null
                                  : null;

                                const rightAnimStyle = isTurnAnimating
                                  ? rightStrikes && !leftStrikes
                                    ? {
                                        transform: [
                                          {
                                            translateX: turnAnim.interpolate({
                                              inputRange: [0, 0.45, 1],
                                              outputRange: [0, -8, 0],
                                            }),
                                          },
                                          {
                                            scale: turnAnim.interpolate({
                                              inputRange: [0, 0.45, 1],
                                              outputRange: [1, 1.05, 1],
                                            }),
                                          },
                                        ],
                                      }
                                    : leftStrikes && !rightStrikes
                                      ? {
                                          transform: [
                                            {
                                              translateX: turnAnim.interpolate({
                                                inputRange: [0, 0.45, 1],
                                                outputRange: [0, 7, 0],
                                              }),
                                            },
                                          ],
                                        }
                                      : leftStrikes && rightStrikes
                                        ? {
                                            transform: [
                                              {
                                                translateX: turnAnim.interpolate({
                                                  inputRange: [0, 0.45, 1],
                                                  outputRange: [0, -6, 0],
                                                }),
                                              },
                                            ],
                                          }
                                        : null
                                  : null;

                                const vsToneStyle =
                                  totalDamage >= 10
                                    ? styles.vsTextDanger
                                    : leftMove === "DODGE" || rightMove === "DODGE"
                                      ? styles.vsTextDodge
                                      : isGuardMove(leftMove) || isGuardMove(rightMove)
                                        ? styles.vsTextGuard
                                        : null;

                                const vsAnimStyle = isTurnAnimating
                                  ? {
                                      transform: [
                                        {
                                          scale: turnAnim.interpolate({
                                            inputRange: [0, 0.45, 1],
                                            outputRange: [1, 1.22, 1],
                                          }),
                                        },
                                      ],
                                      opacity: turnAnim.interpolate({
                                        inputRange: [0, 0.2, 1],
                                        outputRange: [0.65, 1, 0.8],
                                      }),
                                    }
                                  : null;

                                return (
                                  <View key={`${leftId}_${rightId}_${idx}`} style={styles.combatPairRow}>
                                    <Animated.View style={[styles.combatFighterCard, leftEliminated ? styles.combatFighterCardEliminated : null, leftAnimStyle]}>
                                      <ExpoImage
                                        source={left?.imageUrl ? { uri: left.imageUrl } : BOT_AVATAR_IMG}
                                        style={[styles.combatAvatar, leftEliminated ? styles.combatAvatarEliminated : null]}
                                        contentFit="cover"
                                        transition={120}
                                      />
                                      <Text style={[styles.combatName, leftEliminated ? styles.combatNameEliminated : null]} numberOfLines={1}>
                                        {left ? getFighterName(left) : resolveFighterDisplayName(leftId, pair.fighterAName)}
                                      </Text>
                                      <View style={styles.hpTrack}>
                                        <View style={[styles.hpFill, { width: `${Math.max(0, Math.min(100, (leftHp / leftMax) * 100))}%` }]} />
                                      </View>
                                      <Text style={[styles.rowSub, leftEliminated ? styles.rowSubEliminated : null]}>
                                        HP {leftHp.toFixed(0)} / {leftMax.toFixed(0)}
                                      </Text>
                                      {leftEliminated ? <Text style={styles.eliminatedTag}>ELIMINATED</Text> : null}
                                    </Animated.View>
                                    <Animated.Text style={[styles.vsText, vsToneStyle, vsAnimStyle]}>VS</Animated.Text>
                                    <Animated.View style={[styles.combatFighterCard, rightEliminated ? styles.combatFighterCardEliminated : null, rightAnimStyle]}>
                                      <ExpoImage
                                        source={right?.imageUrl ? { uri: right.imageUrl } : BOT_AVATAR_IMG}
                                        style={[styles.combatAvatar, rightEliminated ? styles.combatAvatarEliminated : null]}
                                        contentFit="cover"
                                        transition={120}
                                      />
                                      <Text style={[styles.combatName, rightEliminated ? styles.combatNameEliminated : null]} numberOfLines={1}>
                                        {right ? getFighterName(right) : resolveFighterDisplayName(rightId, pair.fighterBName)}
                                      </Text>
                                      <View style={styles.hpTrack}>
                                        <View style={[styles.hpFill, { width: `${Math.max(0, Math.min(100, (rightHp / rightMax) * 100))}%` }]} />
                                      </View>
                                      <Text style={[styles.rowSub, rightEliminated ? styles.rowSubEliminated : null]}>
                                        HP {rightHp.toFixed(0)} / {rightMax.toFixed(0)}
                                      </Text>
                                      {rightEliminated ? <Text style={styles.eliminatedTag}>ELIMINATED</Text> : null}
                                    </Animated.View>
                                  </View>
                                );
                              })}
                            </View>
                          </Animated.View>
                        )}
                        {combatBench.length > 0 ? (
                          <View style={styles.combatBenchWrap}>
                            <Text style={styles.panelLabel}>BENCH / GRAVEYARD</Text>
                            <View style={styles.listStack}>
                              {combatBench.slice(0, 8).map((fighter, idx) => {
                                const justEliminated = isRecentlyEliminatedFighter(fighter);
                                const isEliminated = safeNumber(fighter.hp, 0) <= 0;
                                const shouldFade = justEliminated || isEliminated;
                                const eliminationAnimStyle = justEliminated
                                  ? {
                                      transform: [
                                        {
                                          scale: turnAnim.interpolate({
                                            inputRange: [0, 0.45, 1],
                                            outputRange: [1, 1.03, 1],
                                          }),
                                        },
                                      ],
                                    }
                                  : null;
                                return (
                                  <Animated.View
                                    key={`${getFighterId(fighter)}_${idx}`}
                                    style={[styles.rowCardTall, shouldFade ? styles.rowCardEliminated : null, eliminationAnimStyle]}
                                  >
                                  <View style={styles.avatarWrap}>
                                    <ExpoImage
                                      source={fighter.imageUrl ? { uri: fighter.imageUrl } : BOT_AVATAR_IMG}
                                      style={[styles.avatarImage, shouldFade ? styles.avatarImageEliminated : null]}
                                      contentFit="cover"
                                      transition={120}
                                    />
                                  </View>
                                  <View style={styles.rowMain}>
                                    <Text style={[styles.rowName, shouldFade ? styles.rowNameEliminated : null]} numberOfLines={1}>
                                      {getFighterName(fighter)}
                                    </Text>
                                    <Text style={[styles.rowSub, shouldFade ? styles.rowSubEliminated : null]}>
                                      HP {safeNumber(fighter.hp, 0).toFixed(0)} // DMG {safeNumber(fighter.totalDamageDealt, 0).toFixed(0)}
                                    </Text>
                                    {justEliminated ? <Text style={styles.eliminatedTag}>ELIMINATED</Text> : null}
                                  </View>
                                  </Animated.View>
                                );
                              })}
                            </View>
                          </View>
                        ) : null}
                        <View style={styles.turnFeedWrap}>
                          <Text style={styles.panelLabel}>TURN FEED</Text>
                          {recentTurns.length === 0 ? (
                            <Text style={styles.emptyText}>No turn history yet.</Text>
                          ) : (
                            <View style={styles.listStack}>
                              {recentTurns.map((turn, idx) => {
                                const turnNumber = safeNumber(turn.turnNumber, recentTurns.length - idx);
                                const pairings = Array.isArray(turn.pairings) ? turn.pairings : [];
                                const eliminations = Array.isArray(turn.eliminations) ? turn.eliminations : [];
                                const eliminationLabels = Array.from(
                                  new Set(eliminations.map(entry => resolveFighterName(entry)).filter(Boolean)),
                                );

                                return (
                                  <View key={`turn_${turnNumber}_${idx}`} style={styles.turnFeedCard}>
                                    <View style={styles.turnFeedTop}>
                                      <Text style={styles.turnFeedTitle}>TURN {turnNumber}</Text>
                                      <Text style={styles.turnFeedMeta}>
                                        {pairings.length} pair{pairings.length === 1 ? "" : "s"} · {eliminations.length} KO{eliminations.length === 1 ? "" : "s"}
                                      </Text>
                                    </View>
                                    {pairings.length > 0 ? (
                                      <>
                                        {pairings.slice(0, 3).map((pair, pairIdx) => {
                                          const leftId = String(pair.fighterA ?? "").trim();
                                          const rightId = String(pair.fighterB ?? "").trim();
                                          const left = featuredFightersById.get(leftId) ?? featuredFightersById.get(leftId.toLowerCase());
                                          const right = featuredFightersById.get(rightId) ?? featuredFightersById.get(rightId.toLowerCase());
                                          const leftName = left ? getFighterName(left) : resolveFighterDisplayName(leftId, pair.fighterAName);
                                          const rightName = right ? getFighterName(right) : resolveFighterDisplayName(rightId, pair.fighterBName);
                                          const dmgToA = safeNumber(pair.damageToA, 0).toFixed(0);
                                          const dmgToB = safeNumber(pair.damageToB, 0).toFixed(0);
                                          const leftHp = Math.max(0, safeNumber(left?.hp, 0));
                                          const rightHp = Math.max(0, safeNumber(right?.hp, 0));
                                          const leftMax = Math.max(1, safeNumber(left?.maxHp, 100));
                                          const rightMax = Math.max(1, safeNumber(right?.maxHp, 100));
                                          const leftHpPct = Math.max(0, Math.min(100, (leftHp / leftMax) * 100));
                                          const rightHpPct = Math.max(0, Math.min(100, (rightHp / rightMax) * 100));
                                          return (
                                            <View key={`pair_${pairIdx}`} style={styles.turnFeedPairRow}>
                                              <Text style={styles.turnFeedLine} numberOfLines={1}>
                                                {leftName} -{dmgToB} | {rightName} -{dmgToA}
                                              </Text>
                                              <View style={styles.turnFeedHpRow}>
                                                <View style={styles.turnFeedHpTrack}>
                                                  <View
                                                    style={[
                                                      styles.turnFeedHpFill,
                                                      leftHpPct <= 0 ? styles.turnFeedHpFillElim : leftHpPct <= 30 ? styles.turnFeedHpFillLow : null,
                                                      { width: `${leftHpPct}%` },
                                                    ]}
                                                  />
                                                </View>
                                                <View style={styles.turnFeedHpTrack}>
                                                  <View
                                                    style={[
                                                      styles.turnFeedHpFill,
                                                      rightHpPct <= 0 ? styles.turnFeedHpFillElim : rightHpPct <= 30 ? styles.turnFeedHpFillLow : null,
                                                      { width: `${rightHpPct}%` },
                                                    ]}
                                                  />
                                                </View>
                                              </View>
                                              <View style={styles.turnFeedHpMetaRow}>
                                                <Text style={styles.turnFeedHpMetaText}>L {leftHp.toFixed(0)}/{leftMax.toFixed(0)}</Text>
                                                <Text style={styles.turnFeedHpMetaText}>R {rightHp.toFixed(0)}/{rightMax.toFixed(0)}</Text>
                                              </View>
                                            </View>
                                          );
                                        })}
                                      </>
                                    ) : (
                                      <Text style={styles.turnFeedLine}>No pairings resolved.</Text>
                                    )}
                                    {eliminationLabels.length > 0 ? (
                                      <Text style={styles.turnFeedElims} numberOfLines={2}>
                                        ELIMS: {eliminationLabels.join(" · ").toUpperCase()}
                                      </Text>
                                    ) : null}
                                  </View>
                                );
                              })}
                            </View>
                          )}
                        </View>
                        <View style={styles.hpBoardWrap}>
                          <Text style={styles.panelLabel}>FIGHTER HP</Text>
                          {hpBoardFighters.length === 0 ? (
                            <Text style={styles.emptyText}>Place a bet to track your fighters here.</Text>
                          ) : (
                            <View style={styles.listStack}>
                              {hpBoardFighters.slice(0, 16).map((fighter, idx) => {
                                const hp = Math.max(0, safeNumber(fighter.hp, 0));
                                const maxHp = Math.max(1, safeNumber(fighter.maxHp, 100));
                                const isEliminated = hp <= 0;
                                const damage = safeNumber(fighter.totalDamageDealt, 0).toFixed(0);
                                return (
                                  <View
                                    key={`${getFighterId(fighter)}_hp_${idx}`}
                                    style={[styles.rowCardTall, isEliminated ? styles.rowCardEliminated : null]}
                                  >
                                    <View style={styles.avatarWrap}>
                                    <ExpoImage
                                      source={fighter.imageUrl ? { uri: fighter.imageUrl } : BOT_AVATAR_IMG}
                                      style={[styles.avatarImage, isEliminated ? styles.avatarImageEliminated : null]}
                                      contentFit="cover"
                                      transition={120}
                                    />
                                    </View>
                                    <View style={styles.rowMain}>
                                      <View style={styles.turnFeedTop}>
                                        <Text style={[styles.rowName, isEliminated ? styles.rowNameEliminated : null]} numberOfLines={1}>
                                          {getFighterName(fighter)}
                                        </Text>
                                        <Text style={styles.turnFeedMeta}>HP {hp.toFixed(0)}/{maxHp.toFixed(0)}</Text>
                                      </View>
                                      <View style={styles.hpTrack}>
                                        <View style={[styles.hpFill, { width: `${Math.max(0, Math.min(100, (hp / maxHp) * 100))}%` }]} />
                                      </View>
                                      <Text style={[styles.rowSub, isEliminated ? styles.rowSubEliminated : null]}>
                                        DMG {damage}{isEliminated ? " // ELIMINATED" : ""}
                                      </Text>
                                    </View>
                                  </View>
                                );
                              })}
                            </View>
                          )}
                        </View>
                      </>
                    ) : null}

                    {featuredState === "payout" ? (
                      <>
                        <Text style={styles.sectionLabel}>FINAL RESULTS</Text>
                        {payoutPlacements.length === 0 ? (
                          <Text style={styles.emptyText}>Waiting for payout results...</Text>
                        ) : (
                          <View style={styles.listStack}>
                            {payoutPlacements.map((fighter, idx) => {
                              const fighterId = getFighterId(fighter);
                              const myStake = myBetsInFeaturedSlot[fighterId] ?? 0;
                              return (
                                <View key={`${fighterId}_${idx}`} style={styles.rowCardTall}>
                                  <View style={styles.avatarWrap}>
                                    <ExpoImage
                                      source={fighter.imageUrl ? { uri: fighter.imageUrl } : BOT_AVATAR_IMG}
                                      style={styles.avatarImage}
                                      contentFit="cover"
                                      transition={120}
                                    />
                                  </View>
                                  <View style={styles.rowMain}>
                                    <View style={styles.rowTopLine}>
                                      <Text style={styles.rowName}>{safeNumber(fighter.placement, idx + 1)}. {getFighterName(fighter)}</Text>
                                      {myStake > 0 ? <Text style={styles.myBetTag}>YOUR BET</Text> : null}
                                    </View>
                                    <Text style={styles.rowSub}>HP {safeNumber(fighter.hp, 0).toFixed(0)} // DMG {safeNumber(fighter.totalDamageDealt, 0).toFixed(0)}</Text>
                                  </View>
                                </View>
                              );
                            })}
                          </View>
                        )}
                        {featuredSlot?.payout ? (
                          <View style={styles.rewardGrid}>
                            <View style={styles.rewardCard}>
                              <Text style={styles.rewardLabel}>Winner Pool</Text>
                              <Text style={styles.rewardValueGreen}>{safeNumber(featuredSlot.payout.winnerBettorsPayout, 0).toFixed(3)} SOL</Text>
                            </View>
                            <View style={styles.rewardCard}>
                              <Text style={styles.rewardLabel}>Total Pool</Text>
                              <Text style={styles.rewardValueAmber}>{safeNumber(featuredSlot.payout.totalPool, 0).toFixed(3)} SOL</Text>
                            </View>
                          </View>
                        ) : null}
                      </>
                    ) : null}
                  </View>
                ) : null}
              </>
            ) : null}

            {activeTab === "chat" ? (
              <View style={styles.panel}>
                <View style={styles.panelTopRow}>
                  <Text style={styles.panelLabel}>Live Chat</Text>
                  <View style={styles.chatMetaWrap}>
                    <Text style={styles.chatSlowTag}>SLOW</Text>
                    <Text style={styles.panelMeta}>{messages.length} msgs</Text>
                  </View>
                </View>
                {chatLoading ? (
                  <ActivityIndicator color="#f59e0b" />
                ) : messages.length === 0 ? (
                  <Text style={styles.emptyText}>No messages yet. Say something.</Text>
                ) : (
                  <View style={styles.chatStack}>
                    {messages.slice(-30).map(message => {
                      const isMine = walletAddress ? message.user_id === walletAddress : false;
                      return (
                        <View key={message.id} style={styles.chatRow}>
                          <View style={styles.chatTop}>
                            <View style={styles.chatUserWrap}>
                              <ExpoImage source={isMine ? HUMAN_AVATAR_IMG : BOT_AVATAR_IMG} style={styles.chatAvatar} contentFit="cover" />
                              <Text style={[styles.chatUser, isMine ? styles.chatUserMine : null]}>{message.username}</Text>
                            </View>
                            <Text style={styles.chatAge}>{formatAge(message.created_at)}</Text>
                          </View>
                          <Text style={styles.chatMsg}>{message.message}</Text>
                        </View>
                      );
                    })}
                  </View>
                )}

                {chatError ? <Text style={styles.errorText}>{chatError}</Text> : null}

                {walletAddress ? (
                  <View style={styles.chatInputRow}>
                    <TextInput
                      value={chatInput}
                      onChangeText={setChatInput}
                      editable={!chatSending}
                      placeholder="Type a message..."
                      placeholderTextColor="#57534e"
                      style={styles.chatInput}
                      maxLength={500}
                    />
                    <Pressable
                      onPress={onSendChat}
                      disabled={chatSending || !chatInput.trim()}
                      style={({ pressed }) => [styles.sendBtn, (chatSending || !chatInput.trim()) && styles.btnDisabled, pressed ? styles.pressablePressed : null]}
                    >
                      <Text style={styles.sendBtnText}>{chatSending ? "..." : "SEND"}</Text>
                    </Pressable>
                  </View>
                ) : (
                  <Text style={styles.panelMuted}>Connect wallet to chat</Text>
                )}
              </View>
            ) : null}

            {activeTab === "queue" ? (
              <>
                <View style={styles.panel}>
                  <Text style={styles.panelLabel}>Rewards</Text>
                  {claimLoading ? (
                    <ActivityIndicator color="#f59e0b" />
                  ) : (
                    <>
                      <View style={styles.rewardGrid}>
                        <View style={styles.rewardCard}>
                          <Text style={styles.rewardLabel}>Unclaimed</Text>
                          <Text style={styles.rewardValueGreen}>{claimableSol.toFixed(4)} SOL</Text>
                        </View>
                        <View style={styles.rewardCard}>
                          <Text style={styles.rewardLabel}>Claimed</Text>
                          <Text style={styles.rewardValueAmber}>{claimedSol.toFixed(4)} SOL</Text>
                        </View>
                      </View>
                      {pendingNotReady > 0 ? (
                        <Text style={styles.panelMuted}>
                          Active bets not settled yet: {pendingNotReady.toFixed(4)} SOL
                        </Text>
                      ) : null}
                      <Pressable
                        onPress={onClaimWinnings}
                        disabled={!canClaim || isBusy}
                        style={({ pressed }) => [styles.claimBtn, (!canClaim || isBusy) && styles.btnDisabled, pressed ? styles.pressablePressed : null]}
                      >
                        <Text style={styles.claimBtnText}>
                          {claimPending ? "CLAIMING..." : canClaim ? "CLAIM ALL WINS" : "NO REWARDS"}
                        </Text>
                      </Pressable>
                      {claimError ? <Text style={styles.errorText}>{claimError}</Text> : null}
                    </>
                  )}
                </View>

                <View style={styles.panel}>
                  <View style={styles.panelTopRow}>
                    <Text style={styles.panelLabel}>Fighter Queue</Text>
                    <Text style={styles.panelMeta}>{queueLength}</Text>
                  </View>
                  <Text style={styles.panelMuted}>{rumbleStatus?.nextRumbleIn ?? "Queue status unavailable"}</Text>
                  {queuePreview.length === 0 ? (
                    <Text style={styles.emptyText}>Queue empty. Fighters needed.</Text>
                  ) : (
                    <View style={styles.listStack}>
                      {queuePreview.map((fighter, idx) => (
                        <View key={`${fighter.fighterId ?? fighter.name ?? idx}`} style={styles.rowCardTall}>
                          <View style={styles.avatarWrap}>
                            {fighter.imageUrl ? (
                              <ExpoImage source={{ uri: fighter.imageUrl }} style={styles.avatarImage} contentFit="cover" transition={120} />
                            ) : (
                              <ExpoImage source={BOT_AVATAR_IMG} style={styles.avatarImage} contentFit="cover" />
                            )}
                          </View>
                          <View style={styles.rowMain}>
                            <Text style={styles.rowName} numberOfLines={1}>{fighter.name ?? "Unknown Fighter"}</Text>
                            <Text style={styles.rowSub}>Position #{safeNumber(fighter.position, idx + 1)}</Text>
                          </View>
                          <Text style={styles.rowIdx}>{safeNumber(fighter.position, idx + 1)}</Text>
                        </View>
                      ))}
                    </View>
                  )}
                </View>

                <View style={styles.panel}>
                  <Text style={styles.panelLabel}>Ichor Shower</Text>
                  <Text style={styles.ichorBig}>
                    {ichorPool.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                  </Text>
                  <Text style={styles.ichorUnit}>JACKPOT POOL // ICHOR</Text>
                  <Text style={styles.panelMuted}>Pool grows with every rumble.</Text>
                  <Text style={styles.panelMuted}>When it triggers, one lucky winner takes it all.</Text>
                  <Text style={styles.ichorWarningText}>All $ICHOR functions are on Devnet. Only SOL betting is live on Mainnet.</Text>
                </View>

                <View style={styles.panel}>
                  <Pressable
                    onPress={() => setTxFeedMinimized(prev => !prev)}
                    style={({ pressed }) => [
                      styles.panelTopRow,
                      styles.panelToggleRow,
                      pressed ? styles.pressablePressed : null,
                    ]}
                  >
                    <Text style={styles.panelLabel}>On-Chain Feed</Text>
                    <View style={styles.panelMetaGroup}>
                      <Text style={styles.panelMeta}>{ONCHAIN_FEED_NETWORK_LABEL}</Text>
                      <Text style={styles.panelCollapseText}>{txFeedMinimized ? "SHOW" : "HIDE"}</Text>
                    </View>
                  </Pressable>
                  {txFeedMinimized ? (
                    <Text style={styles.panelMuted}>Minimized. Tap to expand.</Text>
                  ) : txLoading ? (
                    <ActivityIndicator color="#f59e0b" />
                  ) : txError ? (
                    <Text style={styles.errorText}>{txError}</Text>
                  ) : txFeed.length === 0 ? (
                    <Text style={styles.emptyText}>No transactions yet</Text>
                  ) : (
                    <View style={styles.listStack}>
                      {txFeed.slice(0, 14).map(tx => (
                        <Pressable
                          key={tx.signature}
                          onPress={() => {
                            setStatusText(`Explorer: ${EXPLORER_TX}/${tx.signature}?cluster=${ONCHAIN_FEED_CLUSTER}`);
                          }}
                          style={({ pressed }) => [styles.rowCard, pressed ? styles.pressablePressed : null]}
                        >
                          <View style={[styles.txDot, tx.err ? styles.txDotErr : styles.txDotOk]} />
                          <View style={styles.rowMain}>
                            <Text style={styles.rowName}>{shortAddress(tx.signature, 6, 6)}</Text>
                            <Text style={styles.rowSub}>{formatTxAge(tx.blockTime)} ago</Text>
                          </View>
                          <Text style={styles.rowMeta}>{(tx.confirmationStatus ?? "-").slice(0, 4).toUpperCase()}</Text>
                        </Pressable>
                      ))}
                    </View>
                  )}
                </View>

              </>
            ) : null}
            </Animated.View>
          </ScrollView>
        </View>

        <View style={styles.bottomTabs}>
          <Pressable
            style={({ pressed }) => [styles.bottomTabBtn, activeTab === "arena" && styles.bottomTabBtnActive, pressed ? styles.pressablePressed : null]}
            onPress={() => handleTabChange("arena")}
          >
            <Text style={[styles.bottomTabText, activeTab === "arena" && styles.bottomTabTextActive]}>ARENA</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.bottomTabBtn, activeTab === "chat" && styles.bottomTabBtnActive, pressed ? styles.pressablePressed : null]}
            onPress={() => handleTabChange("chat")}
          >
            <Text style={[styles.bottomTabText, activeTab === "chat" && styles.bottomTabTextActive]}>CHAT</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.bottomTabBtn, activeTab === "queue" && styles.bottomTabBtnActive, pressed ? styles.pressablePressed : null]}
            onPress={() => handleTabChange("queue")}
          >
            <Text style={[styles.bottomTabText, activeTab === "queue" && styles.bottomTabTextActive]}>QUEUE</Text>
          </Pressable>
        </View>
      </View>
    </ImageBackground>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#090909",
  },
  fontLoadingWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#090909",
  },
  bgImage: {
    flex: 1,
  },
  bgImageStyle: {
    opacity: 0.28,
  },
  bgOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(8,8,8,0.9)",
  },
  bugsOverlayWrap: {
    position: "absolute",
    left: 10,
    bottom: 92,
    zIndex: 3,
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
  },
  bugsImage: {
    width: 82,
    height: 72,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#44403c",
  },
  bugsQuoteBox: {
    backgroundColor: "rgba(24,24,24,0.92)",
    borderWidth: 1,
    borderColor: "#44403c",
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 8,
    maxWidth: 168,
    marginBottom: 8,
  },
  bugsQuoteText: {
    color: "#d6d3d1",
    fontSize: 10,
    lineHeight: 12,
    textTransform: "uppercase",
  },
  screen: {
    flex: 1,
  },
  header: {
    borderBottomWidth: 1,
    borderBottomColor: "#292524",
    backgroundColor: "rgba(9,9,9,0.92)",
    paddingHorizontal: 12,
    paddingTop: 0,
    paddingBottom: 10,
    gap: 6,
    alignItems: "center",
  },
  headerTitleWrap: {
    width: "100%",
    alignItems: "center",
    paddingHorizontal: 8,
    overflow: "visible",
  },
  title: {
    width: "94%",
    fontSize: 32,
    lineHeight: 36,
    color: "#f59e0b",
    letterSpacing: 1.1,
    fontFamily: "MostWazted",
    textAlign: "center",
    textTransform: "uppercase",
    includeFontPadding: false,
    paddingHorizontal: 0,
    paddingBottom: 1,
    maxWidth: "94%",
    flexShrink: 1,
    textShadowColor: "rgba(217, 119, 6, 0.8)",
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 8,
  },
  subTitle: {
    marginTop: 2,
    color: "#78716c",
    fontSize: 9,
    letterSpacing: 0.6,
    textAlign: "center",
  },
  headerRight: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    flexWrap: "wrap",
    rowGap: 6,
    columnGap: 8,
    width: "100%",
  },
  liveRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  liveDot: {
    width: 8,
    height: 8,
    borderRadius: 2,
  },
  liveDotOn: {
    backgroundColor: "#22c55e",
  },
  liveDotOff: {
    backgroundColor: "#f59e0b",
  },
  liveText: {
    color: "#a8a29e",
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.8,
  },
  soundControlsRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    flexWrap: "wrap",
    gap: 6,
  },
  soundBtn: {
    borderWidth: 1,
    borderRadius: 7,
    paddingVertical: 5,
    paddingHorizontal: 7,
  },
  soundBtnOn: {
    borderColor: "#a16207",
    backgroundColor: "rgba(120,53,15,0.32)",
  },
  soundBtnOff: {
    borderColor: "#3f3f46",
    backgroundColor: "#111111",
  },
  soundBtnText: {
    fontSize: 9,
    letterSpacing: 0.6,
  },
  soundBtnTextOn: {
    color: "#f59e0b",
  },
  soundBtnTextOff: {
    color: "#71717a",
  },
  walletHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
  },
  walletChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderColor: "#3f3f46",
    backgroundColor: "#111111",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  walletBalanceText: {
    color: "#a8a29e",
    fontSize: 9,
    fontWeight: "700",
  },
  walletChipText: {
    color: "#f59e0b",
    fontSize: 10,
    fontWeight: "700",
  },
  walletChipClose: {
    paddingHorizontal: 2,
    paddingVertical: 2,
  },
  walletChipCloseText: {
    color: "#78716c",
    fontSize: 10,
    fontWeight: "700",
  },
  connectBtn: {
    backgroundColor: "#d97706",
    borderRadius: 6,
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  connectBtnText: {
    color: "#111111",
    fontSize: 10,
    fontWeight: "900",
    letterSpacing: 0.6,
  },
  topStatsRow: {
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 10,
    paddingTop: 8,
    paddingBottom: 6,
  },
  statTile: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#292524",
    backgroundColor: "rgba(17,17,17,0.9)",
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 8,
  },
  statTileLabel: {
    fontSize: 9,
    color: "#78716c",
    letterSpacing: 0.7,
    textTransform: "uppercase",
  },
  statTileValue: {
    marginTop: 2,
    color: "#fbbf24",
    fontSize: 14,
    fontWeight: "800",
  },
  betErrorToast: {
    marginHorizontal: 10,
    marginBottom: 4,
    borderWidth: 1,
    borderColor: "#b45309",
    backgroundColor: "rgba(120,53,15,0.75)",
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  betErrorToastText: {
    color: "#fed7aa",
    fontSize: 11,
    fontWeight: "700",
  },
  contentWrap: {
    flex: 1,
    paddingHorizontal: 10,
  },
  scrollContent: {
    paddingTop: 4,
    paddingBottom: 88,
    gap: 10,
  },
  slotPillRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  slotPill: {
    borderWidth: 1,
    borderColor: "#44403c",
    borderRadius: 6,
    backgroundColor: "rgba(24,24,24,0.85)",
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  slotPillActive: {
    borderColor: "#b45309",
    backgroundColor: "rgba(120,53,15,0.35)",
  },
  slotPillText: {
    fontSize: 10,
    fontWeight: "800",
  },
  panel: {
    borderWidth: 1,
    borderColor: "#44403c",
    borderRadius: 12,
    backgroundColor: "rgba(14,14,14,0.95)",
    padding: 10,
    gap: 8,
    shadowColor: "#000",
    shadowOpacity: 0.32,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  panelTopRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  panelToggleRow: {
    borderRadius: 8,
    paddingVertical: 2,
  },
  panelLabel: {
    color: "#78716c",
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: 0.8,
    fontWeight: "700",
  },
  panelState: {
    fontSize: 10,
    fontWeight: "800",
  },
  panelMeta: {
    color: "#71717a",
    fontSize: 10,
    fontWeight: "700",
  },
  panelMetaGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  panelCollapseText: {
    color: "#a16207",
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.5,
  },
  panelTitle: {
    color: "#f5f5f4",
    fontSize: 27,
    lineHeight: 31,
    letterSpacing: 1.3,
    fontFamily: "MostWazted",
    textShadowColor: "rgba(217, 119, 6, 0.6)",
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 8,
  },
  panelMuted: {
    color: "#a8a29e",
    fontSize: 12,
  },
  panelFootnote: {
    color: "#78716c",
    fontSize: 10,
    textAlign: "center",
    marginTop: 2,
  },
  idleArenaWrap: {
    borderWidth: 1,
    borderColor: "#292524",
    borderRadius: 8,
    overflow: "hidden",
    position: "relative",
    height: 260,
  },
  idleArenaImage: {
    width: "100%",
    height: "100%",
  },
  idleArenaShade: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(10,10,10,0.65)",
  },
  idleCageImage: {
    position: "absolute",
    right: 0,
    left: 0,
    bottom: 0,
    width: "100%",
    height: "100%",
    opacity: 0.55,
  },
  idleArenaTextWrap: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 14,
    alignItems: "center",
    paddingHorizontal: 14,
    gap: 4,
  },
  idleArenaTitle: {
    color: "#f59e0b",
    fontSize: 24,
    letterSpacing: 1.2,
    textAlign: "center",
    fontFamily: "MostWazted",
    textShadowColor: "rgba(217, 119, 6, 0.7)",
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 10,
  },
  idleArenaSub: {
    color: "#d6d3d1",
    fontSize: 13,
    textAlign: "center",
  },
  idleArenaHint: {
    color: "#a8a29e",
    fontSize: 10,
    textAlign: "center",
    letterSpacing: 0.8,
  },
  idleArtRow: {
    flexDirection: "row",
    gap: 8,
    marginTop: 8,
  },
  idleArtThumb: {
    flex: 1,
    height: 100,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#3f3f46",
    resizeMode: "cover",
  },
  timerCard: {
    borderWidth: 1,
    borderColor: "#44403c",
    borderRadius: 9,
    backgroundColor: "#0f0f0f",
    paddingVertical: 8,
    paddingHorizontal: 9,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  timerLabel: {
    color: "#78716c",
    fontSize: 10,
    letterSpacing: 0.7,
  },
  timerValue: {
    color: "#f59e0b",
    fontSize: 14,
    fontWeight: "900",
    letterSpacing: 1,
  },
  sectionLabel: {
    color: "#a8a29e",
    fontSize: 11,
    fontWeight: "700",
    marginTop: 2,
  },
  listStack: {
    gap: 6,
  },
  rowCard: {
    borderWidth: 1,
    borderColor: "#3f3f46",
    borderRadius: 8,
    backgroundColor: "rgba(20,20,20,0.94)",
    paddingVertical: 7,
    paddingHorizontal: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  rowCardTall: {
    borderWidth: 1,
    borderColor: "#3f3f46",
    borderRadius: 8,
    backgroundColor: "rgba(20,20,20,0.94)",
    paddingVertical: 8,
    paddingHorizontal: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  rowCardEliminated: {
    borderColor: "#52525b",
    backgroundColor: "rgba(39,39,42,0.72)",
  },
  rowIdx: {
    width: 18,
    color: "#78716c",
    fontSize: 11,
    fontWeight: "700",
    textAlign: "center",
  },
  rowMain: {
    flex: 1,
    gap: 2,
  },
  rowTopLine: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 6,
  },
  rowName: {
    color: "#f5f5f4",
    fontSize: 12,
    fontWeight: "700",
    flex: 1,
  },
  rowNameEliminated: {
    color: "#9ca3af",
  },
  rowSub: {
    color: "#71717a",
    fontSize: 10,
  },
  rowSubEliminated: {
    color: "#6b7280",
  },
  rowSubStrong: {
    color: "#22d3ee",
    fontSize: 10,
    fontWeight: "700",
  },
  rowMeta: {
    color: "#a8a29e",
    fontSize: 10,
    fontWeight: "700",
  },
  avatarWrap: {
    width: 40,
    height: 40,
    borderRadius: 6,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#3f3f46",
    backgroundColor: "#18181b",
  },
  avatarImage: {
    width: "100%",
    height: "100%",
  },
  avatarImageEliminated: {
    opacity: 0.36,
  },
  avatarFallback: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarFallbackText: {
    color: "#78716c",
    fontSize: 9,
    fontWeight: "700",
  },
  myBetTag: {
    color: "#22d3ee",
    fontSize: 8,
    fontWeight: "800",
    borderWidth: 1,
    borderColor: "#155e75",
    backgroundColor: "rgba(8,47,73,0.4)",
    borderRadius: 4,
    paddingHorizontal: 4,
    paddingVertical: 1,
    overflow: "hidden",
  },
  hpTrack: {
    height: 5,
    borderRadius: 3,
    backgroundColor: "#292524",
    overflow: "hidden",
  },
  hpFill: {
    height: "100%",
    backgroundColor: "#22c55e",
  },
  betCard: {
    borderWidth: 1,
    borderColor: "#292524",
    borderRadius: 8,
    backgroundColor: "#131313",
    overflow: "hidden",
  },
  betCardSelected: {
    borderColor: "#b45309",
    backgroundColor: "rgba(120,53,15,0.2)",
  },
  betTileGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  betTile: {
    width: "48.6%",
    borderWidth: 1,
    borderColor: "#3f3f46",
    borderRadius: 10,
    backgroundColor: "rgba(15,15,15,0.92)",
    overflow: "hidden",
    shadowColor: "#000",
    shadowOpacity: 0.26,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 3,
  },
  betTileSelected: {
    borderColor: "#d97706",
    backgroundColor: "rgba(120,53,15,0.22)",
  },
  betTileTap: {
    padding: 8,
    gap: 6,
  },
  betTileImage: {
    width: "100%",
    aspectRatio: 1,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#44403c",
    backgroundColor: "#111111",
  },
  betTileBody: {
    gap: 2,
  },
  betCardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 8,
  },
  betCardAvatarWrap: {
    width: 46,
    height: 46,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#3f3f46",
    overflow: "hidden",
    backgroundColor: "#18181b",
  },
  betCardAvatar: {
    width: "100%",
    height: "100%",
  },
  betCardAvatarFallback: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  betCardInfo: {
    flex: 1,
    gap: 2,
  },
  betSelectLabel: {
    color: "#f59e0b",
    fontSize: 9,
    fontWeight: "800",
  },
  betControlsWrap: {
    borderTopWidth: 1,
    borderTopColor: "#44403c",
    paddingVertical: 8,
    paddingHorizontal: 8,
    gap: 6,
    backgroundColor: "rgba(8,8,8,0.4)",
  },
  quickAmountRow: {
    flexDirection: "row",
    gap: 6,
  },
  quickAmountBtn: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#44403c",
    borderRadius: 6,
    backgroundColor: "#111111",
    paddingVertical: 6,
    alignItems: "center",
  },
  quickAmountBtnActive: {
    borderColor: "#d97706",
    backgroundColor: "rgba(217,119,6,0.28)",
  },
  quickAmountText: {
    color: "#e7e5e4",
    fontSize: 10,
    fontWeight: "700",
  },
  combatHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
  },
  eliminationFeed: {
    gap: 4,
  },
  eliminationFeedItem: {
    color: "#fed7aa",
    fontSize: 10,
    fontWeight: "800",
    borderWidth: 1,
    borderColor: "#b45309",
    backgroundColor: "rgba(120,53,15,0.38)",
    borderRadius: 6,
    paddingVertical: 4,
    paddingHorizontal: 6,
    overflow: "hidden",
  },
  combatPairsStack: {
    gap: 8,
  },
  combatPairRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    borderWidth: 1,
    borderColor: "#292524",
    borderRadius: 8,
    backgroundColor: "rgba(24,24,24,0.9)",
    padding: 8,
  },
  combatFighterCard: {
    flex: 1,
    alignItems: "center",
    gap: 4,
  },
  combatFighterCardEliminated: {
    opacity: 0.88,
  },
  combatAvatar: {
    width: 78,
    height: 78,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#44403c",
    backgroundColor: "#111111",
  },
  combatAvatarEliminated: {
    opacity: 0.34,
    borderColor: "#52525b",
  },
  combatName: {
    color: "#e7e5e4",
    fontSize: 11,
    fontWeight: "700",
  },
  combatNameEliminated: {
    color: "#9ca3af",
  },
  vsText: {
    color: "#d97706",
    fontSize: 24,
    lineHeight: 28,
    fontFamily: "MostWazted",
    letterSpacing: 0,
    minWidth: 34,
    textAlign: "center",
    paddingHorizontal: 2,
    textTransform: "uppercase",
    textShadowColor: "rgba(217, 119, 6, 0.7)",
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 8,
  },
  vsTextDanger: {
    color: "#f87171",
    textShadowColor: "rgba(239, 68, 68, 0.8)",
  },
  vsTextDodge: {
    color: "#4ade80",
    textShadowColor: "rgba(34, 197, 94, 0.7)",
  },
  vsTextGuard: {
    color: "#60a5fa",
    textShadowColor: "rgba(59, 130, 246, 0.8)",
  },
  combatBenchWrap: {
    borderTopWidth: 1,
    borderTopColor: "#292524",
    paddingTop: 8,
    gap: 8,
  },
  turnFeedWrap: {
    borderTopWidth: 1,
    borderTopColor: "#292524",
    paddingTop: 8,
    gap: 8,
  },
  turnFeedCard: {
    borderWidth: 1,
    borderColor: "#44403c",
    borderRadius: 8,
    backgroundColor: "rgba(20,20,20,0.95)",
    paddingVertical: 7,
    paddingHorizontal: 8,
    gap: 4,
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  turnFeedTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
  },
  turnFeedTitle: {
    color: "#f59e0b",
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.6,
  },
  turnFeedMeta: {
    color: "#a8a29e",
    fontSize: 10,
    fontWeight: "700",
  },
  turnFeedLine: {
    color: "#d6d3d1",
    fontSize: 10,
  },
  turnFeedPairRow: {
    gap: 3,
  },
  turnFeedHpRow: {
    flexDirection: "row",
    gap: 6,
    alignItems: "center",
  },
  turnFeedHpTrack: {
    flex: 1,
    height: 4,
    borderRadius: 3,
    backgroundColor: "#3f3f46",
    overflow: "hidden",
  },
  turnFeedHpFill: {
    height: "100%",
    backgroundColor: "#22c55e",
  },
  turnFeedHpFillLow: {
    backgroundColor: "#f59e0b",
  },
  turnFeedHpFillElim: {
    backgroundColor: "#6b7280",
  },
  turnFeedHpMetaRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  turnFeedHpMetaText: {
    color: "#a8a29e",
    fontSize: 9,
    fontWeight: "700",
  },
  turnFeedElims: {
    color: "#fca5a5",
    fontSize: 10,
    fontWeight: "700",
  },
  hpBoardWrap: {
    borderTopWidth: 1,
    borderTopColor: "#292524",
    paddingTop: 8,
    gap: 8,
  },
  betAmountRow: {
    flexDirection: "row",
    gap: 6,
  },
  betAmountInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#44403c",
    borderRadius: 6,
    backgroundColor: "#101010",
    color: "#f5f5f4",
    fontSize: 12,
    paddingVertical: 7,
    paddingHorizontal: 10,
  },
  lastSigCard: {
    borderWidth: 1,
    borderColor: "#166534",
    borderRadius: 8,
    backgroundColor: "rgba(6,78,59,0.35)",
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  lastSigText: {
    color: "#86efac",
    fontSize: 10,
    fontWeight: "700",
  },
  deployBtn: {
    borderWidth: 1,
    borderColor: "#b45309",
    borderRadius: 8,
    backgroundColor: "#d97706",
    paddingVertical: 10,
    alignItems: "center",
    marginTop: 2,
    shadowColor: "#000",
    shadowOpacity: 0.28,
    shadowRadius: 7,
    shadowOffset: { width: 0, height: 3 },
    elevation: 3,
  },
  deployBtnText: {
    color: "#111111",
    fontSize: 12,
    fontWeight: "900",
    letterSpacing: 0.6,
  },
  emptyText: {
    color: "#78716c",
    fontSize: 12,
  },
  rewardGrid: {
    flexDirection: "row",
    gap: 6,
  },
  rewardCard: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#292524",
    borderRadius: 8,
    backgroundColor: "#131313",
    paddingVertical: 8,
    paddingHorizontal: 8,
    gap: 2,
  },
  rewardLabel: {
    color: "#78716c",
    fontSize: 10,
  },
  rewardValueGreen: {
    color: "#4ade80",
    fontSize: 13,
    fontWeight: "800",
  },
  rewardValueAmber: {
    color: "#fbbf24",
    fontSize: 13,
    fontWeight: "800",
  },
  claimBtn: {
    borderWidth: 1,
    borderColor: "#15803d",
    borderRadius: 8,
    backgroundColor: "#16a34a",
    paddingVertical: 8,
    alignItems: "center",
    marginTop: 2,
  },
  claimBtnText: {
    color: "#111111",
    fontSize: 12,
    fontWeight: "900",
    letterSpacing: 0.5,
  },
  ichorBig: {
    color: "#f59e0b",
    fontSize: 30,
    lineHeight: 34,
    fontWeight: "900",
  },
  ichorBottleImage: {
    width: "100%",
    height: 110,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#3f3f46",
    resizeMode: "cover",
  },
  ichorUnit: {
    color: "#a16207",
    fontSize: 10,
    letterSpacing: 0.8,
    fontWeight: "700",
  },
  ichorWarningText: {
    color: "#a16207",
    fontSize: 10,
    textAlign: "center",
  },
  txDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  txDotOk: {
    backgroundColor: "#22c55e",
  },
  txDotErr: {
    backgroundColor: "#ef4444",
  },
  chatMetaWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  chatSlowTag: {
    color: "#a8a29e",
    fontSize: 9,
    fontWeight: "700",
    borderWidth: 1,
    borderColor: "#3f3f46",
    borderRadius: 4,
    paddingHorizontal: 4,
    paddingVertical: 1,
    overflow: "hidden",
  },
  chatStack: {
    gap: 8,
    maxHeight: 480,
  },
  chatRow: {
    borderWidth: 1,
    borderColor: "#292524",
    borderRadius: 8,
    backgroundColor: "#131313",
    padding: 8,
    gap: 3,
  },
  chatTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  chatUserWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  chatAvatar: {
    width: 20,
    height: 20,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: "#44403c",
  },
  chatUser: {
    color: "#a8a29e",
    fontSize: 11,
    fontWeight: "700",
  },
  chatUserMine: {
    color: "#f59e0b",
  },
  chatAge: {
    color: "#71717a",
    fontSize: 10,
  },
  eliminatedTag: {
    color: "#fca5a5",
    fontSize: 9,
    fontWeight: "900",
    letterSpacing: 0.5,
  },
  chatMsg: {
    color: "#e7e5e4",
    fontSize: 12,
    lineHeight: 16,
  },
  chatInputRow: {
    flexDirection: "row",
    gap: 8,
    marginTop: 2,
  },
  chatInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#44403c",
    borderRadius: 8,
    backgroundColor: "#101010",
    color: "#f5f5f4",
    fontSize: 12,
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  sendBtn: {
    borderRadius: 8,
    backgroundColor: "#d97706",
    paddingHorizontal: 12,
    justifyContent: "center",
    alignItems: "center",
  },
  sendBtnText: {
    color: "#111111",
    fontSize: 11,
    fontWeight: "900",
    letterSpacing: 0.6,
  },
  errorText: {
    color: "#fbbf24",
    fontSize: 11,
  },
  btnStack: {
    gap: 8,
  },
  actionBtn: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#44403c",
    paddingVertical: 10,
    alignItems: "center",
  },
  actionBtnPrimary: {
    backgroundColor: "#b45309",
  },
  actionBtnDanger: {
    backgroundColor: "#7f1d1d",
  },
  actionBtnText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 0.5,
  },
  statusText: {
    color: "#d6d3d1",
    fontSize: 11,
    fontWeight: "700",
  },
  statusErrorDetail: {
    marginTop: 3,
    color: "#fdba74",
    fontSize: 10,
    lineHeight: 13,
  },
  statusBanner: {
    marginHorizontal: 10,
    marginBottom: 4,
    borderWidth: 1,
    borderColor: "#44403c",
    backgroundColor: "rgba(20,20,20,0.9)",
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  statusBannerWarn: {
    marginHorizontal: 10,
    marginBottom: 4,
    borderWidth: 1,
    borderColor: "#b45309",
    backgroundColor: "rgba(120,53,15,0.6)",
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  statusBannerMuted: {
    marginHorizontal: 10,
    marginBottom: 4,
    borderWidth: 1,
    borderColor: "#3f3f46",
    backgroundColor: "rgba(24,24,27,0.75)",
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  btnDisabled: {
    opacity: 0.55,
  },
  pressablePressed: {
    opacity: 0.84,
    transform: [{ scale: 0.985 }],
  },
  bottomTabs: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    borderTopWidth: 1,
    borderTopColor: "#292524",
    backgroundColor: "rgba(9,9,9,0.96)",
    flexDirection: "row",
    paddingHorizontal: 8,
    paddingTop: 8,
    paddingBottom: 14,
    gap: 8,
  },
  bottomTabBtn: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#292524",
    borderRadius: 8,
    backgroundColor: "#121212",
    paddingVertical: 9,
    alignItems: "center",
  },
  bottomTabBtnActive: {
    borderColor: "#a16207",
    backgroundColor: "rgba(120,53,15,0.35)",
  },
  bottomTabText: {
    color: "#71717a",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
  },
  bottomTabTextActive: {
    color: "#f59e0b",
  },
});
