"use client";

import dynamic from "next/dynamic";

const HomeContent = dynamic(() => import("../../components/HomeContent"), {
  ssr: false,
  loading: () => (
    <main className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-stone-950 via-stone-900 to-stone-950 text-stone-200">
      <div className="animate-pulse font-mono text-2xl text-amber-600">Loading UCF Classic...</div>
    </main>
  ),
});

export default function ClassicPage() {
  return <HomeContent />;
}
