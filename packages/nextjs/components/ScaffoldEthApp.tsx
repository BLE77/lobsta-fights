"use client";

import dynamic from "next/dynamic";
import { Toaster } from "react-hot-toast";

const WalletProvider = dynamic(
  () => import("./WalletProvider").then((mod) => mod.WalletProvider),
  { ssr: false }
);

export function ScaffoldEthApp({ children }: { children: React.ReactNode }) {
  return (
    <WalletProvider>
      {children}
      <Toaster
        position="bottom-right"
        toastOptions={{
          style: {
            background: "#1c1917",
            color: "#e7e5e4",
          },
        }}
      />
    </WalletProvider>
  );
}
