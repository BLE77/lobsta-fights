"use client";

import { Toaster } from "react-hot-toast";

// Wallet temporarily disabled - will re-enable for on-chain betting
export function ScaffoldEthApp({ children }: { children: React.ReactNode }) {
  return (
    <>
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
    </>
  );
}
