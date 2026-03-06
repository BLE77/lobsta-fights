// =============================================================================
// Worker Commands — Supabase-based command queue for admin → Railway worker
//
// Admin page (Vercel) writes commands to the `worker_commands` table.
// Railway worker picks them up every tick and executes them.
// =============================================================================

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const noStoreFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, cache: "no-store" });

function freshClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing Supabase env vars");
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: noStoreFetch },
  });
}

export type WorkerCommand = "start_bots" | "stop_bots" | "set_bot_target" | "restart_bots" | "clear_bot_target" | "test_run";

export interface WorkerCommandRow {
  id: string;
  command: WorkerCommand;
  payload_json: Record<string, unknown>;
  status: "pending" | "complete" | "failed";
  result_json: Record<string, unknown> | null;
  created_at: string;
  completed_at: string | null;
}

/**
 * Queue a command for the Railway worker to pick up.
 * Called from Vercel admin endpoints.
 * Returns the command ID for polling.
 */
export async function queueWorkerCommand(
  command: WorkerCommand,
  payload: Record<string, unknown> = {},
): Promise<{ id: string } | null> {
  try {
    const sb = freshClient();
    const { data, error } = await sb
      .from("worker_commands")
      .insert({ command, payload_json: payload })
      .select("id")
      .single();

    if (error) {
      console.error("[WorkerCommands] Failed to queue command:", error.message);
      return null;
    }
    return { id: data.id };
  } catch (err) {
    console.error("[WorkerCommands] Queue error:", (err as Error).message);
    return null;
  }
}

/**
 * Get the status of a queued command (for polling from admin page).
 */
export async function getCommandStatus(commandId: string): Promise<WorkerCommandRow | null> {
  try {
    const sb = freshClient();
    const { data, error } = await sb
      .from("worker_commands")
      .select("*")
      .eq("id", commandId)
      .single();

    if (error) return null;
    return data as WorkerCommandRow;
  } catch {
    return null;
  }
}

/**
 * Fetch and execute pending commands. Called by Railway worker every tick.
 * Returns number of commands processed.
 */
export async function processPendingWorkerCommands(
  executor: {
    pauseHouseBots: () => Promise<any>;
    resumeHouseBots: () => Promise<void>;
    restartHouseBots: () => Promise<any>;
    setHouseBotTargetPopulation: (target: number | null) => number;
    getHouseBotControlStatus: () => any;
    queueHouseBotsManually: (count: number) => Promise<{ queued: string[]; skipped: string[] }>;
    tick: () => Promise<void>;
    getStatus: () => any[];
  },
): Promise<number> {
  try {
    const sb = freshClient();
    const { data, error } = await sb
      .from("worker_commands")
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(10);

    if (error || !data || data.length === 0) return 0;

    let processed = 0;
    for (const row of data as WorkerCommandRow[]) {
      try {
        const result = await executeCommand(row, executor);
        await sb
          .from("worker_commands")
          .update({
            status: "complete",
            result_json: result,
            completed_at: new Date().toISOString(),
          })
          .eq("id", row.id);
        processed++;
        console.log(`[WorkerCommands] Executed: ${row.command} (${row.id})`);
      } catch (err) {
        await sb
          .from("worker_commands")
          .update({
            status: "failed",
            result_json: { error: (err as Error).message },
            completed_at: new Date().toISOString(),
          })
          .eq("id", row.id);
        console.warn(`[WorkerCommands] Failed: ${row.command} (${row.id}):`, (err as Error).message);
      }
    }
    return processed;
  } catch (err: any) {
    console.error("[WorkerCommands] processPendingWorkerCommands error:", err?.message ?? err);
    return 0;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function executeCommand(
  row: WorkerCommandRow,
  executor: {
    pauseHouseBots: () => Promise<any>;
    resumeHouseBots: () => Promise<void>;
    restartHouseBots: () => Promise<any>;
    setHouseBotTargetPopulation: (target: number | null) => number;
    getHouseBotControlStatus: () => any;
    queueHouseBotsManually: (count: number) => Promise<{ queued: string[]; skipped: string[] }>;
    tick: () => Promise<void>;
    getStatus: () => any[];
  },
): Promise<Record<string, unknown>> {
  switch (row.command) {
    case "start_bots": {
      await executor.resumeHouseBots();
      return { action: "resumed", status: executor.getHouseBotControlStatus() };
    }
    case "stop_bots": {
      const result = await executor.pauseHouseBots();
      return { action: "paused", ...result, status: executor.getHouseBotControlStatus() };
    }
    case "restart_bots": {
      const result = await executor.restartHouseBots();
      return { action: "restarted", ...result, status: executor.getHouseBotControlStatus() };
    }
    case "set_bot_target": {
      const target = Number(row.payload_json?.target_population);
      if (!Number.isFinite(target)) throw new Error("Invalid target_population");
      const applied = executor.setHouseBotTargetPopulation(target);
      return { action: "set_target", target_population: applied, status: executor.getHouseBotControlStatus() };
    }
    case "clear_bot_target": {
      const applied = executor.setHouseBotTargetPopulation(null);
      return { action: "cleared_target", target_population: applied, status: executor.getHouseBotControlStatus() };
    }
    case "test_run": {
      const fighterCount = Math.min(16, Math.max(12, Math.floor(Number(row.payload_json?.fighter_count) || 12)));
      const wasPaused = executor.getHouseBotControlStatus().paused;
      if (!wasPaused) await executor.pauseHouseBots();
      const { queued, skipped } = await executor.queueHouseBotsManually(fighterCount);
      if (queued.length === 0) {
        if (!wasPaused) executor.resumeHouseBots();
        throw new Error(`No bots could be queued. Skipped: ${skipped.join(", ")}`);
      }
      for (let i = 0; i < 3; i++) {
        await executor.tick();
        if (i < 2) await sleep(500);
      }
      if (!wasPaused) executor.resumeHouseBots();
      const slots = executor.getStatus().map((slot: any) => ({
        slotIndex: slot.slotIndex,
        state: slot.state,
        rumbleId: slot.rumbleId,
        fighters: slot.fighters?.length ?? 0,
      }));
      return { action: "test_run", queued, queuedCount: queued.length, skipped, slots };
    }
    default:
      throw new Error(`Unknown command: ${row.command}`);
  }
}
