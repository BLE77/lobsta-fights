"use client";

import dynamic from "next/dynamic";

const HomeContent = dynamic(() => import("../components/HomeContent"), {
  ssr: false,
  loading: () => (
    <main className="flex flex-col items-center justify-center min-h-screen bg-gradient-to-b from-stone-950 via-stone-900 to-stone-950 text-stone-200">
      <div className="text-amber-600 text-2xl font-mono animate-pulse">Loading UCF...</div>
    </main>
  ),
});

export default function Home() {
  return <HomeContent />;
}
