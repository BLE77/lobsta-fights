"use client";

/**
 * WalletConnect - Solana wallet connection component for Rumble spectators
 *
 * Uses @solana/wallet-adapter-react for Phantom/Solflare/etc.
 * Shows connected wallet address, SOL balance, and ICHOR balance.
 *
 * Dependencies needed (not yet installed):
 *   @solana/wallet-adapter-react
 *   @solana/wallet-adapter-react-ui
 *   @solana/wallet-adapter-wallets
 *   @solana/web3.js
 */

import { useCallback, useEffect, useState } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import type { WalletBalances } from "~~/lib/solana-wallet-types";
import { truncateAddress, formatSol } from "~~/lib/solana-format";

// Import wallet adapter styles
import "@solana/wallet-adapter-react-ui/styles.css";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WalletConnectProps {
  onConnect?: (address: string) => void;
  onDisconnect?: () => void;
  className?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function WalletConnect({
  onConnect,
  onDisconnect,
  className = "",
}: WalletConnectProps) {
  const { publicKey, connected, disconnect, connecting } = useWallet();
  const { connection } = useConnection();

  const [solBalance, setSolBalance] = useState<number | null>(null);
  const [ichorBalance, setIchorBalance] = useState<number>(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch balances when wallet connects
  const fetchBalances = useCallback(async () => {
    if (!publicKey) return;

    setLoading(true);
    setError(null);

    try {
      // Fetch SOL balance directly from connection (fast)
      const lamports = await connection.getBalance(publicKey, "confirmed");
      setSolBalance(lamports / LAMPORTS_PER_SOL);

      // Fetch full balances from Helius (includes ICHOR + USD values)
      try {
        const res = await fetch(
          `/api/wallet/balances?wallet=${encodeURIComponent(publicKey.toBase58())}`,
          { cache: "no-store" },
        );
        if (!res.ok) throw new Error(`API error ${res.status}`);
        const balances = (await res.json()) as WalletBalances;
        setIchorBalance(balances.ichorBalance);
      } catch {
        // Server-side Helius might not be configured yet; SOL balance still works.
        setIchorBalance(0);
      }
    } catch (err) {
      setError("Failed to fetch balances");
      console.error("WalletConnect: balance fetch error", err);
    } finally {
      setLoading(false);
    }
  }, [publicKey, connection]);

  // Auto-fetch on connect
  useEffect(() => {
    if (connected && publicKey) {
      fetchBalances();
      onConnect?.(publicKey.toBase58());
    }
  }, [connected, publicKey, fetchBalances, onConnect]);

  // Refresh balances every 30 seconds while connected
  useEffect(() => {
    if (!connected || !publicKey) return;
    const interval = setInterval(fetchBalances, 30_000);
    return () => clearInterval(interval);
  }, [connected, publicKey, fetchBalances]);

  const handleDisconnect = useCallback(async () => {
    await disconnect();
    setSolBalance(null);
    setIchorBalance(0);
    setError(null);
    onDisconnect?.();
  }, [disconnect, onDisconnect]);

  // Not connected: show connect button
  if (!connected) {
    return (
      <div className={`flex items-center gap-2 ${className}`}>
        <WalletMultiButton
          style={{
            backgroundColor: "#d97706",
            color: "white",
            borderRadius: "6px",
            fontSize: "14px",
            height: "40px",
            padding: "0 16px",
          }}
        />
      </div>
    );
  }

  // Connected: show wallet info
  const address = publicKey?.toBase58() ?? "";

  return (
    <div
      className={`flex items-center gap-3 bg-gray-900 border border-gray-700 rounded-lg px-4 py-2 ${className}`}
    >
      {/* Balances */}
      <div className="flex flex-col text-sm leading-tight">
        <div className="flex items-center gap-2">
          <span className="text-gray-400">SOL</span>
          <span className="text-white font-mono">
            {loading
              ? "..."
              : solBalance !== null
                ? formatSol(solBalance)
                : "--"}
          </span>
        </div>
        {ichorBalance > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-amber-500">ICHOR</span>
            <span className="text-white font-mono">
              {ichorBalance.toLocaleString(undefined, {
                maximumFractionDigits: 4,
              })}
            </span>
          </div>
        )}
      </div>

      {/* Address + disconnect */}
      <div className="flex items-center gap-2 border-l border-gray-700 pl-3">
        <span
          className="text-gray-300 font-mono text-sm cursor-pointer hover:text-white"
          title={address}
          onClick={() => navigator.clipboard.writeText(address)}
        >
          {truncateAddress(address)}
        </span>
        <button
          onClick={handleDisconnect}
          className="text-gray-500 hover:text-red-400 transition-colors text-xs"
          title="Disconnect wallet"
        >
          X
        </button>
      </div>

      {/* Error indicator */}
      {error && (
        <span className="text-red-400 text-xs" title={error}>
          !
        </span>
      )}
    </div>
  );
}
