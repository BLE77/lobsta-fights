import { getOrchestrator } from "~~/lib/rumble-orchestrator";
import { hasRecovered, recoverOrchestratorState } from "~~/lib/rumble-state-recovery";

const MIN_INTERVAL_MS = (() => {
  const raw = Number(process.env.RUMBLE_PUBLIC_TICK_MIN_INTERVAL_MS ?? "2500");
  if (!Number.isFinite(raw)) return 2500;
  return Math.max(500, Math.min(30_000, Math.floor(raw)));
})();

// Production default is OFF to avoid multi-instance heartbeat stampedes
// from public /status polling. Enable explicitly via env when desired.
const ENABLED = (() => {
  const raw = process.env.RUMBLE_PUBLIC_TICK_ENABLED;
  if (raw === "true") return true;
  if (raw === "false") return false;
  return process.env.NODE_ENV !== "production";
})();

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
