import * as persist from "./rumble-persistence";
import {
  readRumbleAccountState,
  reportResult as reportResultOnChain,
  startCombat as startCombatOnChain,
} from "./solana-programs";
import { parseOnchainRumbleIdNumber } from "./rumble-id";

const g = globalThis as unknown as { __rumbleOnchainReconcileLastRunMs?: number };
const MIN_INTERVAL_MS = process.env.NODE_ENV === "production" ? 60_000 : 20_000;

interface ReconcileDetail {
  rumbleId: string;
  action: string;
  stateBefore: string | null;
  stateAfter: string | null;
  signature?: string | null;
  error?: string;
}

export interface OnchainReconcileResult {
  ran: boolean;
  attempted: number;
  reported: number;
  details: ReconcileDetail[];
  errors: string[];
}

function toFighterId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const id = (value as any).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function toPlacement(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const p = Number((value as any).placement);
  return Number.isInteger(p) && p > 0 ? p : null;
}

function buildPlacementVector(row: persist.CompletedRumbleForOnchainReconcile): {
  placementVector: number[];
  winnerIndex: number;
} | null {
  const fighters = Array.isArray(row.fighters) ? row.fighters : [];
  const placements = Array.isArray(row.placements) ? row.placements : [];
  if (fighters.length < 2 || placements.length < 2) return null;

  const placementById = new Map<string, number>();
  for (const item of placements) {
    const id = toFighterId(item);
    const placement = toPlacement(item);
    if (!id || placement === null) continue;
    placementById.set(id, placement);
  }
  if (placementById.size === 0) return null;

  const placementVector: number[] = [];
  for (const fighter of fighters) {
    const fighterId = toFighterId(fighter);
    if (!fighterId) return null;
    const placement = placementById.get(fighterId);
    if (!placement || !Number.isInteger(placement) || placement < 1) return null;
    placementVector.push(placement);
  }

  const winnerIndex = placementVector.findIndex((p) => p === 1);
  if (winnerIndex < 0) return null;

  return { placementVector, winnerIndex };
}

export async function reconcileOnchainReportResults(options?: {
  force?: boolean;
  limit?: number;
}): Promise<OnchainReconcileResult> {
  const force = options?.force === true;
  const limit = options?.limit ?? 10;

  const now = Date.now();
  const lastRun = g.__rumbleOnchainReconcileLastRunMs ?? 0;
  if (!force && now - lastRun < MIN_INTERVAL_MS) {
    return {
      ran: false,
      attempted: 0,
      reported: 0,
      details: [],
      errors: [],
    };
  }
  g.__rumbleOnchainReconcileLastRunMs = now;

  const rows = await persist.loadRecentCompletedRumblesForOnchainReconcile(limit);
  const result: OnchainReconcileResult = {
    ran: true,
    attempted: 0,
    reported: 0,
    details: [],
    errors: [],
  };

  for (const row of rows) {
    const rumbleIdNum = parseOnchainRumbleIdNumber(row.id);
    if (rumbleIdNum === null) {
      result.details.push({
        rumbleId: row.id,
        action: "skip_invalid_rumble_id",
        stateBefore: null,
        stateAfter: null,
      });
      continue;
    }

    try {
      let state = await readRumbleAccountState(rumbleIdNum).catch(() => null);
      if (!state) {
        result.details.push({
          rumbleId: row.id,
          action: "skip_offchain_only",
          stateBefore: null,
          stateAfter: null,
        });
        continue;
      }

      const stateBefore = state.state;
      if (stateBefore === "payout" || stateBefore === "complete") {
        result.details.push({
          rumbleId: row.id,
          action: "skip_already_settled",
          stateBefore,
          stateAfter: stateBefore,
        });
        continue;
      }

      const built = buildPlacementVector(row);
      if (!built) {
        result.details.push({
          rumbleId: row.id,
          action: "skip_missing_placements",
          stateBefore,
          stateAfter: stateBefore,
        });
        continue;
      }

      // If the rumble never transitioned out of betting, try start_combat first.
      if (state.state === "betting") {
        const startSig = await startCombatOnChain(rumbleIdNum).catch(() => null);
        if (startSig) {
          await persist.updateRumbleTxSignature(row.id, "startCombat", startSig);
        }
        state = await readRumbleAccountState(rumbleIdNum).catch(() => null);
      }

      result.attempted += 1;
      const reportSig = await reportResultOnChain(
        rumbleIdNum,
        built.placementVector,
        built.winnerIndex,
      );

      const stateAfter = await readRumbleAccountState(rumbleIdNum).catch(() => null);
      if (reportSig) {
        await persist.updateRumbleTxSignature(row.id, "reportResult", reportSig);
        result.reported += 1;
      }

      result.details.push({
        rumbleId: row.id,
        action: reportSig ? "report_result_sent" : "report_result_skipped",
        stateBefore,
        stateAfter: stateAfter?.state ?? null,
        signature: reportSig ?? null,
      });
    } catch (error) {
      const message = `[OnchainReconcile] ${row.id}: ${String(error)}`;
      result.errors.push(message);
      result.details.push({
        rumbleId: row.id,
        action: "error",
        stateBefore: null,
        stateAfter: null,
        error: String(error),
      });
    }
  }

  return result;
}
