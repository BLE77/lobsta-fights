"use client";

import { Toaster } from "react-hot-toast";
import AudioToggle from "./AudioToggle";
import WalletProvider from "~~/app/providers/WalletProvider";

export function ScaffoldEthApp({ children }: { children: React.ReactNode }) {
  return (
    <WalletProvider>
      {children}
      <AudioToggle />
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
