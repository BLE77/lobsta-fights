"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import {
  PublicKey,
  Transaction,
  LAMPORTS_PER_SOL,
  Connection,
} from "@solana/web3.js";
import RumbleSlot, { SlotData } from "./components/RumbleSlot";
import PayoutDisplay from "./components/PayoutDisplay";
import QueueSidebar from "./components/QueueSidebar";
import IchorShowerPool from "./components/IchorShowerPool";
import ClaimBalancePanel from "./components/ClaimBalancePanel";
import CommentaryPlayer from "./components/CommentaryPlayer";
import type { CommentarySSEEvent } from "~~/lib/commentary";

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
  placements: Array<{
    fighterId: string;
    fighterName: string;
    imageUrl: string | null;
    placement: number;
    hp: number;
    damageDealt: number;
  }>;
  payout: NonNullable<SlotData["payout"]>;
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
  const [solBalance, setSolBalance] = useState<number | null>(null);
  const [claimBalance, setClaimBalance] = useState<ClaimBalanceStatus | null>(null);
  const [claimLoading, setClaimLoading] = useState(false);
  const [claimPending, setClaimPending] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const [lastSseEvent, setLastSseEvent] = useState<CommentarySSEEvent | null>(null);
  const [sseEventSeq, setSseEventSeq] = useState(0);
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
    } catch {}
    return new Map();
  });

  // Track user stake per fighter per slot.
  // Map<slotIndex, Map<fighterId, totalSolStaked>>
  const [myBetAmountsBySlot, setMyBetAmountsBySlot] = useState<Map<number, Map<string, number>>>(new Map());
  const claimFetchInFlightRef = useRef(false);
  const claimBalanceRef = useRef<ClaimBalanceStatus | null>(null);

  // ---- Direct Phantom wallet management (no wallet adapter) ----
  const [phantomProvider, setPhantomProvider] = useState<any>(null);
  const [publicKey, setPublicKey] = useState<PublicKey | null>(null);
  const walletConnected = !!publicKey;

  // RPC connection
  const rpcEndpoint = process.env.NEXT_PUBLIC_HELIUS_API_KEY
    ? `https://devnet.helius-rpc.com/?api-key=${process.env.NEXT_PUBLIC_HELIUS_API_KEY}`
    : "https://api.devnet.solana.com";
  const connectionRef = useRef(new Connection(rpcEndpoint, "confirmed"));
  const connection = connectionRef.current;

  // Detect Phantom on mount
  useEffect(() => {
    const checkPhantom = () => {
      const provider = (window as any).phantom?.solana;
      if (provider?.isPhantom) {
        setPhantomProvider(provider);
        // Check if already connected (eager connect)
        if (provider.isConnected && provider.publicKey) {
          setPublicKey(new PublicKey(provider.publicKey.toString()));
        }
        // Listen for account changes
        provider.on("accountChanged", (pk: any) => {
          if (pk) {
            setPublicKey(new PublicKey(pk.toString()));
          } else {
            setPublicKey(null);
          }
        });
        provider.on("disconnect", () => setPublicKey(null));
      }
    };
    // Phantom injects after page load, so check with a small delay too
    checkPhantom();
    const timer = setTimeout(checkPhantom, 500);
    return () => clearTimeout(timer);
  }, []);

  const connectPhantom = useCallback(async () => {
    const provider = phantomProvider || (window as any).phantom?.solana;
    if (!provider?.isPhantom) {
      window.open("https://phantom.app/", "_blank");
      return;
    }
    try {
      const resp = await provider.connect();
      setPublicKey(new PublicKey(resp.publicKey.toString()));
      setPhantomProvider(provider);
    } catch (e: any) {
      console.error("Phantom connect failed:", e);
    }
  }, [phantomProvider]);

  const disconnectWallet = useCallback(async () => {
    if (phantomProvider) {
      await phantomProvider.disconnect();
    }
    setPublicKey(null);
    setSolBalance(null);
    setClaimBalance(null);
    setClaimError(null);
  }, [phantomProvider]);

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

  // Fetch full status via polling
  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`/api/rumble/status?_t=${Date.now()}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`Status ${res.status}`);
      const raw = await res.json();
      const data = normalizeStatusPayload(raw);
      setStatus(data);
      setError(null);

      // Keep the latest completed payout visible while slots wait for the next fighters.
      setLastCompletedBySlot((prev) => {
        let changed = false;
        const next = new Map(prev);
        for (const slot of data.slots) {
          if (slot.state === "betting" || slot.state === "combat") {
            if (next.delete(slot.slotIndex)) {
              changed = true;
            }
            continue;
          }

          const completed = buildLastCompletedResult(slot);
          if (!completed) continue;
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
            } catch {}
          }
        }
        return changed ? next : prev;
      });

      // Clear local bet-tracking for slots that returned to idle.
      setMyBetAmountsBySlot((prev) => {
        let changed = false;
        const next = new Map(prev);
        for (const slot of data.slots) {
          if (slot.state === "idle" && next.has(slot.slotIndex)) {
            next.delete(slot.slotIndex);
            changed = true;
          }
        }
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
      setMyBetAmountsBySlot(next);
    } catch {
      // keep last known values on transient errors
    }
  }, [publicKey]);

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
          break;
        }

        case "elimination":
        case "fighter_eliminated":
          // Elimination details are reflected from polled status snapshots.
          break;

        case "betting_open":
          slot.state = "betting";
          slot.rumbleId = typeof event.data?.rumbleId === "string" ? event.data.rumbleId : slot.rumbleId;
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
          break;

        case "payout_complete":
          slot.state = "payout";
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

  // Initialize: poll + SSE
  useEffect(() => {
    fetchStatus();

    // Poll every 2 seconds as fallback
    const pollInterval = setInterval(fetchStatus, 2000);

    // Connect SSE for real-time updates
    const es = connectSSE();

    return () => {
      clearInterval(pollInterval);
      es.close();
    };
  }, [fetchStatus, connectSSE]);

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
    if (!publicKey || !phantomProvider || !walletConnected) {
      setClaimError("Connect your Phantom wallet first.");
      return;
    }
    if (!claimBalance?.onchain_claim_ready || (claimBalance.onchain_claimable_sol_total ?? 0) <= 0) {
      setClaimError("No on-chain claimable payout is ready yet.");
      return;
    }

    setClaimPending(true);
    setClaimError(null);

    try {
      const prepareRes = await fetch("/api/rumble/claim/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet_address: publicKey.toBase58() }),
      });
      const prepared = await prepareRes.json();
      if (!prepareRes.ok) {
        throw new Error(prepared?.error ?? "Failed to prepare claim transaction");
      }

      const tx = decodeBase64Tx(prepared.transaction_base64);
      tx.feePayer = publicKey;

      const signed = await phantomProvider.signTransaction(tx);
      const rawTx = signed.serialize();
      const txSig = await connection.sendRawTransaction(rawTx, {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });

      let blockhash = tx.recentBlockhash;
      let lastValidBlockHeight = tx.lastValidBlockHeight;
      if (!blockhash || typeof lastValidBlockHeight !== "number") {
        const latest = await connection.getLatestBlockhash("confirmed");
        blockhash = latest.blockhash;
        lastValidBlockHeight = latest.lastValidBlockHeight;
      }

      await connection.confirmTransaction(
        {
          signature: txSig,
          blockhash,
          lastValidBlockHeight,
        },
        "confirmed",
      );

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
        throw new Error(confirmData?.error ?? "Failed to confirm claim");
      }

      await Promise.all([fetchClaimBalance(), fetchStatus()]);
      const newBalance = await connection.getBalance(publicKey, "confirmed");
      setSolBalance(newBalance / LAMPORTS_PER_SOL);
    } catch (e: any) {
      if (e?.message?.includes("User rejected")) {
        setClaimError("Claim canceled in wallet.");
      } else {
        setClaimError(e?.message ?? "Claim failed");
      }
    } finally {
      setClaimPending(false);
    }
  }, [
    connection,
    claimBalance,
    fetchClaimBalance,
    fetchStatus,
    phantomProvider,
    publicKey,
    walletConnected,
  ]);

  // Handle single or batched bet placement with one wallet tx.
  const submitBets = useCallback(async (
    slotIndex: number,
    bets: Array<{ fighterId: string; amount: number }>,
  ) => {
    if (!publicKey || !phantomProvider || !walletConnected) {
      alert("Connect your Phantom wallet first to place bets.");
      throw new Error("Wallet not connected");
    }
    if (!bets.length) {
      throw new Error("No bets selected.");
    }
    for (const bet of bets) {
      if (!Number.isFinite(bet.amount) || bet.amount <= 0 || bet.amount > 10) {
        alert("Each bet must be between 0.01 and 10 SOL");
        throw new Error("Invalid amount");
      }
    }

    // 0. Pre-validate: check slot is still in betting state before sending SOL
    const slotData = status?.slots?.find((slot) => slot.slotIndex === slotIndex);
    if (!slotData || slotData.state !== "betting") {
      alert("Betting is not open for this slot right now.");
      throw new Error("Betting closed");
    }
    for (const bet of bets) {
      const fighterInSlot = slotData.fighters?.some(
        (f: any) => f.id === bet.fighterId || f.fighterId === bet.fighterId
      );
      if (!fighterInSlot) {
        alert("One or more selected fighters are not in the current rumble.");
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

      // 2) Sign with Phantom
      const signed = await phantomProvider.signTransaction(tx);

      await assertWindowStillOpen();

      // 3) Send to Solana
      const rawTx = signed.serialize();
      const txSig = await connection.sendRawTransaction(rawTx, {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });

      // 4) Wait for confirmation
      let blockhash = tx.recentBlockhash;
      let lastValidBlockHeight = tx.lastValidBlockHeight;
      if (!blockhash || typeof lastValidBlockHeight !== "number") {
        const latest = await connection.getLatestBlockhash("confirmed");
        blockhash = latest.blockhash;
        lastValidBlockHeight = latest.lastValidBlockHeight;
      }
      await connection.confirmTransaction(
        { signature: txSig, blockhash, lastValidBlockHeight },
        "confirmed",
      );

      // 5) Register all bet legs in off-chain orchestrator/persistence.
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
        alert(data.error || "Bet registered on-chain but API failed");
        return;
      }

      // Optimistic local update for clear "your stake" UI.
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

      // Refresh status + balance
      fetchStatus();
      fetchClaimBalance();
      fetchMyBets();
      const newBalance = await connection.getBalance(publicKey, "confirmed");
      setSolBalance(newBalance / LAMPORTS_PER_SOL);
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
        alert("Betting just closed on-chain for that rumble. No bet was placed.");
      } else {
        console.error("Failed to place bet:", e);
        alert(message || "Failed to place bet");
      }
    } finally {
      setBetPending(false);
    }
  }, [
    connection,
    fetchClaimBalance,
    fetchMyBets,
    fetchStatus,
    phantomProvider,
    publicKey,
    status?.slots,
    walletConnected,
  ]);

  const handlePlaceBet = useCallback(async (
    slotIndex: number,
    fighterId: string,
    amount: number,
  ) => {
    await submitBets(slotIndex, [{ fighterId, amount }]);
  }, [submitBets]);

  const handlePlaceBatchBet = useCallback(async (
    slotIndex: number,
    bets: Array<{ fighterId: string; amount: number }>,
  ) => {
    await submitBets(slotIndex, bets);
  }, [submitBets]);

  const ichorShower = status?.ichorShower ?? {
    currentPool: 0,
    rumblesSinceLastTrigger: 0,
  };

  return (
    <main className="relative flex flex-col min-h-screen text-stone-200">
      {/* Background */}
      <div
        className="fixed inset-0 z-0"
        style={{
          backgroundImage: "url('/rumble-arena.png')",
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
          <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Link
                href="/"
                className="text-amber-500 hover:text-amber-400 font-mono text-sm"
              >
                &lt; UCF
              </Link>
              <Link
                href="/admin"
                className="text-stone-500 hover:text-amber-400 font-mono text-[10px] border border-stone-700 hover:border-amber-700 px-2 py-0.5 rounded-sm transition-colors"
              >
                ADMIN
              </Link>
              <div>
                <h1 className="font-fight-glow text-2xl text-amber-400">
                  RUMBLE
                </h1>
                <p className="font-mono text-[10px] text-stone-600">
                  BATTLE ROYALE // 8-16 FIGHTERS // LAST BOT STANDING
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              {/* AI Commentary */}
              <CommentaryPlayer
                slots={Array.isArray(status?.slots) ? status.slots : []}
                lastEvent={lastSseEvent}
                eventSeq={sseEventSeq}
              />

              {/* Connection indicator */}
              <div className="flex items-center gap-1.5">
                <span
                  className={`inline-block w-2 h-2 rounded-full ${
                    sseConnected ? "bg-green-500" : "bg-red-500 animate-pulse"
                  }`}
                />
                <span className="font-mono text-[10px] text-stone-500">
                  {sseConnected ? "LIVE" : "POLLING"}
                </span>
              </div>

              {/* Wallet */}
              {walletConnected && publicKey ? (
                <div className="flex items-center gap-2 bg-stone-900/80 border border-stone-700 rounded-sm px-2 py-1">
                  <span className="font-mono text-[10px] text-stone-400">
                    {solBalance !== null ? `${solBalance.toFixed(3)} SOL` : "..."}
                  </span>
                  <span className="font-mono text-[10px] text-amber-400">
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
                  onClick={connectPhantom}
                  className="px-3 py-1 bg-amber-600 hover:bg-amber-500 text-stone-950 font-mono text-xs font-bold rounded-sm transition-all"
                >
                  {phantomProvider ? "Connect Phantom" : "Install Phantom"}
                </button>
              )}

            </div>
          </div>
        </header>

        {/* Main Layout */}
        <div className="max-w-7xl mx-auto px-4 py-6">
          {loading ? (
            <div className="flex items-center justify-center h-64">
              <div className="text-center">
                <p className="font-mono text-amber-500 text-lg animate-pulse">
                  Loading Rumble Arena...
                </p>
                <p className="font-mono text-xs text-stone-600 mt-2">
                  Connecting to battle feed
                </p>
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
              const STATE_PRIORITY: Record<string, number> = { combat: 0, betting: 1, payout: 2, idle: 3 };
              const slots = status?.slots ?? [];
              const sorted = [...slots].sort(
                (a, b) => (STATE_PRIORITY[a.state] ?? 9) - (STATE_PRIORITY[b.state] ?? 9),
              );
              const featured = sorted[0] as SlotData | undefined;
              const allIdle = !featured || featured.state === "idle";

              return (
                <div className="flex gap-6">
                  {/* Main content: Single featured rumble */}
                  <div className="flex-1">
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
                                className={`font-mono text-[10px] px-2 py-0.5 border rounded-sm transition-all ${
                                  active
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
                            src="/rumble-arena.png"
                            alt="UCF Rumble Arena"
                            className="w-full h-auto max-h-[420px] object-contain mx-auto opacity-70"
                          />
                          <div className="absolute inset-0 bg-gradient-to-t from-stone-950 via-stone-950/40 to-transparent" />
                          <div className="absolute inset-0 flex flex-col items-center justify-end pb-8">
                            <h2 className="font-fight-glow text-3xl text-amber-400 mb-2">
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
                                myBetFighterIds={undefined}
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
                  <div className="w-64 flex-shrink-0 space-y-4 hidden lg:block">
                    {walletConnected && (
                      <ClaimBalancePanel
                        balance={claimBalance}
                        loading={claimLoading}
                        pending={claimPending}
                        error={claimError}
                        onClaim={handleClaimWinnings}
                      />
                    )}

                    <QueueSidebar
                      queue={status?.queue ?? []}
                      totalLength={status?.queueLength ?? 0}
                      nextRumbleIn={status?.nextRumbleIn ?? null}
                    />

                    <IchorShowerPool
                      currentPool={ichorShower.currentPool}
                    />
                  </div>
                </div>
              );
            })()
          )}
        </div>

        {/* Mobile sidebar (below slots) */}
        <div className="lg:hidden max-w-7xl mx-auto px-4 pb-6 space-y-4">
          {status && (
            <>
              {walletConnected && (
                <ClaimBalancePanel
                  balance={claimBalance}
                  loading={claimLoading}
                  pending={claimPending}
                  error={claimError}
                  onClaim={handleClaimWinnings}
                />
              )}
              <QueueSidebar
                queue={status.queue}
                totalLength={status.queueLength}
                nextRumbleIn={status.nextRumbleIn}
              />
              <IchorShowerPool
                currentPool={ichorShower.currentPool}
              />
            </>
          )}
        </div>

        {/* Footer */}
        <footer className="border-t border-stone-800 bg-stone-950/80 backdrop-blur-sm">
          <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
            <p className="font-mono text-[10px] text-stone-600">
              // POLLING EVERY 2s + SSE LIVE FEED //
            </p>
            <p className="font-mono text-[10px] text-stone-600">
              // RUMBLE: BATTLE ROYALE MODE //
            </p>
          </div>
        </footer>
      </div>
    </main>
  );
}
