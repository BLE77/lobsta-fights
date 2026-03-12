"use client";

import { useCallback, useEffect, useState } from "react";

type TxFeedNetwork = "mainnet" | "devnet";

type TxEntry = {
  signature: string;
  blockTime: number | null;
  confirmationStatus: string | null;
  err: boolean;
};

type FeedState = {
  loading: boolean;
  error: string | null;
  entries: TxEntry[];
};

const EXPLORER_TX = "https://explorer.solana.com/tx";
const POLL_MS = 60_000;
const NETWORKS: TxFeedNetwork[] = ["mainnet", "devnet"];

function shortSig(signature: string): string {
  return `${signature.slice(0, 8)}...${signature.slice(-8)}`;
}

function formatBlockTime(blockTime: number | null): string {
  if (!blockTime) return "--";
  return new Date(blockTime * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function explorerHref(signature: string, network: TxFeedNetwork): string {
  return network === "mainnet"
    ? `${EXPLORER_TX}/${signature}`
    : `${EXPLORER_TX}/${signature}?cluster=devnet`;
}

function NetworkFeed({
  network,
  state,
}: {
  network: TxFeedNetwork;
  state: FeedState;
}) {
  return (
    <div className="bg-stone-900/60 border border-stone-800 rounded-sm overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-stone-800">
        <div className="flex items-center gap-2">
          <span
            className={`inline-block w-2 h-2 rounded-full ${
              network === "mainnet" ? "bg-emerald-500" : "bg-cyan-500"
            }`}
          />
          <h3 className="font-mono text-xs uppercase tracking-wider text-stone-300">
            {network}
          </h3>
        </div>
        <span className="font-mono text-[10px] text-stone-500">
          {network === "mainnet" ? "betting" : "combat"}
        </span>
      </div>

      <div className="max-h-80 overflow-y-auto divide-y divide-stone-800/50">
        {state.loading ? (
          <div className="p-4 text-center font-mono text-xs text-stone-500">
            Loading...
          </div>
        ) : state.error ? (
          <div className="p-4 text-center font-mono text-xs text-red-400">
            {state.error}
          </div>
        ) : state.entries.length === 0 ? (
          <div className="p-4 text-center font-mono text-xs text-stone-500">
            No transactions found
          </div>
        ) : (
          state.entries.map(entry => (
            <a
              key={`${network}:${entry.signature}`}
              href={explorerHref(entry.signature, network)}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-between gap-3 px-3 py-2 hover:bg-stone-800/40 transition-colors"
            >
              <div className="min-w-0 flex items-center gap-2">
                <span
                  className={`inline-block h-1.5 w-1.5 rounded-full shrink-0 ${
                    entry.err ? "bg-red-500" : "bg-green-500"
                  }`}
                />
                <span className="font-mono text-xs text-cyan-400 truncate">
                  {shortSig(entry.signature)}
                </span>
              </div>
              <div className="shrink-0 text-right">
                <div className="font-mono text-[10px] text-stone-400">
                  {formatBlockTime(entry.blockTime)}
                </div>
                <div className="font-mono text-[10px] text-stone-600 uppercase">
                  {(entry.confirmationStatus ?? "-").slice(0, 4)}
                </div>
              </div>
            </a>
          ))
        )}
      </div>
    </div>
  );
}

export default function OnChainTxFeedPanel() {
  const [feeds, setFeeds] = useState<Record<TxFeedNetwork, FeedState>>({
    mainnet: { loading: true, error: null, entries: [] },
    devnet: { loading: true, error: null, entries: [] },
  });

  const fetchFeeds = useCallback(async () => {
    await Promise.all(
      NETWORKS.map(async network => {
        setFeeds(prev => ({
          ...prev,
          [network]: { ...prev[network], loading: true, error: null },
        }));

        try {
          const res = await fetch(`/api/rumble/tx-feed?network=${network}&_t=${Date.now()}`, {
            credentials: "include",
            cache: "no-store",
          });
          if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
          }
          const json = await res.json();
          setFeeds(prev => ({
            ...prev,
            [network]: {
              loading: false,
              error: null,
              entries: Array.isArray(json?.signatures) ? json.signatures : [],
            },
          }));
        } catch (error: any) {
          setFeeds(prev => ({
            ...prev,
            [network]: {
              ...prev[network],
              loading: false,
              error: error?.message ?? "Failed to fetch feed",
            },
          }));
        }
      }),
    );
  }, []);

  useEffect(() => {
    void fetchFeeds();
    const timer = setInterval(() => {
      void fetchFeeds();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [fetchFeeds]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="font-mono text-xs text-stone-500">
          Admin-only transaction feed split by network.
        </p>
        <button
          onClick={() => void fetchFeeds()}
          className="font-mono text-[10px] text-stone-500 hover:text-amber-400 transition-colors"
        >
          Refresh
        </button>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <NetworkFeed network="mainnet" state={feeds.mainnet} />
        <NetworkFeed network="devnet" state={feeds.devnet} />
      </div>
    </div>
  );
}
