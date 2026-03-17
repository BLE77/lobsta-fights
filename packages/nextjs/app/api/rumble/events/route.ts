import { NextResponse } from "next/server";
import { getEventsSince, getLatestSeq } from "~~/lib/rumble-orchestrator";
import { checkRateLimit, getRateLimitKey, rateLimitResponse } from "~~/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * GET /api/rumble/events?since_seq=N&slot_index=X
 *
 * HTTP fallback for clients that can't use SSE.
 * Returns all buffered events with seq > since_seq.
 * Optional slot_index filters to a single slot.
 */
export async function GET(request: Request) {
  const rlKey = getRateLimitKey(request);
  const rl = checkRateLimit("PUBLIC_READ", rlKey);
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

  const url = new URL(request.url);
  const sinceSeqParam = url.searchParams.get("since_seq");
  const slotIndexParam = url.searchParams.get("slot_index");

  const sinceSeq = sinceSeqParam ? parseInt(sinceSeqParam, 10) : 0;
  if (isNaN(sinceSeq)) {
    return NextResponse.json({ error: "Invalid since_seq" }, { status: 400 });
  }

  const slotIndex = slotIndexParam !== null ? parseInt(slotIndexParam, 10) : undefined;
  if (slotIndex !== undefined && isNaN(slotIndex)) {
    return NextResponse.json({ error: "Invalid slot_index" }, { status: 400 });
  }

  const events = getEventsSince(sinceSeq, slotIndex);
  const latestSeq = getLatestSeq();

  return NextResponse.json({
    events,
    latest_seq: latestSeq,
  });
}
