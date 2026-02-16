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
  getIchorShowerState,
  getStats,
} from "~~/lib/rumble-persistence";
import { readArenaConfig, readRumbleAccountState, readRumbleCombatState } from "~~/lib/solana-programs";
import { parseOnchainRumbleIdNumber } from "~~/lib/rumble-id";
import { getConnection } from "~~/lib/solana-connection";

export const dynamic = "force-dynamic";
const SLOT_MS_ESTIMATE = Math.max(250, Number(process.env.RUMBLE_SLOT_MS_ESTIMATE ?? "400"));
const ONCHAIN_DEADLINE_UNIX_SLOT_GAP_THRESHOLD = 5_000_000n;
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
    const lookup = await loadFighterLookup();

    // ---- Build slots from in-memory orchestrator ----------------------------
    const orchStatus = orchestrator.getStatus();
    let slots = orchStatus.map((slotInfo) => {
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
      const turns = (combatState?.turns ?? []).map((t) => ({
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

      // Build payout data from orchestrator (available during payout phase)
      const payoutResult = orchestrator.getPayoutResult(slotInfo.slotIndex);
      let payout = null;
      if (payoutResult) {
        const sumReturned = (arr: Array<{ solReturned: number; solProfit: number }>) =>
          arr.reduce((s, b) => s + b.solReturned + b.solProfit, 0);
        payout = {
          winnerBettorsPayout: sumReturned(payoutResult.winnerBettors),
          placeBettorsPayout: sumReturned(payoutResult.placeBettors),
          showBettorsPayout: sumReturned(payoutResult.showBettors),
          treasuryVault: payoutResult.treasuryVault,
          totalPool,
          ichorMined: payoutResult.ichorDistribution.totalMined,
          ichorShowerTriggered: payoutResult.ichorShowerTriggered,
          ichorShowerAmount: payoutResult.ichorShowerAmount,
        };
      }

      return {
        slotIndex: slotInfo.slotIndex,
        rumbleId: slotInfo.rumbleId,
        state: slotInfo.state,
        fighters,
        odds,
        totalPool,
        bettingDeadline: slotInfo.bettingDeadline?.toISOString() ?? null,
        nextTurnAt: slotInfo.nextTurnAt?.toISOString() ?? null,
        turnIntervalMs: slotInfo.turnIntervalMs ?? null,
        currentTurn: combatState?.turns.length ?? 0,
        turns,
        payout,
        fighterNames,
      };
    });

    // Cross-check slot state/timing against on-chain data so UI pacing is
    // anchored to chain slots (ORE-style), not backend loop cadence.
    const currentClusterSlot = await getConnection().getSlot("processed").catch(() => null);
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
        if (slot.state === "betting" && !slot.bettingDeadline) {
          // Slot entered betting in queue-manager but on-chain rumble is not
          // confirmed yet. Avoid extra RPC pressure while orchestrator retries.
          return {
            ...slot,
            nextTurnAt: null,
            turnIntervalMs: null,
          };
        }
        const rumbleIdNum = parseOnchainRumbleIdNumber(slot.rumbleId);
        if (rumbleIdNum === null) return slot;
        const onchain = await readRumbleAccountState(rumbleIdNum).catch(() => null);
        if (!onchain) return slot;

        let state: "idle" | "betting" | "combat" | "payout" = slot.state;
        if (onchain.state === "combat") state = "combat";
        else if (onchain.state === "payout" || onchain.state === "complete") state = "payout";
        else if (onchain.state === "betting") state = "betting";

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
              bettingDeadline = new Date(Date.now() + etaMs).toISOString();
            }
          }
        } else {
          bettingDeadline = null;
        }

        if (state === "combat") {
          const onchainCombat = await readRumbleCombatState(rumbleIdNum).catch(() => null);
          if (onchainCombat) {
            currentTurn = Math.max(currentTurn ?? 0, onchainCombat.currentTurn ?? 0);

            const slotSpan =
              onchainCombat.revealCloseSlot > onchainCombat.turnOpenSlot
                ? onchainCombat.revealCloseSlot - onchainCombat.turnOpenSlot
                : 0n;
            turnIntervalMs = Number(slotSpan > 0n ? slotSpan : 0n) * SLOT_MS_ESTIMATE;

            let targetSlot: bigint | null = null;
            if (!onchainCombat.turnResolved) {
              targetSlot =
                currentClusterSlotBig !== null && currentClusterSlotBig <= onchainCombat.commitCloseSlot
                  ? onchainCombat.commitCloseSlot
                  : onchainCombat.revealCloseSlot;
            } else if (onchainCombat.remainingFighters > 1) {
              targetSlot = onchainCombat.revealCloseSlot;
            }
            if (targetSlot) {
              const etaMs = slotsToMs(targetSlot);
              nextTurnAt = new Date(Date.now() + etaMs).toISOString();
            } else {
              nextTurnAt = null;
            }
          }
        } else {
          nextTurnAt = null;
          turnIntervalMs = null;
        }

        return {
          ...slot,
          state,
          bettingDeadline,
          nextTurnAt,
          turnIntervalMs,
          currentTurn,
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
    const persistedActive = await loadActiveRumbles();
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
          eliminatedOnTurn: null,
          placement: 0,
        }));
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
        base.set(slotIndex, {
          ...existing,
          rumbleId: row.id,
          state: (row.status as "idle" | "betting" | "combat" | "payout") ?? "idle",
          fighters,
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
          currentTurn: sameRumble ? existing.currentTurn : 0,
          turns: sameRumble ? existing.turns : [],
          payout: sameRumble ? existing.payout : null,
          fighterNames,
        });
      }
      slots = [...base.values()].sort((a, b) => a.slotIndex - b.slotIndex);
    }

    // Safety valve:
    // If public mutation is disabled and combat is visibly stalled at turn 0,
    // perform a single tick to unstick progression.
    if (!STATUS_MUTATION_ENABLED) {
      const stalledCombatDetected = slots.some((slot) => {
        if (slot.state !== "combat") return false;
        if ((slot.currentTurn ?? 0) > 0) return false;
        if (slot.nextTurnAt) return false;
        return true;
      });
      if (stalledCombatDetected) {
        await orchestrator.tick().catch((err) => {
          console.warn("[StatusAPI] stalled combat nudge tick failed", err);
        });
      }
    }

    // ---- Ichor shower state ------------------------------------------------
    const showerState = await getIchorShowerState();
    const arenaConfig = await readArenaConfig().catch(() => null);
    const stats = await getStats();
    const rumblesSinceLastTrigger = stats?.total_rumbles ?? 0;

    // ---- nextRumbleIn estimate ---------------------------------------------
    const effectiveQueueLen = queueEntries.length;
    let nextRumbleIn: string | null = null;
    if (effectiveQueueLen > 0 && effectiveQueueLen < 8) {
      nextRumbleIn = `Need ${8 - effectiveQueueLen} more fighters`;
    } else if (effectiveQueueLen >= 8) {
      const hasIdleSlot = slots.some((s) => s.state === "idle");
      if (!hasIdleSlot) {
        nextRumbleIn = "All slots active";
      } else if (effectiveQueueLen >= 16) {
        nextRumbleIn = "Starting now...";
      } else {
        nextRumbleIn = "Starting soon...";
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
    });
  } catch (error: any) {
    console.error("[StatusAPI]", error);
    return NextResponse.json({ error: "Failed to fetch rumble status" }, { status: 500 });
  }
}
