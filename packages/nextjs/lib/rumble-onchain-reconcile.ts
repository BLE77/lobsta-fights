import * as persist from "./rumble-persistence";
import {
  advanceTurnOnChain,
  finalizeRumbleOnChain,
  isCombatStateDelegated,
  openTurn,
  readRumbleCombatState,
  readRumbleAccountState,
  resolveTurnOnChain,
  startCombat as startCombatOnChain,
  undelegateCombatFromEr,
  waitForUndelegation,
} from "./solana-programs";
import { parseOnchainRumbleIdNumber } from "./rumble-id";
import { getConnection } from "./solana-connection";

const g = globalThis as unknown as { __rumbleOnchainReconcileLastRunMs?: number };
const MIN_INTERVAL_MS = process.env.NODE_ENV === "production" ? 60_000 : 20_000;

function resolveOnchainRumbleIdNumber(row: {
  id: string;
  rumble_number?: number | null;
}): number | null {
  if (Number.isSafeInteger(row.rumble_number) && (row.rumble_number ?? -1) >= 0) {
    return row.rumble_number as number;
  }
  return parseOnchainRumbleIdNumber(row.id);
}

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
  const l1Connection = getConnection();
  const result: OnchainReconcileResult = {
    ran: true,
    attempted: 0,
    reported: 0,
    details: [],
    errors: [],
  };

  for (const row of rows) {
    const rumbleIdNum = resolveOnchainRumbleIdNumber(row);
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

      // If we're in combat on L1 and not delegated, try to actively progress
      // stuck turns before attempting finalize.
      const combat = await readRumbleCombatState(rumbleIdNum, l1Connection).catch(() => null);
      if (combat) {
        const currentSlot = await l1Connection.getSlot("confirmed").catch(() => null);
        const revealCloseSlot = Number(combat.revealCloseSlot ?? 0n);

        if (combat.currentTurn === 0) {
          const openSig = await openTurn(rumbleIdNum, l1Connection).catch(() => null);
          if (openSig) {
            await persist.updateRumbleTxSignature(row.id, "openTurn", openSig);
          }
          result.details.push({
            rumbleId: row.id,
            action: openSig ? "open_turn_recovery_sent" : "open_turn_recovery_failed",
            stateBefore,
            stateAfter: "combat",
            signature: openSig,
          });
          continue;
        }

        if (!combat.turnResolved) {
          if (currentSlot !== null && currentSlot >= revealCloseSlot) {
            const resolveSig = await resolveTurnOnChain(rumbleIdNum, [], l1Connection).catch(() => null);
            if (resolveSig) {
              await persist.updateRumbleTxSignature(row.id, "resolveTurn", resolveSig);
            }
            result.details.push({
              rumbleId: row.id,
              action: resolveSig ? "resolve_turn_recovery_sent" : "resolve_turn_recovery_failed",
              stateBefore,
              stateAfter: "combat",
              signature: resolveSig,
            });
          } else {
            result.details.push({
              rumbleId: row.id,
              action: "waiting_reveal_window",
              stateBefore,
              stateAfter: "combat",
            });
          }
          continue;
        }

        if (combat.remainingFighters > 1 && currentSlot !== null && currentSlot >= revealCloseSlot) {
          const advanceSig = await advanceTurnOnChain(rumbleIdNum, l1Connection).catch(() => null);
          if (advanceSig) {
            await persist.updateRumbleTxSignature(row.id, "advanceTurn", advanceSig);
          }
          result.details.push({
            rumbleId: row.id,
            action: advanceSig ? "advance_turn_recovery_sent" : "advance_turn_recovery_failed",
            stateBefore,
            stateAfter: "combat",
            signature: advanceSig,
          });
          continue;
        }
      }

      // If combat_state is still delegated, finalize cannot write to L1.
      // Re-trigger undelegation here so completed rumbles can self-heal even
      // after process restarts or after initial background retries gave up.
      const delegated = await isCombatStateDelegated(rumbleIdNum).catch(() => false);
      if (delegated) {
        const undelegateSig = await undelegateCombatFromEr(rumbleIdNum).catch(() => null);
        const undelegated = await waitForUndelegation(rumbleIdNum, 20_000).catch(() => false);
        if (!undelegated) {
          result.details.push({
            rumbleId: row.id,
            action: "undelegate_pending",
            stateBefore,
            stateAfter: "combat",
            signature: undelegateSig,
          });
          continue;
        }
      }

      result.attempted += 1;
      let finalizeSig: string | null = null;
      try {
        finalizeSig = await finalizeRumbleOnChain(rumbleIdNum);
      } catch (finalizeErr) {
        const msg = String(finalizeErr);
        const turnNotOpen =
          msg.includes("TurnNotOpen") ||
          msg.includes("Error Number: 6025") ||
          msg.includes("custom program error: 0x1789");
        if (turnNotOpen) {
          const openSig = await openTurn(rumbleIdNum).catch(() => null);
          if (openSig) {
            await persist.updateRumbleTxSignature(row.id, "openTurn", openSig);
          }
          const stateAfterOpen = await readRumbleAccountState(rumbleIdNum).catch(() => null);
          result.details.push({
            rumbleId: row.id,
            action: openSig ? "open_turn_recovery_sent" : "open_turn_recovery_failed",
            stateBefore,
            stateAfter: stateAfterOpen?.state ?? null,
            signature: openSig,
          });
          continue;
        }
        throw finalizeErr;
      }

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
