/**
 * POST /api/webhooks/helius
 *
 * Receives Helius Enhanced Webhook payloads for on-chain transaction
 * notifications. Parses bet-related transactions and updates bet records
 * in Supabase so that Realtime subscribers get instant confirmation.
 *
 * Security: Validates the Authorization header against HELIUS_WEBHOOK_SECRET.
 */

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  getWebhookSecret,
  parseHeliusWebhookPayload,
} from "~~/lib/helius-webhook";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Fresh Supabase client (service role, no cache)
// ---------------------------------------------------------------------------

const noStoreFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, cache: "no-store" });

function freshServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: noStoreFetch },
  });
}

// ---------------------------------------------------------------------------
// Auth verification
// ---------------------------------------------------------------------------

function verifyWebhookAuth(request: Request): boolean {
  const secret = getWebhookSecret();

  // If no secret is configured, allow all requests (development mode)
  if (!secret) {
    console.warn("[HeliusWebhook] No HELIUS_WEBHOOK_SECRET configured — skipping auth check");
    return true;
  }

  const authHeader = request.headers.get("authorization") ?? "";
  const expectedHeader = `Bearer ${secret}`;

  // Constant-time comparison to prevent timing attacks
  if (authHeader.length !== expectedHeader.length) return false;
  let mismatch = 0;
  for (let i = 0; i < authHeader.length; i++) {
    mismatch |= authHeader.charCodeAt(i) ^ expectedHeader.charCodeAt(i);
  }
  return mismatch === 0;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function POST(request: Request) {
  // 1. Verify auth
  if (!verifyWebhookAuth(request)) {
    console.error("[HeliusWebhook] Unauthorized webhook request");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // 2. Parse body — Helius sends an array of enhanced transactions
    const body = await request.json();
    const transactions = Array.isArray(body) ? body : [body];

    if (transactions.length === 0) {
      return NextResponse.json({ ok: true, processed: 0 });
    }

    // 3. Parse for Rumble Engine transactions
    const betEvents = parseHeliusWebhookPayload(transactions);

    if (betEvents.length === 0) {
      // Not a rumble transaction — acknowledge without processing
      return NextResponse.json({ ok: true, processed: 0, rumble_events: 0 });
    }

    console.log(
      `[HeliusWebhook] Received ${transactions.length} txs, ${betEvents.length} Rumble Engine events`,
    );

    // 4. Process each bet event
    const sb = freshServiceClient();
    let confirmed = 0;

    for (const event of betEvents) {
      if (!event.signature) continue;

      // Look up bets that reference this transaction signature
      // Check in ucf_used_tx_signatures first to find matching bets
      const { data: sigRows, error: sigError } = await sb
        .from("ucf_used_tx_signatures")
        .select("tx_signature, wallet_address, rumble_id, slot_index, payload")
        .eq("tx_signature", event.signature)
        .eq("kind", "rumble_bet")
        .limit(1);

      if (sigError) {
        // Table might not exist yet — log and continue
        console.error(
          `[HeliusWebhook] Error looking up signature ${event.signature}:`,
          sigError,
        );
        continue;
      }

      if (!sigRows || sigRows.length === 0) {
        // Signature not in our records — could be a non-bet rumble tx
        continue;
      }

      const sigRecord = sigRows[0];
      const rumbleId = sigRecord.rumble_id;
      const walletAddress = sigRecord.wallet_address;

      if (!rumbleId || !walletAddress) continue;

      // Update the bet's tx_confirmed_at in ucf_bets.
      // We match on rumble_id + wallet_address since a single tx can fund
      // multiple fighter bets in a batch.
      const { error: updateError, data: updatedRows } = await sb
        .from("ucf_bets")
        .update({
          tx_confirmed_at: new Date(event.timestamp * 1000).toISOString(),
          tx_confirmed_slot: event.slot,
        })
        .eq("rumble_id", rumbleId)
        .eq("wallet_address", walletAddress)
        .is("tx_confirmed_at", null)
        .select("id");
      const count = updatedRows?.length ?? 0;

      if (updateError) {
        // The columns might not exist yet — that's okay, the webhook still
        // serves as an event trigger. Log and continue.
        if (
          updateError.code === "42703" || // undefined column
          updateError.message?.includes("tx_confirmed_at")
        ) {
          console.log(
            `[HeliusWebhook] tx_confirmed_at column not yet added — skipping update for ${event.signature}`,
          );
        } else {
          console.error(
            `[HeliusWebhook] Error updating bet for ${event.signature}:`,
            updateError,
          );
        }
        continue;
      }

      confirmed += count ?? 0;
      console.log(
        `[HeliusWebhook] Confirmed tx ${event.signature} — updated ${count ?? 0} bet rows for rumble ${rumbleId}`,
      );
    }

    return NextResponse.json({
      ok: true,
      processed: transactions.length,
      rumble_events: betEvents.length,
      bets_confirmed: confirmed,
    });
  } catch (error) {
    console.error("[HeliusWebhook] Error processing webhook:", error);
    // Return 200 to prevent Helius from retrying on our errors
    return NextResponse.json(
      { ok: false, error: "Internal processing error" },
      { status: 200 },
    );
  }
}
