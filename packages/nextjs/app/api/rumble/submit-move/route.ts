import { NextResponse } from "next/server";
import { freshSupabase } from "~~/lib/supabase";
import {
  getApiKeyFromHeaders,
  authenticateFighterByApiKey,
  isValidUUID,
} from "~~/lib/request-auth";
import { requireJsonContentType } from "~~/lib/api-middleware";

export const dynamic = "force-dynamic";

const VALID_MOVES = new Set([
  "HIGH_STRIKE",
  "MID_STRIKE",
  "LOW_STRIKE",
  "GUARD_HIGH",
  "GUARD_MID",
  "GUARD_LOW",
  "DODGE",
  "CATCH",
  "SPECIAL",
]);

/**
 * POST /api/rumble/submit-move
 * Submit a move in response to a pending move request.
 * This is the polling counterpart to the webhook-based move system.
 *
 * Auth: x-api-key header.
 * Body: { fighter_id, rumble_id, turn, move }
 */
export async function POST(request: Request) {
  const ctCheck = requireJsonContentType(request);
  if (ctCheck) return ctCheck;

  const apiKey = getApiKeyFromHeaders(request.headers);
  if (!apiKey) {
    return NextResponse.json(
      { error: "Missing API key. Provide x-api-key header." },
      { status: 401 },
    );
  }

  let body: {
    fighter_id?: string;
    rumble_id?: string;
    turn?: number;
    move?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { fighter_id, rumble_id, turn, move } = body;

  if (!fighter_id || !isValidUUID(fighter_id)) {
    return NextResponse.json(
      { error: "fighter_id is required and must be a valid UUID" },
      { status: 400 },
    );
  }

  if (typeof rumble_id !== "string" || !rumble_id.trim()) {
    return NextResponse.json(
      { error: "rumble_id is required" },
      { status: 400 },
    );
  }

  if (typeof turn !== "number" || !Number.isInteger(turn) || turn < 1) {
    return NextResponse.json(
      { error: "turn must be a positive integer" },
      { status: 400 },
    );
  }

  const normalizedMove = typeof move === "string" ? move.trim().toUpperCase() : "";
  if (!VALID_MOVES.has(normalizedMove)) {
    return NextResponse.json(
      {
        error: `Invalid move. Must be one of: ${[...VALID_MOVES].join(", ")}`,
      },
      { status: 400 },
    );
  }

  // Authenticate
  const fighter = await authenticateFighterByApiKey(
    fighter_id,
    apiKey,
    "id, name",
    freshSupabase,
  );
  if (!fighter) {
    return NextResponse.json(
      { error: "Invalid fighter_id or API key" },
      { status: 401 },
    );
  }

  // Update the pending move with the response
  const { data, error } = await freshSupabase()
    .from("pending_moves")
    .update({
      response_move: normalizedMove,
      status: "responded",
      responded_at: new Date().toISOString(),
    })
    .eq("fighter_id", fighter_id)
    .eq("rumble_id", rumble_id)
    .eq("turn", turn)
    .eq("status", "pending")
    .gt("expires_at", new Date().toISOString())
    .select("id")
    .maybeSingle();

  if (error) {
    if (error.code === "PGRST205" || error.code === "42P01") {
      return NextResponse.json(
        { error: "Move submission system not initialized" },
        { status: 503 },
      );
    }
    console.error("[SubmitMove] DB error:", error);
    return NextResponse.json(
      { error: "Failed to submit move" },
      { status: 500 },
    );
  }

  if (!data) {
    return NextResponse.json(
      {
        error:
          "No pending move request found for this fighter/rumble/turn, or it has expired",
      },
      { status: 404 },
    );
  }

  console.log(
    `[SubmitMove] Fighter ${fighter.name} submitted ${normalizedMove} for rumble ${rumble_id} turn ${turn}`,
  );

  return NextResponse.json({
    success: true,
    move: normalizedMove,
    rumble_id,
    turn,
  });
}
