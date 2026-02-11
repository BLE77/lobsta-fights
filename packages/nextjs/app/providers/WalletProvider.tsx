"use client";

import { useMemo } from "react";
import {
  ConnectionProvider,
  WalletProvider as SolanaWalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import {
  PhantomWalletAdapter,
  SolflareWalletAdapter,
} from "@solana/wallet-adapter-wallets";
import { type Adapter } from "@solana/wallet-adapter-base";

import "@solana/wallet-adapter-react-ui/styles.css";

function getRpcEndpoint(): string {
  const key = process.env.NEXT_PUBLIC_HELIUS_API_KEY;
  const network = process.env.NEXT_PUBLIC_SOLANA_NETWORK ?? "devnet";

  if (!key) {
    // Fallback to public devnet RPC if no Helius key
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

  const wallets: Adapter[] = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
    [],
  );

  return (
    <ConnectionProvider endpoint={endpoint}>
      <SolanaWalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </SolanaWalletProvider>
    </ConnectionProvider>
  );
}
