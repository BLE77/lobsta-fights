import { getOrchestrator, type OrchestratorEvent } from "~~/lib/rumble-orchestrator";

export const dynamic = "force-dynamic";

/**
 * GET /api/rumble/live
 *
 * Server-Sent Events (SSE) endpoint for live Rumble updates.
 * Hooks directly into orchestrator events:
 *   turn_resolved, fighter_eliminated, rumble_complete,
 *   ichor_shower, betting_open, betting_closed, combat_started,
 *   payout_complete, slot_recycled
 */
export async function GET() {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const orchestrator = getOrchestrator();

      function send(event: string, data: any) {
        try {
          const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
          controller.enqueue(encoder.encode(payload));
        } catch {
          // Stream closed; ignore
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

      const callbacks = new Map<OrchestratorEvent, (data: any) => void>();

      for (const eventName of events) {
        const cb = (data: any) => send(eventName, data);
        callbacks.set(eventName, cb);
        orchestrator.on(eventName, cb);
      }

      // Heartbeat every 15 seconds to keep the connection alive
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: heartbeat ${new Date().toISOString()}\n\n`));
        } catch {
          clearInterval(heartbeat);
        }
      }, 15_000);

      // Store cleanup for when the stream is cancelled
      (controller as any).__cleanup = () => {
        clearInterval(heartbeat);
        for (const [eventName, cb] of callbacks) {
          orchestrator.off(eventName, cb);
        }
      };
    },
    cancel(controller: any) {
      if (controller?.__cleanup) {
        controller.__cleanup();
      }
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
