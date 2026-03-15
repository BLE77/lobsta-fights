import { NextResponse } from "next/server";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { getQueueManager } from "~~/lib/queue-manager";
import { getOrchestrator } from "~~/lib/rumble-orchestrator";
import { saveQueueFighter, removeQueueFighter } from "~~/lib/rumble-persistence";
import { freshSupabase } from "~~/lib/supabase";
import { getApiKeyFromHeaders } from "~~/lib/request-auth";
import { checkRateLimit, getRateLimitKey, rateLimitResponse } from "~~/lib/rate-limit";
import { hashApiKey } from "~~/lib/api-key";
import { requireJsonContentType, sanitizeErrorResponse } from "~~/lib/api-middleware";
import { getCachedBalance, getConnection } from "~~/lib/solana-connection";

/** Minimum SOL balance required to join queue (covers MoveCommitment rent per turn) */
const MIN_SOL_TO_QUEUE = 0.05;
const QUEUE_BALANCE_CACHE_TTL_MS = Math.max(
  5_000,
  Number(process.env.RUMBLE_QUEUE_BALANCE_CACHE_TTL_MS ?? "300000"), // 5 min — bots requeue constantly, balance barely changes
);
const ACTIVE_RUMBLE_STATUSES = ["betting", "combat", "payout"] as const;

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

async function countConcurrentSiblingFighters(siblingIds: string[]): Promise<number> {
  if (siblingIds.length === 0) return 0;

  const sb = freshSupabase();
  const [queueResult, rumbleResult] = await Promise.all([
    sb
      .from("ucf_rumble_queue")
      .select("fighter_id, status")
      .in("fighter_id", siblingIds),
    sb
      .from("ucf_rumbles")
      .select("fighters, status")
      .in("status", [...ACTIVE_RUMBLE_STATUSES]),
  ]);

  if (queueResult.error) throw queueResult.error;
  if (rumbleResult.error) throw rumbleResult.error;

  const activeRumbleFighterIds = new Set<string>();
  for (const row of rumbleResult.data ?? []) {
    const fighters = Array.isArray(row.fighters) ? row.fighters : [];
    for (const fighter of fighters) {
      const fighterId = typeof fighter?.id === "string" ? fighter.id : null;
      if (fighterId && siblingIds.includes(fighterId)) {
        activeRumbleFighterIds.add(fighterId);
      }
    }
  }

  const staleInCombatIds = (queueResult.data ?? [])
    .filter((row) => row.status === "in_combat" && !activeRumbleFighterIds.has(row.fighter_id))
    .map((row) => row.fighter_id);

  if (staleInCombatIds.length > 0) {
    const { error } = await freshSupabase()
      .from("ucf_rumble_queue")
      .delete()
      .in("fighter_id", staleInCombatIds)
      .eq("status", "in_combat");
    if (error) {
      console.warn("[Queue] Failed to clean stale in_combat sibling rows:", error);
    } else {
      console.log(
        `[Queue] Cleaned ${staleInCombatIds.length} stale in_combat sibling queue rows`,
      );
    }
  }

  const concurrentFighterIds = new Set<string>();
  for (const row of queueResult.data ?? []) {
    if (row.status === "waiting" || row.status === "matched") {
      concurrentFighterIds.add(row.fighter_id);
    }
  }
  for (const fighterId of activeRumbleFighterIds) {
    concurrentFighterIds.add(fighterId);
  }

  return concurrentFighterIds.size;
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
    return NextResponse.json(sanitizeErrorResponse(error, "Failed to fetch queue status"), { status: 500 });
  }
}

/**
 * POST /api/rumble/queue
 *
 * Fighter joins the Rumble queue.
 * Body: { fighter_id, api_key?, auto_requeue?, priority? }
 * Auth: x-api-key header or api_key in body
 */
export async function POST(request: Request) {
  const rlKey = getRateLimitKey(request);
  const rl = checkRateLimit("AUTHENTICATED", rlKey, "/api/rumble/queue:post");
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);
  const contentTypeError = requireJsonContentType(request);
  if (contentTypeError) return contentTypeError;

  try {
    const body = await request.json();
    const fighterId = body.fighter_id || body.fighterId;
    const autoRequeue = body.auto_requeue ?? body.autoRequeue ?? false;
    const requestedPriority = body.priority ?? body.queuePriority;
    const parsedPriority =
      typeof requestedPriority === "number"
        ? Math.trunc(requestedPriority)
        : Number.parseInt(String(requestedPriority), 10);
    const priority = Number.isFinite(parsedPriority) ? parsedPriority : 0;
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

    // Full on-chain mode requires each queued fighter to have a valid Solana wallet.
    const { data: fighterRow } = await freshSupabase()
      .from("ucf_fighters")
      .select("wallet_address, verified")
      .eq("id", fighterId)
      .maybeSingle();
    if (!fighterRow?.verified) {
      return NextResponse.json(
        {
          error: "Fighter is pending approval. Verified fighters only can join live rumbles.",
          approval_required: true,
        },
        { status: 403 },
      );
    }
    const walletAddress = String((fighterRow as any)?.wallet_address ?? "").trim();
    if (!walletAddress) {
      return NextResponse.json(
        { error: "Fighter is missing wallet_address. Update the fighter wallet before joining queue." },
        { status: 409 },
      );
    }
    let walletPubkey: PublicKey;
    try {
      walletPubkey = new PublicKey(walletAddress);
    } catch {
      return NextResponse.json(
        { error: "Fighter wallet_address is invalid. Use a valid Solana public key." },
        { status: 409 },
      );
    }

    // SOL balance check — fighters need SOL to pay for on-chain move commitments
    // Skip for auto-requeue: they just finished a rumble, balance was validated recently
    if (!autoRequeue) {
      try {
        const balance = await getCachedBalance(getConnection(), walletPubkey, {
          commitment: "processed",
          ttlMs: QUEUE_BALANCE_CACHE_TTL_MS,
        });
        const solBalance = balance / LAMPORTS_PER_SOL;
        if (solBalance < MIN_SOL_TO_QUEUE) {
          return NextResponse.json(
            {
              error: `Insufficient SOL balance. Fighter wallet needs at least ${MIN_SOL_TO_QUEUE} SOL to participate in on-chain combat. Current balance: ${solBalance.toFixed(4)} SOL.`,
              wallet: walletAddress,
              balance_sol: solBalance,
              required_sol: MIN_SOL_TO_QUEUE,
            },
            { status: 402 },
          );
        }
      } catch (err) {
        console.warn(`[Queue] SOL balance check failed for ${walletAddress}:`, err);
        // Don't block queue join if RPC is down — the on-chain combat will catch it
      }
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

        // Count how many siblings are actually concurrent, ignoring stale queue rows.
        const concurrentSiblings = await countConcurrentSiblingFighters(siblingIds);
        if (concurrentSiblings >= 2) {
          return NextResponse.json(
            { error: "Too many fighters from your network in active Rumbles. Max 2 concurrent." },
            { status: 429 },
          );
        }
      }
    }

    const qm = getQueueManager();
    const orchestrator = getOrchestrator();

    const entry = qm.addToQueue(fighterId, autoRequeue, priority);

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
        priority: entry.priority,
        estimated_wait_ms: estimatedWait,
        joined_at: entry.joinedAt.toISOString(),
    });
  } catch (error: any) {
    return NextResponse.json(sanitizeErrorResponse(error, "Failed to join queue"), { status: 500 });
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
  const rl = checkRateLimit("AUTHENTICATED", rlKey, "/api/rumble/queue:delete");
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);
  const contentTypeError = requireJsonContentType(request);
  if (contentTypeError) return contentTypeError;

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
    return NextResponse.json(sanitizeErrorResponse(error, "Failed to leave queue"), { status: 500 });
  }
}
