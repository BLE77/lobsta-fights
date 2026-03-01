import { createClient } from "@supabase/supabase-js";
import { PublicKey } from "@solana/web3.js";
import { completeRumbleMainnet, createRumbleMainnet, reportResultMainnet, sweepTreasuryMainnet } from "./solana-programs";
import * as persist from "./rumble-persistence";

export type MainnetOpType = "completeRumble" | "sweepTreasury" | "createRumble" | "reportResult";
export type MainnetOpStatus = "pending" | "complete" | "failed";

export interface MainnetPendingOp {
  rumble_id: string;
  op_type: MainnetOpType;
  payload_json: Record<string, unknown>;
  status: MainnetOpStatus;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface MainnetCreateRumblePayload {
  rumbleIdNum: number;
  fighterWallets: string[];
  bettingDeadlineUnix: number;
}

export interface MainnetCompleteRumblePayload {
  rumbleIdNum: number;
}

export interface MainnetReportResultPayload {
  rumbleIdNum: number;
  placements: number[];
  winnerIndex: number;
}

export type MainnetOpPayload =
  | MainnetCreateRumblePayload
  | MainnetCompleteRumblePayload
  | MainnetReportResultPayload
  | Record<string, unknown>;

export interface PersistMainnetOpInput {
  rumbleId: string;
  opType: MainnetOpType;
  payload: MainnetOpPayload;
}

const MAX_MAINNET_RETRY_ATTEMPTS = 5;
const MAX_PENDING_OPS_FETCH = 200;
const RETRY_BACKOFF_MS = [2_000, 4_000, 8_000, 16_000, 32_000];
const TABLE_NAME = "mainnet_pending_ops";

interface MainnetOpRow {
  rumble_id: string;
  op_type: string;
  payload_json: Record<string, unknown> | null;
  status: MainnetOpStatus;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

function freshServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");

  const noStoreFetch: typeof fetch = (input, init) => fetch(input, { ...init, cache: "no-store" });

  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: noStoreFetch },
  });
}

function nowIso(): string {
  return new Date().toISOString();
}

function isKnownOpType(value: string): value is MainnetOpType {
  return value === "completeRumble" || value === "sweepTreasury" || value === "createRumble" || value === "reportResult";
}

function toRow(raw: unknown): MainnetPendingOp | null {
  const row = raw as Partial<MainnetOpRow>;
  if (!row || typeof row !== "object") return null;
  if (typeof row.rumble_id !== "string" || row.rumble_id.length === 0) return null;
  if (typeof row.op_type !== "string" || !isKnownOpType(row.op_type)) return null;

  const attempts = Number(row.attempts);

  return {
    rumble_id: row.rumble_id,
    op_type: row.op_type,
    payload_json: typeof row.payload_json === "object" && row.payload_json !== null ? row.payload_json : {},
    status: row.status ?? "pending",
    attempts: Number.isFinite(attempts) && attempts >= 0 ? attempts : 0,
    last_error: typeof row.last_error === "string" && row.last_error.length > 0 ? row.last_error : null,
    created_at: typeof row.created_at === "string" ? row.created_at : nowIso(),
    updated_at: typeof row.updated_at === "string" ? row.updated_at : nowIso(),
  };
}

function getRetryDelayMs(attempts: number): number {
  if (attempts <= 0) return 0;
  if (attempts > RETRY_BACKOFF_MS.length) return RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1];
  return RETRY_BACKOFF_MS[attempts - 1];
}

function formatError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function persistTxSignature(
  rumbleId: string,
  opType: MainnetOpType,
  sig: string | null,
): Promise<void> {
  if (!sig) return Promise.resolve();

  const step =
    opType === "completeRumble"
      ? "completeRumble_mainnet"
      : opType === "sweepTreasury"
        ? "sweepTreasury_mainnet"
        : opType === "createRumble"
          ? "createRumble_mainnet"
          : "reportResult_mainnet";

  return persist.updateRumbleTxSignature(rumbleId, step as persist.TxStep, sig);
}

function parseCreateRumblePayload(payload: Record<string, unknown>): MainnetCreateRumblePayload {
  const rumbleIdNum = Number(payload.rumbleIdNum);
  const fighterWalletsRaw = Array.isArray(payload.fighterWallets) ? payload.fighterWallets : null;
  const bettingDeadlineUnix = Number(payload.bettingDeadlineUnix);

  if (!Number.isInteger(rumbleIdNum) || rumbleIdNum <= 0 || !fighterWalletsRaw || !Number.isFinite(bettingDeadlineUnix)) {
    throw new Error("Invalid createRumble payload");
  }

  const fighterWallets = fighterWalletsRaw
    .filter((value): value is string => typeof value === "string" && value.length > 0);

  if (fighterWallets.length === 0) {
    throw new Error("Invalid createRumble payload");
  }

  return {
    rumbleIdNum,
    fighterWallets,
    bettingDeadlineUnix,
  };
}

function parseCompleteOrSweepPayload(payload: Record<string, unknown>): MainnetCompleteRumblePayload {
  const rumbleIdNum = Number(payload.rumbleIdNum);
  if (!Number.isInteger(rumbleIdNum) || rumbleIdNum <= 0) {
    throw new Error("Invalid onchain rumble id payload");
  }
  return { rumbleIdNum };
}

function parseReportResultPayload(payload: Record<string, unknown>): MainnetReportResultPayload {
  const rumbleIdNum = Number(payload.rumbleIdNum);
  const winnerIndex = Number(payload.winnerIndex);

  if (!Number.isInteger(rumbleIdNum) || rumbleIdNum <= 0 || !Number.isInteger(winnerIndex)) {
    throw new Error("Invalid reportResult payload");
  }

  const rawPlacements = Array.isArray(payload.placements) ? payload.placements : null;
  if (!rawPlacements || rawPlacements.length === 0) {
    throw new Error("Invalid reportResult payload");
  }

  const placements = rawPlacements.map((value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error("Invalid reportResult payload");
    }
    return Math.max(0, Math.floor(value));
  });

  return {
    rumbleIdNum,
    placements,
    winnerIndex,
  };
}

export async function persistMainnetOp(input: PersistMainnetOpInput): Promise<void> {
  try {
    const sb = freshServiceClient();
    const { data, error } = await sb
      .from(TABLE_NAME)
      .select("status,attempts")
      .eq("rumble_id", input.rumbleId)
      .eq("op_type", input.opType)
      .maybeSingle();

    if (error) throw error;

    if (data && typeof data.status === "string" && data.status === "pending") {
      await sb
        .from(TABLE_NAME)
        .update({
          payload_json: input.payload,
          last_error: null,
          updated_at: nowIso(),
        })
        .eq("rumble_id", input.rumbleId)
        .eq("op_type", input.opType);
      return;
    }

    if (data) return;

    await sb.from(TABLE_NAME).insert({
      rumble_id: input.rumbleId,
      op_type: input.opType,
      payload_json: input.payload,
      status: "pending",
      attempts: 0,
      last_error: null,
      created_at: nowIso(),
      updated_at: nowIso(),
    });
  } catch {
    // intentionally non-fatal
  }
}

export async function markOpComplete(
  rumbleId: string,
  opType: MainnetOpType,
  lastSig: string | null = null,
): Promise<void> {
  if (lastSig) {
    await persistTxSignature(rumbleId, opType, lastSig);
  }

  try {
    const sb = freshServiceClient();
    await sb
      .from(TABLE_NAME)
      .update({
        status: "complete",
        last_error: null,
        updated_at: nowIso(),
      })
      .eq("rumble_id", rumbleId)
      .eq("op_type", opType);
  } catch {
    // intentionally non-fatal
  }
}

export async function markOpFailed(
  rumbleId: string,
  opType: MainnetOpType,
  lastError: string,
): Promise<void> {
  try {
    const sb = freshServiceClient();
    const { data, error } = await sb
      .from(TABLE_NAME)
      .select("attempts,status")
      .eq("rumble_id", rumbleId)
      .eq("op_type", opType)
      .maybeSingle();

    if (error) throw error;
    if (!data) return;
    if (data.status !== "pending") return;

    const nextAttempts = Number(data.attempts ?? 0) + 1;
    const nextStatus: MainnetOpStatus =
      nextAttempts >= MAX_MAINNET_RETRY_ATTEMPTS ? "failed" : "pending";

    await sb
      .from(TABLE_NAME)
      .update({
        attempts: nextAttempts,
        status: nextStatus,
        last_error: lastError,
        updated_at: nowIso(),
      })
      .eq("rumble_id", rumbleId)
      .eq("op_type", opType);
  } catch {
    // intentionally non-fatal
  }
}

async function execute(op: MainnetPendingOp): Promise<void> {
  switch (op.op_type) {
    case "completeRumble": {
      const { rumbleIdNum } = parseCompleteOrSweepPayload(op.payload_json);
      const sig = await completeRumbleMainnet(rumbleIdNum);
      if (!sig) throw new Error("completeRumbleMainnet returned null");
      await persistTxSignature(op.rumble_id, op.op_type, sig);
      await markOpComplete(op.rumble_id, op.op_type, sig);
      return;
    }

    case "sweepTreasury": {
      const { rumbleIdNum } = parseCompleteOrSweepPayload(op.payload_json);
      const sig = await sweepTreasuryMainnet(rumbleIdNum);
      if (!sig) throw new Error("sweepTreasuryMainnet returned null");
      await persistTxSignature(op.rumble_id, op.op_type, sig);
      await markOpComplete(op.rumble_id, op.op_type, sig);
      return;
    }

    case "createRumble": {
      const { rumbleIdNum, fighterWallets, bettingDeadlineUnix } = parseCreateRumblePayload(op.payload_json);
      const fighterPubkeys = fighterWallets.map((rawWallet) => new PublicKey(rawWallet));
      const sig = await createRumbleMainnet(rumbleIdNum, fighterPubkeys, bettingDeadlineUnix);
      if (!sig) throw new Error("createRumbleMainnet returned null");
      await persistTxSignature(op.rumble_id, op.op_type, sig);
      await markOpComplete(op.rumble_id, op.op_type, sig);
      return;
    }

    case "reportResult": {
      const { rumbleIdNum, placements, winnerIndex } = parseReportResultPayload(op.payload_json);
      const sig = await reportResultMainnet(rumbleIdNum, placements, winnerIndex);
      if (!sig) throw new Error("reportResultMainnet returned null");
      await persistTxSignature(op.rumble_id, op.op_type, sig);
      await markOpComplete(op.rumble_id, op.op_type, sig);
      return;
    }

    default:
      throw new Error(`Unknown op type: ${op.op_type}`);
  }
}

export async function retryPendingMainnetOps(): Promise<void> {
  try {
    const sb = freshServiceClient();
    const { data, error } = await sb
      .from(TABLE_NAME)
      .select("rumble_id, op_type, payload_json, status, attempts, last_error, created_at, updated_at")
      .eq("status", "pending")
      .order("updated_at", { ascending: true })
      .limit(MAX_PENDING_OPS_FETCH);

    if (error) return;

    const now = Date.now();
    const rows = (data ?? []).map(toRow).filter((row): row is MainnetPendingOp => row !== null);

    for (const row of rows) {
      const updatedAt = new Date(row.updated_at).getTime();
      if (Number.isNaN(updatedAt)) continue;

      const delayMs = getRetryDelayMs(row.attempts);
      if (row.attempts > 0 && now - updatedAt < delayMs) continue;

      try {
        await execute(row);
      } catch (err) {
        await markOpFailed(row.rumble_id, row.op_type, formatError(err));
      }
    }
  } catch {
    // intentionally non-fatal
  }
}
