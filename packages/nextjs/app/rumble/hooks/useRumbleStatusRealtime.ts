"use client";

import { useEffect, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { getSupabaseBrowserClient } from "~~/lib/supabase-client";

interface UseRumbleStatusRealtimeOptions {
  enabled?: boolean;
  onStatusChange?: () => void;
}

export function useRumbleStatusRealtime({
  enabled = true,
  onStatusChange,
}: UseRumbleStatusRealtimeOptions) {
  const onStatusChangeRef = useRef(onStatusChange);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    onStatusChangeRef.current = onStatusChange;
  }, [onStatusChange]);

  useEffect(() => {
    if (!enabled) {
      if (channelRef.current) {
        channelRef.current.unsubscribe();
        channelRef.current = null;
      }
      setConnected(false);
      return;
    }

    let client: ReturnType<typeof getSupabaseBrowserClient> | null = null;
    try {
      client = getSupabaseBrowserClient();
    } catch (error) {
      console.warn("[RumbleStatusRealtime] Supabase Realtime unavailable:", error);
      setConnected(false);
      return;
    }

    const channel = client
      .channel("rumble_status_realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "ucf_rumbles" },
        () => onStatusChangeRef.current?.(),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "ucf_rumble_queue" },
        () => onStatusChangeRef.current?.(),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "ucf_ichor_shower" },
        () => onStatusChangeRef.current?.(),
      )
      .subscribe((status) => {
        setConnected(status === "SUBSCRIBED");
        if (status === "CHANNEL_ERROR") {
          console.warn("[RumbleStatusRealtime] Channel error. Polling fallback remains active.");
        }
      });

    channelRef.current = channel;

    return () => {
      client?.removeChannel(channel);
      if (channelRef.current === channel) {
        channelRef.current = null;
      }
      setConnected(false);
    };
  }, [enabled]);

  return { connected };
}
