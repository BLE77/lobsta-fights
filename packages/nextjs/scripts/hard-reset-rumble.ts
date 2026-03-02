#!/usr/bin/env npx tsx

import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

type Args = {
  apply: boolean;
  skipDb: boolean;
  keepEr: boolean;
  allowProdDb: boolean;
  envFile: string;
};

type ResetSummary = {
  sessionFile: string;
  sessionMinTimestampMs: number;
  sessionResetAt: string;
  erDisabled: boolean;
  envFile: string;
  dbReset: boolean;
  deleted: {
    bets: number;
    rumbles: number;
    queue: number;
    txSignatures: number;
  } | null;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    apply: false,
    skipDb: false,
    keepEr: false,
    allowProdDb: false,
    envFile: ".env.local",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") {
      args.apply = true;
      continue;
    }
    if (arg === "--skip-db") {
      args.skipDb = true;
      continue;
    }
    if (arg === "--keep-er") {
      args.keepEr = true;
      continue;
    }
    if (arg === "--allow-prod-db") {
      args.allowProdDb = true;
      continue;
    }
    if (arg === "--env-file") {
      const value = argv[i + 1];
      if (!value) throw new Error("Missing value for --env-file");
      args.envFile = value;
      i += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function printUsage(): void {
  console.log("Usage:");
  console.log("  npx tsx scripts/hard-reset-rumble.ts [--apply] [--skip-db] [--keep-er] [--allow-prod-db] [--env-file <path>]");
  console.log("");
  console.log("What it does:");
  console.log("  1) Sets a new rumble session floor (.rumble-session.json)");
  console.log("  2) Disables ER in env file (MAGICBLOCK_ER_ENABLED=false) unless --keep-er");
  console.log("  3) Wipes rumble/bet queue tables in Supabase unless --skip-db");
  console.log("  4) Refuses to wipe production Supabase unless --allow-prod-db is passed");
  console.log("");
  console.log("Examples:");
  console.log("  npx tsx scripts/hard-reset-rumble.ts");
  console.log("  npx tsx scripts/hard-reset-rumble.ts --apply");
  console.log("  npx tsx scripts/hard-reset-rumble.ts --apply --skip-db");
}

function extractSupabaseRef(supabaseUrl: string): string | null {
  try {
    const host = new URL(supabaseUrl).hostname.toLowerCase();
    const match = host.match(/^([a-z0-9-]+)\.supabase\.(co|com)$/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function isProtectedProdRef(ref: string | null): boolean {
  if (!ref) return false;
  const fromEnv = (process.env.HARD_RESET_PROTECTED_SUPABASE_REFS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const protectedRefs = new Set([
    "wymgeupbkuorsutzofjw", // current production project
    ...fromEnv,
  ]);
  return protectedRefs.has(ref);
}

function parseEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, "utf8");
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function upsertEnvVar(filePath: string, key: string, value: string): void {
  const lineValue = `${key}="${value}"`;
  const lines = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, "utf8").split(/\r?\n/)
    : [];
  let found = false;
  const next = lines.map((line) => {
    if (line.startsWith(`${key}=`)) {
      found = true;
      return lineValue;
    }
    return line;
  });
  if (!found) next.push(lineValue);
  const withTrailingNewline = `${next.filter(Boolean).join("\n")}\n`;
  fs.writeFileSync(filePath, withTrailingNewline, "utf8");
}

function isMissingTableError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: string }).code;
  return code === "42P01" || code === "PGRST205";
}

async function resetDb(
  supabaseUrl: string,
  serviceRoleKey: string,
): Promise<ResetSummary["deleted"]> {
  const sb = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: (input, init) => fetch(input, { ...init, cache: "no-store" }) },
  });

  const [{ data: betRows, error: betsErr }, { data: rumbleRows, error: rumblesErr }, { data: queueRows, error: queueErr }] =
    await Promise.all([
      sb.from("ucf_bets").delete().gte("placed_at", "1970-01-01").select("id"),
      sb.from("ucf_rumbles").delete().gte("created_at", "1970-01-01").select("id"),
      sb.from("ucf_rumble_queue").delete().gte("joined_at", "1970-01-01").select("id"),
    ]);
  if (betsErr) throw betsErr;
  if (rumblesErr) throw rumblesErr;
  if (queueErr) throw queueErr;

  let txSigRows: Array<{ tx_signature: string }> | null = null;
  const { data: txRows, error: txSigErr } = await sb
    .from("ucf_used_tx_signatures")
    .delete()
    .gte("created_at", "1970-01-01")
    .select("tx_signature");
  if (txSigErr && !isMissingTableError(txSigErr)) throw txSigErr;
  txSigRows = txRows;

  await Promise.all([
    sb
      .from("ucf_ichor_shower")
      .update({
        pool_amount: 0,
        last_trigger_rumble_id: null,
        last_winner_wallet: null,
        last_payout: null,
        updated_at: new Date().toISOString(),
      })
      .gte("updated_at", "1970-01-01"),
    sb
      .from("ucf_rumble_stats")
      .update({
        total_rumbles: 0,
        total_sol_wagered: 0,
        total_ichor_minted: 0,
        total_ichor_burned: 0,
        updated_at: new Date().toISOString(),
      })
      .gte("updated_at", "1970-01-01"),
  ]);

  return {
    bets: betRows?.length ?? 0,
    rumbles: rumbleRows?.length ?? 0,
    queue: queueRows?.length ?? 0,
    txSignatures: txSigRows?.length ?? 0,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const envFile = path.resolve(process.cwd(), args.envFile);
  const env = parseEnvFile(envFile);

  if (!args.apply) {
    console.log("Dry run. No changes written.");
    console.log("Run with --apply to execute reset.");
    console.log(JSON.stringify({
      envFile,
      willDisableEr: !args.keepEr,
      willResetSession: true,
      willResetDb: !args.skipDb,
    }, null, 2));
    return;
  }

  const session = {
    minRumbleTimestampMs: Date.now(),
    resetAtIso: new Date().toISOString(),
  };
  const sessionFile = path.resolve(process.cwd(), ".rumble-session.json");
  fs.writeFileSync(sessionFile, `${JSON.stringify(session, null, 2)}\n`, "utf8");

  if (!args.keepEr) {
    upsertEnvVar(envFile, "MAGICBLOCK_ER_ENABLED", "false");
  }

  let deleted: ResetSummary["deleted"] = null;
  if (!args.skipDb) {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceRoleKey) {
      throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    }
    const targetRef = extractSupabaseRef(supabaseUrl);
    if (!args.allowProdDb && isProtectedProdRef(targetRef)) {
      throw new Error(
        `Refusing to wipe protected Supabase project ref "${targetRef}". ` +
        `Re-run with --allow-prod-db only if this is intentional.`
      );
    }
    deleted = await resetDb(supabaseUrl, serviceRoleKey);
  }

  const summary: ResetSummary = {
    sessionFile,
    sessionMinTimestampMs: session.minRumbleTimestampMs,
    sessionResetAt: session.resetAtIso,
    erDisabled: !args.keepEr,
    envFile,
    dbReset: !args.skipDb,
    deleted,
  };
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(message);
  process.exit(1);
});
