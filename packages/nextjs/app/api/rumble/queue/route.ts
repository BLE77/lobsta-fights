import { NextResponse } from "next/server";
import { getQueueManager } from "~~/lib/queue-manager";
import { getOrchestrator } from "~~/lib/rumble-orchestrator";
import { saveQueueFighter, removeQueueFighter } from "~~/lib/rumble-persistence";
import { freshSupabase } from "~~/lib/supabase";
import { getApiKeyFromHeaders } from "~~/lib/request-auth";
import { checkRateLimit, getRateLimitKey, rateLimitResponse } from "~~/lib/rate-limit";
import { hashApiKey } from "~~/lib/api-key";

export const dynamic = "force-dynamic";

async function isAuthorizedFighter(fighterId: string, apiKey: string): Promise<boolean> {
  const hashedKey = hashApiKey(apiKey);

  const { data } = await freshSupabase()
    .from("ucf_fighters")
    .select("id")
    .eq("id", fighterId)
    .eq("api_key_hash", hashedKey)
    .maybeSingle();

  return !!data;
}

/**
 * GET /api/rumble/queue
 *
 * Get queue status: entries, positions, estimated wait times.
 */
export async function GET(request: Request) {
  const rlKey = getRateLimitKey(request);
  const rl = checkRateLimit("PUBLIC_READ", rlKey);
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

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
    return NextResponse.json({ error: "Failed to fetch queue status" }, { status: 500 });
  }
}

/**
 * POST /api/rumble/queue
 *
 * Fighter joins the Rumble queue.
 * Body: { fighter_id, api_key?, auto_requeue? }
 * Auth: x-api-key header or api_key in body
 */
export async function POST(request: Request) {
  const rlKey = getRateLimitKey(request);
  const rl = checkRateLimit("AUTHENTICATED", rlKey);
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

  try {
    const body = await request.json();
    const fighterId = body.fighter_id || body.fighterId;
    const autoRequeue = body.auto_requeue ?? body.autoRequeue ?? false;
    const apiKey = body.api_key || body.apiKey || getApiKeyFromHeaders(request.headers);

    if (!fighterId || typeof fighterId !== "string") {
      return NextResponse.json(
        { error: "Missing fighter_id", required: ["fighter_id"], optional: ["auto_requeue"] },
        { status: 400 },
      );
    }
    if (!apiKey || typeof apiKey !== "string") {
      return NextResponse.json(
        { error: "Missing API key. Provide x-api-key header or api_key in body." },
        { status: 400 },
      );
    }
    if (!(await isAuthorizedFighter(fighterId, apiKey))) {
      return NextResponse.json({ error: "Invalid fighter credentials" }, { status: 401 });
    }

    // Sybil protection: limit concurrent fighters from same IP in queue/active Rumbles
    const { data: thisFighter } = await freshSupabase()
      .from("ucf_fighters")
      .select("registered_from_ip")
      .eq("id", fighterId)
      .maybeSingle();

    if (thisFighter?.registered_from_ip) {
      // Find all fighter IDs registered from same IP
      const { data: samIpFighters } = await freshSupabase()
        .from("ucf_fighters")
        .select("id")
        .eq("registered_from_ip", thisFighter.registered_from_ip)
        .neq("id", fighterId);

      if (samIpFighters && samIpFighters.length > 0) {
        const siblingIds = samIpFighters.map((f: { id: string }) => f.id);

        // Count how many siblings are in the queue or active Rumbles
        const { count: queuedSiblings } = await freshSupabase()
          .from("ucf_rumble_queue")
          .select("id", { count: "exact", head: true })
          .in("fighter_id", siblingIds);

        if (queuedSiblings !== null && queuedSiblings >= 2) {
          return NextResponse.json(
            { error: "Too many fighters from your network in active Rumbles. Max 2 concurrent." },
            { status: 429 },
          );
        }
      }
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

    // Persist to Supabase (awaited so tick route recovery sees all fighters)
    await saveQueueFighter(fighterId, "waiting", autoRequeue);

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
      return NextResponse.json({ error: "Fighter is already in an active Rumble" }, { status: 409 });
    }
    return NextResponse.json({ error: "Failed to join queue" }, { status: 500 });
  }
}

/**
 * DELETE /api/rumble/queue
 *
 * Fighter leaves the Rumble queue.
 * Body: { fighter_id, api_key? }
 * Auth: x-api-key header or api_key in body
 */
export async function DELETE(request: Request) {
  const rlKey = getRateLimitKey(request);
  const rl = checkRateLimit("AUTHENTICATED", rlKey);
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

  try {
    const body = await request.json();
    const fighterId = body.fighter_id || body.fighterId;
    const apiKey = body.api_key || body.apiKey || getApiKeyFromHeaders(request.headers);

    if (!fighterId || typeof fighterId !== "string") {
      return NextResponse.json(
        { error: "Missing fighter_id", required: ["fighter_id"] },
        { status: 400 },
      );
    }
    if (!apiKey || typeof apiKey !== "string") {
      return NextResponse.json(
        { error: "Missing API key. Provide x-api-key header or api_key in body." },
        { status: 400 },
      );
    }
    if (!(await isAuthorizedFighter(fighterId, apiKey))) {
      return NextResponse.json({ error: "Invalid fighter credentials" }, { status: 401 });
    }

    const qm = getQueueManager();
    const removed = qm.removeFromQueue(fighterId);

    if (!removed) {
      return NextResponse.json(
        { error: "Fighter not found in queue" },
        { status: 404 },
      );
    }

    // Remove from Supabase persistence
    await removeQueueFighter(fighterId);

    return NextResponse.json({
      status: "removed",
      fighter_id: fighterId,
    });
  } catch (error: any) {
    return NextResponse.json({ error: "Failed to leave queue" }, { status: 500 });
  }
}
