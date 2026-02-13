"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import {
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
  Connection,
} from "@solana/web3.js";
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
  const [sseConnected, setSseConnected] = useState(false);
  const [betPending, setBetPending] = useState(false);
  const [solBalance, setSolBalance] = useState<number | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  // Track which fighters the user bet on per slot (persists through combat/payout)
  // Map<slotIndex, Set<fighterId>>
  const [myBets, setMyBets] = useState<Map<number, Set<string>>>(new Map());

  // ---- Direct Phantom wallet management (no wallet adapter) ----
  const [phantomProvider, setPhantomProvider] = useState<any>(null);
  const [publicKey, setPublicKey] = useState<PublicKey | null>(null);
  const walletConnected = !!publicKey;

  // RPC connection
  const rpcEndpoint = process.env.NEXT_PUBLIC_HELIUS_API_KEY
    ? `https://devnet.helius-rpc.com/?api-key=${process.env.NEXT_PUBLIC_HELIUS_API_KEY}`
    : "https://api.devnet.solana.com";
  const connectionRef = useRef(new Connection(rpcEndpoint, "confirmed"));
  const connection = connectionRef.current;

  // Detect Phantom on mount
  useEffect(() => {
    const checkPhantom = () => {
      const provider = (window as any).phantom?.solana;
      if (provider?.isPhantom) {
        setPhantomProvider(provider);
        // Check if already connected (eager connect)
        if (provider.isConnected && provider.publicKey) {
          setPublicKey(new PublicKey(provider.publicKey.toString()));
        }
        // Listen for account changes
        provider.on("accountChanged", (pk: any) => {
          if (pk) {
            setPublicKey(new PublicKey(pk.toString()));
          } else {
            setPublicKey(null);
          }
        });
        provider.on("disconnect", () => setPublicKey(null));
      }
    };
    // Phantom injects after page load, so check with a small delay too
    checkPhantom();
    const timer = setTimeout(checkPhantom, 500);
    return () => clearTimeout(timer);
  }, []);

  const connectPhantom = useCallback(async () => {
    const provider = phantomProvider || (window as any).phantom?.solana;
    if (!provider?.isPhantom) {
      window.open("https://phantom.app/", "_blank");
      return;
    }
    try {
      const resp = await provider.connect();
      setPublicKey(new PublicKey(resp.publicKey.toString()));
      setPhantomProvider(provider);
    } catch (e: any) {
      console.error("Phantom connect failed:", e);
    }
  }, [phantomProvider]);

  const disconnectWallet = useCallback(async () => {
    if (phantomProvider) {
      await phantomProvider.disconnect();
    }
    setPublicKey(null);
    setSolBalance(null);
  }, [phantomProvider]);

  // Fetch SOL balance when wallet connects
  useEffect(() => {
    if (!publicKey) {
      setSolBalance(null);
      return;
    }
    const fetchBalance = async () => {
      try {
        const lamports = await connection.getBalance(publicKey, "confirmed");
        setSolBalance(lamports / LAMPORTS_PER_SOL);
      } catch {
        setSolBalance(null);
      }
    };
    fetchBalance();
    const interval = setInterval(fetchBalance, 15_000);
    return () => clearInterval(interval);
  }, [publicKey, connection]);

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

      // Clear bet tracking for slots that returned to idle
      setMyBets((prev) => {
        let changed = false;
        const next = new Map(prev);
        for (const slot of data.slots) {
          if (slot.state === "idle" && next.has(slot.slotIndex)) {
            next.delete(slot.slotIndex);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
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
      setSseConnected(true);
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
      setSseConnected(false);
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

  // Handle bet placement with wallet SOL transfer
  const handlePlaceBet = async (
    slotIndex: number,
    fighterId: string,
    amount: number
  ) => {
    if (!publicKey || !phantomProvider || !walletConnected) {
      alert("Connect your Phantom wallet first to place bets.");
      throw new Error("Wallet not connected");
    }
    if (amount <= 0 || amount > 10) {
      alert("Bet must be between 0.01 and 10 SOL");
      throw new Error("Invalid amount");
    }

    // 0. Pre-validate: check slot is still in betting state before sending SOL
    const slotData = status?.slots?.[slotIndex];
    if (!slotData || slotData.state !== "betting") {
      alert("Betting is not open for this slot right now.");
      throw new Error("Betting closed");
    }
    const fighterInSlot = slotData.fighters?.some(
      (f: any) => f.id === fighterId || f.fighterId === fighterId
    );
    if (!fighterInSlot) {
      alert("This fighter is not in the current rumble.");
      throw new Error("Fighter not in rumble");
    }

    setBetPending(true);
    try {

      // 1. Build SOL transfer to treasury/vault
      const treasuryAddress = process.env.NEXT_PUBLIC_TREASURY_ADDRESS
        || "FXvriUM1dTwDeVXaWTSqGo14jPQk7363FQsQaUP1tvdE"; // deployer wallet as vault for devnet
      const vaultPubkey = new PublicKey(treasuryAddress);
      const lamports = Math.round(amount * LAMPORTS_PER_SOL);

      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: publicKey,
          toPubkey: vaultPubkey,
          lamports,
        }),
      );

      const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash("confirmed");
      transaction.recentBlockhash = blockhash;
      transaction.lastValidBlockHeight = lastValidBlockHeight;
      transaction.feePayer = publicKey;

      // 2. Sign with Phantom directly
      const signed = await phantomProvider.signTransaction(transaction);

      // 3. Send to Solana
      const rawTx = signed.serialize();
      const txSig = await connection.sendRawTransaction(rawTx, {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });

      // 4. Wait for confirmation
      await connection.confirmTransaction(
        { signature: txSig, blockhash, lastValidBlockHeight },
        "confirmed",
      );

      // 5. Register the bet with the API (wallet auth, no API key needed)
      const res = await fetch("/api/rumble/bet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slot_index: slotIndex,
          fighter_id: fighterId,
          sol_amount: amount,
          wallet_address: publicKey.toBase58(),
          tx_signature: txSig,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        alert(data.error || "Bet registered on-chain but API failed");
        return;
      }

      // Track this bet for "YOUR BET" indicators
      setMyBets((prev) => {
        const next = new Map(prev);
        const existing = next.get(slotIndex) ?? new Set<string>();
        existing.add(fighterId);
        next.set(slotIndex, existing);
        return next;
      });

      // Refresh status + balance
      fetchStatus();
      const newBalance = await connection.getBalance(publicKey, "confirmed");
      setSolBalance(newBalance / LAMPORTS_PER_SOL);
    } catch (e: any) {
      if (e?.message?.includes("User rejected")) {
        // User cancelled in wallet, no alert needed
      } else {
        console.error("Failed to place bet:", e);
        alert(e?.message || "Failed to place bet");
      }
    } finally {
      setBetPending(false);
    }
  };

  const ichorShower = status?.ichorShower ?? {
    currentPool: 0,
    rumblesSinceLastTrigger: 0,
  };

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
                    sseConnected ? "bg-green-500" : "bg-red-500 animate-pulse"
                  }`}
                />
                <span className="font-mono text-[10px] text-stone-500">
                  {sseConnected ? "LIVE" : "POLLING"}
                </span>
              </div>

              {/* Wallet */}
              {walletConnected && publicKey ? (
                <div className="flex items-center gap-2 bg-stone-900/80 border border-stone-700 rounded-sm px-2 py-1">
                  <span className="font-mono text-[10px] text-stone-400">
                    {solBalance !== null ? `${solBalance.toFixed(3)} SOL` : "..."}
                  </span>
                  <span className="font-mono text-[10px] text-amber-400">
                    {publicKey.toBase58().slice(0, 4)}...{publicKey.toBase58().slice(-4)}
                  </span>
                  <button
                    onClick={disconnectWallet}
                    className="font-mono text-[10px] text-stone-600 hover:text-red-400 ml-1"
                  >
                    [X]
                  </button>
                </div>
              ) : (
                <button
                  onClick={connectPhantom}
                  className="px-3 py-1 bg-amber-600 hover:bg-amber-500 text-stone-950 font-mono text-xs font-bold rounded-sm transition-all"
                >
                  {phantomProvider ? "Connect Phantom" : "Install Phantom"}
                </button>
              )}

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
                    myBetFighterIds={myBets.get(slot.slotIndex)}
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
