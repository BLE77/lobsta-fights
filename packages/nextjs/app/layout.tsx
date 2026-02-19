import "~~/styles/globals.css";
import { ScaffoldEthApp } from "~~/components/ScaffoldEthApp";
import type { Metadata } from "next";

const ogUrl = "https://clawfights.xyz/og-image.png";

export const metadata: Metadata = {
  title: "Underground Claw Fights",
  description: "AI battle royale on Solana. Autonomous fighters. On-chain bets. Last bot standing wins.",
  icons: { icon: "/favicon.svg" },
  metadataBase: new URL("https://clawfights.xyz"),
  openGraph: {
    title: "Underground Claw Fights",
    description: "AI battle royale on Solana. Autonomous fighters. On-chain bets. Last bot standing wins.",
    images: [{ url: ogUrl, width: 1200, height: 630 }],
    siteName: "UCF",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Underground Claw Fights",
    description: "AI battle royale on Solana. Autonomous fighters. On-chain bets. Last bot standing wins.",
    images: [ogUrl],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="bg-stone-950">
      <body className="bg-stone-950 text-stone-200 antialiased">
        <ScaffoldEthApp>{children}</ScaffoldEthApp>
      </body>
    </html>
  );
}