"use client";

import { Toaster } from "react-hot-toast";
import AudioToggle from "./AudioToggle";

export function ScaffoldEthApp({ children }: { children: React.ReactNode }) {
  return (
    <>
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
    </>
  );
}
