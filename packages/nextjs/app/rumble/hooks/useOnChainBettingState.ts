"use client";

import { useEffect, useRef, useState } from "react";
import { Connection, PublicKey } from "@solana/web3.js";
import { parseOnchainRumbleIdNumber } from "~~/lib/rumble-id";

// ---------------------------------------------------------------------------
// Constants (mirrored from solana-programs.ts to avoid importing node:crypto)
// ---------------------------------------------------------------------------

const RUMBLE_ENGINE_ID = new PublicKey(
  process.env.NEXT_PUBLIC_RUMBLE_ENGINE_MAINNET?.trim() ||
  process.env.NEXT_PUBLIC_RUMBLE_ENGINE_ID_MAINNET?.trim() ||
  "2TvW4EfbmMe566ZQWZWd8kX34iFR2DM3oBUpjwpRJcqC"
);
const RUMBLE_SEED = Buffer.from("rumble");

const ONCHAIN_STATES = ["betting", "combat", "payout", "complete"] as const;
type OnchainState = (typeof ONCHAIN_STATES)[number];

// ---------------------------------------------------------------------------
// PDA derivation (same logic as deriveRumblePda in solana-programs.ts)
// ---------------------------------------------------------------------------

function deriveRumblePda(rumbleId: number): [PublicKey, number] {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(rumbleId));
  return PublicKey.findProgramAddressSync(
    [RUMBLE_SEED, buf],
    RUMBLE_ENGINE_ID
  );
}

// ---------------------------------------------------------------------------
// Singleton WebSocket Connection (module-level, shared across all slots)
// ---------------------------------------------------------------------------

let _wssConnection: Connection | null = null;

function toWsEndpoint(httpEndpoint: string): string {
  if (httpEndpoint.startsWith("https://")) {
    return `wss://${httpEndpoint.slice("https://".length)}`;
  }
  if (httpEndpoint.startsWith("http://")) {
    return `ws://${httpEndpoint.slice("http://".length)}`;
  }
  return httpEndpoint;
}

function getWssConnection(): Connection | null {
  if (_wssConnection) return _wssConnection;
  const explicitRpc = process.env.NEXT_PUBLIC_BETTING_RPC_URL?.trim();
  const explicitWs = process.env.NEXT_PUBLIC_BETTING_WS_URL?.trim();
  const heliusMainnetKey = process.env.NEXT_PUBLIC_HELIUS_MAINNET_API_KEY?.trim();
  const httpsUrl =
    explicitRpc ||
    (heliusMainnetKey ? `https://mainnet.helius-rpc.com/?api-key=${heliusMainnetKey}` : "https://api.mainnet-beta.solana.com");
  const wssUrl = explicitWs || toWsEndpoint(httpsUrl);
  _wssConnection = new Connection(httpsUrl, {
    wsEndpoint: wssUrl,
    commitment: "processed",
  });
  console.log("[OnChainBettingState] Mainnet WS connection created");
  return _wssConnection;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

interface OnChainBettingState {
  /** The current on-chain state, or null if not yet loaded */
  onchainState: OnchainState | null;
  /** True when on-chain state has moved past "betting" */
  bettingClosedOnChain: boolean;
  /** Whether we have an active WebSocket subscription */
  connected: boolean;
}

export function useOnChainBettingState(
  rumbleId: string | undefined,
  slotState: "idle" | "betting" | "combat" | "payout"
): OnChainBettingState {
  const [onchainState, setOnchainState] = useState<OnchainState | null>(null);
  const [connected, setConnected] = useState(false);
  const subIdRef = useRef<number | null>(null);
  const connectionRef = useRef<Connection | null>(null);

  useEffect(() => {
    // Only subscribe during betting state
    if (slotState !== "betting") {
      setOnchainState(null);
      setConnected(false);
      return;
    }

    if (!rumbleId) return;

    const rumbleIdNum = parseOnchainRumbleIdNumber(rumbleId);
    if (rumbleIdNum === null) return;

    const conn = getWssConnection();
    if (!conn) {
      console.log("[OnChainBettingState] No mainnet WS endpoint — WS disabled");
      return;
    }

    connectionRef.current = conn;
    const [rumblePda] = deriveRumblePda(rumbleIdNum);

    console.log(
      `[OnChainBettingState] Subscribing to ${rumblePda.toBase58()} (rumble ${rumbleId})`
    );

    let cancelled = false;

    const subscriptionId = conn.onAccountChange(
      rumblePda,
      (accountInfo) => {
        if (cancelled) return;
        const data = accountInfo.data;
        if (!data || data.length < 17) return;

        const rawState = data[16];
        const state = ONCHAIN_STATES[rawState];
        if (state) {
          console.log(`[OnChainBettingState] On-chain state: ${state}`);
          setOnchainState(state);
        }
      },
      "processed"
    );

    subIdRef.current = subscriptionId;
    setConnected(true);
    console.log(
      `[OnChainBettingState] Subscription active (id=${subscriptionId})`
    );

    return () => {
      cancelled = true;
      setConnected(false);
      if (subIdRef.current !== null && connectionRef.current) {
        console.log(
          `[OnChainBettingState] Unsubscribing (id=${subIdRef.current})`
        );
        connectionRef.current
          .removeAccountChangeListener(subIdRef.current)
          .catch(() => {});
        subIdRef.current = null;
      }
    };
  }, [rumbleId, slotState]);

  const bettingClosedOnChain =
    onchainState !== null && onchainState !== "betting";

  return { onchainState, bettingClosedOnChain, connected };
}
