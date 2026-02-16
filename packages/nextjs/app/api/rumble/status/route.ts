import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getOrchestrator } from "~~/lib/rumble-orchestrator";
import { getQueueManager } from "~~/lib/queue-manager";
import { hasRecovered, recoverOrchestratorState } from "~~/lib/rumble-state-recovery";
import { checkRateLimit, getRateLimitKey, rateLimitResponse } from "~~/lib/rate-limit";
import {
  loadQueueState,
  loadActiveRumbles,
  getIchorShowerState,
  getStats,
} from "~~/lib/rumble-persistence";
import { readArenaConfig, readRumbleAccountState } from "~~/lib/solana-programs";
import { parseOnchainRumbleIdNumber } from "~~/lib/rumble-id";

export const dynamic = "force-dynamic";

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
    // Cold-start self-heal so stale betting/combat rows are reconciled even if
    // no one has hit /tick or /bet yet.
    if (!hasRecovered()) {
      await recoverOrchestratorState().catch((err) => {
        console.warn("[StatusAPI] state recovery failed", err);
      });
    }

    const orchestrator = getOrchestrator();
    const qm = getQueueManager();

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

    // Cross-check betting slots against on-chain state so UI doesn't present
    // a stale "Betting Open" phase after the program has already moved on.
    slots = await Promise.all(
      slots.map(async slot => {
        if (slot.state !== "betting" || !slot.rumbleId) return slot;
        const rumbleIdNum = parseOnchainRumbleIdNumber(slot.rumbleId);
        if (rumbleIdNum === null) return slot;
        const onchain = await readRumbleAccountState(rumbleIdNum).catch(() => null);
        if (!onchain || onchain.state === "betting") return slot;
        return {
          ...slot,
          state: onchain.state === "combat" ? "combat" : "payout",
          bettingDeadline: null,
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
    const inMemoryLooksIdle = slots.every((s) => s.state === "idle" && s.fighters.length === 0);
    if (inMemoryLooksIdle) {
      const persistedActive = await loadActiveRumbles();
      if (persistedActive.length > 0) {
        const base = new Map(slots.map((s) => [s.slotIndex, s]));
        for (const row of persistedActive) {
          const slotIndex = Number(row.slot_index);
          if (!Number.isInteger(slotIndex)) continue;
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
          base.set(slotIndex, {
            ...existing,
            rumbleId: row.id,
            state: (row.status as "idle" | "betting" | "combat" | "payout") ?? "idle",
            fighters,
            odds: fighterIds.map((fid) => ({
              fighterId: fid,
              fighterName: fighterName(lookup, fid),
              imageUrl: fighterImage(lookup, fid),
              hp: 100,
              solDeployed: 0,
              betCount: 0,
              impliedProbability: fighterIds.length > 0 ? 1 / fighterIds.length : 0,
              potentialReturn: fighterIds.length || 1,
            })),
            totalPool: 0,
            bettingDeadline: null,
            nextTurnAt: null,
            turnIntervalMs: null,
            currentTurn: 0,
            turns: [],
            payout: null,
            fighterNames,
          });
        }
        slots = [...base.values()].sort((a, b) => a.slotIndex - b.slotIndex);
      }
    }

    // ---- Ichor shower state ------------------------------------------------
    const showerState = await getIchorShowerState();
    const arenaConfig = await readArenaConfig().catch(() => null);
    const stats = await getStats();
    const rumblesSinceLastTrigger = stats?.total_rumbles ?? 0;

    // ---- nextRumbleIn estimate ---------------------------------------------
    const inMemoryQueueLen = qm.getQueueLength();
    const effectiveQueueLen = Math.max(inMemoryQueueLen, queueEntries.length);
    let nextRumbleIn: string | null = null;
    if (effectiveQueueLen > 0 && effectiveQueueLen < 8) {
      nextRumbleIn = `Need ${8 - effectiveQueueLen} more fighters`;
    } else if (effectiveQueueLen >= 8) {
      const hasIdleSlot = slots.some((s) => s.state === "idle");
      nextRumbleIn = hasIdleSlot ? "Starting soon..." : "All slots active";
    }

    // ---- queueLength: in-queue + in-combat fighters for display ------------
    const activeFighterCount = slots.reduce(
      (sum, s) => sum + (s.state !== "idle" ? s.fighters.length : 0),
      0,
    );

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
    });
  } catch (error: any) {
    console.error("[StatusAPI]", error);
    return NextResponse.json({ error: "Failed to fetch rumble status" }, { status: 500 });
  }
}
