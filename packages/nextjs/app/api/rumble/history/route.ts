import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { checkRateLimit, getRateLimitKey, rateLimitResponse } from "~~/lib/rate-limit";

export const dynamic = "force-dynamic";

// Fresh service-role client with no-store to bypass Next.js fetch caching.
function freshServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing Supabase env vars");
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: (input, init) => fetch(input, { ...init, cache: "no-store" }) },
  });
}

/**
 * GET /api/rumble/history?limit=10&offset=0
 *
 * Returns recent completed Rumbles from Supabase (ucf_rumbles table).
 * Sorted newest-first by completed_at, fallback created_at.
 */
export async function GET(request: Request) {
  const rlKey = getRateLimitKey(request);
  const rl = checkRateLimit("PUBLIC_READ", rlKey);
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

  try {
    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get("limit") ?? "10", 10) || 10, 50);
    const offset = Math.max(parseInt(searchParams.get("offset") ?? "0", 10) || 0, 0);

    const sb = freshServiceClient();

    // Count total completed rumbles for pagination metadata.
    const { count, error: countError } = await sb
      .from("ucf_rumbles")
      .select("id", { count: "exact", head: true })
      .eq("status", "complete");
    if (countError) throw countError;

    // Fetch the requested page.
    // Supabase doesn't support COALESCE ordering directly, but completed_at
    // is always set for status=complete rows. Fallback sort by created_at
    // handles any edge case where completed_at is null.
    const { data, error } = await sb
      .from("ucf_rumbles")
      .select("id, slot_index, winner_id, placements, total_turns, fighters, completed_at, created_at")
      .eq("status", "complete")
      .order("completed_at", { ascending: false, nullsFirst: false })
      .range(offset, offset + limit - 1);
    if (error) throw error;

    const results = (data ?? []).map((row: any) => {
      const fighters = Array.isArray(row.fighters) ? row.fighters : [];
      const placements = Array.isArray(row.placements) ? row.placements : [];

      return {
        rumble_id: row.id ?? null,
        slot_index: typeof row.slot_index === "number" ? row.slot_index : 0,
        winner: row.winner_id ?? null,
        placements: placements.map((p: any) => ({
          id: p?.id ?? p?.fighter_id ?? null,
          placement: typeof p?.placement === "number" ? p.placement : 0,
        })),
        total_turns: typeof row.total_turns === "number" ? row.total_turns : 0,
        fighter_count: fighters.length,
        completed_at: row.completed_at ?? row.created_at ?? null,
      };
    });

    return NextResponse.json({
      total: count ?? 0,
      limit,
      offset,
      results,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("[RumbleHistory]", error);
    return NextResponse.json({ error: "Failed to fetch rumble history" }, { status: 500 });
  }
}
