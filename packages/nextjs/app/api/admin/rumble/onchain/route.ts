import { PublicKey } from "@solana/web3.js";
import {
  advanceTurnOnChain,
  completeRumble,
  deriveMoveCommitmentPda,
  finalizeRumbleOnChain,
  getAdminSignerPublicKey,
  openTurn,
  readRumbleConfig,
  readRumbleAccountState,
  readRumbleCombatState,
  resolveTurnOnChain,
  startCombat,
  sweepTreasury,
} from "~~/lib/solana-programs";
import { parseOnchainRumbleIdNumber } from "~~/lib/rumble-id";
import { isAuthorizedAdminRequest } from "~~/lib/request-auth";

export const dynamic = "force-dynamic";

// BigInt-safe JSON serialization — convert bigints to strings
function safeJson(data: unknown): string {
  return JSON.stringify(data, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(safeJson(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type OnchainAdminAction =
  | "start_combat"
  | "open_turn"
  | "resolve_turn"
  | "advance_turn"
  | "finalize_rumble"
  | "complete_rumble"
  | "sweep_treasury";

function parseRumbleId(input: unknown): number | null {
  if (typeof input === "number" && Number.isSafeInteger(input) && input > 0) return input;
  if (typeof input === "string") return parseOnchainRumbleIdNumber(input);
  return null;
}

function parseAction(input: unknown): OnchainAdminAction | null {
  if (typeof input !== "string") return null;
  const normalized = input.trim().toLowerCase();
  const allowed: OnchainAdminAction[] = [
    "start_combat",
    "open_turn",
    "resolve_turn",
    "advance_turn",
    "finalize_rumble",
    "complete_rumble",
    "sweep_treasury",
  ];
  return allowed.includes(normalized as OnchainAdminAction)
    ? (normalized as OnchainAdminAction)
    : null;
}

function parseWalletList(input: unknown): PublicKey[] {
  if (!Array.isArray(input)) return [];
  const keys: PublicKey[] = [];
  for (const raw of input) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    try {
      keys.push(new PublicKey(raw.trim()));
    } catch {
      // Ignore invalid pubkeys to keep admin action resilient.
    }
  }
  return keys;
}

async function buildAdminHealth() {
  const signerPubkey = getAdminSignerPublicKey();
  const cfg = await readRumbleConfig().catch(() => null);
  const rumbleAdmin = cfg?.admin ?? null;

  const match = !!(signerPubkey && rumbleAdmin && signerPubkey === rumbleAdmin);
  return {
    signerPubkey,
    rumbleAdmin,
    signerLoaded: !!signerPubkey,
    adminMatch: match,
    ready: match,
    onchainTurnAuthority: process.env.RUMBLE_ONCHAIN_TURN_AUTHORITY === "true",
  };
}

export async function GET(request: Request) {
  if (!isAuthorizedAdminRequest(request.headers)) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const url = new URL(request.url);
  const rumbleIdRaw = url.searchParams.get("rumble_id") ?? url.searchParams.get("rumbleId");

  // Health-only mode: no rumble_id → return admin health info
  if (!rumbleIdRaw) {
    const health = await buildAdminHealth();
    return jsonResponse({
      success: true,
      health,
      timestamp: new Date().toISOString(),
    });
  }

  const rumbleId = parseRumbleId(rumbleIdRaw);
  if (!rumbleId) {
    return jsonResponse({ error: "Invalid rumble_id" }, 400);
  }

  const [rumble, combat, health] = await Promise.all([
    readRumbleAccountState(rumbleId).catch(() => null),
    readRumbleCombatState(rumbleId).catch(() => null),
    buildAdminHealth(),
  ]);

  return jsonResponse({
    success: true,
    onchain_rumble_id: rumbleId,
    rumble,
    combat,
    health,
    timestamp: new Date().toISOString(),
  });
}

export async function POST(request: Request) {
  if (!isAuthorizedAdminRequest(request.headers)) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  try {
    const body = await request.json();
    const rumbleId = parseRumbleId(body?.rumble_id ?? body?.rumbleId);
    const action = parseAction(body?.action);
    if (!rumbleId) {
      return jsonResponse({ error: "Invalid rumble_id" }, 400);
    }
    if (!action) {
      return jsonResponse({ error: "Invalid action" }, 400);
    }

    let signature: string | null = null;
    switch (action) {
      case "start_combat":
        signature = await startCombat(rumbleId);
        break;
      case "open_turn":
        signature = await openTurn(rumbleId);
        break;
      case "resolve_turn": {
        const combat = await readRumbleCombatState(rumbleId);
        const turn = combat?.currentTurn ?? 0;
        const fighterWallets = parseWalletList(body?.fighter_wallets ?? body?.fighterWallets);
        const moveCommitmentAccounts =
          turn > 0
            ? fighterWallets.map((wallet) => deriveMoveCommitmentPda(rumbleId, wallet, turn)[0])
            : [];
        signature = await resolveTurnOnChain(rumbleId, moveCommitmentAccounts);
        break;
      }
      case "advance_turn":
        signature = await advanceTurnOnChain(rumbleId);
        break;
      case "finalize_rumble":
        signature = await finalizeRumbleOnChain(rumbleId);
        break;
      case "complete_rumble":
        signature = await completeRumble(rumbleId);
        break;
      case "sweep_treasury":
        signature = await sweepTreasury(rumbleId);
        break;
      default:
        return jsonResponse({ error: "Unsupported action" }, 400);
    }

    const [rumbleAfter, combatAfter] = await Promise.all([
      readRumbleAccountState(rumbleId).catch(() => null),
      readRumbleCombatState(rumbleId).catch(() => null),
    ]);

    return jsonResponse({
      success: true,
      action,
      onchain_rumble_id: rumbleId,
      signature,
      rumble: rumbleAfter,
      combat: combatAfter,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    return jsonResponse(
      { error: err?.message ?? "Failed to run on-chain admin action" },
      500,
    );
  }
}
