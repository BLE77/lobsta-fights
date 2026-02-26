import { NextResponse } from "next/server";
import { freshSupabase } from "~~/lib/supabase";
import {
  getApiKeyFromHeaders,
  authenticateFighterByApiKey,
  isValidUUID,
} from "~~/lib/request-auth";
import { requireJsonContentType } from "~~/lib/api-middleware";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/fighter/webhook
 * Update a fighter's webhook URL after registration.
 * Auth: x-api-key header (same API key used for queue join).
 */
export async function PATCH(request: Request) {
  const ctCheck = requireJsonContentType(request);
  if (ctCheck) return ctCheck;

  const apiKey = getApiKeyFromHeaders(request.headers);
  if (!apiKey) {
    return NextResponse.json(
      { error: "Missing API key. Provide x-api-key header." },
      { status: 401 },
    );
  }

  let body: { fighter_id?: string; webhook_url?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { fighter_id, webhook_url } = body;

  if (!fighter_id || !isValidUUID(fighter_id)) {
    return NextResponse.json(
      { error: "fighter_id is required and must be a valid UUID" },
      { status: 400 },
    );
  }

  if (typeof webhook_url !== "string" || !webhook_url.trim()) {
    return NextResponse.json(
      { error: "webhook_url is required" },
      { status: 400 },
    );
  }

  // Validate URL format
  let parsed: URL;
  try {
    parsed = new URL(webhook_url);
  } catch {
    return NextResponse.json({ error: "Invalid webhook URL" }, { status: 400 });
  }

  if (!["https:", "http:"].includes(parsed.protocol)) {
    return NextResponse.json(
      { error: "Webhook must use http or https" },
      { status: 400 },
    );
  }

  // Authenticate fighter
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

  // Update webhook URL
  const { error } = await freshSupabase()
    .from("ucf_fighters")
    .update({ webhook_url: webhook_url.trim() })
    .eq("id", fighter_id);

  if (error) {
    console.error("[Webhook Update] DB error:", error);
    return NextResponse.json(
      { error: "Failed to update webhook URL" },
      { status: 500 },
    );
  }

  console.log(
    `[Webhook Update] Fighter ${fighter.name} (${fighter_id}) updated webhook to ${webhook_url}`,
  );

  return NextResponse.json({
    success: true,
    fighter_id,
    webhook_url: webhook_url.trim(),
  });
}
