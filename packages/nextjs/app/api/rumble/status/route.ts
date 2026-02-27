import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getOrchestrator } from "~~/lib/rumble-orchestrator";
import { getQueueManager } from "~~/lib/queue-manager";
import { hasRecovered, recoverOrchestratorState } from "~~/lib/rumble-state-recovery";
import { ensureRumblePublicHeartbeat } from "~~/lib/rumble-public-heartbeat";
import { checkRateLimit, getRateLimitKey, rateLimitResponse } from "~~/lib/rate-limit";
import {
  loadQueueState,
  loadActiveRumbles,
  loadRumbleTurnLog,
  loadPayoutResult,
  getIchorShowerState,
  getStats,
} from "~~/lib/rumble-persistence";
import { readArenaConfig, readRumbleAccountState, readRumbleCombatState } from "~~/lib/solana-programs";
import { parseOnchainRumbleIdNumber } from "~~/lib/rumble-id";
import { getConnection, getRpcEndpoint } from "~~/lib/solana-connection";
import { getCommentaryForRumble } from "~~/lib/commentary-hook";
import { MAX_TURNS } from "~~/lib/rumble-engine";

export const dynamic = "force-dynamic";
const SLOT_MS_ESTIMATE = Math.max(250, Number(process.env.RUMBLE_SLOT_MS_ESTIMATE ?? "400"));
const ONCHAIN_DEADLINE_UNIX_SLOT_GAP_THRESHOLD = 5_000_000n;
// Fallback betting duration for Vercel cold-start when on-chain account isn't readable yet.
// This gives users a visible "Betting Open" window while Railway creates the on-chain account.
const BETTING_FALLBACK_DURATION_MS = Math.max(
  30_000,
  Math.min(10 * 60_000, Number(process.env.RUMBLE_BETTING_DURATION_MS ?? "120000")),
);
const STATUS_MUTATION_ENABLED = (() => {
  const env = process.env.RUMBLE_PUBLIC_STATUS_MUTATION_ENABLED;
  if (typeof env === "string" && env.length > 0) return env === "true";
  return process.env.NODE_ENV !== "production";
})();
const MAX_ACTIVE_AGE_MS_BY_STATUS: Record<string, number> = {
  betting: 10 * 60 * 1000,
  combat: 45 * 60 * 1000,
  payout: 10 * 60 * 1000,
};
const STATUS_CACHE_TTLS_MS = {
  slot: 1_500,
  fighterLookup: 10_000,
  commentary: 2_500,
  turnLog: 2_500,
  activeRumbles: 2_500,
  showerState: 3_000,
  arenaConfig: 3_000,
  stats: 3_000,
};

// ---------------------------------------------------------------------------
// Cached getSlot — avoids redundant RPC calls across concurrent status polls
// ---------------------------------------------------------------------------
let _slotCache: { slot: number; at: number } | null = null;
async function getCachedSlot(): Promise<number | null> {
  const now = Date.now();
  if (_slotCache && now - _slotCache.at < STATUS_CACHE_TTLS_MS.slot) return _slotCache.slot;
  const slot = await getConnection().getSlot("processed").catch(() => null);
  if (slot !== null) _slotCache = { slot, at: now };
  return slot;
}

// ---------------------------------------------------------------------------
// Stable nextTurnAt cache — prevents timer reset on page refresh.
// Keyed by (rumbleId, turn, phase) so the same absolute timestamp is returned
// for the same on-chain state, instead of recomputing Date.now()+eta each call.
// ---------------------------------------------------------------------------
const _nextTurnAtCache = new Map<string, { iso: string; expiresAt: number }>();

const _bettingDeadlineCache = new Map<number, { iso: string; expiresAt: number }>();

function getStableBettingDeadline(rumbleIdNum: number, computeIso: () => string): string {
  const now = Date.now();
  const cached = _bettingDeadlineCache.get(rumbleIdNum);
  if (cached && cached.expiresAt > now) return cached.iso;
  if (_bettingDeadlineCache.size > 50) {
    for (const [k, v] of _bettingDeadlineCache) { if (v.expiresAt <= now) _bettingDeadlineCache.delete(k); }
  }
  const iso = computeIso();
  _bettingDeadlineCache.set(rumbleIdNum, { iso, expiresAt: now + 30_000 });
  return iso;
}

function getStableNextTurnAt(
  rumbleIdNum: number,
  turn: number,
  phase: string,
  computeIso: () => string,
): string {
  const key = `${rumbleIdNum}:${turn}:${phase}`;
  const now = Date.now();
  const cached = _nextTurnAtCache.get(key);
  // Return cached value if it exists and hasn't expired (max 60s to handle stale edge cases)
  if (cached && cached.expiresAt > now) return cached.iso;
  // Evict stale entries
  if (_nextTurnAtCache.size > 50) {
    for (const [k, v] of _nextTurnAtCache) {
      if (v.expiresAt <= now) _nextTurnAtCache.delete(k);
    }
  }
  const iso = computeIso();
  _nextTurnAtCache.set(key, { iso, expiresAt: now + 20_000 });
  return iso;
}

// ---------------------------------------------------------------------------
// Fresh Supabase client (no-store cache)
// ---------------------------------------------------------------------------

const noStoreFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, cache: "no-store" });

function freshServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing Supabase env vars");
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: noStoreFetch },
  });
}

// ---------------------------------------------------------------------------
// Fighter lookup cache (refreshed per request)
// ---------------------------------------------------------------------------

interface RobotMeta {
  robot_type?: string;
  fighting_style?: string;
  signature_move?: string;
  personality?: string;
  chassis_description?: string;
  distinguishing_features?: string;
  victory_line?: string;
  defeat_line?: string;
  taunt_lines?: string[];
}

type FighterInfo = { name: string; imageUrl: string | null; robotMeta: RobotMeta | null };
type CacheEntry<T> = { at: number; value: T };
type CommentaryRows = Awaited<ReturnType<typeof getCommentaryForRumble>>;
type ActiveRumbleRows = Awaited<ReturnType<typeof loadActiveRumbles>>;
type IchorShowerState = Awaited<ReturnType<typeof getIchorShowerState>>;
type ArenaConfigState = Awaited<ReturnType<typeof readArenaConfig>>;
type StatsState = Awaited<ReturnType<typeof getStats>>;

let _fighterLookupCache: CacheEntry<Map<string, FighterInfo>> | null = null;
const _commentaryCache = new Map<string, CacheEntry<CommentaryRows>>();
const _turnLogCache = new Map<string, CacheEntry<unknown[] | null>>();
let _activeRumblesCache: CacheEntry<ActiveRumbleRows> | null = null;
let _showerStateCache: CacheEntry<IchorShowerState> | null = null;
let _arenaConfigCache: CacheEntry<ArenaConfigState | null> | null = null;
let _statsCache: CacheEntry<StatsState> | null = null;

async function loadFighterLookup(): Promise<Map<string, FighterInfo>> {
  const sb = freshServiceClient();
  const { data } = await sb
    .from("ucf_fighters")
    .select("id, name, image_url, robot_metadata");

  const map = new Map<string, FighterInfo>();
  for (const f of data ?? []) {
    const raw = f.robot_metadata;
    const robotMeta: RobotMeta | null = raw && typeof raw === "object" ? {
      robot_type: raw.robot_type ?? undefined,
      fighting_style: raw.fighting_style ?? undefined,
      signature_move: raw.signature_move ?? undefined,
      personality: raw.personality ?? undefined,
      chassis_description: raw.chassis_description ?? undefined,
      distinguishing_features: raw.distinguishing_features ?? undefined,
      victory_line: raw.victory_line ?? undefined,
      defeat_line: raw.defeat_line ?? undefined,
      taunt_lines: Array.isArray(raw.taunt_lines) ? raw.taunt_lines : undefined,
    } : null;
    map.set(f.id, { name: f.name, imageUrl: f.image_url, robotMeta });
  }
  return map;
}

async function loadFighterLookupCached(): Promise<Map<string, FighterInfo>> {
  const now = Date.now();
  if (_fighterLookupCache && now - _fighterLookupCache.at < STATUS_CACHE_TTLS_MS.fighterLookup) {
    return _fighterLookupCache.value;
  }
  const value = await loadFighterLookup();
  _fighterLookupCache = { at: now, value };
  return value;
}

async function getCommentaryForRumbleCached(rumbleId: string): Promise<CommentaryRows> {
  const now = Date.now();
  const hit = _commentaryCache.get(rumbleId);
  if (hit && now - hit.at < STATUS_CACHE_TTLS_MS.commentary) {
    return hit.value;
  }
  const rows = await getCommentaryForRumble(rumbleId);
  _commentaryCache.set(rumbleId, { at: now, value: rows });
  if (_commentaryCache.size > 200) {
    for (const [key, entry] of _commentaryCache.entries()) {
      if (now - entry.at >= STATUS_CACHE_TTLS_MS.commentary) {
        _commentaryCache.delete(key);
      }
    }
  }
  return rows;
}

async function loadRumbleTurnLogCached(rumbleId: string): Promise<unknown[] | null> {
  const now = Date.now();
  const hit = _turnLogCache.get(rumbleId);
  if (hit && now - hit.at < STATUS_CACHE_TTLS_MS.turnLog) {
    return hit.value;
  }
  const rows = await loadRumbleTurnLog(rumbleId);
  _turnLogCache.set(rumbleId, { at: now, value: rows });
  if (_turnLogCache.size > 200) {
    for (const [key, entry] of _turnLogCache.entries()) {
      if (now - entry.at >= STATUS_CACHE_TTLS_MS.turnLog) {
        _turnLogCache.delete(key);
      }
    }
  }
  return rows;
}

// Cache for total pool from Supabase bets
const _poolCache = new Map<string, { at: number; value: number }>();

async function loadTotalPoolFromDB(rumbleId: string): Promise<number> {
  const now = Date.now();
  const hit = _poolCache.get(rumbleId);
  if (hit && now - hit.at < 3000) return hit.value;
  try {
    const sb = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false }, global: { fetch: (input, init) => fetch(input, { ...init, cache: "no-store" }) } },
    );
    const { data } = await sb
      .from("ucf_bets")
      .select("net_amount")
      .eq("rumble_id", rumbleId);
    const total = (data ?? []).reduce((s, r) => s + Number(r.net_amount ?? 0), 0);
    _poolCache.set(rumbleId, { at: now, value: total });
    if (_poolCache.size > 50) {
      for (const [k, v] of _poolCache) { if (now - v.at > 30000) _poolCache.delete(k); }
    }
    return total;
  } catch {
    return _poolCache.get(rumbleId)?.value ?? 0;
  }
}

async function loadActiveRumblesCached(): Promise<ActiveRumbleRows> {
  const now = Date.now();
  if (_activeRumblesCache && now - _activeRumblesCache.at < STATUS_CACHE_TTLS_MS.activeRumbles) {
    return _activeRumblesCache.value;
  }
  const value = await loadActiveRumbles();
  _activeRumblesCache = { at: now, value };
  return value;
}

async function getIchorShowerStateCached(): Promise<IchorShowerState> {
  const now = Date.now();
  if (_showerStateCache && now - _showerStateCache.at < STATUS_CACHE_TTLS_MS.showerState) {
    return _showerStateCache.value;
  }
  const value = await getIchorShowerState();
  _showerStateCache = { at: now, value };
  return value;
}

async function readArenaConfigCached(): Promise<ArenaConfigState | null> {
  const now = Date.now();
  if (_arenaConfigCache && now - _arenaConfigCache.at < STATUS_CACHE_TTLS_MS.arenaConfig) {
    return _arenaConfigCache.value;
  }
  const value = await readArenaConfig().catch(() => null);
  _arenaConfigCache = { at: now, value };
  return value;
}

async function getStatsCached(): Promise<StatsState> {
  const now = Date.now();
  if (_statsCache && now - _statsCache.at < STATUS_CACHE_TTLS_MS.stats) {
    return _statsCache.value;
  }
  const value = await getStats();
  _statsCache = { at: now, value };
  return value;
}

function fighterName(lookup: Map<string, FighterInfo>, id: string): string {
  return lookup.get(id)?.name ?? id.slice(0, 8);
}

function fighterImage(lookup: Map<string, FighterInfo>, id: string): string | null {
  return lookup.get(id)?.imageUrl ?? null;
}

function fighterRobotMeta(lookup: Map<string, FighterInfo>, id: string): RobotMeta | null {
  return lookup.get(id)?.robotMeta ?? null;
}

// ---------------------------------------------------------------------------
// GET /api/rumble/status
//
// Returns the exact shape expected by the /rumble spectator page:
//   { slots: SlotData[], queue: QueueFighter[], queueLength, nextRumbleIn, ichorShower }
// ---------------------------------------------------------------------------

export async function GET(request: Request) {
  const rlKey = getRateLimitKey(request);
  const rl = checkRateLimit("PUBLIC_READ", rlKey);
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

  try {
    // In production, keep status read-only by default to avoid split-brain
    // serverless instances mutating queue/combat state independently.
    if (STATUS_MUTATION_ENABLED) {
      await ensureRumblePublicHeartbeat("status");

      if (!hasRecovered()) {
        await recoverOrchestratorState().catch((err) => {
          console.warn("[StatusAPI] state recovery failed", err);
        });
      }
    }

    const orchestrator = getOrchestrator();
    const qm = getQueueManager();

    // Deadlock self-heal:
    // if queue has enough fighters to start but all slots are idle, force one
    // orchestrator tick so we don't sit forever in "Starting soon...".
    if (STATUS_MUTATION_ENABLED) {
      const inMemorySlots = orchestrator.getStatus();
      const allSlotsIdle = inMemorySlots.every(
        (slot) => slot.state === "idle" && slot.fighters.length === 0,
      );
      if (allSlotsIdle && qm.getQueueLength() >= 8) {
        await orchestrator.tick().catch((err) => {
          console.warn("[StatusAPI] deadlock kick tick failed", err);
        });
      }
    }

    // Load fighter info for name/image enrichment
    const lookup = await loadFighterLookupCached();

    // ---- Build slots from in-memory orchestrator ----------------------------
    const orchStatus = orchestrator.getStatus();
    let slots = await Promise.all(orchStatus.map(async (slotInfo) => {
      const combatState = orchestrator.getCombatState(slotInfo.slotIndex);

      // Fighter name lookup for this slot
      const fighterNames: Record<string, string> = {};
      for (const fid of slotInfo.fighters) {
        fighterNames[fid] = fighterName(lookup, fid);
      }

      // Build fighters array (SlotFighter[])
      let fighters;
      if (combatState && (slotInfo.state === "combat" || slotInfo.state === "payout")) {
        fighters = combatState.fighters.map((f) => ({
          id: f.id,
          name: fighterName(lookup, f.id),
          hp: f.hp,
          maxHp: 100,
          imageUrl: fighterImage(lookup, f.id),
          robotMeta: fighterRobotMeta(lookup, f.id),
          meter: f.meter,
          totalDamageDealt: f.totalDamageDealt,
          totalDamageTaken: f.totalDamageTaken,
          eliminatedOnTurn: f.eliminatedOnTurn,
          placement: f.placement,
        }));
      } else {
        fighters = slotInfo.fighters.map((fid) => ({
          id: fid,
          name: fighterName(lookup, fid),
          hp: 100,
          maxHp: 100,
          imageUrl: fighterImage(lookup, fid),
          robotMeta: fighterRobotMeta(lookup, fid),
          meter: 0,
          totalDamageDealt: 0,
          totalDamageTaken: 0,
          eliminatedOnTurn: null,
          placement: 0,
        }));
      }

      // Build odds (SlotOdds[]) — always include ALL fighters, merge bet data
      const orchOdds = orchestrator.getOdds(slotInfo.slotIndex);
      let totalPool = 0;

      // Build a map of fighterId -> bet data from orchestrator odds
      const oddsMap = new Map<string, typeof orchOdds[number]>();
      for (const o of orchOdds) {
        totalPool += o.solDeployed;
        oddsMap.set(o.fighterId, o);
      }

      // If in-memory pool is 0, read from Supabase (Vercel doesn't have Railway's betting state)
      if (totalPool === 0 && slotInfo.rumbleId) {
        totalPool = await loadTotalPoolFromDB(slotInfo.rumbleId);
      }

      const count = Math.max(1, slotInfo.fighters.length);
      const odds = slotInfo.fighters.map((fid) => {
        const betData = oddsMap.get(fid);
        return {
          fighterId: fid,
          fighterName: fighterName(lookup, fid),
          imageUrl: fighterImage(lookup, fid),
          hp: combatState?.fighters.find((f) => f.id === fid)?.hp ?? 100,
          solDeployed: betData?.solDeployed ?? 0,
          betCount: betData?.betCount ?? 0,
          impliedProbability: betData?.impliedProbability ?? 1 / count,
          potentialReturn: betData?.potentialReturn ?? count,
        };
      });

      // Build turns (SlotTurn[])
      let turns = (combatState?.turns ?? []).map((t) => ({
        turnNumber: t.turnNumber,
        pairings: t.pairings.map((p) => ({
          fighterA: p.fighterA,
          fighterB: p.fighterB,
          fighterAName: fighterName(lookup, p.fighterA),
          fighterBName: fighterName(lookup, p.fighterB),
          moveA: p.moveA,
          moveB: p.moveB,
          damageToA: p.damageToA,
          damageToB: p.damageToB,
        })),
        eliminations: t.eliminations,
        bye: t.bye,
      }));

      // Build payout data — try in-memory transformed payout first (on-chain
      // SOL values computed by Railway worker), then Supabase fallback (Vercel).
      const transformed = orchestrator.getTransformedPayout(slotInfo.slotIndex);
      let payout = null;
      if (transformed) {
        payout = transformed;
      } else if (slotInfo.rumbleId && (slotInfo.state === "payout" || slotInfo.state === "combat")) {
        // Fallback: load pre-transformed payout from Supabase (persisted by Railway worker)
        const dbPayout = await loadPayoutResult(slotInfo.rumbleId).catch(() => null);
        if (dbPayout) {
          payout = dbPayout;
        }
      }

      // Pre-generated commentary clips for this rumble (shared stream)
      // Reads from Supabase so Vercel can access clips generated by Railway worker
      const commentaryRows = slotInfo.rumbleId
        ? await getCommentaryForRumbleCached(slotInfo.rumbleId)
        : [];
      const commentary = commentaryRows.map((e) => ({
        clipKey: e.clipKey,
        text: e.text,
        audioUrl: e.audioUrl,
        eventType: e.eventType,
        createdAt: e.createdAt,
      }));

      return {
        slotIndex: slotInfo.slotIndex,
        rumbleId: slotInfo.rumbleId,
        rumbleNumber: null as number | null,
        state: slotInfo.state,
        fighters,
        odds,
        totalPool,
        bettingDeadline: slotInfo.bettingDeadline?.toISOString() ?? null,
        nextTurnAt: slotInfo.nextTurnAt?.toISOString() ?? null,
        turnIntervalMs: slotInfo.turnIntervalMs ?? null,
        currentTurn: combatState?.turns.length ?? 0,
        remainingFighters: null as number | null,
        turnPhase: null as string | null,
        nextTurnTargetSlot: null as number | null,
        currentSlot: null as number | null,
        slotMsEstimate: SLOT_MS_ESTIMATE,
        turns,
        payout,
        fighterNames,
        commentary,
      };
    }));

    // Cross-check slot state/timing against on-chain data so UI pacing is
    // anchored to chain slots (ORE-style), not backend loop cadence.
    const currentClusterSlot = await getCachedSlot();
    const currentClusterSlotBig =
      typeof currentClusterSlot === "number" && Number.isFinite(currentClusterSlot)
        ? BigInt(currentClusterSlot)
        : null;
    const slotsToMs = (targetSlot: bigint | null): number => {
      if (!targetSlot || currentClusterSlotBig === null || targetSlot <= currentClusterSlotBig) return 0;
      const delta = targetSlot - currentClusterSlotBig;
      const capped = delta > 1_000_000n ? 1_000_000n : delta;
      return Number(capped) * SLOT_MS_ESTIMATE;
    };

    slots = await Promise.all(
      slots.map(async slot => {
        if (!slot.rumbleId) return slot;
        if (slot.state === "idle" || slot.state === "payout") return slot;
        const rumbleIdNum = parseOnchainRumbleIdNumber(slot.rumbleId);
        if (rumbleIdNum === null) return slot;
        const onchain = await readRumbleAccountState(rumbleIdNum).catch(() => null);
        if (!onchain) return slot;

        // Only ADVANCE state from on-chain data, never regress it.
        // E.g. if in-memory is "combat" (deadline passed, advanceSlots ran)
        // but on-chain is still "betting" (startCombat tx hasn't landed),
        // keep the more-advanced in-memory state to prevent UI from
        // showing "betting" indefinitely when combat is already running.
        const STATE_ORDER: Record<string, number> = { idle: 0, betting: 1, combat: 2, payout: 3 };
        let state: "idle" | "betting" | "combat" | "payout" = slot.state;
        const inMemoryOrder = STATE_ORDER[slot.state] ?? 0;
        let onchainOrder = 0;
        if (onchain.state === "combat") onchainOrder = 2;
        else if (onchain.state === "payout" || onchain.state === "complete") onchainOrder = 3;
        else if (onchain.state === "betting") onchainOrder = 1;

        if (onchainOrder > inMemoryOrder) {
          if (onchainOrder === 2) state = "combat";
          else if (onchainOrder === 3) state = "payout";
          else if (onchainOrder === 1) state = "betting";
        }

        let nextTurnAt = slot.nextTurnAt;
        let turnIntervalMs = slot.turnIntervalMs;
        let currentTurn = slot.currentTurn;
        let bettingDeadline = slot.bettingDeadline;

        if (state === "betting") {
          const closeRaw = ((onchain as any).bettingCloseSlot ?? onchain.bettingDeadlineTs ?? 0n) as bigint;
          if (closeRaw > 0n) {
            const looksLikeUnix =
              currentClusterSlotBig !== null
                ? closeRaw > currentClusterSlotBig + ONCHAIN_DEADLINE_UNIX_SLOT_GAP_THRESHOLD
                : closeRaw > 1_000_000_000n;
            if (looksLikeUnix) {
              const unixMs = Number(closeRaw) * 1_000;
              bettingDeadline = Number.isFinite(unixMs) ? new Date(unixMs).toISOString() : slot.bettingDeadline;
            } else {
              const etaMs = slotsToMs(closeRaw);
              bettingDeadline = getStableBettingDeadline(rumbleIdNum, () =>
                new Date(Date.now() + etaMs).toISOString(),
              );
            }
          }
        } else {
          bettingDeadline = null;
        }

        // Enriched fighters/turns from on-chain + Supabase persistence
        let enrichedFighters = slot.fighters;
        let turns = slot.turns;
        let remainingFighters = slot.remainingFighters;
        let turnPhase = slot.turnPhase;

        if (state === "combat") {
          const onchainCombat = await readRumbleCombatState(rumbleIdNum).catch(() => null);
          if (onchainCombat) {
            currentTurn = Math.max(currentTurn ?? 0, onchainCombat.currentTurn ?? 0);
            remainingFighters = onchainCombat.remainingFighters;

            const slotSpan =
              onchainCombat.revealCloseSlot > onchainCombat.turnOpenSlot
                ? onchainCombat.revealCloseSlot - onchainCombat.turnOpenSlot
                : 0n;
            turnIntervalMs = Number(slotSpan > 0n ? slotSpan : 0n) * SLOT_MS_ESTIMATE;

            // On-chain turn timing: COMMIT_WINDOW=30 slots + REVEAL_WINDOW=30 slots
            const ONCHAIN_TURN_MS = 60 * SLOT_MS_ESTIMATE; // ~24s

            if (!onchainCombat.turnResolved) {
              // Turn is active — always countdown to revealCloseSlot (when
              // the turn actually resolves). Previously we showed separate
              // commit and reveal countdowns, which looked like the timer
              // reset from 10→0 twice before a move happened.
              const inCommitPhase =
                currentClusterSlotBig !== null &&
                currentClusterSlotBig <= onchainCombat.commitCloseSlot;
              turnPhase = inCommitPhase ? "commit" : "reveal";

              // Always target revealCloseSlot — single continuous countdown
              const targetSlotVal = onchainCombat.revealCloseSlot;

              // Send raw slot numbers so frontend computes countdown locally
              // (prevents timer reset on refresh / different Vercel instances)
              slot.nextTurnTargetSlot = Number(targetSlotVal);
              slot.currentSlot = currentClusterSlotBig !== null ? Number(currentClusterSlotBig) : null;

              const etaMs = slotsToMs(targetSlotVal);
              // Use turn number only (not phase) as cache key so the
              // countdown doesn't jump when phase transitions commit→reveal
              nextTurnAt = getStableNextTurnAt(rumbleIdNum, currentTurn, "turn", () =>
                etaMs > 0
                  ? new Date(Date.now() + etaMs).toISOString()
                  : new Date(Date.now() + 3_000).toISOString(),
              );
            } else if (onchainCombat.remainingFighters > 1) {
              // Turn resolved, waiting for worker to open next turn (~2s tick)
              turnPhase = "resolved";
              slot.nextTurnTargetSlot = null;
              slot.currentSlot = currentClusterSlotBig !== null ? Number(currentClusterSlotBig) : null;
              nextTurnAt = getStableNextTurnAt(rumbleIdNum, currentTurn, "resolved", () =>
                new Date(Date.now() + 3_000).toISOString(),
              );
            } else {
              turnPhase = "resolved";
              nextTurnAt = null; // combat over
            }

            if (!turnIntervalMs || turnIntervalMs <= 0) {
              turnIntervalMs = ONCHAIN_TURN_MS;
            }

            // Update fighter HP/damage/meter from on-chain CombatState
            enrichedFighters = slot.fighters.map((f, i) => {
              if (i >= onchainCombat.fighterCount) return f;
              return {
                ...f,
                hp: onchainCombat.hp[i],
                meter: onchainCombat.meter[i],
                totalDamageDealt: Number(onchainCombat.totalDamageDealt[i]),
                totalDamageTaken: Number(onchainCombat.totalDamageTaken[i]),
                eliminatedOnTurn: onchainCombat.eliminationRank[i] > 0
                  ? onchainCombat.eliminationRank[i]
                  : f.eliminatedOnTurn,
              };
            });
          }
        } else {
          nextTurnAt = null;
          turnIntervalMs = null;
        }

        // Load real turn data from Supabase persistence (Railway worker saves
        // turn_log with pairings/moves/damage on each resolved turn).
        if (currentTurn > 0 && slot.rumbleId) {
          const persistedTurns = await loadRumbleTurnLogCached(slot.rumbleId).catch(() => null);
          if (persistedTurns && persistedTurns.length > 0) {
            turns = (persistedTurns as Array<any>).map((t: any) => ({
              turnNumber: t.turnNumber ?? 0,
              pairings: (t.pairings ?? []).map((p: any) => ({
                fighterA: p.fighterA ?? "",
                fighterB: p.fighterB ?? "",
                fighterAName: fighterName(lookup, p.fighterA ?? ""),
                fighterBName: fighterName(lookup, p.fighterB ?? ""),
                moveA: p.moveA ?? "",
                moveB: p.moveB ?? "",
                damageToA: p.damageToA ?? 0,
                damageToB: p.damageToB ?? 0,
              })),
              eliminations: t.eliminations ?? [],
              bye: t.bye,
            }));
          } else if (!turns || turns.length === 0) {
            // Fallback: synthetic turn entries so UI shows turn count
            turns = Array.from({ length: currentTurn }, (_, i) => ({
              turnNumber: i + 1,
              pairings: [],
              eliminations: [],
              bye: undefined,
            }));
          }
        }

        return {
          ...slot,
          state,
          fighters: enrichedFighters,
          bettingDeadline,
          nextTurnAt,
          turnIntervalMs,
          currentTurn,
          maxTurns: MAX_TURNS,
          remainingFighters,
          turnPhase,
          turns,
        };
      }),
    );

    // ---- Build queue (QueueFighter[]) --------------------------------------
    const queueEntries = await loadQueueState();
    const queue = queueEntries.map((entry, index) => ({
      fighterId: entry.fighter_id,
      name: fighterName(lookup, entry.fighter_id),
      imageUrl: fighterImage(lookup, entry.fighter_id),
      position: index + 1,
    }));

    // ---------------------------------------------------------------------
    // Serverless cold-start fallback:
    // If in-memory orchestrator is empty, hydrate visible slot state from DB.
    // This keeps UI accurate even when /status runs on a different lambda
    // instance than /tick.
    // ---------------------------------------------------------------------
    const persistedActive = await loadActiveRumblesCached();
    const nowMs = Date.now();
    const freshPersisted = persistedActive.filter((row) => {
      const status = String(row.status ?? "").toLowerCase();
      const maxAge = MAX_ACTIVE_AGE_MS_BY_STATUS[status] ?? 10 * 60 * 1000;
      const createdAtMs = new Date(row.created_at).getTime();
      if (!Number.isFinite(createdAtMs)) return false;
      return nowMs - createdAtMs <= maxAge;
    });
    const latestPersistedBySlot = new Map<number, (typeof persistedActive)[number]>();
    for (const row of freshPersisted) {
      const slotIndex = Number(row.slot_index);
      if (!Number.isInteger(slotIndex)) continue;
      const existing = latestPersistedBySlot.get(slotIndex);
      if (!existing || new Date(row.created_at).getTime() > new Date(existing.created_at).getTime()) {
        latestPersistedBySlot.set(slotIndex, row);
      }
    }

    if (freshPersisted.length > 0) {
      const base = new Map(slots.map((s) => [s.slotIndex, s]));
      for (const [slotIndex, row] of latestPersistedBySlot.entries()) {
        const fighterRows = Array.isArray(row.fighters)
          ? (row.fighters as Array<{ id?: string; name?: string }>)
          : [];
        const fighterIds = fighterRows
          .map((f) => String(f?.id ?? "").trim())
          .filter(Boolean);
        // Build fighter state — replay turn_log if available to show actual HP
        const turnLog = Array.isArray(row.turn_log) ? row.turn_log : [];
        const fighters = fighterIds.map((fid) => ({
          id: fid,
          name: fighterName(lookup, fid),
          hp: 100,
          maxHp: 100,
          imageUrl: fighterImage(lookup, fid),
          robotMeta: fighterRobotMeta(lookup, fid),
          meter: 0,
          totalDamageDealt: 0,
          totalDamageTaken: 0,
          eliminatedOnTurn: null as number | null,
          placement: 0,
        }));
        // Replay persisted turns to derive correct HP / damage stats
        if (turnLog.length > 0) {
          const fMap = new Map(fighters.map(f => [f.id, f]));
          for (const turn of turnLog as Array<{ pairings?: Array<{ fighterA: string; fighterB: string; damageToA: number; damageToB: number }>; eliminations?: string[]; turnNumber?: number }>) {
            for (const p of turn.pairings ?? []) {
              const fA = fMap.get(p.fighterA);
              const fB = fMap.get(p.fighterB);
              if (fA) { fA.hp = Math.max(0, fA.hp - p.damageToA); fA.totalDamageDealt += p.damageToB; fA.totalDamageTaken += p.damageToA; }
              if (fB) { fB.hp = Math.max(0, fB.hp - p.damageToB); fB.totalDamageDealt += p.damageToA; fB.totalDamageTaken += p.damageToB; }
            }
            for (const elimId of turn.eliminations ?? []) {
              const f = fMap.get(elimId);
              if (f && f.eliminatedOnTurn === null) f.eliminatedOnTurn = turn.turnNumber ?? 0;
            }
          }
        }
        // Apply placements from DB (set during finishCombat)
        const dbPlacements = Array.isArray((row as any).placements) ? (row as any).placements as Array<{ id: string; placement: number }> : [];
        if (dbPlacements.length > 0) {
          const fMap = new Map(fighters.map(f => [f.id, f]));
          for (const p of dbPlacements) {
            const f = fMap.get(p.id);
            if (f) f.placement = p.placement;
          }
        }
        const fighterNames: Record<string, string> = {};
        for (const fid of fighterIds) fighterNames[fid] = fighterName(lookup, fid);

        const existing = base.get(slotIndex);
        if (!existing) continue;
        const sameRumble = existing.rumbleId === row.id;
        const shouldOverlay =
          sameRumble ||
          existing.state === "idle" ||
          (existing.state === "betting" && !existing.bettingDeadline);
        if (!shouldOverlay) continue;
        // When sameRumble, prefer existing fighters (enriched from on-chain)
        // over turn-log replay which may be stale
        const useFighters = sameRumble && existing.fighters.length > 0
          ? existing.fighters
          : fighters;
        base.set(slotIndex, {
          ...existing,
          // CRITICAL: Reset remainingFighters when overlaying a different rumble.
          // Otherwise stale remainingFighters from a previous rumble leaks through
          // ...existing and causes the post-overlay enrichment to skip this slot.
          remainingFighters: sameRumble ? existing.remainingFighters : null,
          rumbleId: row.id,
          rumbleNumber: (row as any).rumble_number ?? existing.rumbleNumber ?? null,
          state: sameRumble ? existing.state : (row.status as "idle" | "betting" | "combat" | "payout") ?? "idle",
          fighters: useFighters,
          odds: sameRumble
            ? existing.odds
            : fighterIds.map((fid) => ({
                fighterId: fid,
                fighterName: fighterName(lookup, fid),
                imageUrl: fighterImage(lookup, fid),
                hp: 100,
                solDeployed: 0,
                betCount: 0,
                impliedProbability: fighterIds.length > 0 ? 1 / fighterIds.length : 0,
                potentialReturn: fighterIds.length || 1,
              })),
          totalPool: sameRumble ? existing.totalPool : 0,
          bettingDeadline: sameRumble ? existing.bettingDeadline : null,
          nextTurnAt: sameRumble ? existing.nextTurnAt : null,
          turnIntervalMs: sameRumble ? existing.turnIntervalMs : null,
          currentTurn: sameRumble
            ? existing.currentTurn
            : turnLog.length > 0
              ? turnLog.length
              : 0,
          turns: sameRumble
            ? existing.turns
            : turnLog.length > 0
              ? (turnLog as Array<any>).map((t: any) => ({
                  turnNumber: t.turnNumber ?? 0,
                  pairings: (t.pairings ?? []).map((p: any) => ({
                    fighterA: p.fighterA ?? "",
                    fighterB: p.fighterB ?? "",
                    fighterAName: fighterName(lookup, p.fighterA ?? ""),
                    fighterBName: fighterName(lookup, p.fighterB ?? ""),
                    moveA: p.moveA ?? "",
                    moveB: p.moveB ?? "",
                    damageToA: p.damageToA ?? 0,
                    damageToB: p.damageToB ?? 0,
                  })),
                  eliminations: t.eliminations ?? [],
                  bye: t.bye,
                }))
              : [],
          payout: sameRumble
            ? (existing.payout ?? (row as any).payout_result ?? null)
            : (row as any).payout_result ?? null,
          fighterNames,
        });
      }
      slots = [...base.values()].sort((a, b) => a.slotIndex - b.slotIndex);
    }

    // In read-only production mode, suppress ghost in-memory active states
    // when no persisted active row exists for that slot.
    if (!STATUS_MUTATION_ENABLED) {
      slots = slots.map((slot) => {
        const persisted = latestPersistedBySlot.get(slot.slotIndex);
        if (slot.state === "idle") return slot;
        if (persisted && persisted.id === slot.rumbleId) return slot;
        return {
          ...slot,
          state: "idle" as const,
          fighters: [],
          odds: [],
          totalPool: 0,
          bettingDeadline: null,
          nextTurnAt: null,
          turnIntervalMs: null,
          currentTurn: 0,
          turns: [],
          payout: null,
          fighterNames: {},
        };
      });
    }

    // Post-overlay on-chain enrichment: fill in fighter HP, timer, and
    // elimination data for slots that were hydrated from DB (Vercel cold start).
    // The initial enrichment pass (above) skips slots with no rumbleId, which
    // is every slot on Vercel before the DB overlay adds the rumbleId.
    slots = await Promise.all(
      slots.map(async (slot) => {
        if (!slot.rumbleId) return slot;
        // Skip idle/payout — nothing to enrich
        if (slot.state === "idle" || slot.state === "payout") return slot;
        // Skip if already enriched (has on-chain timing data from first pass)
        if (slot.remainingFighters !== null && slot.remainingFighters !== undefined) return slot;
        const rumbleIdNum = parseOnchainRumbleIdNumber(slot.rumbleId);
        if (rumbleIdNum === null) return slot;

        // --- Betting state: restore countdown from on-chain close slot ---
        if (slot.state === "betting") {
          const onchain = await readRumbleAccountState(rumbleIdNum).catch(() => null);

          // Case 1: On-chain doesn't exist yet (still being created on Railway).
          // Use a fallback deadline so the user sees "Betting Open" immediately
          // instead of "Initializing On-Chain..." forever.
          if (!onchain) {
            const persisted = latestPersistedBySlot.get(slot.slotIndex);
            if (persisted) {
              const createdAt = new Date(persisted.created_at).getTime();
              const fallbackDeadline = Number.isFinite(createdAt)
                ? new Date(createdAt + BETTING_FALLBACK_DURATION_MS).toISOString()
                : new Date(Date.now() + BETTING_FALLBACK_DURATION_MS).toISOString();
              return { ...slot, bettingDeadline: fallbackDeadline };
            }
            return { ...slot, bettingDeadline: new Date(Date.now() + BETTING_FALLBACK_DURATION_MS).toISOString() };
          }

          // Case 2: On-chain has already transitioned past betting (Railway
          // called startCombat). Update state to match on-chain so the user
          // sees combat/payout instead of a stuck "Initializing On-Chain..." banner.
          // DON'T return early — fall through so combat enrichment runs below.
          if (onchain.state !== "betting") {
            slot = { ...slot, state: onchain.state as any, bettingDeadline: null };
            // fall through to combat enrichment below
          } else {
            // Case 3: On-chain is in betting state with a valid close slot/timestamp.
            const closeRaw = ((onchain as any).bettingCloseSlot ?? onchain.bettingDeadlineTs ?? 0n) as bigint;
            if (!(closeRaw > 0n)) {
              // On-chain betting but no deadline set — use fallback
              return { ...slot, bettingDeadline: new Date(Date.now() + BETTING_FALLBACK_DURATION_MS).toISOString() };
            }
            const looksLikeUnix =
              currentClusterSlotBig !== null
                ? closeRaw > currentClusterSlotBig + ONCHAIN_DEADLINE_UNIX_SLOT_GAP_THRESHOLD
                : closeRaw > 1_000_000_000n;
            const bettingDeadline = looksLikeUnix
              ? new Date(Number(closeRaw) * 1_000).toISOString()
              : getStableBettingDeadline(rumbleIdNum, () =>
                  new Date(Date.now() + slotsToMs(closeRaw)).toISOString(),
                );
            return { ...slot, bettingDeadline };
          }
        }

        // --- Combat state: enrich from on-chain CombatState PDA ---
        if (slot.state !== "combat") return slot;
        const onchainCombat = await readRumbleCombatState(rumbleIdNum).catch(() => null);
        if (!onchainCombat) return slot;

        const currentTurn = Math.max(slot.currentTurn ?? 0, onchainCombat.currentTurn ?? 0);
        const remainingFighters = onchainCombat.remainingFighters;
        const ONCHAIN_TURN_MS = 60 * SLOT_MS_ESTIMATE;

        const slotSpan =
          onchainCombat.revealCloseSlot > onchainCombat.turnOpenSlot
            ? onchainCombat.revealCloseSlot - onchainCombat.turnOpenSlot
            : 0n;
        let turnIntervalMs = Number(slotSpan > 0n ? slotSpan : 0n) * SLOT_MS_ESTIMATE;
        if (!turnIntervalMs || turnIntervalMs <= 0) turnIntervalMs = ONCHAIN_TURN_MS;

        let nextTurnAt: string | null = slot.nextTurnAt;
        let turnPhase: string | null = null;
        let nextTurnTargetSlot: number | null = null;
        const currentSlotVal = currentClusterSlotBig !== null ? Number(currentClusterSlotBig) : null;

        if (!onchainCombat.turnResolved) {
          const inCommitPhase =
            currentClusterSlotBig !== null &&
            currentClusterSlotBig <= onchainCombat.commitCloseSlot;
          turnPhase = inCommitPhase ? "commit" : "reveal";
          // Always target revealCloseSlot — single continuous countdown
          const targetSlotVal = onchainCombat.revealCloseSlot;
          nextTurnTargetSlot = Number(targetSlotVal);
          const etaMs = slotsToMs(targetSlotVal);
          nextTurnAt = getStableNextTurnAt(rumbleIdNum, currentTurn, "turn", () =>
            etaMs > 0
              ? new Date(Date.now() + etaMs).toISOString()
              : new Date(Date.now() + 3_000).toISOString(),
          );
        } else if (onchainCombat.remainingFighters > 1) {
          turnPhase = "resolved";
          nextTurnAt = getStableNextTurnAt(rumbleIdNum, currentTurn, "resolved", () =>
            new Date(Date.now() + 3_000).toISOString(),
          );
        } else {
          turnPhase = "resolved";
          nextTurnAt = null;
        }

        // Enrich fighters from on-chain CombatState (accurate HP, damage, elimination)
        const enrichedFighters = slot.fighters.map((f, i) => {
          if (i >= onchainCombat.fighterCount) return f;
          return {
            ...f,
            hp: onchainCombat.hp[i],
            meter: onchainCombat.meter[i],
            totalDamageDealt: Number(onchainCombat.totalDamageDealt[i]),
            totalDamageTaken: Number(onchainCombat.totalDamageTaken[i]),
            eliminatedOnTurn: onchainCombat.eliminationRank[i] > 0
              ? onchainCombat.eliminationRank[i]
              : f.eliminatedOnTurn,
          };
        });

        return {
          ...slot,
          fighters: enrichedFighters,
          currentTurn,
          remainingFighters,
          turnPhase,
          nextTurnAt,
          nextTurnTargetSlot,
          currentSlot: currentSlotVal,
          turnIntervalMs,
        };
      }),
    );

    // Final pass: ensure combat slots have a turnIntervalMs for pacing.
    slots = slots.map((slot) => {
      if (slot.state !== "combat") return slot;
      return {
        ...slot,
        turnIntervalMs: slot.turnIntervalMs ?? 24_000,
      };
    });

    // ---- Ichor shower state ------------------------------------------------
    const showerState = await getIchorShowerStateCached();
    const arenaConfig = await readArenaConfigCached();
    const stats = await getStatsCached();
    const rumblesSinceLastTrigger = stats?.total_rumbles ?? 0;

    // ---- nextRumbleIn estimate ---------------------------------------------
    const effectiveQueueLen = queueEntries.length;
    let nextRumbleIn: string | null = null;
    const fightersNeeded = Number(process.env.FIGHTERS_PER_RUMBLE) || 8;
    if (effectiveQueueLen > 0 && effectiveQueueLen < fightersNeeded) {
      nextRumbleIn = `Need ${fightersNeeded - effectiveQueueLen} more fighters`;
    } else if (effectiveQueueLen >= fightersNeeded) {
      const hasIdleSlot = slots.some((s) => s.state === "idle");
      if (!hasIdleSlot) {
        nextRumbleIn = "All slots active";
      } else {
        nextRumbleIn = "Starting now...";
      }
    }

    // ---- queueLength: in-queue + in-combat fighters for display ------------
    const activeFighterCount = slots.reduce(
      (sum, s) => sum + (s.state !== "idle" ? s.fighters.length : 0),
      0,
    );
    const runtimeHealth = orchestrator.getRuntimeHealth();
    const systemWarnings: string[] = [];
    if (!runtimeHealth.onchainAdmin.ready && runtimeHealth.onchainAdmin.reason) {
      systemWarnings.push(`On-chain admin unavailable: ${runtimeHealth.onchainAdmin.reason}`);
    }
    const unarmedBettingSlots = slots.filter((slot) => slot.state === "betting" && !slot.bettingDeadline);
    for (const slot of unarmedBettingSlots) {
      systemWarnings.push(
        `Slot ${slot.slotIndex} is initializing on-chain (betting timer not armed yet).`,
      );
    }
    if (Array.isArray(runtimeHealth.onchainCreateFailures)) {
      for (const failure of runtimeHealth.onchainCreateFailures.slice(0, 3)) {
        const slotLabel =
          typeof failure?.slotIndex === "number" && Number.isInteger(failure.slotIndex)
            ? `slot ${failure.slotIndex}`
            : "unknown slot";
        const attempts = Number.isFinite(Number(failure?.attempts))
          ? Number(failure.attempts)
          : null;
        const attemptsSuffix = attempts ? ` (attempt ${attempts})` : "";
        const reason = typeof failure?.reason === "string" ? failure.reason : "unknown create_rumble failure";
        const rumbleId = typeof failure?.rumbleId === "string" ? failure.rumbleId : "unknown";
        systemWarnings.push(`On-chain create failed for ${slotLabel}, ${rumbleId}: ${reason}${attemptsSuffix}`);
      }
    }

    // Temporary debug: expose RPC endpoint (masked) to diagnose Vercel connection
    const rpcUrl = getRpcEndpoint();
    const rpcDebug = rpcUrl.includes("helius") ? "helius" : rpcUrl.includes("devnet.solana") ? "public-devnet" : rpcUrl.substring(0, 40);
    // Quick direct test of the RPC
    let rpcTestResult: string = "not-tested";
    try {
      const testConn = getConnection();
      const testSlot = await testConn.getSlot("processed");
      rpcTestResult = `ok:${testSlot}`;
    } catch (e: any) {
      rpcTestResult = `error:${e?.message?.substring(0, 100) ?? "unknown"}`;
    }

    return NextResponse.json({
      slots,
      queue,
      queueLength: queueEntries.length + activeFighterCount,
      nextRumbleIn,
      ichorShower: {
        currentPool:
          arenaConfig
            ? Number(arenaConfig.ichorShowerPool) / 1_000_000_000
            : Number(showerState?.pool_amount ?? 0),
        rumblesSinceLastTrigger,
      },
      runtimeHealth,
      systemWarnings,
      _debug: {
        rpc: rpcDebug,
        clusterSlot: currentClusterSlot,
        rpcTest: rpcTestResult,
        hasHeliusKey: !!process.env.HELIUS_API_KEY,
        heliusKeyPrefix: process.env.HELIUS_API_KEY?.substring(0, 8) ?? "none",
        hasPublicKey: !!process.env.NEXT_PUBLIC_HELIUS_API_KEY,
        publicKeyPrefix: process.env.NEXT_PUBLIC_HELIUS_API_KEY?.substring(0, 8) ?? "none",
      },
    });
  } catch (error: any) {
    console.error("[StatusAPI]", error);
    return NextResponse.json({ error: "Failed to fetch rumble status" }, { status: 500 });
  }
}
