"use client";

/**
 * Wallet adapter provider — uses wallet-standard protocol to auto-detect
 * all installed Solana wallets (Phantom, Solflare, Backpack, etc.).
 *
 * Empty wallets array is intentional: wallet-standard handles discovery.
 * autoConnect is OFF so users explicitly choose which wallet to connect.
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
  const network = process.env.NEXT_PUBLIC_SOLANA_NETWORK ?? "devnet";
  const explicit = process.env.NEXT_PUBLIC_SOLANA_RPC_URL?.trim();
  if (explicit) return explicit;

  // Frontend defaults to public RPC to avoid exposing/rate-limiting a shared key.
  return network === "mainnet-beta"
    ? "https://api.mainnet-beta.solana.com"
    : "https://api.devnet.solana.com";
}

export default function WalletProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const endpoint = useMemo(() => getRpcEndpoint(), []);

  // Empty array — wallet-standard auto-detects all installed Solana wallets
  const wallets = useMemo(() => [], []);

  const onError = useCallback((error: WalletError) => {
    console.error("[WalletProvider] error:", error);
  }, []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <SolanaWalletProvider wallets={wallets} autoConnect={false} onError={onError}>
        <WalletModalProvider>{children}</WalletModalProvider>
      </SolanaWalletProvider>
    </ConnectionProvider>
  );
}
