"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import {
  PublicKey,
  Transaction,
  LAMPORTS_PER_SOL,
  Connection,
} from "@solana/web3.js";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import RumbleSlot, { SlotData } from "./components/RumbleSlot";
import PayoutDisplay from "./components/PayoutDisplay";
import QueueSidebar from "./components/QueueSidebar";
import IchorShowerPool from "./components/IchorShowerPool";
import ClaimBalancePanel from "./components/ClaimBalancePanel";
import ChatPanel from "./components/ChatPanel";
import CommentaryPlayer from "./components/CommentaryPlayer";
import { useBetConfirmation } from "./hooks/useBetConfirmation";
import type { CommentarySSEEvent } from "~~/lib/commentary";
import { audioManager, soundForPairing } from "~~/lib/audio";
import { BoltIcon, ChatBubbleLeftRightIcon, ListBulletIcon } from "@heroicons/react/24/outline";

// ---------------------------------------------------------------------------
// Types for the status API response
// ---------------------------------------------------------------------------

interface QueueFighter {
  fighterId: string;
  name: string;
  imageUrl: string | null;
  position: number;
}

interface RumbleStatus {
  slots: SlotData[];
  queue: QueueFighter[];
  queueLength: number;
  nextRumbleIn: string | null;
  ichorShower: {
    currentPool: number;
    rumblesSinceLastTrigger: number;
  };
}

interface PendingRumbleClaim {
  rumble_id: string;
  claimable_sol: number;
  onchain_claimable_sol: number | null;
  claim_method: "onchain" | "offchain";
  onchain_rumble_state?: "betting" | "combat" | "payout" | "complete" | null;
  onchain_payout_ready?: boolean;
}

interface ClaimBalanceStatus {
  payout_mode: "instant" | "accrue_claim";
  claimable_sol: number;
  legacy_claimable_sol: number;
  total_pending_claimable_sol: number;
  claimed_sol: number;
  unsettled_sol: number;
  orphaned_stale_sol?: number;
  onchain_claimable_sol_total: number;
  onchain_pending_not_ready_sol?: number;
  onchain_claim_ready: boolean;
  pending_rumbles: PendingRumbleClaim[];
}

interface MyBetsSlot {
  slot_index: number;
  rumble_id: string;
  total_sol: number;
  bets: Array<{
    fighter_id: string;
    sol_amount: number;
    bet_count: number;
  }>;
}

interface MyBetsResponse {
  wallet: string;
  slots: MyBetsSlot[];
  total_sol: number;
}

interface LastCompletedSlotResult {
  rumbleId: string;
  settledAtIso: string;
  capturedAt: number; // Date.now() when captured — used for grace period
  placements: Array<{
    fighterId: string;
    fighterName: string;
    imageUrl: string | null;
    placement: number;
    hp: number;
    damageDealt: number;
  }>;
  payout: NonNullable<SlotData["payout"]>;
  myBetFighterIds?: string[]; // fighter IDs the user had bet on (captured at result time)
}

// ---------------------------------------------------------------------------
// SSE event types for live updates
// ---------------------------------------------------------------------------

interface SSEEvent {
  type:
  | OrchestratorSseName
  | "turn"
  | "elimination"
  | "slot_state_change"
  | "bet_placed";
  slotIndex: number;
  data: any;
}

type OrchestratorSseName =
  | "turn_resolved"
  | "fighter_eliminated"
  | "rumble_complete"
  | "ichor_shower"
  | "betting_open"
  | "betting_closed"
  | "combat_started"
  | "payout_complete"
  | "slot_recycled";

const ORCHESTRATOR_SSE_EVENTS = [
  "turn_resolved",
  "fighter_eliminated",
  "rumble_complete",
  "ichor_shower",
  "betting_open",
  "betting_closed",
  "combat_started",
  "payout_complete",
  "slot_recycled",
] as const satisfies ReadonlyArray<OrchestratorSseName>;

const LEGACY_EVENT_MAP: Partial<Record<SSEEvent["type"], OrchestratorSseName>> = {
  turn: "turn_resolved",
  elimination: "fighter_eliminated",
};
const CLIENT_BET_CLOSE_GUARD_MS = 12_000;

function isSlotState(value: unknown): value is SlotData["state"] {
  return value === "idle" || value === "betting" || value === "combat" || value === "payout";
}

function buildLastCompletedResult(slot: SlotData): LastCompletedSlotResult | null {
  if (!slot.payout) return null;
  const placements = slot.fighters
    .filter((fighter) => fighter.placement > 0)
    .sort((a, b) => a.placement - b.placement)
    .map((fighter) => ({
      fighterId: fighter.id,
      fighterName: fighter.name,
      imageUrl: fighter.imageUrl,
      placement: fighter.placement,
      hp: fighter.hp,
      damageDealt: fighter.totalDamageDealt,
    }));
  if (placements.length === 0) return null;
  return {
    rumbleId: slot.rumbleId,
    settledAtIso: new Date().toISOString(),
    capturedAt: Date.now(),
    placements,
    payout: slot.payout,
  };
}

function safeNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function safeString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function normalizeSlotState(value: unknown): SlotData["state"] {
  return value === "idle" || value === "betting" || value === "combat" || value === "payout"
    ? value
    : "idle";
}

function normalizeTurn(raw: any): SlotData["turns"][number] | null {
  if (!raw || typeof raw !== "object") return null;
  const pairings = Array.isArray(raw.pairings)
    ? raw.pairings.map((p: any) => ({
      fighterA: safeString(p?.fighterA),
      fighterB: safeString(p?.fighterB),
      fighterAName: safeString(p?.fighterAName, safeString(p?.fighterA, "Unknown")),
      fighterBName: safeString(p?.fighterBName, safeString(p?.fighterB, "Unknown")),
      moveA: safeString(p?.moveA),
      moveB: safeString(p?.moveB),
      damageToA: safeNumber(p?.damageToA, 0),
      damageToB: safeNumber(p?.damageToB, 0),
    }))
    : [];
  return {
    turnNumber: safeNumber(raw.turnNumber, 0),
    pairings,
    eliminations: Array.isArray(raw.eliminations)
      ? raw.eliminations.map((id: any) => safeString(id)).filter(Boolean)
      : [],
    bye: raw.bye ? safeString(raw.bye) : undefined,
  };
}

function normalizeStatusPayload(raw: any): RumbleStatus {
  const slots: SlotData[] = Array.isArray(raw?.slots)
    ? raw.slots.map((slot: any, index: number) => {
      const fightersRaw = Array.isArray(slot?.fighters) ? slot.fighters : [];
      const fighters = fightersRaw.map((f: any) => ({
        id: safeString(f?.id),
        name: safeString(f?.name, safeString(f?.id)),
        hp: safeNumber(f?.hp, 100),
        maxHp: safeNumber(f?.maxHp, 100),
        imageUrl: typeof f?.imageUrl === "string" ? f.imageUrl : null,
        meter: safeNumber(f?.meter, 0),
        totalDamageDealt: safeNumber(f?.totalDamageDealt, 0),
        totalDamageTaken: safeNumber(f?.totalDamageTaken, 0),
        eliminatedOnTurn:
          f?.eliminatedOnTurn === null || f?.eliminatedOnTurn === undefined
            ? null
            : safeNumber(f?.eliminatedOnTurn, 0),
        placement: safeNumber(f?.placement, 0),
      }));

      const oddsRaw = Array.isArray(slot?.odds) ? slot.odds : [];
      const odds = oddsRaw.map((o: any) => ({
        fighterId: safeString(o?.fighterId),
        fighterName: safeString(o?.fighterName, safeString(o?.fighterId)),
        imageUrl: typeof o?.imageUrl === "string" ? o.imageUrl : null,
        hp: safeNumber(o?.hp, 100),
        solDeployed: safeNumber(o?.solDeployed, 0),
        betCount: safeNumber(o?.betCount, 0),
        impliedProbability: safeNumber(o?.impliedProbability, 0),
        potentialReturn: safeNumber(o?.potentialReturn, 0),
      }));

      const turns = Array.isArray(slot?.turns)
        ? slot.turns
          .map((turn: any) => normalizeTurn(turn))
          .filter(
            (turn: SlotData["turns"][number] | null): turn is SlotData["turns"][number] =>
              Boolean(turn),
          )
        : [];

      const payoutRaw = slot?.payout && typeof slot.payout === "object" ? slot.payout : null;
      const payout = payoutRaw
        ? {
          winnerBettorsPayout: safeNumber(payoutRaw.winnerBettorsPayout, 0),
          placeBettorsPayout: safeNumber(payoutRaw.placeBettorsPayout, 0),
          showBettorsPayout: safeNumber(payoutRaw.showBettorsPayout, 0),
          treasuryVault: safeNumber(payoutRaw.treasuryVault, 0),
          totalPool: safeNumber(payoutRaw.totalPool, 0),
          ichorMined: safeNumber(payoutRaw.ichorMined, 0),
          ichorShowerTriggered: Boolean(payoutRaw.ichorShowerTriggered),
          ichorShowerAmount:
            payoutRaw.ichorShowerAmount === undefined || payoutRaw.ichorShowerAmount === null
              ? undefined
              : safeNumber(payoutRaw.ichorShowerAmount, 0),
        }
        : null;

      const fighterNamesRaw =
        slot?.fighterNames && typeof slot.fighterNames === "object" ? slot.fighterNames : {};
      const fighterNames: Record<string, string> = {};
      for (const [k, v] of Object.entries(fighterNamesRaw)) {
        fighterNames[String(k)] = safeString(v, String(k));
      }

      return {
        slotIndex: safeNumber(slot?.slotIndex, index),
        rumbleId: safeString(slot?.rumbleId, `slot_${index}`),
        rumbleNumber: slot?.rumbleNumber != null ? safeNumber(slot.rumbleNumber, 0) || null : null,
        state: normalizeSlotState(slot?.state),
        fighters,
        odds,
        totalPool: safeNumber(slot?.totalPool, 0),
        bettingDeadline: typeof slot?.bettingDeadline === "string" ? slot.bettingDeadline : null,
        nextTurnAt: typeof slot?.nextTurnAt === "string" ? slot.nextTurnAt : null,
        turnIntervalMs:
          slot?.turnIntervalMs === undefined || slot?.turnIntervalMs === null
            ? null
            : safeNumber(slot?.turnIntervalMs, 0),
        currentTurn: safeNumber(slot?.currentTurn, 0),
        maxTurns: slot?.maxTurns != null ? safeNumber(slot.maxTurns, 20) : 20,
        remainingFighters:
          slot?.remainingFighters === null || slot?.remainingFighters === undefined
            ? null
            : safeNumber(slot?.remainingFighters, 0),
        turnPhase: typeof slot?.turnPhase === "string" ? slot.turnPhase : null,
        nextTurnTargetSlot: slot?.nextTurnTargetSlot != null ? safeNumber(slot.nextTurnTargetSlot, 0) : null,
        currentSlot: slot?.currentSlot != null ? safeNumber(slot.currentSlot, 0) : null,
        slotMsEstimate: safeNumber(slot?.slotMsEstimate, 400),
        turns,
        payout,
        fighterNames,
      };
    })
    : [];

  const queue: QueueFighter[] = Array.isArray(raw?.queue)
    ? raw.queue.map((item: any, index: number) => ({
      fighterId: safeString(item?.fighterId, `queue_${index}`),
      name: safeString(item?.name, safeString(item?.fighterId)),
      imageUrl: typeof item?.imageUrl === "string" ? item.imageUrl : null,
      position: safeNumber(item?.position, index + 1),
    }))
    : [];

  return {
    slots,
    queue,
    queueLength: safeNumber(raw?.queueLength, queue.length),
    nextRumbleIn: typeof raw?.nextRumbleIn === "string" ? raw.nextRumbleIn : null,
    ichorShower: {
      currentPool: safeNumber(raw?.ichorShower?.currentPool, 0),
      rumblesSinceLastTrigger: safeNumber(raw?.ichorShower?.rumblesSinceLastTrigger, 0),
    },
  };
}

// ---------------------------------------------------------------------------
// Page Component
// ---------------------------------------------------------------------------

export default function RumblePage() {
  const [status, setStatus] = useState<RumbleStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sseConnected, setSseConnected] = useState(false);
  const [betPending, setBetPending] = useState(false);
  const [betError, setBetError] = useState<string | null>(null);
  const [solBalance, setSolBalance] = useState<number | null>(null);
  const [claimBalance, setClaimBalance] = useState<ClaimBalanceStatus | null>(null);
  const [claimLoading, setClaimLoading] = useState(false);
  const [claimPending, setClaimPending] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  // Grace period: after an optimistic bet update, prevent fetchMyBets from overwriting for 10s
  const optimisticBetUntilRef = useRef<number>(0);
  // Track rumbleId per slot to detect rumble transitions and clear stale bets
  const slotRumbleIdRef = useRef<Map<number, string>>(new Map());
  const [lastSseEvent, setLastSseEvent] = useState<CommentarySSEEvent | null>(null);
  const [sseEventSeq, setSseEventSeq] = useState(0);
  const [mobileTab, setMobileTab] = useState<"arena" | "chat" | "queue">("arena");
  const LAST_RESULT_STORAGE_KEY = "ucf_last_result";
  const [lastCompletedBySlot, setLastCompletedBySlot] = useState<Map<number, LastCompletedSlotResult>>(() => {
    try {
      const stored = typeof window !== "undefined" ? localStorage.getItem(LAST_RESULT_STORAGE_KEY) : null;
      if (stored) {
        const parsed = JSON.parse(stored) as
          | { slotIndex?: number; result?: LastCompletedSlotResult }
          | LastCompletedSlotResult;
        if (
          parsed &&
          typeof parsed === "object" &&
          "result" in parsed &&
          parsed.result?.rumbleId &&
          Number.isInteger(parsed.slotIndex)
        ) {
          return new Map([[Number(parsed.slotIndex), parsed.result]]);
        }
        if ((parsed as LastCompletedSlotResult)?.rumbleId) {
          // Backward compatibility with older local format (no slot index)
          return new Map([[0, parsed as LastCompletedSlotResult]]);
        }
      }
    } catch { }
    return new Map();
  });

  // Track user stake per fighter per slot.
  // Map<slotIndex, Map<fighterId, totalSolStaked>>
  const [myBetAmountsBySlot, setMyBetAmountsBySlot] = useState<Map<number, Map<string, number>>>(new Map());
  // Mirror myBetAmountsBySlot in a ref so fetchStatus can capture bet data at result time
  const myBetAmountsBySlotRef = useRef(myBetAmountsBySlot);
  myBetAmountsBySlotRef.current = myBetAmountsBySlot;
  const claimFetchInFlightRef = useRef(false);
  const claimBalanceRef = useRef<ClaimBalanceStatus | null>(null);
  const pollSeqRef = useRef(0);

  // Track previous slot states for sound effect detection (works with both SSE and polling)
  const prevSlotAudioState = useRef<Map<number, { state: string; turnCount: number; fighterCount: number }>>(new Map());

  // ---- Wallet adapter hooks ----
  const { publicKey, signTransaction, connected, disconnect: walletDisconnect, wallet } = useWallet();
  const { setVisible: setWalletModalVisible } = useWalletModal();
  const walletConnected = connected && !!publicKey;

  // RPC connection — use Helius if available, otherwise public RPC
  const network = process.env.NEXT_PUBLIC_SOLANA_NETWORK ?? "devnet";
  // Client-side RPC uses public endpoints only — Helius key stays server-side
  const rpcEndpoint = (() => {
    const explicit = process.env.NEXT_PUBLIC_SOLANA_RPC_URL?.trim();
    if (explicit) return explicit;
    return network === "mainnet-beta" ? "https://api.mainnet-beta.solana.com" : "https://api.devnet.solana.com";
  })();
  const connectionRef = useRef(new Connection(rpcEndpoint, "confirmed"));
  const connection = connectionRef.current;

  const disconnectWallet = useCallback(async () => {
    await walletDisconnect();
    setSolBalance(null);
    setClaimBalance(null);
    setClaimError(null);
  }, [walletDisconnect]);

  // Fetch SOL balance when wallet connects
  useEffect(() => {
    if (!publicKey) {
      setSolBalance(null);
      return;
    }
    const fetchBalance = async () => {
      try {
        const lamports = await connection.getBalance(publicKey, "confirmed");
        setSolBalance(lamports / LAMPORTS_PER_SOL);
      } catch {
        setSolBalance(null);
      }
    };
    fetchBalance();
    const interval = setInterval(fetchBalance, 15_000);
    return () => clearInterval(interval);
  }, [publicKey, connection]);

  useEffect(() => {
    claimBalanceRef.current = claimBalance;
  }, [claimBalance]);

  // Reset wallet-specific state immediately when wallet account changes
  useEffect(() => {
    setClaimBalance(null);
    setMyBetAmountsBySlot(new Map());
    setSolBalance(null);
    setClaimError(null);
    setBetError(null);
  }, [publicKey]);

  // Fetch full status via polling
  const fetchStatus = useCallback(async () => {
    const seq = ++pollSeqRef.current;
    try {
      const res = await fetch(`/api/rumble/status?_t=${Date.now()}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`Status ${res.status}`);
      let raw = await res.json();

      // Inject local mock data for UI testing if the server is empty
      if (process.env.NODE_ENV === "development" && (!raw.slots || raw.slots.length === 0)) {
        raw = {
          ...raw,
          slots: [{
            slot: 999,
            state: "betting",
            phaseStart: Date.now() - 10000,
            phaseEnd: Date.now() + 600000,
            minFighters: 8,
            minBet: 0.01,
            poolSize: 15.4,
            fighters: [
              { fighterId: "f1", fighterName: "ClawdBot", hp: 100, maxHp: 100, solDeployed: 5.2, betCount: 14, impliedProbability: 0.33, potentialReturn: 3.0, imageUrl: "https://teal-distinct-tarantula-166.mypinata.cloud/ipfs/bafybeicgclzndr3wwk4d4qpxe5edv67j6shm4zffp7v6ps2bhmstex64ka" },
              { fighterId: "f2", fighterName: "IronClaw", hp: 100, maxHp: 100, solDeployed: 2.1, betCount: 5, impliedProbability: 0.15, potentialReturn: 6.6, imageUrl: "https://teal-distinct-tarantula-166.mypinata.cloud/ipfs/bafybeidof5y26j44uqun5p6tpt6u2ndvgyg72ov3o2lfl4p5tw72g24sfi" },
              { fighterId: "f3", fighterName: "RustBucket", hp: 100, maxHp: 100, solDeployed: 8.1, betCount: 30, impliedProbability: 0.52, potentialReturn: 1.9, imageUrl: "https://teal-distinct-tarantula-166.mypinata.cloud/ipfs/bafybeieffh6d2gqbs3n442aoxj42q7w5nndn2ndxsz2ofvwhcwngn2owee" },
              { fighterId: "f4", fighterName: "SnapDragon", hp: 100, maxHp: 100, solDeployed: 0.5, betCount: 1, impliedProbability: 0.05, potentialReturn: 20.0, imageUrl: "https://teal-distinct-tarantula-166.mypinata.cloud/ipfs/bafybeidof5y26j44uqun5p6tpt6u2ndvgyg72ov3o2lfl4p5tw72g24sfi" },
              { fighterId: "f5", fighterName: "NeonPincer", hp: 100, maxHp: 100, solDeployed: 1.0, betCount: 2, impliedProbability: 0.1, potentialReturn: 10.0, imageUrl: "https://teal-distinct-tarantula-166.mypinata.cloud/ipfs/bafybeicgclzndr3wwk4d4qpxe5edv67j6shm4zffp7v6ps2bhmstex64ka" }
            ],
            combatLog: [],
            winnerId: null,
            payouts: null
          }],
          queue: [{ id: "q1", title: "Heavyweight Prototype" }, { id: "q2", title: "MK-1 Aggressor" }],
          queueLength: 2
        };
      }

      if (seq !== pollSeqRef.current) return; // stale response, discard
      const data = normalizeStatusPayload(raw);
      setStatus(data);
      setError(null);

      // Keep the latest completed payout visible while slots wait for the next fighters.
      setLastCompletedBySlot((prev) => {
        let changed = false;
        const next = new Map(prev);
        const now = Date.now();
        for (const slot of data.slots) {
          if (slot.state === "betting" || slot.state === "combat") {
            // Keep completed result visible for 20s after slot recycles
            // so users can still see who won even when a new rumble starts
            const existing = next.get(slot.slotIndex);
            if (existing && now - existing.capturedAt > 20_000) {
              if (next.delete(slot.slotIndex)) {
                changed = true;
              }
            }
            continue;
          }

          // Clear stale results when slot is idle with no fighters (full reset)
          if (slot.state === "idle" && slot.fighters.length === 0) {
            const existing = next.get(slot.slotIndex);
            if (existing && now - existing.capturedAt > 20_000) {
              if (next.delete(slot.slotIndex)) {
                changed = true;
              }
            }
            continue;
          }

          const completed = buildLastCompletedResult(slot);
          if (!completed) continue;
          // Capture user's bet fighter IDs at result time so PayoutDisplay
          // can show "YOU WON" even after bets are cleared for the next rumble.
          const slotBets = myBetAmountsBySlotRef.current.get(slot.slotIndex);
          if (slotBets && slotBets.size > 0) {
            completed.myBetFighterIds = [...slotBets.keys()];
          }
          const existing = next.get(slot.slotIndex);
          if (!existing || existing.rumbleId !== completed.rumbleId) {
            next.set(slot.slotIndex, completed);
            changed = true;
          }
        }
        if (changed) {
          // Persist most recent result for page-refresh survival
          const latestEntry = [...next.entries()].pop();
          if (latestEntry) {
            const [slotIndex, result] = latestEntry;
            try {
              localStorage.setItem(
                LAST_RESULT_STORAGE_KEY,
                JSON.stringify({ slotIndex, result }),
              );
            } catch { }
          } else {
            // All results cleared (full reset) — remove from localStorage too
            try { localStorage.removeItem(LAST_RESULT_STORAGE_KEY); } catch { }
          }
        }
        return changed ? next : prev;
      });

      // Clear local bet-tracking when a slot goes idle OR its rumbleId changes
      // (new rumble started). Also reset optimistic grace so stale bets from
      // the previous rumble don't bleed into the new one.
      setMyBetAmountsBySlot((prev) => {
        let changed = false;
        const next = new Map(prev);
        const prevRumbleIds = slotRumbleIdRef.current;
        const nextRumbleIds = new Map<number, string>();
        for (const slot of data.slots) {
          nextRumbleIds.set(slot.slotIndex, slot.rumbleId);
          const prevId = prevRumbleIds.get(slot.slotIndex);
          const rumbleChanged = prevId != null && prevId !== slot.rumbleId;
          if ((slot.state === "idle" || rumbleChanged) && next.has(slot.slotIndex)) {
            next.delete(slot.slotIndex);
            changed = true;
            // Kill optimistic grace so fetchMyBets uses fresh server data
            optimisticBetUntilRef.current = 0;
          }
        }
        slotRumbleIdRef.current = nextRumbleIds;
        return changed ? next : prev;
      });
    } catch (e: any) {
      console.error("Failed to fetch rumble status:", e);
      setError(e.message || "Failed to connect");
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchClaimBalance = useCallback(async () => {
    if (!publicKey) {
      setClaimBalance(null);
      setClaimError(null);
      return;
    }
    if (claimFetchInFlightRef.current) return;
    claimFetchInFlightRef.current = true;

    const firstLoad = !claimBalanceRef.current;
    if (firstLoad) {
      setClaimLoading(true);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("timeout"), 4_500);
    try {
      const wallet = encodeURIComponent(publicKey.toBase58());
      const res = await fetch(`/api/rumble/balance?wallet=${wallet}&_t=${Date.now()}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error ?? `Balance ${res.status}`);
      }
      setClaimBalance(data as ClaimBalanceStatus);
      setClaimError(null);
    } catch (e: any) {
      if (e?.name === "AbortError") {
        if (!claimBalanceRef.current) {
          setClaimError("Balance refresh timed out. Retrying...");
        }
        return;
      }
      setClaimError(e?.message ?? "Failed to load claim balance");
    } finally {
      clearTimeout(timeout);
      claimFetchInFlightRef.current = false;
      if (firstLoad) {
        setClaimLoading(false);
      }
    }
  }, [publicKey]);

  const fetchMyBets = useCallback(async () => {
    if (!publicKey) {
      setMyBetAmountsBySlot(new Map());
      return;
    }
    try {
      const wallet = encodeURIComponent(publicKey.toBase58());
      const res = await fetch(`/api/rumble/my-bets?wallet=${wallet}&_t=${Date.now()}`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok) return;
      const payload = data as MyBetsResponse;
      const next = new Map<number, Map<string, number>>();
      for (const slot of payload.slots ?? []) {
        const fighterMap = new Map<string, number>();
        for (const bet of slot.bets ?? []) {
          const amount = Number(bet.sol_amount ?? 0);
          if (!Number.isFinite(amount) || amount <= 0) continue;
          fighterMap.set(String(bet.fighter_id), amount);
        }
        if (fighterMap.size > 0) {
          next.set(slot.slot_index, fighterMap);
        }
      }
      // During optimistic grace period, merge server data with local optimistic bets
      // so the user's just-placed bet isn't wiped by stale server response
      if (Date.now() < optimisticBetUntilRef.current) {
        setMyBetAmountsBySlot(prev => {
          const merged = new Map(next);
          for (const [slotIndex, fighterMap] of prev) {
            if (!merged.has(slotIndex)) {
              merged.set(slotIndex, fighterMap);
            } else {
              const serverMap = merged.get(slotIndex)!;
              for (const [fighterId, amount] of fighterMap) {
                if (!serverMap.has(fighterId)) {
                  serverMap.set(fighterId, amount);
                }
              }
            }
          }
          return merged;
        });
      } else {
        setMyBetAmountsBySlot(next);
      }
    } catch {
      // keep last known values on transient errors
    }
  }, [publicKey]);

  // Supabase Realtime: instant bet confirmation via Helius webhook path.
  // Falls back to polling if Realtime is unavailable.
  useBetConfirmation({
    walletAddress: publicKey?.toBase58() ?? null,
    onBetConfirmed: useCallback(() => {
      // Webhook confirmed our tx on-chain — refresh bets + balance immediately
      fetchMyBets();
      fetchClaimBalance();
      fetchStatus();
    }, [fetchMyBets, fetchClaimBalance, fetchStatus]),
    onPayoutUpdate: useCallback(() => {
      // Settlement changed — refresh claim balance
      fetchClaimBalance();
      fetchMyBets();
    }, [fetchClaimBalance, fetchMyBets]),
  });

  // Connect to SSE for real-time combat updates
  const connectSSE = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const es = new EventSource("/api/rumble/live");
    eventSourceRef.current = es;

    es.onopen = () => {
      setSseConnected(true);
    };

    es.onmessage = (event) => {
      try {
        // Backward compatibility for unnamed/default events.
        const parsed = JSON.parse(event.data);
        if (parsed?.type && typeof parsed?.slotIndex === "number") {
          handleSSEEvent(parsed as SSEEvent);
        }
      } catch {
        // Ignore parse errors from keepalive pings
      }
    };

    const bindNamedEvent = (eventName: OrchestratorSseName) => {
      es.addEventListener(eventName, (event) => {
        try {
          const data = JSON.parse((event as MessageEvent).data);
          if (typeof data?.slotIndex !== "number") return;
          handleSSEEvent({
            type: eventName,
            slotIndex: data.slotIndex,
            data,
          });
        } catch {
          // Ignore malformed payloads
        }
      });
    };

    ORCHESTRATOR_SSE_EVENTS.forEach(bindNamedEvent);

    es.onerror = () => {
      setSseConnected(false);
      // EventSource auto-reconnects
    };

    return es;
  }, []);

  // Handle incoming SSE events by patching local state
  const handleSSEEvent = useCallback((rawEvent: SSEEvent) => {
    const eventType = LEGACY_EVENT_MAP[rawEvent.type] ?? rawEvent.type;
    const event: SSEEvent = { ...rawEvent, type: eventType };

    // Sound effects are now driven by the status useEffect (works with both
    // SSE patches and polling). No need for SSE-only sound triggers here.

    if (event.type === "betting_open") {
      setLastCompletedBySlot((prev) => {
        if (!prev.has(event.slotIndex)) return prev;
        const next = new Map(prev);
        next.delete(event.slotIndex);
        return next;
      });
    }

    // Forward to commentary player
    setLastSseEvent({
      type: event.type,
      slotIndex: event.slotIndex,
      data: event.data,
    });
    setSseEventSeq((s) => s + 1);

    setStatus((prev) => {
      if (!prev) return prev;

      const slots = [...prev.slots];
      const slotIdx = slots.findIndex(
        (s) => s.slotIndex === event.slotIndex
      );
      if (slotIdx === -1) return prev;

      const slot = { ...slots[slotIdx] };

      switch (event.type) {
        case "turn":
        case "turn_resolved": {
          const turn = normalizeTurn(event.data?.turn ?? event.data);
          if (!turn || typeof turn.turnNumber !== "number") break;
          // Append new turn data
          if (!slot.turns.some((t) => t.turnNumber === turn.turnNumber)) {
            slot.turns = [...slot.turns, turn];
          }
          slot.currentTurn = Math.max(slot.currentTurn, turn.turnNumber);
          // Apply damage from turn pairings to fighters
          if (turn.pairings) {
            for (const p of turn.pairings) {
              slot.fighters = slot.fighters.map(f => {
                if (f.id === p.fighterA) return { ...f, hp: Math.max(0, f.hp - (p.damageToA ?? 0)) };
                if (f.id === p.fighterB) return { ...f, hp: Math.max(0, f.hp - (p.damageToB ?? 0)) };
                return f;
              });
            }
          }
          // Mark eliminations
          if (turn.eliminations) {
            for (const elimId of turn.eliminations) {
              slot.fighters = slot.fighters.map(f =>
                f.id === elimId ? { ...f, hp: 0, eliminatedOnTurn: turn.turnNumber ?? slot.currentTurn } : f
              );
            }
          }
          break;
        }

        case "elimination":
        case "fighter_eliminated":
          // Elimination details are reflected from polled status snapshots.
          break;

        case "betting_open":
          slot.state = "betting";
          slot.rumbleId = typeof event.data?.rumbleId === "string" ? event.data.rumbleId : slot.rumbleId;
          slot.bettingDeadline =
            typeof event.data?.deadline === "string" ? event.data.deadline : slot.bettingDeadline;
          slot.turns = [];
          slot.currentTurn = 0;
          slot.payout = null;
          break;

        case "betting_closed":
          // Betting is closed but slot remains in pre-combat transition.
          break;

        case "combat_started":
          slot.state = "combat";
          break;

        case "rumble_complete":
          slot.state = "payout";
          if (event.data?.payout) slot.payout = event.data.payout;
          break;

        case "payout_complete":
          slot.state = "payout";
          if (event.data?.payout) slot.payout = event.data.payout;
          break;

        case "slot_recycled":
          slot.state = "idle";
          slot.turns = [];
          slot.currentTurn = 0;
          slot.totalPool = 0;
          slot.payout = null;
          break;

        case "slot_state_change":
          if (isSlotState(event.data?.state)) {
            slot.state = event.data.state;
          }
          if (event.data?.payout && typeof event.data.payout === "object") {
            slot.payout = event.data.payout;
          }
          if (Array.isArray(event.data?.odds)) {
            slot.odds = event.data.odds;
          }
          if (Array.isArray(event.data?.fighters)) {
            // Preserve robotMeta from existing slot data when SSE patches fighters
            const existingMetaMap = new Map(
              slot.fighters.map((f: any) => [f.id, f.robotMeta]),
            );
            slot.fighters = event.data.fighters.map((f: any) => ({
              ...f,
              robotMeta: f.robotMeta ?? existingMetaMap.get(f.id) ?? null,
            }));
          }
          break;

        case "bet_placed":
          slot.totalPool = safeNumber(event.data?.totalPool, slot.totalPool);
          if (Array.isArray(event.data?.odds)) {
            slot.odds = event.data.odds;
          }
          break;

        case "ichor_shower":
          return {
            ...prev,
            ichorShower: {
              currentPool: safeNumber(event.data?.currentPool, prev.ichorShower.currentPool),
              rumblesSinceLastTrigger: safeNumber(
                event.data?.rumblesSinceLastTrigger,
                prev.ichorShower.rumblesSinceLastTrigger,
              ),
            },
            slots: slots,
          };

        default:
          break;
      }

      slots[slotIdx] = slot;
      return { ...prev, slots };
    });
  }, []);

  // Connect SSE once for real-time updates.
  useEffect(() => {
    const es = connectSSE();
    return () => {
      es.close();
    };
  }, [connectSSE]);

  // Poll as a safety net:
  // - fast when SSE is down
  // - slower when SSE is healthy to reduce server/RPC load
  useEffect(() => {
    fetchStatus();
    const intervalMs = sseConnected ? 10_000 : 4_000;
    const pollInterval = setInterval(fetchStatus, intervalMs);
    return () => clearInterval(pollInterval);
  }, [fetchStatus, sseConnected]);

  // ---- Sound effects driven by state changes (works with polling + SSE) ----
  useEffect(() => {
    if (!status || !audioManager || audioManager.isMuted) return;

    for (const slot of status.slots) {
      const prev = prevSlotAudioState.current.get(slot.slotIndex);
      const currTurnCount = slot.turns?.length ?? 0;
      const currFighterCount = slot.fighters?.filter((f: any) => f.hp > 0).length ?? 0;

      if (!prev) {
        // First time seeing this slot — just record state, no sounds
        prevSlotAudioState.current.set(slot.slotIndex, {
          state: slot.state,
          turnCount: currTurnCount,
          fighterCount: currFighterCount,
        });
        continue;
      }

      // Combat just started
      if (prev.state !== "combat" && slot.state === "combat") {
        audioManager.init();
        audioManager.play("round_start");
      }

      // New turn(s) resolved — play hit sounds for the latest turn
      if (slot.state === "combat" && currTurnCount > prev.turnCount && slot.turns?.length > 0) {
        audioManager.init();
        const latestTurn = slot.turns[slot.turns.length - 1];
        const pairings = Array.isArray(latestTurn?.pairings) ? latestTurn.pairings : [];
        if (pairings.length > 0) {
          let best = pairings[0];
          let bestDmg = (best.damageToA ?? 0) + (best.damageToB ?? 0);
          for (let i = 1; i < pairings.length; i++) {
            const dmg = (pairings[i].damageToA ?? 0) + (pairings[i].damageToB ?? 0);
            if (dmg > bestDmg) { best = pairings[i]; bestDmg = dmg; }
          }
          audioManager.play(soundForPairing(best));
        }

        // KO sound for eliminations
        const elims = latestTurn?.eliminations;
        if (Array.isArray(elims) && elims.length > 0) {
          setTimeout(() => audioManager.play("ko_explosion"), 150);
        }
      }

      // Fighter count dropped (elimination detected even without turn data)
      if (slot.state === "combat" && currFighterCount < prev.fighterCount && currTurnCount === prev.turnCount) {
        audioManager.play("ko_explosion");
      }

      // Rumble complete / payout
      if ((prev.state === "combat" || prev.state === "betting") && slot.state === "payout") {
        audioManager.stopAmbient();
        audioManager.play("crowd_cheer");
      }

      // Slot recycled back to idle
      if (prev.state !== "idle" && slot.state === "idle") {
        audioManager.stopAmbient();
      }

      // Update tracked state
      prevSlotAudioState.current.set(slot.slotIndex, {
        state: slot.state,
        turnCount: currTurnCount,
        fighterCount: currFighterCount,
      });
    }
  }, [status]);

  // Wallet payout/claimable balance polling
  useEffect(() => {
    if (!publicKey) {
      setClaimBalance(null);
      setClaimError(null);
      setMyBetAmountsBySlot(new Map());
      return;
    }
    fetchClaimBalance();
    fetchMyBets();
    const interval = setInterval(() => {
      fetchClaimBalance();
      fetchMyBets();
    }, 12_000);
    return () => clearInterval(interval);
  }, [publicKey, fetchClaimBalance, fetchMyBets]);

  const decodeBase64Tx = (base64: string): Transaction => {
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return Transaction.from(bytes);
  };

  const handleClaimWinnings = useCallback(async () => {
    if (!publicKey || !signTransaction || !walletConnected) {
      setClaimError("Connect your wallet first.");
      return;
    }
    if (!claimBalance?.onchain_claim_ready || (claimBalance.onchain_claimable_sol_total ?? 0) <= 0) {
      setClaimError("No on-chain claimable payout is ready yet.");
      return;
    }

    setClaimPending(true);
    setClaimError(null);

    let totalClaimed = 0;
    let batchNum = 0;
    const MAX_BATCHES = 5;

    try {
      // Loop to claim all batches — Solana tx size limits mean we may need multiple txs
      while (batchNum < MAX_BATCHES) {
        batchNum++;

        const prepareRes = await fetch("/api/rumble/claim/prepare", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ wallet_address: publicKey.toBase58() }),
        });
        const prepared = await prepareRes.json();
        if (!prepareRes.ok) {
          // If nothing left to claim after first batch, that's success
          if (batchNum > 1 && (prepared?.reason === "none_ready" || prepared?.reason === "vaults_underfunded" || prepareRes.status === 404)) {
            break;
          }
          throw new Error(prepared?.error ?? "Failed to prepare claim transaction");
        }

        const claimCount = prepared.claim_count ?? 1;
        const skippedEligible = prepared.skipped_eligible_claims ?? 0;

        const tx = decodeBase64Tx(prepared.transaction_base64);
        tx.feePayer = publicKey;

        const signed = await signTransaction(tx);
        const rawTx = signed.serialize();
        const txSig = await connection.sendRawTransaction(rawTx, {
          skipPreflight: false,
          preflightCommitment: "processed",
        });

        // Don't block on confirmTransaction — devnet hangs for 30s+.
        // The confirm endpoint verifies the tx on-chain with retries.

        const confirmRes = await fetch("/api/rumble/claim/confirm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            wallet_address: publicKey.toBase58(),
            rumble_id: prepared.rumble_id,
            rumble_ids: Array.isArray(prepared.rumble_ids)
              ? prepared.rumble_ids
              : [prepared.rumble_id].filter(Boolean),
            tx_signature: txSig,
          }),
        });
        const confirmData = await confirmRes.json();
        if (!confirmRes.ok) {
          // If confirm fails but we already claimed some, report partial success
          if (totalClaimed > 0) {
            setClaimError(`Claimed ${totalClaimed} rumble(s). Remaining batch failed: ${confirmData?.error ?? "confirm error"}`);
            break;
          }
          throw new Error(confirmData?.error ?? "Failed to confirm claim");
        }

        totalClaimed += claimCount;

        // If no more skipped claims waiting, we're done
        if (skippedEligible <= 0) break;

        // Brief pause between batches to let on-chain state settle
        await new Promise(r => setTimeout(r, 2000));
      }

      await Promise.all([fetchClaimBalance(), fetchStatus()]);
      const newBalance = await connection.getBalance(publicKey, "confirmed");
      setSolBalance(newBalance / LAMPORTS_PER_SOL);
    } catch (e: any) {
      if (e?.message?.includes("User rejected")) {
        setClaimError(totalClaimed > 0
          ? `Claimed ${totalClaimed} rumble(s). Remaining canceled in wallet.`
          : "Claim canceled in wallet.");
      } else {
        setClaimError(totalClaimed > 0
          ? `Claimed ${totalClaimed} rumble(s). Error on next batch: ${e?.message ?? "unknown"}`
          : (e?.message ?? "Claim failed"));
      }
    } finally {
      setClaimPending(false);
    }
  }, [
    connection,
    claimBalance,
    fetchClaimBalance,
    fetchStatus,
    signTransaction,
    publicKey,
    walletConnected,
  ]);

  // Handle single or batched bet placement with one wallet tx.
  const submitBets = useCallback(async (
    slotIndex: number,
    bets: Array<{ fighterId: string; amount: number }>,
  ) => {
    if (!publicKey || !signTransaction || !walletConnected) {
      setBetError("Connect your wallet first to place bets.");
      setTimeout(() => setBetError(null), 5000);
      throw new Error("Wallet not connected");
    }
    if (!bets.length) {
      throw new Error("No bets selected.");
    }
    for (const bet of bets) {
      if (!Number.isFinite(bet.amount) || bet.amount <= 0 || bet.amount > 10) {
        setBetError("Each bet must be between 0.01 and 10 SOL");
        setTimeout(() => setBetError(null), 5000);
        throw new Error("Invalid amount");
      }
    }

    // 0. Pre-validate: check slot is still in betting state before sending SOL
    const slotData = status?.slots?.find((slot) => slot.slotIndex === slotIndex);
    if (!slotData || slotData.state !== "betting") {
      setBetError("Betting is not open for this slot right now.");
      setTimeout(() => setBetError(null), 5000);
      throw new Error("Betting closed");
    }
    for (const bet of bets) {
      const fighterInSlot = slotData.fighters?.some(
        (f: any) => f.id === bet.fighterId || f.fighterId === bet.fighterId
      );
      if (!fighterInSlot) {
        setBetError("One or more selected fighters are not in the current rumble.");
        setTimeout(() => setBetError(null), 5000);
        throw new Error("Fighter not in rumble");
      }
    }

    setBetPending(true);
    try {
      // 1) Build on-chain place_bet tx (single or batch).
      const prepareRes = await fetch("/api/rumble/bet/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slot_index: slotIndex,
          wallet_address: publicKey.toBase58(),
          bets: bets.map((b) => ({
            fighter_id: b.fighterId,
            sol_amount: b.amount,
          })),
        }),
      });
      const prepared = await prepareRes.json();
      if (!prepareRes.ok) {
        throw new Error(prepared?.error ?? "Failed to prepare bet transaction");
      }
      const onchainDeadlineMs =
        prepared?.onchain_betting_deadline
          ? new Date(String(prepared.onchain_betting_deadline)).getTime()
          : Number.NaN;
      const closeGuardMs =
        Number.isFinite(Number(prepared?.guard_ms)) && Number(prepared.guard_ms) > 0
          ? Number(prepared.guard_ms)
          : CLIENT_BET_CLOSE_GUARD_MS;
      if (Number.isFinite(onchainDeadlineMs) && Date.now() >= onchainDeadlineMs - closeGuardMs) {
        throw new Error("Betting just closed on-chain. Wait for the next rumble.");
      }

      const tx = decodeBase64Tx(prepared.transaction_base64);
      tx.feePayer = publicKey;

      const closeSlotRaw = Number(prepared?.onchain_betting_close_slot);
      const guardSlotsRaw = Number(prepared?.guard_slots);
      const shouldCheckCloseSlot =
        Number.isFinite(closeSlotRaw) && closeSlotRaw > 0 && Number.isFinite(guardSlotsRaw) && guardSlotsRaw >= 0;
      const assertWindowStillOpen = async () => {
        if (!shouldCheckCloseSlot) return;
        const latestSlot = await connection.getSlot("processed");
        if (latestSlot + guardSlotsRaw >= closeSlotRaw) {
          throw new Error("Betting just closed on-chain. Wait for the next rumble.");
        }
      };

      // Re-check immediately before signing and sending to reduce prepare->send race.
      await assertWindowStillOpen();

      // 2) Sign with wallet
      const signed = await signTransaction(tx);

      await assertWindowStillOpen();

      // 3) Send to Solana (fire-and-forget — don't block on confirmation)
      const rawTx = signed.serialize();
      const txSig = await connection.sendRawTransaction(rawTx, {
        skipPreflight: false,
        preflightCommitment: "processed",
      });

      // 4) Register bet immediately — the API verifies the tx on-chain.
      //    Blocking on confirmTransaction hangs the UI on devnet (30s+ timeouts).
      const preparedLegs: Array<{
        fighter_id: string;
        fighter_index?: number;
        sol_amount: number;
      }> =
        Array.isArray(prepared?.bets) && prepared.bets.length > 0
          ? prepared.bets
          : bets.map((b) => ({ fighter_id: b.fighterId, sol_amount: b.amount }));
      const res = await fetch("/api/rumble/bet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slot_index: slotIndex,
          fighter_id: preparedLegs[0]?.fighter_id,
          sol_amount: preparedLegs[0]?.sol_amount,
          bets: preparedLegs,
          wallet_address: publicKey.toBase58(),
          tx_signature: txSig,
          tx_kind: prepared.tx_kind ?? "rumble_place_bet",
          rumble_id: prepared.rumble_id,
          fighter_index: preparedLegs[0]?.fighter_index ?? prepared.fighter_index,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        setBetError(data.error || "Bet registered on-chain but API failed");
        setTimeout(() => setBetError(null), 5000);
        return;
      }

      // Optimistic local update for clear "your stake" UI.
      // Set grace period so polling/fetchMyBets won't overwrite with stale server data
      optimisticBetUntilRef.current = Date.now() + 45_000;
      setMyBetAmountsBySlot((prev) => {
        const next = new Map(prev);
        const existing = new Map(next.get(slotIndex) ?? new Map<string, number>());
        for (const leg of preparedLegs) {
          const fighter = String(leg.fighter_id);
          const amount = Number(leg.sol_amount ?? 0);
          if (!Number.isFinite(amount) || amount <= 0) continue;
          existing.set(fighter, (existing.get(fighter) ?? 0) + amount);
        }
        next.set(slotIndex, existing);
        return next;
      });

      // Refresh status + balance immediately, but delay fetchMyBets
      // to give the DB/chain time to propagate the new bet
      fetchStatus();
      fetchClaimBalance();
      setTimeout(() => fetchMyBets(), 4_000);
      const newBalance = await connection.getBalance(publicKey, "confirmed");
      setSolBalance(newBalance / LAMPORTS_PER_SOL);

      return txSig;
    } catch (e: any) {
      const message = String(e?.message ?? "");
      if (message.includes("User rejected")) {
        // User cancelled in wallet, no alert needed
      } else if (
        message.includes("BettingClosed") ||
        message.includes("0x1771") ||
        message.includes("On-chain betting is closed")
      ) {
        fetchStatus();
        setBetError("Betting just closed on-chain for that rumble. No bet was placed.");
        setTimeout(() => setBetError(null), 5000);
      } else {
        console.error("Failed to place bet:", e);
        setBetError(message || "Failed to place bet");
        setTimeout(() => setBetError(null), 5000);
      }
    } finally {
      setBetPending(false);
    }
  }, [
    connection,
    fetchClaimBalance,
    fetchMyBets,
    fetchStatus,
    signTransaction,
    publicKey,
    status?.slots,
    walletConnected,
  ]);

  const handlePlaceBet = useCallback(async (
    slotIndex: number,
    fighterId: string,
    amount: number,
  ): Promise<string | undefined> => {
    return await submitBets(slotIndex, [{ fighterId, amount }]);
  }, [submitBets]);

  const handlePlaceBatchBet = useCallback(async (
    slotIndex: number,
    bets: Array<{ fighterId: string; amount: number }>,
  ): Promise<string | undefined> => {
    return await submitBets(slotIndex, bets);
  }, [submitBets]);

  const ichorShower = status?.ichorShower ?? {
    currentPool: 0,
    rumblesSinceLastTrigger: 0,
  };

  return (
    <main className="relative flex flex-col min-h-screen text-stone-200">
      {/* Background */}
      <div
        className="fixed inset-0 z-0 animate-breathe"
        style={{
          backgroundImage: "url('/rumble-arena.webp')",
          backgroundSize: "cover",
          backgroundPosition: "center",
          backgroundAttachment: "fixed",
        }}
      >
        <div className="absolute inset-0 bg-stone-950/90"></div>
      </div>

      {/* Content */}
      <div className="relative z-10 w-full">
        {/* Header */}
        <header className="border-b border-stone-800 bg-stone-950/80 backdrop-blur-sm">
          <div className="max-w-[1600px] mx-auto px-4 py-3 flex flex-col lg:grid lg:grid-cols-3 items-center gap-3 lg:gap-0">
            {/* Left — Home */}
            <div className="flex items-center w-full justify-center lg:justify-start order-2 lg:order-1">
              <Link
                href="/"
                className="text-stone-500 hover:text-amber-400 font-mono text-xs uppercase tracking-wider transition-colors"
              >
                [ HOME ]
              </Link>
            </div>

            {/* Center — RUMBLE title */}
            <div className="text-center order-1 lg:order-2 w-full">
              <h1 className="font-fight-glow text-3xl text-amber-400">
                RUMBLE
              </h1>
              <p className="font-mono text-[10px] text-stone-600 hidden sm:block">
                BATTLE ROYALE // 8-16 FIGHTERS // LAST BOT STANDING
              </p>
            </div>

            {/* Right — Controls */}
            <div className="flex items-center gap-2 sm:gap-3 justify-center lg:justify-end order-3 w-full flex-wrap">
              {/* AI Commentary */}
              <CommentaryPlayer
                slots={Array.isArray(status?.slots) ? status.slots : []}
                lastEvent={lastSseEvent}
                eventSeq={sseEventSeq}
              />

              {/* Connection indicator */}
              <div className="flex items-center gap-1.5">
                <span
                  className={`inline-block w-2 h-2 rounded-sm ${sseConnected ? "bg-green-500" : "bg-amber-500 animate-pulse"
                    }`}
                />
                <span className="font-mono text-[10px] text-stone-500">
                  {sseConnected ? "LIVE" : "POLLING"}
                </span>
              </div>

              {/* Wallet */}
              {walletConnected && publicKey ? (
                <div className="flex items-center gap-2 bg-stone-900/80 border border-stone-700 rounded-sm px-2 py-1">
                  {wallet?.adapter?.icon && (
                    <img
                      src={wallet.adapter.icon}
                      alt={wallet.adapter.name}
                      title={wallet.adapter.name}
                      className="w-4 h-4"
                    />
                  )}
                  <span className="font-mono text-[10px] text-stone-400">
                    {solBalance !== null ? `${solBalance.toFixed(3)} SOL` : "..."}
                  </span>
                  <span className="font-mono text-[10px] text-amber-400 max-w-[80px] sm:max-w-none truncate">
                    {publicKey.toBase58().slice(0, 4)}...{publicKey.toBase58().slice(-4)}
                  </span>
                  <button
                    onClick={disconnectWallet}
                    className="font-mono text-[10px] text-stone-600 hover:text-red-400 ml-1"
                  >
                    [X]
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setWalletModalVisible(true)}
                  className="px-3 py-1 bg-amber-600 hover:bg-amber-500 text-stone-950 font-mono text-xs font-bold rounded-sm transition-all active:scale-95"
                >
                  Connect Wallet
                </button>
              )}
            </div>
          </div>
        </header>

        {/* Main Layout */}
        <div className="max-w-[1600px] mx-auto px-4 py-6 pb-24 lg:pb-6">
          {loading ? (
            <div className="flex gap-6 justify-center">
              <div className="flex-1 max-w-4xl">
                <div className="h-[400px] bg-stone-900/50 border border-stone-800 rounded-sm animate-pulse" />
              </div>
              <div className="w-64 flex-shrink-0 space-y-4 hidden lg:block">
                <div className="h-48 bg-stone-900/50 border border-stone-800 rounded-sm animate-pulse" />
                <div className="h-32 bg-stone-900/50 border border-stone-800 rounded-sm animate-pulse" />
              </div>
            </div>
          ) : error && !status ? (
            <div className="flex items-center justify-center h-64">
              <div className="text-center bg-stone-900/80 border border-red-800/50 rounded-sm p-6">
                <p className="font-mono text-red-400 text-sm">{error}</p>
                <p className="font-mono text-xs text-stone-600 mt-2">
                  Rumble API not yet available. Check back soon.
                </p>
                <button
                  onClick={fetchStatus}
                  className="mt-4 px-4 py-2 bg-stone-800 hover:bg-stone-700 text-stone-300 font-mono text-xs border border-stone-700 transition-all"
                >
                  RETRY
                </button>
              </div>
            </div>
          ) : (
            (() => {
              // Pick the most interesting slot to feature
              const STATE_PRIORITY: Record<string, number> = { combat: 0, payout: 1, betting: 2, idle: 3 };
              const slots = status?.slots ?? [];
              const sorted = [...slots].sort(
                (a, b) => (STATE_PRIORITY[a.state] ?? 9) - (STATE_PRIORITY[b.state] ?? 9),
              );
              const featured = sorted[0] as SlotData | undefined;
              const allIdle = !featured || featured.state === "idle";

              return (
                <div className="flex gap-6 justify-center">
                  {/* Left Sidebar: Chat */}
                  <div className={`flex-shrink-0 w-full xl:w-72 ${mobileTab === 'chat' ? 'block lg:hidden xl:block' : 'hidden xl:block'}`}>
                    <div className="animate-fade-in-up h-full lg:sticky lg:top-6">
                      <ChatPanel walletAddress={publicKey?.toBase58() ?? null} />
                    </div>
                  </div>

                  {betError && (
                    <div className="fixed bottom-4 right-4 z-50 bg-red-900/90 border border-red-600 text-red-300 font-mono text-xs px-4 py-2 rounded-sm shadow-lg animate-fade-in-up">
                      {betError}
                    </div>
                  )}

                  {/* Main content: Single featured rumble */}
                  <div className={`flex-1 max-w-4xl w-full ${mobileTab === 'arena' ? 'block lg:block' : 'hidden lg:block'}`}>
                    {/* Slot selector pills (only if multiple active) */}
                    {slots.filter((s) => s.state !== "idle").length > 1 && (
                      <div className="flex items-center gap-2 mb-3">
                        {slots
                          .filter((s) => s.state !== "idle")
                          .map((s) => {
                            const active = s.slotIndex === featured?.slotIndex;
                            const stateColor =
                              s.state === "combat"
                                ? "border-red-600 text-red-400"
                                : s.state === "betting"
                                  ? "border-amber-600 text-amber-400"
                                  : "border-green-600 text-green-400";
                            return (
                              <button
                                key={s.slotIndex}
                                onClick={() => {
                                  // Scroll to ensure visible — slot auto-selected by priority
                                }}
                                className={`font-mono text-[10px] px-2 py-0.5 border rounded-sm transition-all ${active
                                  ? `${stateColor} bg-stone-900/80`
                                  : "border-stone-700 text-stone-500 hover:text-stone-300"
                                  }`}
                              >
                                SLOT {s.slotIndex + 1} [{s.state.toUpperCase()}]
                              </button>
                            );
                          })}
                      </div>
                    )}

                    {/* Arena preview when idle */}
                    {allIdle ? (
                      <div className="relative rounded-sm overflow-hidden border border-stone-800 bg-stone-950/60">
                        <div className="relative">
                          <img
                            src="/rumble-arena.webp"
                            alt="UCF Rumble Arena"
                            className="w-full h-auto max-h-[520px] object-contain mx-auto opacity-70"
                          />
                          <div className="absolute inset-0 bg-gradient-to-t from-stone-950 via-stone-950/40 to-transparent" />
                          <div className="absolute inset-0 flex flex-col items-center justify-end pb-8">
                            <h2 className="font-fight-glow text-3xl text-amber-400 mb-2 animate-pulse-slow">
                              THE CAGE AWAITS
                            </h2>
                            <p className="font-mono text-sm text-stone-400 mb-1">
                              {status?.queueLength
                                ? `${status.queueLength} fighter${status.queueLength !== 1 ? "s" : ""} in queue`
                                : "No fighters queued"}
                            </p>
                            <p className="font-mono text-[10px] text-stone-600">
                              {status?.queueLength && status.queueLength >= 8
                                ? "NEXT RUMBLE STARTING SOON"
                                : "Need 8+ fighters to start a rumble"}
                            </p>
                          </div>
                        </div>

                        {/* Show last completed result if available */}
                        {(() => {
                          const lastResult = lastCompletedBySlot.size > 0
                            ? [...lastCompletedBySlot.values()][0]
                            : null;
                          if (!lastResult) return null;
                          return (
                            <div className="p-4 border-t border-stone-800">
                              <p className="font-mono text-[10px] text-stone-500 uppercase mb-2">
                                Last Rumble Result
                              </p>
                              <PayoutDisplay
                                placements={lastResult.placements}
                                payout={lastResult.payout}
                                myBetFighterIds={lastResult.myBetFighterIds?.length
                                  ? new Set(lastResult.myBetFighterIds)
                                  : undefined}
                              />
                            </div>
                          );
                        })()}
                      </div>
                    ) : featured ? (
                      <RumbleSlot
                        slot={featured}
                        onPlaceBet={handlePlaceBet}
                        onPlaceBatchBet={handlePlaceBatchBet}
                        myBetAmounts={myBetAmountsBySlot.get(featured.slotIndex)}
                        lastCompletedResult={lastCompletedBySlot.get(featured.slotIndex)}
                      />
                    ) : null}
                  </div>

                  {/* Sidebar: Queue + Ichor Shower */}
                  <div className={`flex-shrink-0 space-y-4 w-full lg:w-64 ${mobileTab === 'queue' ? 'block lg:block' : 'hidden lg:block'}`}>
                    {walletConnected && (
                      <div className="animate-fade-in-up">
                        <ClaimBalancePanel
                          balance={claimBalance}
                          loading={claimLoading}
                          pending={claimPending}
                          error={claimError}
                          onClaim={handleClaimWinnings}
                        />
                      </div>
                    )}

                    <div className="animate-fade-in-up" style={{ animationDelay: '100ms', animationFillMode: 'both' }}>
                      <QueueSidebar
                        queue={status?.queue ?? []}
                        totalLength={status?.queueLength ?? 0}
                        nextRumbleIn={status?.nextRumbleIn ?? null}
                      />
                    </div>

                    <div className="animate-fade-in-up" style={{ animationDelay: '200ms', animationFillMode: 'both' }}>
                      <IchorShowerPool
                        currentPool={ichorShower.currentPool}
                      />
                    </div>
                  </div>
                </div>
              );
            })()
          )}
        </div>

      </div>

      {/* Mobile Bottom Navigation */}
      <div className="lg:hidden fixed bottom-0 left-0 right-0 z-50 bg-stone-950/95 border-t border-stone-800 backdrop-blur-md pb-safe">
        <div className="flex justify-around items-center h-16 px-2">
          <button
            onClick={() => setMobileTab("arena")}
            className={`flex flex-col items-center justify-center w-full h-full space-y-1 transition-colors ${mobileTab === "arena" ? "text-amber-400" : "text-stone-500 hover:text-stone-300"
              }`}
          >
            <BoltIcon className="w-6 h-6" />
            <span className="font-mono text-[10px] tracking-widest">ARENA</span>
          </button>
          <button
            onClick={() => setMobileTab("chat")}
            className={`flex flex-col items-center justify-center w-full h-full space-y-1 transition-colors ${mobileTab === "chat" ? "text-amber-400" : "text-stone-500 hover:text-stone-300"
              }`}
          >
            <ChatBubbleLeftRightIcon className="w-6 h-6" />
            <span className="font-mono text-[10px] tracking-widest">CHAT</span>
          </button>
          <button
            onClick={() => setMobileTab("queue")}
            className={`flex flex-col items-center justify-center w-full h-full space-y-1 transition-colors ${mobileTab === "queue" ? "text-amber-400" : "text-stone-500 hover:text-stone-300"
              }`}
          >
            <ListBulletIcon className="w-6 h-6" />
            <span className="font-mono text-[10px] tracking-widest">QUEUE</span>
          </button>
        </div>
      </div>

      {/* Footer */}
      <footer className="border-t border-stone-800 bg-stone-950/80 backdrop-blur-sm">
        <div className="max-w-[1600px] mx-auto px-4 py-3 flex items-center justify-between">
          <p className="font-mono text-[10px] text-stone-600">
              // UNDERGROUND CLAW FIGHTS //
          </p>
          <p className="font-mono text-[10px] text-stone-600">
              // RUMBLE: BATTLE ROYALE MODE //
          </p>
        </div>
      </footer>
    </div>
    </main >
  );
}
