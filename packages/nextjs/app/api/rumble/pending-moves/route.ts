import { NextResponse } from "next/server";
import { freshSupabase } from "~~/lib/supabase";
import {
  getApiKeyFromHeaders,
  authenticateFighterByApiKey,
  isValidUUID,
} from "~~/lib/request-auth";

export const dynamic = "force-dynamic";

/**
 * GET /api/rumble/pending-moves?fighter_id=<uuid>
 * Poll for pending move requests. External bots call this instead of
 * running a webhook server. Returns the oldest pending request for the
 * fighter, or an empty array if none.
 *
 * Auth: x-api-key header.
 */
export async function GET(request: Request) {
  const apiKey = getApiKeyFromHeaders(request.headers);
  if (!apiKey) {
    return NextResponse.json(
      { error: "Missing API key. Provide x-api-key header." },
      { status: 401 },
    );
  }

  const { searchParams } = new URL(request.url);
  const fighterId = searchParams.get("fighter_id");

  if (!fighterId || !isValidUUID(fighterId)) {
    return NextResponse.json(
      { error: "fighter_id query param is required and must be a valid UUID" },
      { status: 400 },
    );
  }

  // Authenticate
  const fighter = await authenticateFighterByApiKey(
    fighterId,
    apiKey,
    "id",
    freshSupabase,
  );
  if (!fighter) {
    return NextResponse.json(
      { error: "Invalid fighter_id or API key" },
      { status: 401 },
    );
  }

  // Fetch pending move requests (not expired)
  const { data, error } = await freshSupabase()
    .from("pending_moves")
    .select("id, rumble_id, turn, request_payload, created_at, expires_at")
    .eq("fighter_id", fighterId)
    .eq("status", "pending")
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: true })
    .limit(1);

  if (error) {
    // Table might not exist yet
    if (error.code === "PGRST205" || error.code === "42P01") {
      return NextResponse.json({ pending: [] });
    }
    console.error("[PendingMoves] DB error:", error);
    return NextResponse.json(
      { error: "Failed to fetch pending moves" },
      { status: 500 },
    );
  }

  return NextResponse.json({ pending: data ?? [] });
}
