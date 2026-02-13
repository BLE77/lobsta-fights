import { getOrchestrator, type OrchestratorEvent } from "~~/lib/rumble-orchestrator";
import { checkRateLimit, getRateLimitKey, rateLimitResponse } from "~~/lib/rate-limit";

export const dynamic = "force-dynamic";
const MAX_SSE_CONNECTIONS = 200;
let activeSseConnections = 0;

/**
 * GET /api/rumble/live
 *
 * Server-Sent Events (SSE) endpoint for live Rumble updates.
 * Hooks directly into orchestrator events:
 *   turn_resolved, fighter_eliminated, rumble_complete,
 *   ichor_shower, betting_open, betting_closed, combat_started,
 *   payout_complete, slot_recycled
 */
export async function GET(request: Request) {
  const rlKey = getRateLimitKey(request);
  const rl = checkRateLimit("SSE", rlKey);
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

  if (activeSseConnections >= MAX_SSE_CONNECTIONS) {
    return new Response(
      JSON.stringify({
        error: "Too many live connections",
        max_connections: MAX_SSE_CONNECTIONS,
      }),
      {
        status: 429,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  const encoder = new TextEncoder();
  let cleanup: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const orchestrator = getOrchestrator();
      activeSseConnections += 1;
      let cleanedUp = false;
      const callbacks = new Map<OrchestratorEvent, (data: any) => void>();
      let heartbeat: ReturnType<typeof setInterval> | null = null;

      const runCleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        if (heartbeat) {
          clearInterval(heartbeat);
        }
        for (const [eventName, cb] of callbacks) {
          orchestrator.off(eventName, cb);
        }
        activeSseConnections = Math.max(0, activeSseConnections - 1);
      };
      cleanup = runCleanup;

      function send(event: string, data: any) {
        try {
          const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
          controller.enqueue(encoder.encode(payload));
        } catch {
          runCleanup();
        }
      }

      // Send initial connection event
      send("connected", {
        message: "Connected to Rumble live feed",
        timestamp: new Date().toISOString(),
      });

      // Register listeners for all orchestrator events
      const events: OrchestratorEvent[] = [
        "turn_resolved",
        "fighter_eliminated",
        "rumble_complete",
        "ichor_shower",
        "betting_open",
        "betting_closed",
        "combat_started",
        "payout_complete",
        "slot_recycled",
      ];

      for (const eventName of events) {
        const cb = (data: any) => send(eventName, data);
        callbacks.set(eventName, cb);
        orchestrator.on(eventName, cb);
      }

      // Heartbeat every 15 seconds to keep the connection alive
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: heartbeat ${new Date().toISOString()}\n\n`));
        } catch {
          runCleanup();
        }
      }, 15_000);
    },
    cancel() {
      cleanup?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
