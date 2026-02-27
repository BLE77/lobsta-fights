"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Connection, PublicKey } from "@solana/web3.js";

const PROGRAM_ID = "2TvW4EfbmMe566ZQWZWd8kX34iFR2DM3oBUpjwpRJcqC";
const DEVNET_RPC = process.env.NEXT_PUBLIC_SOLANA_RPC_URL?.trim() || "https://api.devnet.solana.com";
const EXPLORER_TX = "https://explorer.solana.com/tx";
const TX_LIMIT = 20;
const REFRESH_MS = 45_000;

interface TxEntry {
  signature: string;
  blockTime: number | null;
  confirmationStatus: string | null;
  err: boolean;
}

function truncateSig(sig: string): string {
  return `${sig.slice(0, 6)}...${sig.slice(-6)}`;
}

function formatBlockTime(ts: number | null): string {
  if (!ts) return "--";
  const d = new Date(ts * 1000);
  const now = Date.now();
  const diffS = Math.floor((now - d.getTime()) / 1000);
  if (diffS < 60) return `${diffS}s ago`;
  if (diffS < 3600) return `${Math.floor(diffS / 60)}m ago`;
  if (diffS < 86400) return `${Math.floor(diffS / 3600)}h ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function OnChainTxFeed() {
  const [txs, setTxs] = useState<TxEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const connRef = useRef<Connection | null>(null);

  const fetchTxs = useCallback(async () => {
    try {
      if (!connRef.current) {
        connRef.current = new Connection(DEVNET_RPC, "confirmed");
      }
      const programKey = new PublicKey(PROGRAM_ID);
      const sigs = await connRef.current.getSignaturesForAddress(programKey, {
        limit: TX_LIMIT,
      });
      setTxs(
        sigs.map((s) => ({
          signature: s.signature,
          blockTime: s.blockTime ?? null,
          confirmationStatus: s.confirmationStatus ?? null,
          err: !!s.err,
        })),
      );
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? "Failed to fetch transactions");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTxs();
    const interval = setInterval(fetchTxs, REFRESH_MS);
    return () => clearInterval(interval);
  }, [fetchTxs]);

  return (
    <div className="bg-stone-900/80 border border-stone-700 rounded-sm backdrop-blur-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-stone-800">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-cyan-500" />
          </span>
          <h3 className="text-xs font-mono text-stone-400 uppercase tracking-wider">
            On-Chain Feed
          </h3>
        </div>
        <span className="font-mono text-[10px] text-stone-600">devnet</span>
      </div>

      {/* Body */}
      <div className="max-h-72 overflow-y-auto divide-y divide-stone-800/50">
        {loading ? (
          <div className="p-4 text-center">
            <span className="text-stone-500 font-mono text-xs animate-pulse">
              Fetching transactions...
            </span>
          </div>
        ) : error ? (
          <div className="p-3 text-center">
            <span className="text-red-400/70 font-mono text-[10px]">{error}</span>
          </div>
        ) : txs.length === 0 ? (
          <div className="p-4 text-center">
            <span className="text-stone-500 font-mono text-xs">No transactions yet</span>
          </div>
        ) : (
          txs.map((tx) => (
            <a
              key={tx.signature}
              href={`${EXPLORER_TX}/${tx.signature}?cluster=devnet`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-between gap-2 px-3 py-1.5 hover:bg-stone-800/60 transition-colors group"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${
                    tx.err ? "bg-red-500" : "bg-green-500"
                  }`}
                />
                <span className="font-mono text-[11px] text-cyan-400 group-hover:text-cyan-300 truncate">
                  {truncateSig(tx.signature)}
                </span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="font-mono text-[10px] text-stone-500">
                  {formatBlockTime(tx.blockTime)}
                </span>
                {tx.confirmationStatus && (
                  <span
                    className={`font-mono text-[9px] px-1 py-px rounded-sm ${
                      tx.confirmationStatus === "finalized"
                        ? "bg-green-900/40 text-green-500"
                        : tx.confirmationStatus === "confirmed"
                          ? "bg-cyan-900/40 text-cyan-500"
                          : "bg-stone-800 text-stone-500"
                    }`}
                  >
                    {tx.confirmationStatus.slice(0, 4).toUpperCase()}
                  </span>
                )}
              </div>
            </a>
          ))
        )}
      </div>
    </div>
  );
}
