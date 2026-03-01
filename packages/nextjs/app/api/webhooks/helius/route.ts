/**
 * POST /api/webhooks/helius
 *
 * Receives Helius Enhanced Webhook payloads for on-chain transaction
 * notifications on mainnet. Processes:
 *
 * 1. Bet confirmations — updates ucf_bets.tx_confirmed_at so Supabase
 *    Realtime pushes instant confirmation to the client.
 * 2. Payout claims — detects SOL flowing from vault PDAs to user wallets,
 *    updates payout_status so clients see instant settlement.
 *
 * Security: Validates the Authorization header against HELIUS_WEBHOOK_SECRET.
 */

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  getWebhookSecret,
  parseHeliusWebhookPayload,
} from "~~/lib/helius-webhook";
import { invalidateReadCache } from "~~/lib/solana-programs";

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

function verifyWebhookAuth(request: Request): boolean | number {
  const secret = getWebhookSecret();

  if (!secret) {
    console.warn("[HeliusWebhook] HELIUS_WEBHOOK_SECRET is missing");

    if (process.env.NODE_ENV === "test") {
      return true;
    }

    return 503;
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
  const auth = verifyWebhookAuth(request);
  if (auth !== true) {
    if (auth === 503) {
      return NextResponse.json({ error: "Webhook secret unavailable" }, { status: 503 });
    }

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
    const rumbleEvents = parseHeliusWebhookPayload(transactions);

    if (rumbleEvents.length === 0) {
      // Not a rumble transaction — acknowledge without processing
      return NextResponse.json({ ok: true, processed: 0, rumble_events: 0 });
    }

    console.log(
      `[HeliusWebhook] Received ${transactions.length} txs, ${rumbleEvents.length} Rumble Engine events`,
    );

    // Invalidate cached on-chain reads so next poll gets fresh data
    invalidateReadCache();

    // 4. Process each event
    const sb = freshServiceClient();
    let betsConfirmed = 0;
    let payoutsDetected = 0;

    for (const event of rumbleEvents) {
      if (!event.signature) continue;

      // ---------------------------------------------------------------
      // 4a. Bet Confirmation — match tx signature to ucf_used_tx_signatures
      // ---------------------------------------------------------------
      const { data: sigRows, error: sigError } = await sb
        .from("ucf_used_tx_signatures")
        .select("tx_signature, wallet_address, rumble_id, slot_index, payload")
        .eq("tx_signature", event.signature)
        .eq("kind", "rumble_bet")
        .limit(1);

      if (sigError) {
        console.error(
          `[HeliusWebhook] Error looking up signature ${event.signature}:`,
          sigError,
        );
      }

      if (sigRows && sigRows.length > 0) {
        const sigRecord = sigRows[0];
        const rumbleId = sigRecord.rumble_id;
        const walletAddress = sigRecord.wallet_address;

        if (rumbleId && walletAddress) {
          // Update the bet's tx_confirmed_at — triggers Supabase Realtime
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
            if (
              updateError.code === "42703" || // undefined column
              updateError.message?.includes("tx_confirmed_at")
            ) {
              console.log(
                `[HeliusWebhook] tx_confirmed_at column not yet added — skipping for ${event.signature}`,
              );
            } else {
              console.error(
                `[HeliusWebhook] Error updating bet for ${event.signature}:`,
                updateError,
              );
            }
          } else {
            betsConfirmed += count;
            if (count > 0) {
              console.log(
                `[HeliusWebhook] Confirmed bet tx ${event.signature} — updated ${count} rows`,
              );
            }
          }
        }
      }

      // ---------------------------------------------------------------
      // 4b. Payout Detection — check if SOL moved from vault to user
      // When a user claims a payout, SOL transfers from a program-owned
      // vault PDA to the user's wallet. We detect this pattern and mark
      // the bet as paid. This triggers Supabase Realtime → client refresh.
      // ---------------------------------------------------------------
      if (event.nativeTransfers && event.nativeTransfers.length > 0) {
        for (const transfer of event.nativeTransfers) {
          // Only care about non-trivial transfers (> 0.0005 SOL, excludes rent)
          if (transfer.amount < 500_000) continue;

          const recipientWallet = transfer.toUserAccount;
          if (!recipientWallet) continue;

          // Check if recipient has any pending bets
          const { data: pendingBets, error: betError } = await sb
            .from("ucf_bets")
            .select("id, rumble_id, payout_status")
            .eq("wallet_address", recipientWallet)
            .eq("payout_status", "pending")
            .limit(5);

          if (betError || !pendingBets || pendingBets.length === 0) continue;

          // Update payout_status to 'paid' — triggers Supabase Realtime
          const solAmount = transfer.amount / 1_000_000_000;
          for (const bet of pendingBets) {
            const { error: payoutError } = await sb
              .from("ucf_bets")
              .update({
                payout_status: "paid",
                payout_amount: solAmount,
              })
              .eq("id", bet.id)
              .eq("payout_status", "pending"); // safety: don't overwrite if already updated

            if (!payoutError) {
              payoutsDetected++;
              console.log(
                `[HeliusWebhook] Payout detected: ${solAmount.toFixed(4)} SOL → ${recipientWallet.slice(0, 8)}... (bet ${bet.id})`,
              );
            }
          }
        }
      }
    }

    return NextResponse.json({
      ok: true,
      processed: transactions.length,
      rumble_events: rumbleEvents.length,
      bets_confirmed: betsConfirmed,
      payouts_detected: payoutsDetected,
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
