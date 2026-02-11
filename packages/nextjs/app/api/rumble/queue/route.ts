import { NextResponse } from "next/server";
import { getQueueManager } from "~~/lib/queue-manager";
import { getOrchestrator } from "~~/lib/rumble-orchestrator";

export const dynamic = "force-dynamic";

/**
 * GET /api/rumble/queue
 *
 * Get queue status: entries, positions, estimated wait times.
 */
export async function GET(request: Request) {
  try {
    const qm = getQueueManager();
    const { searchParams } = new URL(request.url);
    const fighterId = searchParams.get("fighter_id");

    const response: Record<string, any> = {
      queue_length: qm.getQueueLength(),
      timestamp: new Date().toISOString(),
    };

    if (fighterId) {
      const position = qm.getQueuePosition(fighterId);
      const estimatedWait = qm.getEstimatedWait(fighterId);
      response.fighter = {
        fighter_id: fighterId,
        position,
        estimated_wait_ms: estimatedWait,
        in_queue: position !== null,
      };
    }

    return NextResponse.json(response);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * POST /api/rumble/queue
 *
 * Fighter joins the Rumble queue.
 * Body: { fighter_id, auto_requeue? }
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const fighterId = body.fighter_id || body.fighterId;
    const autoRequeue = body.auto_requeue ?? body.autoRequeue ?? false;

    if (!fighterId || typeof fighterId !== "string") {
      return NextResponse.json(
        { error: "Missing fighter_id", required: ["fighter_id"], optional: ["auto_requeue"] },
        { status: 400 },
      );
    }

    const qm = getQueueManager();
    const orchestrator = getOrchestrator();

    const entry = qm.addToQueue(fighterId, autoRequeue);

    // Track auto-requeue preference in the orchestrator for active slots
    if (autoRequeue) {
      const slots = qm.getSlots();
      for (const slot of slots) {
        if (slot.fighters.includes(fighterId)) {
          orchestrator.setAutoRequeue(slot.slotIndex, fighterId, true);
        }
      }
    }

    const position = qm.getQueuePosition(fighterId);
    const estimatedWait = qm.getEstimatedWait(fighterId);

    return NextResponse.json({
      status: "queued",
      fighter_id: fighterId,
      position,
      auto_requeue: entry.autoRequeue,
      estimated_wait_ms: estimatedWait,
      joined_at: entry.joinedAt.toISOString(),
    });
  } catch (error: any) {
    if (error.message?.includes("already in active Rumble")) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * DELETE /api/rumble/queue
 *
 * Fighter leaves the Rumble queue.
 * Body: { fighter_id }
 */
export async function DELETE(request: Request) {
  try {
    const body = await request.json();
    const fighterId = body.fighter_id || body.fighterId;

    if (!fighterId || typeof fighterId !== "string") {
      return NextResponse.json(
        { error: "Missing fighter_id", required: ["fighter_id"] },
        { status: 400 },
      );
    }

    const qm = getQueueManager();
    const removed = qm.removeFromQueue(fighterId);

    if (!removed) {
      return NextResponse.json(
        { error: "Fighter not found in queue" },
        { status: 404 },
      );
    }

    return NextResponse.json({
      status: "removed",
      fighter_id: fighterId,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
