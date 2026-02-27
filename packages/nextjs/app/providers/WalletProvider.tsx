"use client";

/**
 * Wallet adapter provider — uses wallet-standard protocol to auto-detect
 * all installed Solana wallets (Phantom, Solflare, Backpack, etc.).
 *
 * Empty wallets array is intentional: wallet-standard handles discovery.
 * autoConnect is ON so selecting a wallet in the modal triggers connect(),
 * and page reloads reconnect to the previously chosen wallet.
 */

import { useMemo, useCallback } from "react";
import {
  ConnectionProvider,
  WalletProvider as SolanaWalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { type WalletError } from "@solana/wallet-adapter-base";
import {
  SolanaMobileWalletAdapter,
  createDefaultAddressSelector,
  createDefaultAuthorizationResultCache,
  createDefaultWalletNotFoundHandler,
} from "@solana-mobile/wallet-adapter-mobile";
import { useSolanaMobileContext } from "~~/lib/solana-mobile";

import "@solana/wallet-adapter-react-ui/styles.css";

type SolanaNetwork = "devnet" | "testnet" | "mainnet-beta";

function getWalletNetwork(): SolanaNetwork {
  // Betting is on mainnet — if a dedicated betting RPC is configured,
  // the wallet adapter must authorize on mainnet so users sign with real SOL.
  if (process.env.NEXT_PUBLIC_BETTING_RPC_URL?.trim()) return "mainnet-beta";
  const explicit = process.env.NEXT_PUBLIC_SOLANA_NETWORK as SolanaNetwork | undefined;
  if (explicit) return explicit;
  return "devnet";
}

function getRpcEndpoint(): string {
  // Betting is on mainnet — users sign bet/claim txs with real SOL.
  // Use dedicated betting RPC if configured, otherwise fall back to network-based endpoint.
  const bettingRpc = process.env.NEXT_PUBLIC_BETTING_RPC_URL?.trim();
  if (bettingRpc) return bettingRpc;

  const explicit = process.env.NEXT_PUBLIC_SOLANA_RPC_URL?.trim();
  if (explicit) return explicit;

  const network = getWalletNetwork();
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
  const mobileContext = useSolanaMobileContext();
  const network = getWalletNetwork();

  const wallets = useMemo(() => {
    // Keep wallet-standard desktop behavior; prefer Solana Mobile adapter
    // when running in Seeker/Solana mobile browser contexts.
    if (!mobileContext.shouldPreferMobileWalletAdapter) return [];

    return [
      new SolanaMobileWalletAdapter({
        chain: network,
        addressSelector: createDefaultAddressSelector(),
        authorizationResultCache: createDefaultAuthorizationResultCache(),
        onWalletNotFound: createDefaultWalletNotFoundHandler(),
        appIdentity: {
          name: "Underground Claw Fights",
          uri: "https://clawfights.xyz",
          icon: "https://clawfights.xyz/favicon.svg",
        },
      }),
    ];
  }, [mobileContext.shouldPreferMobileWalletAdapter, network]);

  const onError = useCallback((error: WalletError) => {
    console.error("[WalletProvider] error:", error);
  }, []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <SolanaWalletProvider wallets={wallets} autoConnect onError={onError}>
        <WalletModalProvider>{children}</WalletModalProvider>
      </SolanaWalletProvider>
    </ConnectionProvider>
  );
}
