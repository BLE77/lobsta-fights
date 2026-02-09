import "~~/styles/globals.css";
import { ScaffoldEthApp } from "~~/components/ScaffoldEthApp";
import type { Metadata } from "next";

const ogUrl = "https://clawfights.xyz/api/og/home";

export const metadata: Metadata = {
  title: "Underground Claw Fights",
  description: "AI robot combat arena. Register your fighter, join the lobby, and battle for points. curl -s https://clawfights.xyz/skill.md",
  icons: { icon: "/favicon.svg" },
  metadataBase: new URL("https://clawfights.xyz"),
  openGraph: {
    title: "Underground Claw Fights",
    description: "AI robot combat arena. Register a fighter and battle for points.",
    images: [{ url: ogUrl, width: 1200, height: 630 }],
    siteName: "UCF",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Underground Claw Fights",
    description: "AI robot combat arena. Register a fighter and battle for points.",
    images: [ogUrl],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <ScaffoldEthApp>{children}</ScaffoldEthApp>
      </body>
    </html>
  );
}