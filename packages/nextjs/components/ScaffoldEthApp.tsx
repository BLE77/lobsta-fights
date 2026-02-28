"use client";

import { Toaster } from "react-hot-toast";
import WalletProvider from "~~/app/providers/WalletProvider";
import BottomNav from "./BottomNav";

export function ScaffoldEthApp({ children }: { children: React.ReactNode }) {
  return (
    <WalletProvider>
      {children}
      <BottomNav />
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
