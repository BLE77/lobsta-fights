"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import RumbleSlot, { SlotData } from "./components/RumbleSlot";
import QueueSidebar from "./components/QueueSidebar";
import IchorShowerPool from "./components/IchorShowerPool";

// ---------------------------------------------------------------------------
// Types for the status API response
// ---------------------------------------------------------------------------

interface QueueFighter {
  fighterId: string;
  name: string;
  imageUrl: string | null;
  position: number;
}

interface RumbleStatus {
  slots: SlotData[];
  queue: QueueFighter[];
  queueLength: number;
  nextRumbleIn: string | null;
  ichorShower: {
    currentPool: number;
    rumblesSinceLastTrigger: number;
  };
}

// ---------------------------------------------------------------------------
// SSE event types for live updates
// ---------------------------------------------------------------------------

interface SSEEvent {
  type:
    | "turn"
    | "elimination"
    | "slot_state_change"
    | "bet_placed"
    | "ichor_shower";
  slotIndex: number;
  data: any;
}

// ---------------------------------------------------------------------------
// Page Component
// ---------------------------------------------------------------------------

export default function RumblePage() {
  const [status, setStatus] = useState<RumbleStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);

  // Fetch full status via polling
  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`/api/rumble/status?_t=${Date.now()}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`Status ${res.status}`);
      const data: RumbleStatus = await res.json();
      setStatus(data);
      setError(null);
    } catch (e: any) {
      console.error("Failed to fetch rumble status:", e);
      setError(e.message || "Failed to connect");
    } finally {
      setLoading(false);
    }
  }, []);

  // Connect to SSE for real-time combat updates
  const connectSSE = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const es = new EventSource("/api/rumble/live");
    eventSourceRef.current = es;

    es.onopen = () => {
      setConnected(true);
    };

    es.onmessage = (event) => {
      try {
        const sseEvent: SSEEvent = JSON.parse(event.data);
        handleSSEEvent(sseEvent);
      } catch {
        // Ignore parse errors from keepalive pings
      }
    };

    es.onerror = () => {
      setConnected(false);
      // EventSource auto-reconnects
    };

    return es;
  }, []);

  // Handle incoming SSE events by patching local state
  const handleSSEEvent = useCallback((event: SSEEvent) => {
    setStatus((prev) => {
      if (!prev) return prev;

      const slots = [...prev.slots];
      const slotIdx = slots.findIndex(
        (s) => s.slotIndex === event.slotIndex
      );
      if (slotIdx === -1) return prev;

      const slot = { ...slots[slotIdx] };

      switch (event.type) {
        case "turn":
          // Append new turn data
          slot.turns = [...slot.turns, event.data.turn];
          slot.currentTurn = event.data.turn.turnNumber;
          // Update fighter HPs from the event
          if (event.data.fighters) {
            slot.fighters = event.data.fighters;
          }
          break;

        case "elimination":
          // Update fighter state
          if (event.data.fighters) {
            slot.fighters = event.data.fighters;
          }
          break;

        case "slot_state_change":
          slot.state = event.data.state;
          if (event.data.payout) {
            slot.payout = event.data.payout;
          }
          if (event.data.odds) {
            slot.odds = event.data.odds;
          }
          if (event.data.fighters) {
            slot.fighters = event.data.fighters;
          }
          break;

        case "bet_placed":
          slot.totalPool = event.data.totalPool;
          if (event.data.odds) {
            slot.odds = event.data.odds;
          }
          break;

        case "ichor_shower":
          return {
            ...prev,
            ichorShower: event.data,
            slots: slots,
          };
      }

      slots[slotIdx] = slot;
      return { ...prev, slots };
    });
  }, []);

  // Initialize: poll + SSE
  useEffect(() => {
    fetchStatus();

    // Poll every 2 seconds as fallback
    const pollInterval = setInterval(fetchStatus, 2000);

    // Connect SSE for real-time updates
    const es = connectSSE();

    return () => {
      clearInterval(pollInterval);
      es.close();
    };
  }, [fetchStatus, connectSSE]);

  // Handle bet placement
  const handlePlaceBet = async (
    slotIndex: number,
    fighterId: string,
    amount: number
  ) => {
    try {
      const res = await fetch("/api/rumble/bet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slotIndex, fighterId, amount }),
      });
      if (!res.ok) {
        const data = await res.json();
        alert(data.error || "Failed to place bet");
        return;
      }
      // Refresh status immediately after bet
      fetchStatus();
    } catch (e) {
      console.error("Failed to place bet:", e);
    }
  };

  const ichorShower = status?.ichorShower ?? {
    currentPool: 0,
    rumblesSinceLastTrigger: 0,
  };

  // Consider "near trigger" if we're past 80% of expected (~400 rumbles)
  const isNearTrigger = ichorShower.rumblesSinceLastTrigger > 400;

  return (
    <main className="relative flex flex-col min-h-screen text-stone-200">
      {/* Background */}
      <div
        className="fixed inset-0 z-0"
        style={{
          backgroundImage: "url('/arena-bg.png')",
          backgroundSize: "cover",
          backgroundPosition: "center",
          backgroundAttachment: "fixed",
        }}
      >
        <div className="absolute inset-0 bg-stone-950/90"></div>
      </div>

      {/* Content */}
      <div className="relative z-10 w-full">
        {/* Header */}
        <header className="border-b border-stone-800 bg-stone-950/80 backdrop-blur-sm">
          <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Link
                href="/"
                className="text-amber-500 hover:text-amber-400 font-mono text-sm"
              >
                &lt; UCF
              </Link>
              <div>
                <h1 className="font-fight-glow text-2xl text-amber-400">
                  RUMBLE
                </h1>
                <p className="font-mono text-[10px] text-stone-600">
                  BATTLE ROYALE // 8-16 FIGHTERS // LAST BOT STANDING
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              {/* Connection indicator */}
              <div className="flex items-center gap-1.5">
                <span
                  className={`inline-block w-2 h-2 rounded-full ${
                    connected ? "bg-green-500" : "bg-red-500 animate-pulse"
                  }`}
                />
                <span className="font-mono text-[10px] text-stone-500">
                  {connected ? "LIVE" : "POLLING"}
                </span>
              </div>

              <Link
                href="/matches"
                className="font-mono text-xs text-stone-500 hover:text-stone-300 transition-colors"
              >
                1v1 Matches
              </Link>
            </div>
          </div>
        </header>

        {/* Main Layout */}
        <div className="max-w-7xl mx-auto px-4 py-6">
          {loading ? (
            <div className="flex items-center justify-center h-64">
              <div className="text-center">
                <p className="font-mono text-amber-500 text-lg animate-pulse">
                  Loading Rumble Arena...
                </p>
                <p className="font-mono text-xs text-stone-600 mt-2">
                  Connecting to battle feed
                </p>
              </div>
            </div>
          ) : error && !status ? (
            <div className="flex items-center justify-center h-64">
              <div className="text-center bg-stone-900/80 border border-red-800/50 rounded-sm p-6">
                <p className="font-mono text-red-400 text-sm">{error}</p>
                <p className="font-mono text-xs text-stone-600 mt-2">
                  Rumble API not yet available. Check back soon.
                </p>
                <button
                  onClick={fetchStatus}
                  className="mt-4 px-4 py-2 bg-stone-800 hover:bg-stone-700 text-stone-300 font-mono text-xs border border-stone-700 transition-all"
                >
                  RETRY
                </button>
              </div>
            </div>
          ) : (
            <div className="flex gap-6">
              {/* Main content: 3 Rumble Slots */}
              <div className="flex-1 space-y-4">
                {/* Slots */}
                {status?.slots.map((slot) => (
                  <RumbleSlot
                    key={slot.slotIndex}
                    slot={slot}
                    onPlaceBet={handlePlaceBet}
                  />
                ))}

                {/* Show placeholder slots if no data */}
                {(!status?.slots || status.slots.length === 0) && (
                  <div className="space-y-4">
                    {[0, 1, 2].map((i) => (
                      <div
                        key={i}
                        className="bg-stone-900/50 border border-stone-800 rounded-sm p-4 backdrop-blur-sm"
                      >
                        <div className="flex items-center gap-2 mb-4">
                          <span className="font-mono text-xs text-stone-600">
                            SLOT {i + 1}
                          </span>
                          <span className="font-mono text-xs text-stone-700">
                            [IDLE]
                          </span>
                        </div>
                        <div className="flex items-center justify-center h-24">
                          <p className="font-mono text-sm text-stone-700">
                            Waiting for fighters...
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Sidebar: Queue + Ichor Shower */}
              <div className="w-64 flex-shrink-0 space-y-4 hidden lg:block">
                <QueueSidebar
                  queue={status?.queue ?? []}
                  totalLength={status?.queueLength ?? 0}
                  nextRumbleIn={status?.nextRumbleIn ?? null}
                />

                <IchorShowerPool
                  currentPool={ichorShower.currentPool}
                  rumblesSinceLastTrigger={
                    ichorShower.rumblesSinceLastTrigger
                  }
                  isNearTrigger={isNearTrigger}
                />
              </div>
            </div>
          )}
        </div>

        {/* Mobile sidebar (below slots) */}
        <div className="lg:hidden max-w-7xl mx-auto px-4 pb-6 space-y-4">
          {status && (
            <>
              <QueueSidebar
                queue={status.queue}
                totalLength={status.queueLength}
                nextRumbleIn={status.nextRumbleIn}
              />
              <IchorShowerPool
                currentPool={ichorShower.currentPool}
                rumblesSinceLastTrigger={
                  ichorShower.rumblesSinceLastTrigger
                }
                isNearTrigger={isNearTrigger}
              />
            </>
          )}
        </div>

        {/* Footer */}
        <footer className="border-t border-stone-800 bg-stone-950/80 backdrop-blur-sm">
          <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
            <p className="font-mono text-[10px] text-stone-600">
              // POLLING EVERY 2s + SSE LIVE FEED //
            </p>
            <p className="font-mono text-[10px] text-stone-600">
              // RUMBLE: BATTLE ROYALE MODE //
            </p>
          </div>
        </footer>
      </div>
    </main>
  );
}
