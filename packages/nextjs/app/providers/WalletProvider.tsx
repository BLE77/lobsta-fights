"use client";

/**
 * Minimal wrapper — the rumble page manages Phantom directly via
 * window.phantom.solana so we don't need the wallet adapter's autoConnect
 * (which was picking up MetaMask and crashing).
 *
 * We keep ConnectionProvider for any legacy components that might use
 * useConnection(), but disable autoConnect and pass no wallet adapters.
 */

import { useMemo, useCallback } from "react";
import {
  ConnectionProvider,
  WalletProvider as SolanaWalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { type WalletError } from "@solana/wallet-adapter-base";

import "@solana/wallet-adapter-react-ui/styles.css";

function getRpcEndpoint(): string {
  const key = process.env.NEXT_PUBLIC_HELIUS_API_KEY;
  const network = process.env.NEXT_PUBLIC_SOLANA_NETWORK ?? "devnet";

  if (!key) {
    if (network === "mainnet-beta") {
      return "https://api.mainnet-beta.solana.com";
    }
    return "https://api.devnet.solana.com";
  }

  if (network === "mainnet-beta") {
    return `https://mainnet.helius-rpc.com/?api-key=${key}`;
  }
  return `https://devnet.helius-rpc.com/?api-key=${key}`;
}

export default function WalletProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const endpoint = useMemo(() => getRpcEndpoint(), []);

  // Empty adapters array + autoConnect OFF = no MetaMask interference
  const wallets = useMemo(() => [], []);

  const onError = useCallback((error: WalletError) => {
    console.error("[WalletProvider] error:", error);
  }, []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <SolanaWalletProvider wallets={wallets} onError={onError}>
        <WalletModalProvider>{children}</WalletModalProvider>
      </SolanaWalletProvider>
    </ConnectionProvider>
  );
}
