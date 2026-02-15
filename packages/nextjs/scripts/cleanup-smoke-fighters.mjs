#!/usr/bin/env node
/**
 * Cleanup smoke/test fighters by name prefix.
 *
 * Usage:
 *   node scripts/cleanup-smoke-fighters.mjs --prefix=SMOKE-RUMBLE-
 *   node scripts/cleanup-smoke-fighters.mjs --prefix=SMOKE-RUMBLE- --dry-run
 *
 * Requires env vars (reads from .env.local automatically):
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Parse .env.local for required vars
function loadEnv() {
  try {
    const envPath = resolve(process.cwd(), ".env.local");
    const content = readFileSync(envPath, "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if (
        (val.startsWith("\"") && val.endsWith("\"")) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  } catch {}
}

loadEnv();

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const args = process.argv.slice(2);
const prefixArg = args.find((a) => a.startsWith("--prefix="));
const prefix = prefixArg ? prefixArg.split("=")[1] : "SMOKE-RUMBLE-";
const dryRun = args.includes("--dry-run");

if (!prefix || prefix.length < 3) {
  console.error("Prefix must be at least 3 characters to avoid accidental deletion.");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function main() {
  console.log(`Searching for fighters with name prefix: "${prefix}"`);
  if (dryRun) console.log("(DRY RUN — no deletions)");

  // Find matching fighters
  const { data: fighters, error: findErr } = await sb
    .from("ucf_fighters")
    .select("id, name, created_at")
    .ilike("name", `${prefix}%`);

  if (findErr) {
    console.error("Failed to query fighters:", findErr.message);
    process.exit(1);
  }

  if (!fighters || fighters.length === 0) {
    console.log("No matching fighters found.");
    return;
  }

  console.log(`Found ${fighters.length} fighter(s):`);
  for (const f of fighters) {
    console.log(`  - ${f.name} (id: ${f.id}, created: ${f.created_at})`);
  }

  if (dryRun) {
    console.log("\nDry run complete. No changes made.");
    return;
  }

  const ids = fighters.map((f) => f.id);

  // Clean up related data first (bets, queue entries)
  console.log("\nCleaning related data...");

  const { error: queueErr, count: queueCount } = await sb
    .from("ucf_rumble_queue")
    .delete({ count: "exact" })
    .in("fighter_id", ids);
  if (queueErr) console.warn("  Queue cleanup error:", queueErr.message);
  else console.log(`  Removed ${queueCount ?? 0} queue entries`);

  const { error: betErr, count: betCount } = await sb
    .from("ucf_bets")
    .delete({ count: "exact" })
    .in("fighter_id", ids);
  if (betErr) console.warn("  Bet cleanup error:", betErr.message);
  else console.log(`  Removed ${betCount ?? 0} bet entries`);

  // Delete the fighters
  console.log("\nDeleting fighters...");
  const { error: deleteErr, count: deleteCount } = await sb
    .from("ucf_fighters")
    .delete({ count: "exact" })
    .in("id", ids);

  if (deleteErr) {
    console.error("Failed to delete fighters:", deleteErr.message);
    process.exit(1);
  }

  console.log(`Deleted ${deleteCount ?? 0} fighter(s).`);
  console.log("Done.");
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
