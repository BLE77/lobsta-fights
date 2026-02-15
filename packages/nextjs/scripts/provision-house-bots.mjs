#!/usr/bin/env node
/**
 * Provision secure house bots for rumble auto-fill.
 *
 * Creates:
 * - real Solana wallet keypairs (devnet/mainnet compatible pubkeys)
 * - verified ucf_fighters rows (service-role direct insert)
 * - API keys + hashes
 * - output file with credentials (chmod 600)
 *
 * Usage:
 *   node scripts/provision-house-bots.mjs --count=12 --webhook-url=https://clawfights.xyz/api/house-bot/fight
 *   node scripts/provision-house-bots.mjs --count=8 --prefix=HOUSE --dry-run
 */

import { createClient } from "@supabase/supabase-js";
import { Keypair } from "@solana/web3.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";

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
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {}
}

function parseArgs() {
  const args = process.argv.slice(2);
  const getArg = (name, fallback = "") =>
    args.find(arg => arg.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;

  const count = Number.parseInt(getArg("count", "12"), 10);
  const prefix = getArg("prefix", "HOUSE-BOT");
  const webhookUrl = getArg("webhook-url", process.env.HOUSE_BOT_WEBHOOK_URL || "");
  const targetPopulation = Number.parseInt(getArg("target-population", "8"), 10);
  const outPath = getArg(
    "out",
    `artifacts/house-bots/house-bots-${Date.now()}.json`,
  );
  const dryRun = args.includes("--dry-run");

  if (!Number.isFinite(count) || count <= 0 || count > 64) {
    throw new Error("--count must be between 1 and 64");
  }
  if (!prefix || prefix.length < 3) {
    throw new Error("--prefix must be at least 3 chars");
  }
  if (!webhookUrl) {
    throw new Error("--webhook-url is required");
  }
  if (!/^https?:\/\//i.test(webhookUrl)) {
    throw new Error("--webhook-url must start with http:// or https://");
  }

  return {
    count,
    prefix,
    webhookUrl,
    targetPopulation: Math.max(0, Math.min(64, targetPopulation || 8)),
    outPath,
    dryRun,
  };
}

function hashApiKey(key) {
  return createHash("sha256").update(key).digest("hex");
}

function buildRobotMetadata(index) {
  return {
    robot_type: "House Arena Enforcer",
    chassis_description:
      `Purpose-built rumble chassis #${index}. Reinforced servo frame, impact-rated shoulder pivots, and ` +
      "shock-absorbing core stabilizers tuned for extended cage fights and repeated collision load.",
    fists_description:
      "Titanium-alloy knuckle pods with layered damping and anti-slip grip ridges; built for bare-knuckle " +
      "robot striking without external weapons.",
    fighting_style: "balanced",
    personality: "Disciplined house bot that keeps the arena active for challengers.",
    signature_move: "Arena Pressure Loop",
    victory_line: "House control maintained.",
    defeat_line: "Recalibrating for the next rumble.",
    taunt_lines: ["Step into the cage.", "Keep your guard up.", "House bots do not blink."],
    color_scheme: "industrial orange and gunmetal with hazard striping",
    distinguishing_features:
      "Front chest houses a glowing ring indicator and etched serial pattern; left forearm has a visible " +
      "impact counter plate with worn battle marks.",
  };
}

async function main() {
  loadEnv();
  const options = parseArgs();

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }

  const sb = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const createdAt = new Date().toISOString();
  const prefixTag = `${options.prefix}-${Date.now()}`;

  const staged = [];
  for (let i = 1; i <= options.count; i++) {
    const kp = Keypair.generate();
    const wallet = kp.publicKey.toBase58();
    const apiKey = randomUUID();
    const botName = `${prefixTag}-${String(i).padStart(2, "0")}`;
    staged.push({
      insertRow: {
        wallet_address: wallet,
        name: botName,
        description: "Autonomous house bot that keeps rumble queue active when no real bots are online.",
        special_move: "Arena Pressure Loop",
        webhook_url: options.webhookUrl,
        image_url: null,
        robot_metadata: buildRobotMetadata(i),
        points: 1000,
        verified: true,
        moltbook_agent_id: null,
        registered_from_ip: "house-bot-provisioner",
        api_key_hash: hashApiKey(apiKey),
      },
      secret: {
        wallet_public_key: wallet,
        wallet_secret_key: Array.from(kp.secretKey),
        api_key: apiKey,
      },
    });
  }

  if (options.dryRun) {
    console.log(`[HouseBots] Dry run. Would create ${staged.length} bots with webhook ${options.webhookUrl}`);
    console.log(`[HouseBots] Name prefix: ${prefixTag}`);
    return;
  }

  const { data, error } = await sb
    .from("ucf_fighters")
    .insert(staged.map(s => s.insertRow))
    .select("id, name, wallet_address");
  if (error) {
    throw new Error(`Insert failed: ${error.message}`);
  }

  const rows = data ?? [];
  if (rows.length !== staged.length) {
    throw new Error(`Expected ${staged.length} inserted rows, got ${rows.length}`);
  }

  const byWallet = new Map(rows.map(row => [row.wallet_address, row]));
  const bots = staged.map(item => {
    const row = byWallet.get(item.secret.wallet_public_key);
    if (!row) throw new Error(`Missing inserted row for wallet ${item.secret.wallet_public_key}`);
    return {
      fighter_id: row.id,
      name: row.name,
      wallet_public_key: item.secret.wallet_public_key,
      wallet_secret_key: item.secret.wallet_secret_key,
      api_key: item.secret.api_key,
    };
  });

  const outAbs = resolve(process.cwd(), options.outPath);
  mkdirSync(dirname(outAbs), { recursive: true });
  writeFileSync(
    outAbs,
    JSON.stringify(
      {
        created_at: createdAt,
        webhook_url: options.webhookUrl,
        prefix: prefixTag,
        bots,
      },
      null,
      2,
    ),
    "utf8",
  );
  chmodSync(outAbs, 0o600);

  const fighterIds = bots.map(b => b.fighter_id).join(",");
  console.log(`[HouseBots] Created ${bots.length} bots.`);
  console.log(`[HouseBots] Secrets file: ${outAbs} (mode 600)`);
  console.log("");
  console.log("Set these env vars:");
  console.log(`RUMBLE_HOUSE_BOTS_ENABLED=true`);
  console.log(`RUMBLE_HOUSE_BOT_IDS=${fighterIds}`);
  console.log(`RUMBLE_HOUSE_BOT_TARGET_POPULATION=${options.targetPopulation}`);
  console.log(`HOUSE_BOT_ALLOWED_FIGHTER_IDS=${fighterIds}`);
  console.log("");
  console.log("Security notes:");
  console.log("- Treat the output JSON as sensitive (contains wallet private keys + API keys).");
  console.log("- Move secrets into a proper secret manager before production.");
}

main().catch((err) => {
  console.error(`[HouseBots] ${err.message || err}`);
  process.exit(1);
});
