import { createHash, createHmac } from "node:crypto";
import { NextResponse } from "next/server";
import { createMoveHash, isValidMove, SPECIAL_METER_COST } from "~~/lib/combat";
import type { MoveType } from "~~/lib/types";
import { verifyWebhookSignature } from "~~/lib/webhook";

export const dynamic = "force-dynamic";

const HOUSE_BOT_ALLOWED_FIGHTERS = new Set(
  (process.env.HOUSE_BOT_ALLOWED_FIGHTER_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0),
);
const WEBHOOK_SECRET_CONFIGURED = Boolean(process.env.UCF_WEBHOOK_SHARED_SECRET?.trim());
const HOUSE_BOT_REQUIRE_SIGNATURE =
  (process.env.HOUSE_BOT_REQUIRE_SIGNATURE ??
    (WEBHOOK_SECRET_CONFIGURED ? "true" : "false")) === "true";
const HOUSE_BOT_SIGNATURE_MAX_SKEW_SECONDS = Math.max(
  30,
  Math.min(900, Number(process.env.HOUSE_BOT_SIGNATURE_MAX_SKEW_SECONDS ?? 300) || 300),
);
const STRATEGY_SEED =
  process.env.HOUSE_BOT_STRATEGY_SEED?.trim() ||
  process.env.UCF_WEBHOOK_SHARED_SECRET?.trim() ||
  "house-bot-local-seed-change-me";

const ALL_VALID_MOVES: MoveType[] = [
  "HIGH_STRIKE",
  "MID_STRIKE",
  "LOW_STRIKE",
  "GUARD_HIGH",
  "GUARD_MID",
  "GUARD_LOW",
  "DODGE",
  "CATCH",
  "SPECIAL",
];

type HouseStyle = "aggressive" | "counter" | "evasive" | "balanced";

interface HouseBotEventPayload {
  event?: string;
  timestamp?: string;
  fighter_id?: string;
  rumble_id?: string;
  match_id?: string;
  turn?: number;
  move_hash?: string;
  match_state?: {
    your_hp?: number;
    opponent_hp?: number;
    your_meter?: number;
    opponent_meter?: number;
    turn?: number;
  };
  your_state?: {
    hp?: number;
    meter?: number;
  };
  opponent_state?: {
    hp?: number;
    meter?: number;
  };
}

interface SnapshotState {
  yourHp: number;
  opponentHp: number;
  yourMeter: number;
  opponentMeter: number;
  turn: number;
}

function toInt(input: unknown, fallback: number): number {
  const n = Number(input);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function seededFloat(seed: string): number {
  const digest = createHash("sha256").update(seed).digest();
  return digest.readUInt32BE(0) / 0x100000000;
}

function hmacHex(seed: string, input: string): string {
  return createHmac("sha256", seed).update(input).digest("hex");
}

function deriveStyle(fighterId: string): HouseStyle {
  const styles: HouseStyle[] = ["aggressive", "counter", "evasive", "balanced"];
  const idx = parseInt(sha256Hex(`${STRATEGY_SEED}|style|${fighterId}`).slice(0, 2), 16) % styles.length;
  return styles[idx];
}

function parseSnapshotState(payload: HouseBotEventPayload): SnapshotState {
  const turnFromPayload = toInt(payload.turn, toInt(payload.match_state?.turn, 1));
  return {
    yourHp: clamp(toInt(payload.match_state?.your_hp, toInt(payload.your_state?.hp, 100)), 0, 100),
    opponentHp: clamp(toInt(payload.match_state?.opponent_hp, toInt(payload.opponent_state?.hp, 100)), 0, 100),
    yourMeter: clamp(toInt(payload.match_state?.your_meter, toInt(payload.your_state?.meter, 0)), 0, 100),
    opponentMeter: clamp(toInt(payload.match_state?.opponent_meter, toInt(payload.opponent_state?.meter, 0)), 0, 100),
    turn: clamp(turnFromPayload, 1, 10_000),
  };
}

function weightedPick(seed: string, entries: Array<{ move: MoveType; weight: number }>): MoveType {
  const valid = entries.filter((entry) => entry.weight > 0 && isValidMove(entry.move));
  if (!valid.length) return "MID_STRIKE";

  const total = valid.reduce((sum, entry) => sum + entry.weight, 0);
  if (total <= 0) return "MID_STRIKE";

  let cursor = seededFloat(seed) * total;
  for (const entry of valid) {
    cursor -= entry.weight;
    if (cursor <= 0) return entry.move;
  }
  return valid[valid.length - 1].move;
}

function chooseMove(style: HouseStyle, snapshot: SnapshotState, seedBase: string): MoveType {
  const { yourHp, opponentHp, yourMeter, opponentMeter } = snapshot;

  if (yourMeter >= SPECIAL_METER_COST) {
    const specialRoll = seededFloat(`${seedBase}|special`);
    if (opponentHp <= 34 || specialRoll < 0.24) return "SPECIAL";
  }

  if (yourHp <= 18) {
    const panicEntries: Record<HouseStyle, Array<{ move: MoveType; weight: number }>> = {
      aggressive: [
        { move: "DODGE", weight: 28 },
        { move: "GUARD_MID", weight: 22 },
        { move: "CATCH", weight: 14 },
        { move: "MID_STRIKE", weight: 36 },
      ],
      counter: [
        { move: "GUARD_HIGH", weight: 28 },
        { move: "GUARD_MID", weight: 28 },
        { move: "DODGE", weight: 24 },
        { move: "CATCH", weight: 20 },
      ],
      evasive: [
        { move: "DODGE", weight: 52 },
        { move: "GUARD_LOW", weight: 18 },
        { move: "GUARD_MID", weight: 15 },
        { move: "LOW_STRIKE", weight: 15 },
      ],
      balanced: [
        { move: "DODGE", weight: 30 },
        { move: "GUARD_HIGH", weight: 20 },
        { move: "GUARD_MID", weight: 20 },
        { move: "MID_STRIKE", weight: 30 },
      ],
    };
    return weightedPick(`${seedBase}|panic`, panicEntries[style]);
  }

  if (opponentMeter >= SPECIAL_METER_COST && seededFloat(`${seedBase}|anti-special`) < 0.45) {
    return weightedPick(`${seedBase}|anti-special-pick`, [
      { move: "DODGE", weight: 52 },
      { move: "GUARD_HIGH", weight: 16 },
      { move: "GUARD_MID", weight: 16 },
      { move: "GUARD_LOW", weight: 16 },
    ]);
  }

  const baseProfiles: Record<HouseStyle, Array<{ move: MoveType; weight: number }>> = {
    aggressive: [
      { move: "HIGH_STRIKE", weight: 30 },
      { move: "MID_STRIKE", weight: 28 },
      { move: "LOW_STRIKE", weight: 18 },
      { move: "CATCH", weight: 10 },
      { move: "DODGE", weight: 6 },
      { move: "GUARD_MID", weight: 4 },
      { move: "GUARD_HIGH", weight: 2 },
      { move: "GUARD_LOW", weight: 2 },
    ],
    counter: [
      { move: "GUARD_HIGH", weight: 18 },
      { move: "GUARD_MID", weight: 22 },
      { move: "GUARD_LOW", weight: 18 },
      { move: "CATCH", weight: 14 },
      { move: "DODGE", weight: 14 },
      { move: "MID_STRIKE", weight: 10 },
      { move: "HIGH_STRIKE", weight: 2 },
      { move: "LOW_STRIKE", weight: 2 },
    ],
    evasive: [
      { move: "DODGE", weight: 34 },
      { move: "LOW_STRIKE", weight: 18 },
      { move: "MID_STRIKE", weight: 16 },
      { move: "CATCH", weight: 14 },
      { move: "GUARD_LOW", weight: 8 },
      { move: "GUARD_MID", weight: 6 },
      { move: "HIGH_STRIKE", weight: 4 },
    ],
    balanced: [
      { move: "HIGH_STRIKE", weight: 18 },
      { move: "MID_STRIKE", weight: 22 },
      { move: "LOW_STRIKE", weight: 16 },
      { move: "GUARD_HIGH", weight: 10 },
      { move: "GUARD_MID", weight: 10 },
      { move: "GUARD_LOW", weight: 8 },
      { move: "DODGE", weight: 10 },
      { move: "CATCH", weight: 6 },
    ],
  };

  return weightedPick(`${seedBase}|profile`, baseProfiles[style]);
}

function buildTurnKey(payload: HouseBotEventPayload): string {
  const matchOrRumble = payload.rumble_id || payload.match_id || "unknown";
  const fighterId = payload.fighter_id || "unknown";
  const turn = clamp(toInt(payload.turn, toInt(payload.match_state?.turn, 1)), 1, 10_000);
  return `${matchOrRumble}|${fighterId}|${turn}`;
}

function buildDecision(payload: HouseBotEventPayload): { move: MoveType; salt: string; moveHash: string; style: HouseStyle } {
  const fighterId = payload.fighter_id || "house-fallback";
  const snapshot = parseSnapshotState(payload);
  const style = deriveStyle(fighterId);
  const stateFingerprint = `${snapshot.yourHp}:${snapshot.opponentHp}:${snapshot.yourMeter}:${snapshot.opponentMeter}`;
  const turnKey = buildTurnKey(payload);
  const seedBase = `${STRATEGY_SEED}|${style}|${turnKey}|${stateFingerprint}`;

  const move = chooseMove(style, snapshot, seedBase);
  const salt = hmacHex(STRATEGY_SEED, `salt|${turnKey}|${move}`).slice(0, 32);
  const moveHash = createMoveHash(move, salt);
  return { move, salt, moveHash, style };
}

function ensureAllowedFighter(payload: HouseBotEventPayload): NextResponse | null {
  if (HOUSE_BOT_ALLOWED_FIGHTERS.size === 0) return null;
  const fighterId = payload.fighter_id ?? "";
  if (!fighterId || !HOUSE_BOT_ALLOWED_FIGHTERS.has(fighterId)) {
    return NextResponse.json({ error: "fighter_not_allowed" }, { status: 403 });
  }
  return null;
}

function handleEvent(payload: HouseBotEventPayload): NextResponse {
  const event = payload.event;

  if (event === "ping") {
    return NextResponse.json({
      status: "ready",
      bot: "house-bot",
      commit_reveal: true,
      signature_enforced: HOUSE_BOT_REQUIRE_SIGNATURE,
    });
  }

  switch (event) {
    case "challenge":
      return NextResponse.json({ accept: true });

    case "move_commit_request": {
      const allowed = ensureAllowedFighter(payload);
      if (allowed) return allowed;
      const decision = buildDecision(payload);
      return NextResponse.json({
        move_hash: decision.moveHash,
        meta: { style: decision.style },
      });
    }

    case "move_reveal_request": {
      const allowed = ensureAllowedFighter(payload);
      if (allowed) return allowed;
      const decision = buildDecision(payload);
      const providedHash =
        typeof payload.move_hash === "string" ? payload.move_hash.trim().toLowerCase() : "";
      if (providedHash && providedHash !== decision.moveHash.toLowerCase()) {
        return NextResponse.json(
          { error: "move_hash_mismatch", expected: decision.moveHash },
          { status: 409 },
        );
      }
      return NextResponse.json({
        move: decision.move,
        salt: decision.salt,
        meta: { style: decision.style },
      });
    }

    case "move_request": {
      const allowed = ensureAllowedFighter(payload);
      if (allowed) return allowed;
      const decision = buildDecision(payload);
      return NextResponse.json({
        move: decision.move,
        salt: decision.salt,
        meta: { style: decision.style },
      });
    }

    case "turn_result":
    case "match_result":
    case "match_created":
      return NextResponse.json({ ack: true });

    default:
      return NextResponse.json({ ack: true, warning: "unknown_event" });
  }
}

export async function POST(request: Request) {
  try {
    const rawBody = await request.text();
    let payload: HouseBotEventPayload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: "invalid_json" }, { status: 400 });
    }

    if (HOUSE_BOT_REQUIRE_SIGNATURE) {
      if (!WEBHOOK_SECRET_CONFIGURED) {
        return NextResponse.json(
          { error: "house_bot_signature_misconfigured" },
          { status: 503 },
        );
      }
      const timestamp =
        request.headers.get("x-ucf-timestamp") ||
        (typeof payload.timestamp === "string" ? payload.timestamp : "");
      const signature = request.headers.get("x-ucf-signature");
      const valid = verifyWebhookSignature(
        timestamp,
        rawBody,
        signature,
        HOUSE_BOT_SIGNATURE_MAX_SKEW_SECONDS,
      );
      if (!valid) {
        return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
      }
    }

    return handleEvent(payload);
  } catch (error: any) {
    console.error("[HouseBot] Failed to handle event:", error);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({
    name: "UCF House Bot",
    status: "ready",
    strategy: "deterministic_commit_reveal",
    signature_required: HOUSE_BOT_REQUIRE_SIGNATURE,
    allowed_fighters_configured: HOUSE_BOT_ALLOWED_FIGHTERS.size,
    supported_events: [
      "ping",
      "challenge",
      "move_commit_request",
      "move_reveal_request",
      "move_request",
      "turn_result",
      "match_result",
      "match_created",
    ],
    valid_moves: ALL_VALID_MOVES,
  });
}
