import * as persist from "./rumble-persistence";
import {
  finalizeRumbleOnChain,
  readRumbleAccountState,
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

      // If the rumble never transitioned out of betting, try start_combat first.
      if (state.state === "betting") {
        const startSig = await startCombatOnChain(rumbleIdNum).catch(() => null);
        if (startSig) {
          await persist.updateRumbleTxSignature(row.id, "startCombat", startSig);
        }
        state = await readRumbleAccountState(rumbleIdNum).catch(() => null);
      }
      if (!state) {
        result.details.push({
          rumbleId: row.id,
          action: "skip_state_unavailable",
          stateBefore,
          stateAfter: null,
        });
        continue;
      }

      if (state.state !== "combat") {
        result.details.push({
          rumbleId: row.id,
          action: "skip_not_combat",
          stateBefore,
          stateAfter: state.state,
        });
        continue;
      }

      result.attempted += 1;
      const finalizeSig = await finalizeRumbleOnChain(rumbleIdNum);

      const stateAfter = await readRumbleAccountState(rumbleIdNum).catch(() => null);
      if (finalizeSig) {
        await persist.updateRumbleTxSignature(row.id, "reportResult", finalizeSig);
        result.reported += 1;
      }

      result.details.push({
        rumbleId: row.id,
        action: finalizeSig ? "finalize_sent" : "finalize_skipped",
        stateBefore,
        stateAfter: stateAfter?.state ?? null,
        signature: finalizeSig ?? null,
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
