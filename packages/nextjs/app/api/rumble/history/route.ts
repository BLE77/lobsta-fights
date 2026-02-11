import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// In-memory history store (will be replaced by Supabase later).
// The orchestrator emits "rumble_complete" events; we register a listener
// once to capture results.

interface RumbleHistoryEntry {
  rumble_id: string;
  slot_index: number;
  winner: string;
  placements: Array<{ id: string; placement: number }>;
  total_turns: number;
  fighter_count: number;
  completed_at: string;
}

const history: RumbleHistoryEntry[] = [];
const MAX_HISTORY = 100;

let listenersRegistered = false;

function ensureListeners() {
  if (listenersRegistered) return;
  listenersRegistered = true;

  try {
    // Dynamic require to avoid issues during build-time static analysis
    const { getOrchestrator } = require("~~/lib/rumble-orchestrator");
    const orchestrator = getOrchestrator();

    orchestrator.on("rumble_complete", (data: any) => {
      const entry: RumbleHistoryEntry = {
        rumble_id: data.rumbleId,
        slot_index: data.slotIndex,
        winner: data.result.winner,
        placements: data.result.placements,
        total_turns: data.result.totalTurns,
        fighter_count: data.result.fighters.length,
        completed_at: new Date().toISOString(),
      };

      history.unshift(entry);
      if (history.length > MAX_HISTORY) {
        history.pop();
      }
    });
  } catch {
    // Orchestrator not available during build. Will retry on next request.
    listenersRegistered = false;
  }
}

/**
 * Append a completed rumble to history (called externally if needed).
 */
export function addToHistory(entry: RumbleHistoryEntry): void {
  history.unshift(entry);
  if (history.length > MAX_HISTORY) {
    history.pop();
  }
}

/**
 * GET /api/rumble/history?limit=10&offset=0
 *
 * Returns recent completed Rumbles with placements and results.
 */
export async function GET(request: Request) {
  ensureListeners();

  try {
    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get("limit") ?? "10", 10) || 10, 50);
    const offset = parseInt(searchParams.get("offset") ?? "0", 10) || 0;

    const page = history.slice(offset, offset + limit);

    return NextResponse.json({
      total: history.length,
      limit,
      offset,
      results: page,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
