#!/usr/bin/env node

/**
 * Dedicated rumble keeper loop.
 *
 * Calls /api/rumble/tick on a short interval so on-chain phase transitions
 * progress continuously (create -> betting -> combat -> resolve -> finalize).
 *
 * Required env:
 * - RUMBLE_KEEPER_CRON_SECRET (or CRON_SECRET)
 *
 * Optional env:
 * - RUMBLE_KEEPER_BASE_URL (default: https://clawfights.xyz)
 * - RUMBLE_KEEPER_INTERVAL_MS (default: 2000, min 500)
 * - RUMBLE_KEEPER_TIMEOUT_MS (default: 12000, min 2000)
 * - RUMBLE_KEEPER_JITTER_MS (default: 250, min 0)
 */

const BASE_URL = (process.env.RUMBLE_KEEPER_BASE_URL ?? "https://clawfights.xyz")
  .trim()
  .replace(/\/+$/, "");

const CRON_SECRET = (
  process.env.RUMBLE_KEEPER_CRON_SECRET ??
  process.env.CRON_SECRET ??
  ""
).trim();

const INTERVAL_MS = Math.max(
  500,
  Number.isFinite(Number(process.env.RUMBLE_KEEPER_INTERVAL_MS))
    ? Math.floor(Number(process.env.RUMBLE_KEEPER_INTERVAL_MS))
    : 2000,
);

const TIMEOUT_MS = Math.max(
  2000,
  Number.isFinite(Number(process.env.RUMBLE_KEEPER_TIMEOUT_MS))
    ? Math.floor(Number(process.env.RUMBLE_KEEPER_TIMEOUT_MS))
    : 12000,
);

const JITTER_MS = Math.max(
  0,
  Number.isFinite(Number(process.env.RUMBLE_KEEPER_JITTER_MS))
    ? Math.floor(Number(process.env.RUMBLE_KEEPER_JITTER_MS))
    : 250,
);

if (!CRON_SECRET) {
  console.error("[keeper] Missing RUMBLE_KEEPER_CRON_SECRET (or CRON_SECRET).");
  process.exit(1);
}

const TICK_URL = `${BASE_URL}/api/rumble/tick`;

let stopping = false;
let consecutiveFailures = 0;
let tickCount = 0;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fmtNow() {
  return new Date().toISOString();
}

function summarizeSlots(payload) {
  const slots = Array.isArray(payload?.slots) ? payload.slots : [];
  if (slots.length === 0) return "no-slots";
  return slots
    .map((slot) => {
      const idx = slot?.slot ?? "?";
      const state = slot?.state ?? "unknown";
      const fighters = Number(slot?.fighters ?? 0);
      const turns = Number(slot?.turnCount ?? 0);
      return `s${idx}:${state}:f${fighters}:t${turns}`;
    })
    .join(" | ");
}

async function callTick() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(TICK_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${CRON_SECRET}`,
        "User-Agent": "ucf-rumble-keeper/1.0",
      },
      signal: controller.signal,
    });

    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { raw: text };
    }

    if (response.status === 401) {
      console.error(`[${fmtNow()}] [keeper] Unauthorized (401). Check CRON secret.`);
      stopping = true;
      return;
    }

    if (!response.ok || payload?.success === false) {
      consecutiveFailures += 1;
      const detail = payload?.error ?? response.statusText ?? "tick failed";
      console.error(
        `[${fmtNow()}] [keeper] tick failed (${response.status}) fail#${consecutiveFailures}: ${detail}`,
      );
      return;
    }

    tickCount += 1;
    consecutiveFailures = 0;
    if (tickCount === 1 || tickCount % 10 === 0) {
      console.log(
        `[${fmtNow()}] [keeper] ok tick#${tickCount} ${summarizeSlots(payload)}`,
      );
    }
  } catch (error) {
    consecutiveFailures += 1;
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[${fmtNow()}] [keeper] request error fail#${consecutiveFailures}: ${message}`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function loop() {
  console.log(`[${fmtNow()}] [keeper] starting`);
  console.log(`[${fmtNow()}] [keeper] target=${TICK_URL} interval=${INTERVAL_MS}ms timeout=${TIMEOUT_MS}ms`);
  while (!stopping) {
    await callTick();
    if (stopping) break;

    const jitter = JITTER_MS > 0 ? Math.floor(Math.random() * (JITTER_MS + 1)) : 0;
    await sleep(INTERVAL_MS + jitter);
  }
  console.log(`[${fmtNow()}] [keeper] stopped`);
}

process.on("SIGINT", () => {
  stopping = true;
});
process.on("SIGTERM", () => {
  stopping = true;
});

loop().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`[${fmtNow()}] [keeper] fatal: ${message}`);
  process.exit(1);
});
