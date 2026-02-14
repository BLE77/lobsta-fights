/**
 * Backfill winner-takes-all payout rows for historical rumbles.
 *
 * Default is dry run. Pass --apply to persist updates.
 *
 * Usage:
 *   node scripts/backfill-rumble-claims.mjs
 *   node scripts/backfill-rumble-claims.mjs --apply
 *   node scripts/backfill-rumble-claims.mjs --apply --mode=accrue_claim
 *   node scripts/backfill-rumble-claims.mjs --rumble-id=<uuid>
 *   node scripts/backfill-rumble-claims.mjs --apply --void-unresolved
 */

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";

function loadDotEnvLocal() {
  const envPath = path.resolve(process.cwd(), ".env.local");
  if (!fs.existsSync(envPath)) return;
  const contents = fs.readFileSync(envPath, "utf8");
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    while (
      value.length >= 2 &&
      ((value.startsWith("\"") && value.endsWith("\"")) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function parseArgs(argv) {
  const apply = argv.includes("--apply");
  const forcePartial = argv.includes("--force-partial");
  const voidUnresolved = argv.includes("--void-unresolved");

  const modeArg = argv.find(arg => arg.startsWith("--mode="))?.split("=")[1];
  const mode = modeArg === "instant" ? "instant" : "accrue_claim";

  const rumbleId = argv.find(arg => arg.startsWith("--rumble-id="))?.split("=")[1];
  const limitRaw = argv.find(arg => arg.startsWith("--limit="))?.split("=")[1];
  const limit = limitRaw ? Number(limitRaw) : undefined;

  return { apply, mode, rumbleId, limit, forcePartial, voidUnresolved };
}

function toNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function winnerFromPlacements(placements) {
  if (!Array.isArray(placements)) return null;
  const first = placements.find(entry => entry?.placement === 1);
  if (first?.id && typeof first.id === "string") return first.id;
  const fallback = placements[0];
  return typeof fallback?.id === "string" ? fallback.id : null;
}

function planWinnerTakeAllUpdates(rows, winnerFighterId, mode) {
  const totalsByFighter = new Map();
  for (const row of rows) {
    totalsByFighter.set(
      row.fighter_id,
      (totalsByFighter.get(row.fighter_id) ?? 0) + row.net_amount,
    );
  }

  const winnerPool = totalsByFighter.get(winnerFighterId) ?? 0;
  let losersPool = 0;
  for (const [fighterId, amount] of totalsByFighter) {
    if (fighterId !== winnerFighterId) losersPool += amount;
  }

  const treasuryCut = losersPool * 0.1;
  const distributable = Math.max(0, losersPool - treasuryCut);
  const winnerStatus = mode === "accrue_claim" ? "pending" : "paid";

  return rows.map(row => {
    if (row.fighter_id !== winnerFighterId) {
      return { id: row.id, payoutAmount: 0, payoutStatus: "lost" };
    }
    const winningsShare = winnerPool > 0 ? (distributable * row.net_amount) / winnerPool : 0;
    return {
      id: row.id,
      payoutAmount: row.net_amount + winningsShare,
      payoutStatus: winnerStatus,
    };
  });
}

async function main() {
  loadDotEnvLocal();
  const options = parseArgs(process.argv.slice(2));

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }

  const sb = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: (input, init) => fetch(input, { ...init, cache: "no-store" }) },
  });

  let rumbleQuery = sb
    .from("ucf_rumbles")
    .select("id, winner_id, placements, status")
    .in("status", ["complete", "payout"])
    .order("completed_at", { ascending: true });

  if (options.rumbleId) rumbleQuery = rumbleQuery.eq("id", options.rumbleId);
  if (typeof options.limit === "number" && options.limit > 0) rumbleQuery = rumbleQuery.limit(options.limit);

  const { data: rumbleRowsRaw, error: rumbleErr } = await rumbleQuery;
  if (rumbleErr) throw rumbleErr;
  const rumbleRows = rumbleRowsRaw ?? [];

  console.log(`[Backfill] Found ${rumbleRows.length} candidate rumbles`);
  console.log(
    `[Backfill] Mode=${options.mode} Apply=${options.apply} ForcePartial=${options.forcePartial} VoidUnresolved=${options.voidUnresolved}`,
  );

  let totalRumblesUpdated = 0;
  let totalBetsUpdated = 0;

  for (const rumble of rumbleRows) {
    const winnerId = rumble.winner_id ?? winnerFromPlacements(rumble.placements);
    if (!winnerId) {
      const { data: unresolvedRows, error: unresolvedErr } = await sb
        .from("ucf_bets")
        .select("id")
        .eq("rumble_id", rumble.id)
        .eq("payout_status", "pending")
        .is("payout_amount", null);

      if (unresolvedErr) {
        console.warn(`[Backfill] ${rumble.id}: failed to inspect unresolved rows`, unresolvedErr.message);
        continue;
      }

      const unresolvedIds = (unresolvedRows ?? []).map(row => String(row.id));
      if (!options.voidUnresolved) {
        console.warn(
          `[Backfill] ${rumble.id}: skipped (missing winner_id/placements, unresolvedRows=${unresolvedIds.length})`,
        );
        continue;
      }

      console.warn(
        `[Backfill] ${rumble.id}: missing winner metadata; ${options.apply ? "voiding" : "would void"} ${unresolvedIds.length} unresolved pending rows`,
      );

      if (!options.apply || unresolvedIds.length === 0) {
        continue;
      }

      const CHUNK = 250;
      let failed = 0;
      for (let i = 0; i < unresolvedIds.length; i += CHUNK) {
        const ids = unresolvedIds.slice(i, i + CHUNK);
        const { error: updateErr } = await sb
          .from("ucf_bets")
          .update({ payout_amount: 0, payout_status: "lost" })
          .in("id", ids);
        if (updateErr) {
          failed += ids.length;
          console.warn(`[Backfill] ${rumble.id}: void chunk failed`, updateErr.message);
        } else {
          totalBetsUpdated += ids.length;
        }
      }

      if (failed === 0) {
        totalRumblesUpdated += 1;
      }
      continue;
    }

    const { data: betsRaw, error: betsErr } = await sb
      .from("ucf_bets")
      .select("id, fighter_id, net_amount, payout_amount, payout_status")
      .eq("rumble_id", rumble.id);

    if (betsErr) {
      console.warn(`[Backfill] ${rumble.id}: failed to load bets`, betsErr.message);
      continue;
    }

    const bets = (betsRaw ?? []).map(row => ({
      id: String(row.id),
      fighter_id: String(row.fighter_id),
      net_amount: toNumber(row.net_amount),
      payout_amount: row.payout_amount === null ? null : toNumber(row.payout_amount),
      payout_status: row.payout_status ?? "pending",
    }));

    if (bets.length === 0) {
      console.log(`[Backfill] ${rumble.id}: no bets, skipping`);
      continue;
    }

    const settledRows = bets.filter(b => b.payout_amount !== null);
    if (settledRows.length === bets.length) {
      console.log(`[Backfill] ${rumble.id}: already settled, skipping`);
      continue;
    }
    if (settledRows.length > 0 && !options.forcePartial) {
      console.warn(
        `[Backfill] ${rumble.id}: partially settled (${settledRows.length}/${bets.length}), skipping (use --force-partial)`,
      );
      continue;
    }

    const targetRows = options.forcePartial ? bets : bets.filter(b => b.payout_amount === null);
    const planned = planWinnerTakeAllUpdates(targetRows, winnerId, options.mode);

    const claimable = planned
      .filter(p => p.payoutStatus === "pending")
      .reduce((sum, p) => sum + p.payoutAmount, 0);
    const instantPaid = planned
      .filter(p => p.payoutStatus === "paid")
      .reduce((sum, p) => sum + p.payoutAmount, 0);

    console.log(
      `[Backfill] ${rumble.id}: winner=${winnerId} updates=${planned.length} claimable=${claimable.toFixed(6)} instantPaid=${instantPaid.toFixed(6)}`,
    );

    if (!options.apply) continue;

    const writes = planned.map(update =>
      sb
        .from("ucf_bets")
        .update({
          payout_amount: update.payoutAmount,
          payout_status: update.payoutStatus,
        })
        .eq("id", update.id),
    );

    const results = await Promise.all(writes);
    const failed = results.filter(r => r.error);
    if (failed.length > 0) {
      console.warn(`[Backfill] ${rumble.id}: ${failed.length} row updates failed`);
      continue;
    }

    totalRumblesUpdated += 1;
    totalBetsUpdated += planned.length;
  }

  if (options.apply) {
    console.log(`[Backfill] Completed. rumblesUpdated=${totalRumblesUpdated} betsUpdated=${totalBetsUpdated}`);
  } else {
    console.log("[Backfill] Dry run complete. Re-run with --apply to write updates.");
  }
}

main().catch(error => {
  console.error("[Backfill] Fatal:", error);
  process.exit(1);
});
