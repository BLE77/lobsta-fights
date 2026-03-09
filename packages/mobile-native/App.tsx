/**
 * App.tsx — UCF (Lobsta Fights) mobile-native entry point.
 *
 * MONOLITH STATUS (2026-03-08):
 *   This file was originally ~4,660 lines with all types, constants, utilities,
 *   styles, and component logic in a single file. The following were safely
 *   extracted with zero behavioral changes:
 *
 *   - lib/types.ts      — 14 shared type definitions
 *   - lib/constants.ts   — All compile-time constants & asset requires
 *   - lib/utils.ts       — Pure utility functions, API helpers, merge logic
 *   - lib/styles.ts      — Full StyleSheet (moved verbatim)
 *
 *   REMAINING in this file (~2,500 lines):
 *   - RumbleNativeScreen component (all useState/useRef/useEffect/useCallback hooks)
 *   - Small presentational components (WalletHeader, SoundControls, StatTile, ActionButton)
 *   - All JSX render logic
 *
 *   Further refactoring (splitting RumbleNativeScreen into sub-components,
 *   extracting custom hooks like useAudio/usePolling/useRumbleStatus) would
 *   reduce this further but carries higher risk of breaking state flow.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StatusBar } from "expo-status-bar";
import { Audio } from "expo-av";
import * as Haptics from "expo-haptics";
import { Image as ExpoImage } from "expo-image";
import {
  ActivityIndicator,
  AppState,
  type AppStateStatus,
  Animated,
  Easing,
  ImageBackground,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  Vibration,
  View,
} from "react-native";
import { useFonts } from "expo-font";
import {
  Connection,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  MobileWalletProvider,
  fromUint8Array,
  transact,
  useMobileWallet,
} from "@wallet-ui/react-native-web3js";
import { getSupabaseRealtimeClient } from "./lib/supabase";

// Extracted modules
import type {
  ChatMessage,
  ClaimBalanceResponse,
  MyBetsResponse,
  NonceResponse,
  PrepareBetResponse,
  RumbleSlot,
  RumbleSlotFighter,
  RumbleStatusResponse,
  RumbleTurnPairing,
  SlotPayout,
  TabKey,
  TxEntry,
  VerifyResponse,
} from "./lib/types";

import {
  BOT_AVATAR_IMG,
  CHAT_POLL_ACTIVE_MS,
  FALLBACK_RPC,
  HUMAN_AVATAR_IMG,
  RPC_RATE_LIMIT_COOLDOWN_MS,
  RUMBLE_ARENA_BG,
  RUMBLE_CAGE_OVERLAY_PNG,
  SND_BET_PLACED,
  SND_BG_TRACKS,
  SND_CLAIM,
  SND_CLICK,
  SND_CROWD_CHEER,
  SND_KO,
  SND_ROUND_START,
  STATE_PRIORITY,
  STATUS_REALTIME_REFRESH_DEBOUNCE_MS,
  TX_FEED_POLL_ACTIVE_MS,
  WALLET_POLL_ACTIVE_MS,
  chain,
  endpoint,
  identity,
} from "./lib/constants";

import {
  decodeBase64Tx,
  fetchJsonFromCandidates,
  formatAge,
  formatCountdown,
  formatMove,
  formatPct,
  formatTxAge,
  getFighterId,
  getFighterName,
  getMoveColor,
  getSuggestedStatusPollDelayMs,
  getStateColor,
  isCancellationError,
  isGuardMove,
  isRateLimitError,
  isStrikeMove,
  mergeRumbleStatusSnapshots,
  normalizeWalletAddress,
  pickPairingSfx,
  postJsonWithFallback,
  safeNumber,
  shortAddress,
} from "./lib/utils";

import { styles } from "./lib/styles";

// Types are now in ./lib/types.ts
// Utility functions are now in ./lib/utils.ts





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
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <View style={styles.soundControlsWrap}>
      <Pressable
        onPress={() => setMenuOpen(current => !current)}
        accessibilityRole="button"
        accessibilityLabel={menuOpen ? "Close settings" : "Open settings"}
        style={({ pressed }) => [
          styles.soundGearBtn,
          menuOpen ? styles.soundGearBtnOpen : null,
          pressed ? styles.pressablePressed : null,
        ]}
      >
        <Text style={[styles.soundGearGlyph, menuOpen ? styles.soundGearGlyphOpen : null]}>⚙</Text>
      </Pressable>

      {menuOpen ? (
        <View style={styles.soundMenu}>
          <Pressable
            onPress={onToggleSfx}
            style={({ pressed }) => [
              styles.soundMenuRow,
              pressed ? styles.pressablePressed : null,
            ]}
          >
            <Text style={styles.soundMenuLabel}>SFX</Text>
            <Text style={[styles.soundMenuValue, sfxEnabled ? styles.soundMenuValueOn : styles.soundMenuValueOff]}>
              {sfxEnabled ? "ON" : "OFF"}
            </Text>
          </Pressable>

          <Pressable
            onPress={onToggleMusic}
            style={({ pressed }) => [
              styles.soundMenuRow,
              pressed ? styles.pressablePressed : null,
            ]}
          >
            <Text style={styles.soundMenuLabel}>MUSIC</Text>
            <Text style={[styles.soundMenuValue, musicEnabled ? styles.soundMenuValueOn : styles.soundMenuValueOff]}>
              {musicEnabled ? "ON" : "OFF"}
            </Text>
          </Pressable>

          <Pressable
            onPress={onToggleHaptics}
            style={({ pressed }) => [
              styles.soundMenuRow,
              pressed ? styles.pressablePressed : null,
            ]}
          >
            <Text style={styles.soundMenuLabel}>HAPTIC</Text>
            <Text style={[styles.soundMenuValue, hapticsEnabled ? styles.soundMenuValueOn : styles.soundMenuValueOff]}>
              {hapticsEnabled ? "ON" : "OFF"}
            </Text>
          </Pressable>
        </View>
      ) : null}
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
  const [appState, setAppState] = useState<AppStateStatus>(AppState.currentState);

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
  const [txFeedNetwork, setTxFeedNetwork] = useState<"mainnet" | "devnet">("mainnet");

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
  const bgTrackIndexRef = useRef(0);
  const audioInitializedRef = useRef(false);
  const musicEnabledRef = useRef(musicEnabled);
  const turnAnim = useRef(new Animated.Value(0)).current;
  const slotShakeAnim = useRef(new Animated.Value(0)).current;
  const contentRevealAnim = useRef(new Animated.Value(1)).current;
  const betTileSelectAnimRef = useRef<Record<string, Animated.Value>>({});
  const betTilePressAnimRef = useRef<Record<string, Animated.Value>>({});
  const lastAnimatedTurnRef = useRef<string>("");
  const lastStateToneRef = useRef<{ rumbleId: string; state: string } | null>(null);
  const lastNonIdleSlotRef = useRef<RumbleSlot | null>(null);
  const idleGraceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [idleGraceActive, setIdleGraceActive] = useState(false);
  const [winnerPopup, setWinnerPopup] = useState<{ fighter: RumbleSlotFighter; payout: SlotPayout | null; rumbleNumber: number | null } | null>(null);
  const winnerPopupAnim = useRef(new Animated.Value(0)).current;
  const winnerPopupShownForRef = useRef<string>("");
  const winnerPopupDismissRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearElimsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusRequestInFlightRef = useRef(false);
  const chatRequestInFlightRef = useRef(false);
  const statusRetryAfterRef = useRef(0);
  const chatRetryAfterRef = useRef(0);
  const statusRealtimeChannelRef = useRef<RealtimeChannel | null>(null);
  const statusRealtimeRefreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const txRetryAfterRef = useRef(0);
  const balanceRetryAfterRef = useRef(0);
  const fallbackSendConnectionRef = useRef<Connection | null>(null);
  const isAppActive = appState === "active";

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

  const loadAndPlayTrack = useCallback(async (trackIndex: number, cancelled?: { current: boolean }) => {
    try {
      const prev = bgMusicRef.current;
      if (prev) {
        bgMusicRef.current = null;
        await prev.unloadAsync();
      }
      const source = SND_BG_TRACKS[trackIndex % SND_BG_TRACKS.length];
      const { sound } = await Audio.Sound.createAsync(source, {
        isLooping: false,
        volume: 0.3,
        shouldPlay: false,
      });
      if (cancelled?.current) {
        await sound.unloadAsync();
        return;
      }
      sound.setOnPlaybackStatusUpdate(status => {
        if (!status.isLoaded) return;
        if (status.didJustFinish && musicEnabledRef.current) {
          const nextIndex = (bgTrackIndexRef.current + 1) % SND_BG_TRACKS.length;
          bgTrackIndexRef.current = nextIndex;
          void loadAndPlayTrack(nextIndex);
        }
      });
      bgMusicRef.current = sound;
      if (musicEnabledRef.current) {
        await sound.playAsync();
      }
    } catch {
      // silently fail
    }
  }, []);

  useEffect(() => {
    const cancelled = { current: false };

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
        await loadAndPlayTrack(bgTrackIndexRef.current, cancelled);
      } catch {
        audioInitializedRef.current = false;
      }
    };

    void initAudio();

    return () => {
      cancelled.current = true;
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

  const rawFeaturedSlot = useMemo(() => {
    const slots = Array.isArray(rumbleStatus?.slots) ? [...rumbleStatus.slots] : [];
    if (slots.length === 0) return null;
    slots.sort((a, b) => {
      const aPriority = STATE_PRIORITY[a.state ?? "idle"] ?? 9;
      const bPriority = STATE_PRIORITY[b.state ?? "idle"] ?? 9;
      return aPriority - bPriority;
    });
    return slots[0] ?? null;
  }, [rumbleStatus]);

  // Hold the previous non-idle slot for a grace period during transitions
  // to prevent flashing idle/blank between rumbles
  useEffect(() => {
    const isIdle = !rawFeaturedSlot || rawFeaturedSlot.state === "idle";
    if (!isIdle) {
      lastNonIdleSlotRef.current = rawFeaturedSlot;
      setIdleGraceActive(false);
      if (idleGraceTimeoutRef.current) {
        clearTimeout(idleGraceTimeoutRef.current);
        idleGraceTimeoutRef.current = null;
      }
    } else if (lastNonIdleSlotRef.current && !idleGraceActive) {
      // Slot just went idle — start a 4s grace period before showing idle screen
      setIdleGraceActive(true);
      idleGraceTimeoutRef.current = setTimeout(() => {
        lastNonIdleSlotRef.current = null;
        setIdleGraceActive(false);
        idleGraceTimeoutRef.current = null;
      }, 4_000);
    }
    return () => {
      if (idleGraceTimeoutRef.current) {
        clearTimeout(idleGraceTimeoutRef.current);
        idleGraceTimeoutRef.current = null;
      }
    };
  }, [rawFeaturedSlot, idleGraceActive]);

  const featuredSlot = idleGraceActive && lastNonIdleSlotRef.current
    ? lastNonIdleSlotRef.current
    : rawFeaturedSlot;

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

  // Winner popup when entering payout state
  useEffect(() => {
    const rumbleId = String(featuredSlot?.rumbleId ?? "");
    const state = String(featuredSlot?.state ?? "idle");
    if (state !== "payout" || !rumbleId) return;
    if (winnerPopupShownForRef.current === rumbleId) return;

    const placements = (featuredSlot?.fighters ?? [])
      .filter(f => safeNumber(f.placement, 0) > 0)
      .sort((a, b) => safeNumber(a.placement, 0) - safeNumber(b.placement, 0));
    const winner = placements[0];
    if (!winner) return;

    winnerPopupShownForRef.current = rumbleId;
    setWinnerPopup({ fighter: winner, payout: featuredSlot?.payout ?? null, rumbleNumber: featuredSlot?.rumbleNumber ?? null });
    winnerPopupAnim.setValue(0);
    Animated.spring(winnerPopupAnim, {
      toValue: 1,
      tension: 60,
      friction: 8,
      useNativeDriver: true,
    }).start();
    void triggerHaptic("impact");

    if (winnerPopupDismissRef.current) clearTimeout(winnerPopupDismissRef.current);
    winnerPopupDismissRef.current = setTimeout(() => {
      Animated.timing(winnerPopupAnim, {
        toValue: 0,
        duration: 300,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) setWinnerPopup(null);
      });
    }, 6_000);
  }, [featuredSlot?.rumbleId, featuredSlot?.state, featuredSlot?.fighters, featuredSlot?.payout, featuredSlot?.rumbleNumber, winnerPopupAnim, triggerHaptic]);

  useEffect(() => {
    return () => {
      if (clearElimsTimeoutRef.current) clearTimeout(clearElimsTimeoutRef.current);
      if (idleGraceTimeoutRef.current) clearTimeout(idleGraceTimeoutRef.current);
      if (winnerPopupDismissRef.current) clearTimeout(winnerPopupDismissRef.current);
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
  }, [activeTab, contentRevealAnim]);

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
      setRumbleStatus(previous => mergeRumbleStatusSnapshots(previous, data));
      setLastStatusAt(Date.now());
      setStatusError(null);
      statusRetryAfterRef.current = 0;
      if (statusText.startsWith("Network issue:")) {
        setStatusText("Ready");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isRateLimitError(error)) {
        const retryMs = 15_000;
        statusRetryAfterRef.current = Date.now() + retryMs;
        // Don't show error banner for rate limits — just silently back off
        // and keep displaying the last known good state
        return;
      }
      // Only show error if we have no data at all
      if (!rumbleStatus) {
        setStatusError(message);
        setStatusText(`Network issue: ${message}`);
      }
    } finally {
      statusRequestInFlightRef.current = false;
      setStatusLoading(false);
    }
  }, [rumbleStatus, statusText]);

  const scheduleStatusRefresh = useCallback((force = false, delayMs = STATUS_REALTIME_REFRESH_DEBOUNCE_MS) => {
    if (!isAppActive) return;
    if (statusRealtimeRefreshTimeoutRef.current) return;
    statusRealtimeRefreshTimeoutRef.current = setTimeout(() => {
      statusRealtimeRefreshTimeoutRef.current = null;
      void fetchStatus(force);
    }, delayMs);
  }, [fetchStatus, isAppActive]);

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
      const data = await fetchJsonFromCandidates<{ signatures: TxEntry[] }>(`/api/rumble/tx-feed?network=${txFeedNetwork}&_t=${Date.now()}`);
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
  }, [txFeedNetwork]);

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
    const sub = AppState.addEventListener("change", nextState => {
      setAppState(nextState);
    });
    return () => {
      sub.remove();
    };
  }, []);

  useEffect(() => {
    if (!isAppActive) return;
    void fetchStatus();
  }, [fetchStatus, isAppActive]);

  useEffect(() => {
    if (!isAppActive) {
      if (statusRealtimeRefreshTimeoutRef.current) {
        clearTimeout(statusRealtimeRefreshTimeoutRef.current);
        statusRealtimeRefreshTimeoutRef.current = null;
      }
      return;
    }

    const client = getSupabaseRealtimeClient();
    if (!client) return;

    const scheduleRefresh = () => {
      scheduleStatusRefresh(false);
    };

    const channel = client
      .channel("rumble_status_mobile")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "ucf_rumbles" },
        scheduleRefresh,
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "ucf_rumble_queue" },
        scheduleRefresh,
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "ucf_ichor_shower" },
        scheduleRefresh,
      )
      .subscribe(status => {
        if (status === "CHANNEL_ERROR") {
          console.warn("[mobile-realtime] Channel error. Polling fallback remains active.");
        }
      });

    statusRealtimeChannelRef.current = channel;

    return () => {
      if (statusRealtimeRefreshTimeoutRef.current) {
        clearTimeout(statusRealtimeRefreshTimeoutRef.current);
        statusRealtimeRefreshTimeoutRef.current = null;
      }
      client.removeChannel(channel);
      if (statusRealtimeChannelRef.current === channel) {
        statusRealtimeChannelRef.current = null;
      }
    };
  }, [isAppActive, scheduleStatusRefresh]);

  useEffect(() => {
    if (!isAppActive) return;
    const delayMs = getSuggestedStatusPollDelayMs(rumbleStatus, statusError);
    const timer = setTimeout(() => void fetchStatus(), delayMs);
    return () => clearTimeout(timer);
  }, [fetchStatus, isAppActive, rumbleStatus, statusError]);

  useEffect(() => {
    if (!isAppActive || activeTab !== "chat") return;
    void fetchChat(true);
  }, [activeTab, fetchChat, isAppActive]);

  useEffect(() => {
    if (!isAppActive || activeTab !== "chat") return;
    const timer = setTimeout(() => void fetchChat(), CHAT_POLL_ACTIVE_MS);
    return () => clearTimeout(timer);
  }, [activeTab, fetchChat, isAppActive, messages.length, chatError]);

  useEffect(() => {
    if (!isAppActive || activeTab !== "queue" || txFeedMinimized) return;
    void fetchTxFeed();
  }, [activeTab, fetchTxFeed, isAppActive, txFeedMinimized]);

  useEffect(() => {
    if (!isAppActive || activeTab !== "queue" || txFeedMinimized) return;
    const timer = setTimeout(() => void fetchTxFeed(), TX_FEED_POLL_ACTIVE_MS);
    return () => clearTimeout(timer);
  }, [activeTab, fetchTxFeed, isAppActive, txFeedMinimized, txFeed.length, txError]);

  useEffect(() => {
    if (!walletAddress || !isAppActive) return;
    void fetchClaimBalance();
    void fetchMyBets(activeTab === "queue");
    void fetchSolBalance();
  }, [walletAddress, activeTab, fetchClaimBalance, fetchMyBets, fetchSolBalance, isAppActive]);

  useEffect(() => {
    if (!walletAddress || !isAppActive) return;
    const timer = setTimeout(() => {
      void fetchClaimBalance();
      void fetchMyBets(activeTab === "queue");
      void fetchSolBalance();
    }, WALLET_POLL_ACTIVE_MS);
    return () => clearTimeout(timer);
  }, [
    walletAddress,
    activeTab,
    fetchClaimBalance,
    fetchMyBets,
    fetchSolBalance,
    isAppActive,
    claimBalance?.claimable_sol,
    claimBalance?.claimed_sol,
    solBalance,
  ]);

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
  const signalLive =
    lastStatusAt !== null &&
    Date.now() - lastStatusAt <
      Math.max(8_000, getSuggestedStatusPollDelayMs(rumbleStatus, statusError) + 4_000);

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
            <Text style={styles.subTitle}>BATTLE ROYALE // 12-16 FIGHTERS // LAST BOT STANDING</Text>
          </View>
          <View style={styles.headerRight}>
            <View style={styles.liveRow}>
              <View style={[styles.liveDot, signalLive ? styles.liveDotOn : styles.liveDotOff]} />
              <Text style={styles.liveText}>{signalLive ? "LIVE" : "POLLING"}</Text>
            </View>
            <View style={styles.headerUtilityGroup}>
              <View style={styles.headerWalletSlot}>
                <WalletHeader
                  walletAddress={walletAddress}
                  busy={isBusy}
                  solBalance={solBalance}
                  onConnect={onConnect}
                  onDisconnect={onDisconnect}
                />
              </View>
              <View style={styles.headerGearSlot}>
                <SoundControls
                  musicEnabled={musicEnabled}
                  sfxEnabled={sfxEnabled}
                  hapticsEnabled={hapticsEnabled}
                  onToggleMusic={handleToggleMusic}
                  onToggleSfx={handleToggleSfx}
                  onToggleHaptics={handleToggleHaptics}
                />
              </View>
            </View>
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
                          {queueLength >= 12 ? "NEXT RUMBLE STARTING SOON" : "Need 12+ fighters to start a rumble"}
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
                                      {leftMove ? (
                                        <Text style={[styles.moveTag, { color: getMoveColor(leftMove) }]}>
                                          {formatMove(leftMove)} {safeNumber(pair.damageToB, 0) > 0 ? `(-${safeNumber(pair.damageToB, 0).toFixed(0)})` : ""}
                                        </Text>
                                      ) : null}
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
                                      {rightMove ? (
                                        <Text style={[styles.moveTag, { color: getMoveColor(rightMove) }]}>
                                          {formatMove(rightMove)} {safeNumber(pair.damageToA, 0) > 0 ? `(-${safeNumber(pair.damageToA, 0).toFixed(0)})` : ""}
                                        </Text>
                                      ) : null}
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
                                          const leftMove = String(pair.moveA ?? "").toUpperCase();
                                          const rightMove = String(pair.moveB ?? "").toUpperCase();
                                          return (
                                            <View key={`pair_${pairIdx}`} style={styles.turnFeedPairRow}>
                                              <Text style={styles.turnFeedLine} numberOfLines={1}>
                                                {leftName} -{dmgToB} | {rightName} -{dmgToA}
                                              </Text>
                                              <View style={styles.turnFeedMoveRow}>
                                                <Text style={[styles.turnFeedMoveTag, { color: getMoveColor(leftMove) }]}>{formatMove(leftMove)}</Text>
                                                <Text style={styles.turnFeedMoveSep}>vs</Text>
                                                <Text style={[styles.turnFeedMoveTag, { color: getMoveColor(rightMove) }]}>{formatMove(rightMove)}</Text>
                                              </View>
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
                      <Text style={styles.panelCollapseText}>{txFeedMinimized ? "SHOW" : "HIDE"}</Text>
                    </View>
                  </Pressable>
                  {!txFeedMinimized ? (
                    <View style={styles.networkToggleRow}>
                      <Pressable
                        onPress={() => { setTxFeed([]); setTxLoading(true); setTxFeedNetwork("mainnet"); }}
                        style={[styles.networkToggleBtn, txFeedNetwork === "mainnet" ? styles.networkToggleBtnActive : null]}
                      >
                        <Text style={[styles.networkToggleText, txFeedNetwork === "mainnet" ? styles.networkToggleTextActive : null]}>MAINNET</Text>
                      </Pressable>
                      <Pressable
                        onPress={() => { setTxFeed([]); setTxLoading(true); setTxFeedNetwork("devnet"); }}
                        style={[styles.networkToggleBtn, txFeedNetwork === "devnet" ? styles.networkToggleBtnActive : null]}
                      >
                        <Text style={[styles.networkToggleText, txFeedNetwork === "devnet" ? styles.networkToggleTextActive : null]}>DEVNET</Text>
                      </Pressable>
                    </View>
                  ) : null}
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
                          onPress={() => {}}
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

      {winnerPopup ? (
        <Animated.View
          style={[
            styles.winnerOverlay,
            {
              opacity: winnerPopupAnim,
              transform: [
                {
                  scale: winnerPopupAnim.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0.8, 1],
                  }),
                },
              ],
            },
          ]}
        >
          <Pressable style={styles.winnerOverlayBackdrop} onPress={() => {
            if (winnerPopupDismissRef.current) clearTimeout(winnerPopupDismissRef.current);
            Animated.timing(winnerPopupAnim, {
              toValue: 0,
              duration: 250,
              easing: Easing.in(Easing.cubic),
              useNativeDriver: true,
            }).start(({ finished }) => { if (finished) setWinnerPopup(null); });
          }}>
            <View style={styles.winnerCard}>
              <Text style={styles.winnerCrown}>WINNER</Text>
              {winnerPopup.rumbleNumber ? (
                <Text style={styles.winnerRumbleLabel}>RUMBLE #{winnerPopup.rumbleNumber}</Text>
              ) : null}
              <View style={styles.winnerAvatarRing}>
                <ExpoImage
                  source={winnerPopup.fighter.imageUrl ? { uri: winnerPopup.fighter.imageUrl } : BOT_AVATAR_IMG}
                  style={styles.winnerAvatar}
                  contentFit="cover"
                  transition={120}
                />
              </View>
              <Text style={styles.winnerName}>{getFighterName(winnerPopup.fighter)}</Text>
              <Text style={styles.winnerStats}>
                HP {safeNumber(winnerPopup.fighter.hp, 0).toFixed(0)} // DMG {safeNumber(winnerPopup.fighter.totalDamageDealt, 0).toFixed(0)}
              </Text>
              {winnerPopup.payout ? (
                <View style={styles.winnerPayoutRow}>
                  <Text style={styles.winnerPayoutLabel}>Pool</Text>
                  <Text style={styles.winnerPayoutValue}>{safeNumber(winnerPopup.payout.totalPool, 0).toFixed(3)} SOL</Text>
                </View>
              ) : null}
              <Text style={styles.winnerDismissHint}>TAP TO DISMISS</Text>
            </View>
          </Pressable>
        </Animated.View>
      ) : null}
    </ImageBackground>
  );
}

// Styles are now in ./lib/styles.ts
// (This trailing comment replaces the ~1,400-line StyleSheet.create block)
