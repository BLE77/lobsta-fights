"use client";

import { useEffect, useRef, useState } from "react";
import { Connection, PublicKey } from "@solana/web3.js";
import { parseOnchainRumbleIdNumber } from "~~/lib/rumble-id";
import { resolveMainnetRumbleEngineId } from "~~/lib/rumble-program-id";
import {
  getClientBettingNetwork,
  getSafeClientBettingRpcEndpoint,
  getSafeClientCombatRpcEndpoint,
  toWsEndpoint,
} from "~~/lib/client-solana-rpc";

// ---------------------------------------------------------------------------
// Constants (mirrored from solana-programs.ts to avoid importing node:crypto)
// ---------------------------------------------------------------------------

const RUMBLE_ENGINE_ID = new PublicKey(
  resolveMainnetRumbleEngineId(
    [
      process.env.NEXT_PUBLIC_RUMBLE_ENGINE_MAINNET?.trim(),
      process.env.NEXT_PUBLIC_RUMBLE_ENGINE_ID_MAINNET?.trim(),
      process.env.NEXT_PUBLIC_RUMBLE_ENGINE_PROGRAM?.trim(),
    ],
    "638DcfW6NaBweznnzmJe4PyxCw51s3CTkykUNskWnxTU",
  )
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
// Singleton WebSocket Connection (module-level, shared across all betting slots)
// ---------------------------------------------------------------------------

let _bettingStateWssConnection: Connection | null = null;
let _bettingStateWssEndpoint: string | null = null;

function getBettingStateConnection(): { conn: Connection; label: "mainnet" | "devnet" } {
  const network = getClientBettingNetwork();
  const label = network === "mainnet-beta" ? "mainnet" : "devnet";
  const explicitWs = process.env.NEXT_PUBLIC_BETTING_WS_URL?.trim();
  const httpsUrl =
    network === "mainnet-beta"
      ? getSafeClientBettingRpcEndpoint()
      : getSafeClientCombatRpcEndpoint();
  const wssUrl = label === "mainnet" && explicitWs ? explicitWs : toWsEndpoint(httpsUrl);

  if (_bettingStateWssConnection && _bettingStateWssEndpoint === `${httpsUrl}|${wssUrl}`) {
    return { conn: _bettingStateWssConnection, label };
  }

  _bettingStateWssEndpoint = `${httpsUrl}|${wssUrl}`;
  _bettingStateWssConnection = new Connection(httpsUrl, {
    wsEndpoint: wssUrl,
    commitment: "processed",
  });
  return { conn: _bettingStateWssConnection, label };
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

function normalizeRumbleNumber(value: unknown): number | null {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(num) || num <= 0) return null;
  return num;
}

export function useOnChainBettingState(
  rumbleId: string | undefined,
  slotState: "idle" | "betting" | "combat" | "payout",
  rumbleNumber?: number | null,
): OnChainBettingState {
  const [onchainState, setOnchainState] = useState<OnchainState | null>(null);
  const [connected, setConnected] = useState(false);
  const subIdsRef = useRef<Array<{ conn: Connection; id: number }>>([]);

  useEffect(() => {
    // Only subscribe during betting state
    if (slotState !== "betting") {
      setOnchainState(null);
      setConnected(false);
      return;
    }

    if (!rumbleId) return;

    const rumbleIdNum =
      normalizeRumbleNumber(rumbleNumber) ??
      parseOnchainRumbleIdNumber(rumbleId);
    if (rumbleIdNum === null) return;

    const [rumblePda] = deriveRumblePda(rumbleIdNum);
    let cancelled = false;
    const subs: Array<{ conn: Connection; id: number }> = [];

    const handleAccountChange = (data: Buffer) => {
      if (cancelled) return;
      if (!data || data.length < 17) return;
      const rawState = data[16];
      const state = ONCHAIN_STATES[rawState];
      if (state) {
        setOnchainState(state);
      }
    };

    try {
      const { conn, label } = getBettingStateConnection();
      const subId = conn.onAccountChange(
        rumblePda,
        (accountInfo) => handleAccountChange(accountInfo.data),
        "processed"
      );
      subs.push({ conn, id: subId });
      console.log(
        `[OnChainBettingState] ${label} subscription active for ${rumblePda.toBase58()} (id=${subId})`
      );
    } catch (err) {
      console.warn("[OnChainBettingState] subscription failed", err);
    }

    subIdsRef.current = subs;
    setConnected(subs.length > 0);

    return () => {
      cancelled = true;
      setConnected(false);
      for (const { conn, id } of subIdsRef.current) {
        conn.removeAccountChangeListener(id).catch(() => {});
      }
      subIdsRef.current = [];
    };
  }, [rumbleId, slotState, rumbleNumber]);

  const bettingClosedOnChain =
    onchainState !== null && onchainState !== "betting";

  return { onchainState, bettingClosedOnChain, connected };
}
