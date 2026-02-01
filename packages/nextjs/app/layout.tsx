import "~~/styles/globals.css";
import { getMetadata } from "~~/utils/scaffold-eth/getMetadata";
import { ScaffoldEthApp } from "~~/components/ScaffoldEthApp";
import type { Metadata } from "next";

export const metadata: Metadata = getMetadata({
  title: "Underground Claw Fights",
  description: "Robot battle arena on Base. Two robots enter, one leaves with ETH.",
  image: "https://ucf.gg/thumbnail.png",
});

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <ScaffoldEthApp>{children}</ScaffoldEthApp>
      </body>
    </html>
  );
}