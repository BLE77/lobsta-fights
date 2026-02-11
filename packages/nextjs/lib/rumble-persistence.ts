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
  Array<{ id: string; slot_index: number; status: string; fighters: unknown }>
> {
  try {
    const sb = freshServiceClient();
    const { data, error } = await sb
      .from("ucf_rumbles")
      .select("id, slot_index, status, fighters")
      .in("status", ["betting", "combat", "payout"])
      .order("created_at", { ascending: true });
    if (error) throw error;
    return data ?? [];
  } catch (err) {
    logError("loadActiveRumbles failed", err);
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

export async function saveBet(input: SaveBetInput): Promise<void> {
  try {
    const sb = freshServiceClient();
    const { error } = await sb
      .from("ucf_bets")
      .insert({
        rumble_id: input.rumbleId,
        wallet_address: input.walletAddress,
        fighter_id: input.fighterId,
        gross_amount: input.grossAmount,
        net_amount: input.netAmount,
        admin_fee: input.adminFee,
        sponsor_fee: input.sponsorFee,
      })
      .select();
    if (error) throw error;
  } catch (err) {
    logError("saveBet failed", err);
  }
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
 * Look up Solana wallet addresses for fighters by their name (used as fighter_id).
 * Returns a map of fighter_id → wallet_address.
 */
export async function lookupFighterWallets(
  fighterIds: string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (fighterIds.length === 0) return result;
  try {
    const sb = freshServiceClient();
    const { data, error } = await sb
      .from("ucf_fighters")
      .select("name, wallet_address")
      .in("name", fighterIds);
    if (error) throw error;
    for (const row of data ?? []) {
      if (row.wallet_address) {
        result.set(row.name, row.wallet_address);
      }
    }
  } catch (err) {
    logError("lookupFighterWallets failed", err);
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
