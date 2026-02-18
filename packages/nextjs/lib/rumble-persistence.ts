// =============================================================================
// Rumble Persistence Layer — Syncs orchestrator state to Supabase tables
//
// IMPORTANT: Every function creates a FRESH Supabase client using the
// service role key to bypass RLS. This avoids stale-data issues from
// Next.js fetch caching and the shared Proxy client.
//
// All functions are fire-and-forget safe: they log errors but never throw,
// so the in-memory orchestrator keeps running even if persistence fails.
// =============================================================================

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { RumblePayoutMode } from "./rumble-payout-mode";

// ---------------------------------------------------------------------------
// Fresh service-role client factory
// ---------------------------------------------------------------------------

const noStoreFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, cache: "no-store" });

function freshServiceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: noStoreFetch },
  });
}

function log(msg: string, ...args: unknown[]) {
  console.log(`[RumblePersistence] ${msg}`, ...args);
}

function logError(msg: string, err: unknown) {
  console.error(`[RumblePersistence] ${msg}`, err);
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

export async function saveQueueFighter(
  fighterId: string,
  status: "waiting" | "matched" | "in_combat",
  autoRequeue: boolean = false,
): Promise<void> {
  try {
    const sb = freshServiceClient();
    const { error } = await sb
      .from("ucf_rumble_queue")
      .upsert(
        { fighter_id: fighterId, status, auto_requeue: autoRequeue },
        { onConflict: "fighter_id" },
      )
      .select();
    if (error) throw error;
  } catch (err) {
    logError("saveQueueFighter failed", err);
  }
}

export async function removeQueueFighter(fighterId: string): Promise<void> {
  try {
    const sb = freshServiceClient();
    const { error } = await sb
      .from("ucf_rumble_queue")
      .delete()
      .eq("fighter_id", fighterId);
    if (error) throw error;
  } catch (err) {
    logError("removeQueueFighter failed", err);
  }
}

export async function loadQueueState(): Promise<
  Array<{ fighter_id: string; auto_requeue: boolean; status: string }>
> {
  try {
    const sb = freshServiceClient();
    const { data, error } = await sb
      .from("ucf_rumble_queue")
      .select("fighter_id, auto_requeue, status")
      .eq("status", "waiting")
      .order("joined_at", { ascending: true });
    if (error) throw error;
    return data ?? [];
  } catch (err) {
    logError("loadQueueState failed", err);
    return [];
  }
}

export async function clearQueueByStatus(
  status: "waiting" | "matched" | "in_combat",
): Promise<void> {
  try {
    const sb = freshServiceClient();
    const { error } = await sb
      .from("ucf_rumble_queue")
      .delete()
      .eq("status", status);
    if (error) throw error;
  } catch (err) {
    logError("clearQueueByStatus failed", err);
  }
}

export async function countBetsForRumble(rumbleId: string): Promise<number> {
  try {
    const sb = freshServiceClient();
    const { count, error } = await sb
      .from("ucf_bets")
      .select("id", { count: "exact", head: true })
      .eq("rumble_id", rumbleId);
    if (error) throw error;
    return count ?? 0;
  } catch (err) {
    logError("countBetsForRumble failed", err);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Rumbles
// ---------------------------------------------------------------------------

export interface CreateRumbleInput {
  id: string;
  slotIndex: number;
  fighters: Array<{ id: string; name: string }>;
}

export async function createRumbleRecord(input: CreateRumbleInput): Promise<void> {
  try {
    const sb = freshServiceClient();
    const { error } = await sb
      .from("ucf_rumbles")
      .insert({
        id: input.id,
        slot_index: input.slotIndex,
        status: "betting",
        fighters: input.fighters,
      })
      .select();
    if (error) throw error;
    log("Created rumble record", input.id);
  } catch (err) {
    logError("createRumbleRecord failed", err);
  }
}

export async function updateRumbleStatus(
  rumbleId: string,
  status: "betting" | "combat" | "payout" | "complete",
  extra: Record<string, unknown> = {},
): Promise<void> {
  try {
    const sb = freshServiceClient();
    const updates: Record<string, unknown> = { status, ...extra };
    if (status === "combat") updates.started_at = new Date().toISOString();
    if (status === "complete") updates.completed_at = new Date().toISOString();

    const { error } = await sb
      .from("ucf_rumbles")
      .update(updates)
      .eq("id", rumbleId)
      .select();
    if (error) throw error;
  } catch (err) {
    logError("updateRumbleStatus failed", err);
  }
}

export async function updateRumbleTurnLog(
  rumbleId: string,
  turnLog: unknown[],
  totalTurns: number,
): Promise<void> {
  try {
    const sb = freshServiceClient();
    const { error } = await sb
      .from("ucf_rumbles")
      .update({ turn_log: turnLog, total_turns: totalTurns })
      .eq("id", rumbleId)
      .select();
    if (error) throw error;
  } catch (err) {
    logError("updateRumbleTurnLog failed", err);
  }
}

export async function loadRumbleTurnLog(
  rumbleId: string,
): Promise<unknown[] | null> {
  try {
    const sb = freshServiceClient();
    const { data, error } = await sb
      .from("ucf_rumbles")
      .select("turn_log, total_turns")
      .eq("id", rumbleId)
      .single();
    if (error) throw error;
    if (!data || !Array.isArray(data.turn_log) || data.turn_log.length === 0) return null;
    return data.turn_log;
  } catch (err) {
    logError("loadRumbleTurnLog failed", err);
    return null;
  }
}

export async function completeRumbleRecord(
  rumbleId: string,
  winnerId: string,
  placements: unknown[],
  turnLog: unknown[],
  totalTurns: number,
): Promise<void> {
  try {
    const sb = freshServiceClient();
    const { error } = await sb
      .from("ucf_rumbles")
      .update({
        status: "complete",
        winner_id: winnerId,
        placements,
        turn_log: turnLog,
        total_turns: totalTurns,
        completed_at: new Date().toISOString(),
      })
      .eq("id", rumbleId)
      .select();
    if (error) throw error;
    log("Completed rumble record", rumbleId);
  } catch (err) {
    logError("completeRumbleRecord failed", err);
  }
}

export async function loadActiveRumbles(): Promise<
  Array<{
    id: string;
    slot_index: number;
    status: string;
    fighters: unknown;
    created_at: string;
    started_at: string | null;
    turn_log: unknown[] | null;
    total_turns: number;
  }>
> {
  try {
    const sb = freshServiceClient();
    const { data, error } = await sb
      .from("ucf_rumbles")
      .select("id, slot_index, status, fighters, created_at, started_at, turn_log, total_turns")
      .in("status", ["betting", "combat", "payout"])
      .order("created_at", { ascending: true });
    if (error) throw error;
    return data ?? [];
  } catch (err) {
    logError("loadActiveRumbles failed", err);
    return [];
  }
}

export interface CompletedRumbleForOnchainReconcile {
  id: string;
  status: string;
  winner_id: string | null;
  placements: unknown;
  fighters: unknown;
  tx_signatures: Record<string, string | null> | null;
  completed_at: string | null;
}

export interface PendingSettlementRumble {
  id: string;
  status: string;
  winner_id: string | null;
  placements: unknown;
  fighters: unknown;
  pending_rows: number;
  pending_net_sol: number;
}

/**
 * Load recent completed rumbles so we can reconcile on-chain report_result
 * if a previous on-chain settlement step failed.
 */
export async function loadRecentCompletedRumblesForOnchainReconcile(
  limit: number = 20,
): Promise<CompletedRumbleForOnchainReconcile[]> {
  try {
    const sb = freshServiceClient();
    const since = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
    const { data, error } = await sb
      .from("ucf_rumbles")
      .select("id, status, winner_id, placements, fighters, tx_signatures, completed_at")
      .eq("status", "complete")
      .gte("completed_at", since)
      .order("completed_at", { ascending: false })
      .limit(Math.max(1, Math.min(limit, 100)));
    if (error) throw error;
    return (data as CompletedRumbleForOnchainReconcile[]) ?? [];
  } catch (err) {
    logError("loadRecentCompletedRumblesForOnchainReconcile failed", err);
    return [];
  }
}

/**
 * Load rumbles that still have pending rows with null payout_amount.
 * These are candidates for stale payout reconciliation.
 */
export async function loadPendingSettlementRumbles(
  limit: number = 40,
): Promise<PendingSettlementRumble[]> {
  try {
    const sb = freshServiceClient();
    const { data: pendingRows, error: pendingError } = await sb
      .from("ucf_bets")
      .select("rumble_id, net_amount")
      .eq("payout_status", "pending")
      .is("payout_amount", null)
      .order("placed_at", { ascending: false })
      .limit(Math.max(1, Math.min(limit * 25, 1000)));
    if (pendingError) throw pendingError;

    const pendingByRumble = new Map<string, { rows: number; netSol: number }>();
    for (const row of pendingRows ?? []) {
      const rumbleId = String((row as any).rumble_id ?? "");
      if (!rumbleId) continue;
      const current = pendingByRumble.get(rumbleId) ?? { rows: 0, netSol: 0 };
      current.rows += 1;
      current.netSol += toNumber((row as any).net_amount);
      pendingByRumble.set(rumbleId, current);
    }
    const rumbleIds = [...pendingByRumble.keys()].slice(0, Math.max(1, Math.min(limit, 200)));
    if (rumbleIds.length === 0) return [];

    const { data: rumbleRows, error: rumbleError } = await sb
      .from("ucf_rumbles")
      .select("id, status, winner_id, placements, fighters")
      .in("id", rumbleIds);
    if (rumbleError) throw rumbleError;

    const out: PendingSettlementRumble[] = [];
    for (const row of rumbleRows ?? []) {
      const id = String((row as any).id ?? "");
      const pending = pendingByRumble.get(id);
      if (!id || !pending) continue;
      out.push({
        id,
        status: String((row as any).status ?? ""),
        winner_id:
          typeof (row as any).winner_id === "string" ? String((row as any).winner_id) : null,
        placements: (row as any).placements ?? null,
        fighters: (row as any).fighters ?? null,
        pending_rows: pending.rows,
        pending_net_sol: pending.netSol,
      });
    }

    out.sort((a, b) => b.pending_net_sol - a.pending_net_sol);
    return out;
  } catch (err) {
    logError("loadPendingSettlementRumbles failed", err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Bets
// ---------------------------------------------------------------------------

export interface SaveBetInput {
  rumbleId: string;
  walletAddress: string;
  fighterId: string;
  grossAmount: number;
  netAmount: number;
  adminFee: number;
  sponsorFee: number;
}

export type SaveBetsResult = { ok: true } | { ok: false; reason: string };

export async function saveBets(inputs: SaveBetInput[]): Promise<SaveBetsResult> {
  if (inputs.length === 0) return { ok: true };
  const rows = inputs.map((input) => ({
    rumble_id: input.rumbleId,
    wallet_address: input.walletAddress,
    fighter_id: input.fighterId,
    gross_amount: input.grossAmount,
    net_amount: input.netAmount,
    admin_fee: input.adminFee,
    sponsor_fee: input.sponsorFee,
  }));

  let lastReason = "Unknown persistence error.";
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const sb = freshServiceClient();
      const { error } = await sb.from("ucf_bets").insert(rows).select();
      if (error) throw error;
      return { ok: true };
    } catch (err: unknown) {
      const isLastAttempt = attempt === maxAttempts;
      const supaErr = err && typeof err === "object" && "message" in err ? (err as { message: string; code?: string; details?: string }) : null;
      const detail = supaErr
        ? `code=${supaErr.code ?? "?"} message="${supaErr.message}" details="${supaErr.details ?? ""}"`
        : String(err);
      logError(
        `saveBets failed (attempt ${attempt}/${maxAttempts}) rumbleIds=[${rows.map(r => r.rumble_id).join(",")}] — ${detail}`,
        err,
      );

      // Detect the "one fighter per wallet" trigger — no point retrying
      const msg = supaErr?.message ?? String(err);
      if (msg.includes("already bet on a different fighter")) {
        return { ok: false, reason: "You already bet on another fighter in this rumble. One fighter per wallet per rumble." };
      }

      lastReason = supaErr?.message ?? "Bet registration failed. Please retry with the same signed transaction.";
      if (isLastAttempt) return { ok: false, reason: lastReason };
      await new Promise(resolve => setTimeout(resolve, 150 * attempt));
    }
  }
  return { ok: false, reason: lastReason };
}

export async function saveBet(input: SaveBetInput): Promise<void> {
  await saveBets([input]);
}

export async function loadBetsForRumble(
  rumbleId: string,
): Promise<
  Array<{
    id: string;
    wallet_address: string;
    fighter_id: string;
    gross_amount: number;
    net_amount: number;
    payout_status: string;
  }>
> {
  try {
    const sb = freshServiceClient();
    const { data, error } = await sb
      .from("ucf_bets")
      .select("id, wallet_address, fighter_id, gross_amount, net_amount, payout_status")
      .eq("rumble_id", rumbleId);
    if (error) throw error;
    return data ?? [];
  } catch (err) {
    logError("loadBetsForRumble failed", err);
    return [];
  }
}

export interface BetPayoutUpdate {
  betId: string;
  payoutAmount: number;
  payoutStatus: "pending" | "paid" | "lost";
}

export async function updateBetPayouts(
  rumbleId: string,
  payouts: BetPayoutUpdate[],
): Promise<void> {
  try {
    const sb = freshServiceClient();
    // Batch update: use individual updates within a single try/catch
    // Supabase JS client doesn't support batch updates natively,
    // so we run them in parallel with Promise.all.
    const updates = payouts.map((p) =>
      sb
        .from("ucf_bets")
        .update({ payout_amount: p.payoutAmount, payout_status: p.payoutStatus })
        .eq("id", p.betId)
        .select(),
    );
    const results = await Promise.all(updates);
    for (const { error } of results) {
      if (error) throw error;
    }
    log(`Updated ${payouts.length} bet payouts for rumble ${rumbleId}`);
  } catch (err) {
    logError("updateBetPayouts failed", err);
  }
}

/**
 * Mark all bets on losing fighters as 'lost' for a given rumble.
 */
export async function markLosingBets(
  rumbleId: string,
  losingFighterIds: string[],
): Promise<void> {
  if (losingFighterIds.length === 0) return;
  try {
    const sb = freshServiceClient();
    const { error } = await sb
      .from("ucf_bets")
      .update({ payout_amount: 0, payout_status: "lost" })
      .eq("rumble_id", rumbleId)
      .in("fighter_id", losingFighterIds)
      .select();
    if (error) throw error;
  } catch (err) {
    logError("markLosingBets failed", err);
  }
}

/**
 * Settle winner-takes-all payouts into ucf_bets.
 * Winners are marked:
 * - pending in accrue_claim mode (user must claim)
 * - paid in instant mode
 */
export async function settleWinnerTakeAllBets(
  rumbleId: string,
  winnerFighterId: string,
  payoutMode: RumblePayoutMode,
): Promise<void> {
  try {
    const sb = freshServiceClient();
    const { data, error } = await sb
      .from("ucf_bets")
      .select("id, fighter_id, net_amount")
      .eq("rumble_id", rumbleId);
    if (error) throw error;

    const bets = (data ?? []).map((row: any) => ({
      id: String(row.id),
      fighterId: String(row.fighter_id),
      netAmount: toNumber(row.net_amount),
    }));
    if (bets.length === 0) return;

    const totalByFighter = new Map<string, number>();
    for (const bet of bets) {
      totalByFighter.set(
        bet.fighterId,
        (totalByFighter.get(bet.fighterId) ?? 0) + bet.netAmount,
      );
    }

    const winnerPool = totalByFighter.get(winnerFighterId) ?? 0;
    let losersPool = 0;
    for (const [fighterId, total] of totalByFighter) {
      if (fighterId !== winnerFighterId) losersPool += total;
    }

    const treasuryCut = losersPool * 0.1;
    const distributable = Math.max(0, losersPool - treasuryCut);
    const winnerStatus = payoutMode === "accrue_claim" ? "pending" : "paid";

    const updates = bets.map((bet) => {
      if (bet.fighterId !== winnerFighterId) {
        return {
          betId: bet.id,
          payoutAmount: 0,
          payoutStatus: "lost" as const,
        };
      }
      const winningsShare =
        winnerPool > 0 ? (distributable * bet.netAmount) / winnerPool : 0;
      const payoutAmount = bet.netAmount + winningsShare;
      return {
        betId: bet.id,
        payoutAmount,
        payoutStatus: winnerStatus as "pending" | "paid",
      };
    });

    await updateBetPayouts(rumbleId, updates);
    log(
      `Settled ${updates.length} bets for rumble ${rumbleId} (${payoutMode}, winner=${winnerFighterId})`,
    );
  } catch (err) {
    logError("settleWinnerTakeAllBets failed", err);
  }
}

export interface WalletClaimableRumble {
  rumbleId: string;
  claimableSol: number;
}

export interface WalletPayoutBalance {
  claimableSol: number;
  claimedSol: number;
  unsettledSol: number;
  orphanedSol: number;
  pendingRumbles: WalletClaimableRumble[];
}

/**
 * Returns payout balances for a wallet from persisted bet settlement state.
 */
export async function getWalletPayoutBalance(
  walletAddress: string,
): Promise<WalletPayoutBalance> {
  try {
    const sb = freshServiceClient();
    const { data, error } = await sb
      .from("ucf_bets")
      .select("rumble_id, payout_status, payout_amount, net_amount")
      .eq("wallet_address", walletAddress);
    if (error) throw error;

    let claimableSol = 0;
    let claimedSol = 0;
    let unsettledSol = 0;
    let orphanedSol = 0;
    const pendingByRumble = new Map<string, number>();
    const unsettledCandidates: Array<{ rumbleId: string; netAmount: number }> = [];

    for (const row of data ?? []) {
      const status = String((row as any).payout_status ?? "pending");
      const payoutAmount = toNumber((row as any).payout_amount);
      const netAmount = toNumber((row as any).net_amount);
      const rumbleId = String((row as any).rumble_id ?? "");

      if (status === "paid") {
        claimedSol += payoutAmount;
        continue;
      }
      if (status === "lost") {
        continue;
      }

      // status pending
      if (payoutAmount > 0) {
        claimableSol += payoutAmount;
        pendingByRumble.set(rumbleId, (pendingByRumble.get(rumbleId) ?? 0) + payoutAmount);
      } else if (netAmount > 0) {
        unsettledCandidates.push({ rumbleId, netAmount });
      }
    }

    if (unsettledCandidates.length > 0) {
      const unsettledRumbleIds = [...new Set(unsettledCandidates.map((row) => row.rumbleId))];
      const { data: rumbleRows, error: rumbleError } = await sb
        .from("ucf_rumbles")
        .select("id, status, winner_id")
        .in("id", unsettledRumbleIds);
      if (rumbleError) throw rumbleError;

      const rumbleMeta = new Map<string, { status: string; winnerId: string | null }>();
      for (const row of rumbleRows ?? []) {
        rumbleMeta.set(String((row as any).id ?? ""), {
          status: String((row as any).status ?? ""),
          winnerId:
            typeof (row as any).winner_id === "string" ? String((row as any).winner_id) : null,
        });
      }

      for (const row of unsettledCandidates) {
        const meta = rumbleMeta.get(row.rumbleId);
        // Only show "unsettled" for in-flight rumbles.
        if (!meta || meta.status === "betting" || meta.status === "combat" || meta.status === "payout") {
          unsettledSol += row.netAmount;
          continue;
        }

        // Completed rumbles with pending rows are stale/orphaned and should not
        // block the claim UX as "unsettled". Track separately for diagnostics.
        if (meta.status === "complete") {
          orphanedSol += row.netAmount;
          continue;
        }

        // Unknown status fallback.
        unsettledSol += row.netAmount;
      }
    }

    const pendingRumbles = [...pendingByRumble.entries()]
      .map(([rumbleId, amount]) => ({ rumbleId, claimableSol: amount }))
      .sort((a, b) => b.claimableSol - a.claimableSol);

    return { claimableSol, claimedSol, unsettledSol, orphanedSol, pendingRumbles };
  } catch (err) {
    logError("getWalletPayoutBalance failed", err);
    return { claimableSol: 0, claimedSol: 0, unsettledSol: 0, orphanedSol: 0, pendingRumbles: [] };
  }
}

/**
 * Marks a rumble's pending payouts as paid for this wallet after a claim tx confirms.
 */
export async function markWalletRumbleClaimed(
  walletAddress: string,
  rumbleId: string,
): Promise<{ updated: number; claimedSol: number }> {
  try {
    const sb = freshServiceClient();
    const { data: pendingRows, error: readError } = await sb
      .from("ucf_bets")
      .select("id, payout_amount")
      .eq("wallet_address", walletAddress)
      .eq("rumble_id", rumbleId)
      .eq("payout_status", "pending");
    if (readError) throw readError;

    const targetRows = (pendingRows ?? []).filter(
      (row: any) => toNumber(row.payout_amount) > 0,
    );
    if (targetRows.length === 0) return { updated: 0, claimedSol: 0 };

    let claimedSol = 0;
    for (const row of targetRows) {
      claimedSol += toNumber((row as any).payout_amount);
    }

    const ids = targetRows.map((row: any) => String(row.id));
    const { data: updatedRows, error: updateError } = await sb
      .from("ucf_bets")
      .update({ payout_status: "paid" })
      .in("id", ids)
      .select("id");
    if (updateError) throw updateError;

    return { updated: updatedRows?.length ?? 0, claimedSol };
  } catch (err) {
    logError("markWalletRumbleClaimed failed", err);
    return { updated: 0, claimedSol: 0 };
  }
}

// ---------------------------------------------------------------------------
// Ichor Shower
// ---------------------------------------------------------------------------

export async function updateIchorShowerPool(poolIncrement: number): Promise<void> {
  try {
    const sb = freshServiceClient();
    const { error } = await sb.rpc("increment_ichor_shower_pool", {
      delta_pool_amount: poolIncrement,
    });
    if (error) throw error;
  } catch (err) {
    logError("updateIchorShowerPool failed", err);
  }
}

export async function triggerIchorShower(
  rumbleId: string,
  winnerWallet: string,
  payout: number,
): Promise<void> {
  try {
    const sb = freshServiceClient();
    const { data: rows, error: fetchErr } = await sb
      .from("ucf_ichor_shower")
      .select("id")
      .limit(1)
      .single();
    if (fetchErr) throw fetchErr;

    const { error } = await sb
      .from("ucf_ichor_shower")
      .update({
        pool_amount: 0,
        last_trigger_rumble_id: rumbleId,
        last_winner_wallet: winnerWallet,
        last_payout: payout,
        updated_at: new Date().toISOString(),
      })
      .eq("id", rows.id)
      .select();
    if (error) throw error;
    log("Ichor Shower triggered!", { rumbleId, winnerWallet, payout });
  } catch (err) {
    logError("triggerIchorShower failed", err);
  }
}

export async function getIchorShowerState(): Promise<{
  pool_amount: number;
  last_winner_wallet: string | null;
  last_payout: number | null;
} | null> {
  try {
    const sb = freshServiceClient();
    const { data, error } = await sb
      .from("ucf_ichor_shower")
      .select("pool_amount, last_winner_wallet, last_payout")
      .limit(1)
      .single();
    if (error) throw error;
    return data;
  } catch (err) {
    logError("getIchorShowerState failed", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export async function incrementStats(
  solWagered: number,
  ichorMinted: number,
  ichorBurned: number,
): Promise<void> {
  try {
    const sb = freshServiceClient();
    const { error } = await sb.rpc("increment_rumble_stats", {
      delta_sol_wagered: solWagered,
      delta_ichor_minted: ichorMinted,
      delta_ichor_burned: ichorBurned,
    });
    if (error) throw error;
  } catch (err) {
    logError("incrementStats failed", err);
  }
}

// ---------------------------------------------------------------------------
// Fighter Wallet Lookup
// ---------------------------------------------------------------------------

/**
 * Look up Solana wallet addresses for fighters by either fighter id or fighter name.
 * Returns a map keyed by the original lookup token (id/name) -> wallet_address.
 */
export async function lookupFighterWallets(
  fighterKeys: string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (fighterKeys.length === 0) return result;
  try {
    const sb = freshServiceClient();
    const uniqueKeys = [...new Set(fighterKeys.filter(Boolean))];
    const [byIdRes, byNameRes] = await Promise.all([
      sb
        .from("ucf_fighters")
        .select("id, name, wallet_address")
        .in("id", uniqueKeys),
      sb
        .from("ucf_fighters")
        .select("id, name, wallet_address")
        .in("name", uniqueKeys),
    ]);
    if (byIdRes.error) throw byIdRes.error;
    if (byNameRes.error) throw byNameRes.error;

    const rows = [...(byIdRes.data ?? []), ...(byNameRes.data ?? [])];
    for (const row of rows) {
      if (!row.wallet_address) continue;
      if (row.id && uniqueKeys.includes(row.id)) result.set(row.id, row.wallet_address);
      if (row.name && uniqueKeys.includes(row.name)) result.set(row.name, row.wallet_address);
    }
  } catch (err) {
    logError("lookupFighterWallets failed", err);
  }
  return result;
}

export interface RumbleFighterProfile {
  id: string;
  name: string;
  webhookUrl: string | null;
}

/**
 * Load fighter profiles required by rumble combat orchestration.
 */
export async function loadRumbleFighterProfiles(
  fighterIds: string[],
): Promise<Map<string, RumbleFighterProfile>> {
  const result = new Map<string, RumbleFighterProfile>();
  if (fighterIds.length === 0) return result;

  try {
    const sb = freshServiceClient();
    const uniqueIds = [...new Set(fighterIds.filter(Boolean))];
    const { data, error } = await sb
      .from("ucf_fighters")
      .select("id, name, webhook_url")
      .in("id", uniqueIds);
    if (error) throw error;

    for (const row of data ?? []) {
      const id = String((row as any).id ?? "");
      if (!id) continue;
      result.set(id, {
        id,
        name: String((row as any).name ?? id),
        webhookUrl:
          typeof (row as any).webhook_url === "string" && (row as any).webhook_url.trim().length > 0
            ? String((row as any).webhook_url)
            : null,
      });
    }
  } catch (err) {
    logError("loadRumbleFighterProfiles failed", err);
  }

  return result;
}

export async function getStats(): Promise<{
  total_rumbles: number;
  total_sol_wagered: number;
  total_ichor_minted: number;
  total_ichor_burned: number;
} | null> {
  try {
    const sb = freshServiceClient();
    const { data, error } = await sb
      .from("ucf_rumble_stats")
      .select("total_rumbles, total_sol_wagered, total_ichor_minted, total_ichor_burned")
      .limit(1)
      .single();
    if (error) throw error;
    return data;
  } catch (err) {
    logError("getStats failed", err);
    return null;
  }
}

/* ── Tx signature tracking ───────────────────────────────── */

export type TxStep =
  | "createRumble"
  | "startCombat"
  | "openTurn"
  | "resolveTurn"
  | "advanceTurn"
  | "distributeReward"
  | "reportResult"
  | "mintRumbleReward"
  | "checkIchorShower"
  | "completeRumble"
  | "sweepTreasury";

export async function updateRumbleTxSignature(
  rumbleId: string,
  step: TxStep,
  sig: string | null,
): Promise<void> {
  try {
    const sb = freshServiceClient();
    // Read current tx_signatures, merge, write back
    const { data, error: readErr } = await sb
      .from("ucf_rumbles")
      .select("tx_signatures")
      .eq("id", rumbleId)
      .single();
    if (readErr) throw readErr;

    const existing = (data?.tx_signatures as Record<string, string | null>) ?? {};
    existing[step] = sig;

    const { error: writeErr } = await sb
      .from("ucf_rumbles")
      .update({ tx_signatures: existing })
      .eq("id", rumbleId);
    if (writeErr) throw writeErr;
  } catch (err) {
    logError(`updateRumbleTxSignature(${rumbleId}, ${step}) failed`, err);
  }
}
