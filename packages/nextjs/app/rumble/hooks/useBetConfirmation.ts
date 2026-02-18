"use client";

/**
 * useBetConfirmation — Supabase Realtime subscription for bet confirmations.
 *
 * When a Helius webhook confirms a bet transaction on-chain, the webhook
 * handler updates the ucf_bets row (sets tx_confirmed_at). This hook
 * subscribes to Realtime changes on ucf_bets for the connected wallet
 * and fires a callback when confirmation arrives.
 *
 * Falls back gracefully if Supabase Realtime is unavailable — the existing
 * polling in the parent page continues to work as before.
 */

import { useEffect, useRef, useCallback, useState } from "react";
import { createClient, type RealtimeChannel } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BetConfirmationEvent {
  betId: string;
  rumbleId: string;
  fighterId: string;
  walletAddress: string;
  txConfirmedAt: string | null;
  txConfirmedSlot: number | null;
  payoutStatus: string;
  payoutAmount: number | null;
}

interface UseBetConfirmationOptions {
  walletAddress: string | null;
  /** Called when a bet is confirmed via webhook (tx_confirmed_at set) */
  onBetConfirmed?: (event: BetConfirmationEvent) => void;
  /** Called when payout status changes (settlement) */
  onPayoutUpdate?: (event: BetConfirmationEvent) => void;
  /** Whether to enable the subscription (default: true) */
  enabled?: boolean;
}

// ---------------------------------------------------------------------------
// Supabase client for Realtime (anon key, client-side)
// ---------------------------------------------------------------------------

let _realtimeClient: ReturnType<typeof createClient> | null = null;

function getRealtimeClient() {
  if (_realtimeClient) return _realtimeClient;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;

  _realtimeClient = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { params: { eventsPerSecond: 10 } },
  });

  return _realtimeClient;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useBetConfirmation({
  walletAddress,
  onBetConfirmed,
  onPayoutUpdate,
  enabled = true,
}: UseBetConfirmationOptions) {
  const channelRef = useRef<RealtimeChannel | null>(null);
  const [connected, setConnected] = useState(false);
  const onBetConfirmedRef = useRef(onBetConfirmed);
  const onPayoutUpdateRef = useRef(onPayoutUpdate);

  // Keep callback refs fresh without re-subscribing
  useEffect(() => {
    onBetConfirmedRef.current = onBetConfirmed;
  }, [onBetConfirmed]);

  useEffect(() => {
    onPayoutUpdateRef.current = onPayoutUpdate;
  }, [onPayoutUpdate]);

  useEffect(() => {
    if (!enabled || !walletAddress) {
      // Cleanup existing subscription
      if (channelRef.current) {
        channelRef.current.unsubscribe();
        channelRef.current = null;
        setConnected(false);
      }
      return;
    }

    const client = getRealtimeClient();
    if (!client) {
      console.log("[BetConfirmation] Supabase Realtime not available — falling back to polling");
      return;
    }

    // Subscribe to changes on ucf_bets for this wallet
    const channelName = `bets:${walletAddress.slice(0, 8)}`;
    const channel = client.channel(channelName);

    channel
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "ucf_bets",
          filter: `wallet_address=eq.${walletAddress}`,
        },
        (payload) => {
          const row = payload.new as Record<string, unknown>;
          const old = payload.old as Record<string, unknown>;

          const event: BetConfirmationEvent = {
            betId: String(row.id ?? ""),
            rumbleId: String(row.rumble_id ?? ""),
            fighterId: String(row.fighter_id ?? ""),
            walletAddress: String(row.wallet_address ?? ""),
            txConfirmedAt: row.tx_confirmed_at ? String(row.tx_confirmed_at) : null,
            txConfirmedSlot: typeof row.tx_confirmed_slot === "number" ? row.tx_confirmed_slot : null,
            payoutStatus: String(row.payout_status ?? "pending"),
            payoutAmount: typeof row.payout_amount === "number" ? row.payout_amount : null,
          };

          // Detect tx confirmation (webhook just confirmed the on-chain tx)
          if (event.txConfirmedAt && !old.tx_confirmed_at) {
            console.log(
              `[BetConfirmation] Bet ${event.betId} confirmed via webhook at slot ${event.txConfirmedSlot}`,
            );
            onBetConfirmedRef.current?.(event);
          }

          // Detect payout status change
          if (row.payout_status !== old.payout_status) {
            console.log(
              `[BetConfirmation] Bet ${event.betId} payout: ${old.payout_status} -> ${event.payoutStatus}`,
            );
            onPayoutUpdateRef.current?.(event);
          }
        },
      )
      .subscribe((status) => {
        setConnected(status === "SUBSCRIBED");
        if (status === "SUBSCRIBED") {
          console.log(`[BetConfirmation] Realtime subscribed for wallet ${walletAddress.slice(0, 8)}...`);
        } else if (status === "CHANNEL_ERROR") {
          console.warn("[BetConfirmation] Realtime channel error — polling fallback active");
        }
      });

    channelRef.current = channel;

    return () => {
      channel.unsubscribe();
      channelRef.current = null;
      setConnected(false);
    };
  }, [walletAddress, enabled]);

  return { connected };
}
