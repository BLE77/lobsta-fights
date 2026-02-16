import { getOrchestrator } from "~~/lib/rumble-orchestrator";
import { hasRecovered, recoverOrchestratorState } from "~~/lib/rumble-state-recovery";

const MIN_INTERVAL_MS = (() => {
  const fallback = process.env.NODE_ENV === "production" ? 15_000 : 2_500;
  const raw = Number(process.env.RUMBLE_PUBLIC_TICK_MIN_INTERVAL_MS ?? String(fallback));
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(500, Math.min(30_000, Math.floor(raw)));
})();

// Keep public heartbeat enabled by default so queue/slots continue advancing
// even when cron/admin tab is not open. Can be explicitly disabled.
const ENABLED = (process.env.RUMBLE_PUBLIC_TICK_ENABLED ?? "true") !== "false";
const ALLOW_NON_STATUS_SOURCES = (process.env.RUMBLE_PUBLIC_TICK_ALLOW_NON_STATUS ?? "false") === "true";

type HeartbeatState = {
  inFlight: Promise<void> | null;
  lastTickAt: number;
};

const g = globalThis as unknown as { __rumblePublicHeartbeat?: HeartbeatState };

function getState(): HeartbeatState {
  if (!g.__rumblePublicHeartbeat) {
    g.__rumblePublicHeartbeat = {
      inFlight: null,
      lastTickAt: 0,
    };
  }
  return g.__rumblePublicHeartbeat;
}

export async function ensureRumblePublicHeartbeat(source: string): Promise<void> {
  if (!ENABLED) return;
  if (!ALLOW_NON_STATUS_SOURCES && source !== "status") return;

  const state = getState();
  if (state.inFlight) {
    await state.inFlight;
    return;
  }

  const now = Date.now();
  if (now - state.lastTickAt < MIN_INTERVAL_MS) return;

  state.inFlight = (async () => {
    try {
      if (!hasRecovered()) {
        await recoverOrchestratorState().catch((err) => {
          console.warn(`[RumbleHeartbeat:${source}] recovery failed`, err);
        });
      }
      const orchestrator = getOrchestrator();
      await orchestrator.tick();
      state.lastTickAt = Date.now();
    } catch (err) {
      console.warn(`[RumbleHeartbeat:${source}] tick failed`, err);
    } finally {
      state.inFlight = null;
    }
  })();

  await state.inFlight;
}
