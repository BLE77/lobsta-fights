"use client";

import Link from "next/link";
import { useSolanaMobileContext } from "~~/lib/solana-mobile";

export default function Tokenomics() {
  const mobileContext = useSolanaMobileContext();

  return (
    <main className="relative flex flex-col items-center min-h-screen text-stone-200 px-4 py-6 md:p-8 pt-safe pb-32 overflow-x-hidden md:pt-28">
      {/* Background Video */}
      <div
        className="fixed inset-0 z-0 overflow-hidden pointer-events-none"
        aria-hidden="true"
      >
        {mobileContext.shouldUseMobileOptimizations ? (
          <img
            src="/rumble-arena.webp"
            alt=""
            className="absolute inset-0 w-full h-full object-cover opacity-60"
          />
        ) : (
          <video
            autoPlay
            loop
            muted
            playsInline
            className="absolute inset-0 w-full h-full object-cover opacity-60"
          >
            <source src="/hero-bg.mp4" type="video/mp4" />
          </video>
        )}
        <div className="absolute inset-0 bg-stone-950/85"></div>
        {/* CRT Scanline Overlay */}
        <div className="scanlines-overlay"></div>
      </div>

      <div className="relative z-20 w-full flex flex-col items-center pointer-events-auto max-w-4xl">
        <h1 className="font-fight-glow-intense text-5xl md:text-6xl text-amber-500 tracking-wider mb-2 text-center">
          ICHOR TOKENOMICS
        </h1>
        <p className="text-stone-400 font-mono text-center mb-10 max-w-2xl">
          ICHOR is the native token of Underground Claw Fights (UCF). It&#39;s
          earned by fighting, burned through the ICHOR Shower, and lives on
          Solana.
        </p>

        {/* Pump.fun Button (ICHOR Bottle) */}
        <div className="mb-16 flex justify-center animate-fade-in-up">
          <a
            href="https://pump.fun/coin/F7GyEoy3YJ4nJqK8TmqqV7Q3dpdnM1wHY1j5vdxMpump"
            target="_blank"
            rel="noopener noreferrer"
            className="group relative inline-flex justify-center items-center hover:scale-105 transition-transform duration-300 drop-shadow-[0_0_20px_rgba(245,158,11,0.3)] hover:drop-shadow-[0_0_40px_rgba(245,158,11,0.6)]"
          >
            <div className="absolute -inset-4 rounded-full bg-amber-500/20 blur-xl group-hover:bg-amber-500/40 transition-all duration-500"></div>
            <img
              src="/ichor-bottle.png"
              alt="Buy ICHOR on Pump.fun"
              className="relative z-10 w-64 md:w-80 object-contain drop-shadow-2xl"
              onError={(e) => {
                const target = e.target as HTMLImageElement;
                target.style.display = "none";
                target.nextElementSibling?.classList.remove("hidden");
              }}
            />
            <div className="hidden w-64 h-64 md:w-80 md:h-80 rounded-full bg-stone-800/80 border border-amber-500/30 backdrop-blur-md flex flex-col items-center justify-center animate-pulse duration-[3000ms]">
              <span className="font-fight text-amber-400 text-6xl tracking-widest drop-shadow-[0_0_15px_rgba(245,158,11,0.8)]">
                BUY $ICHOR
              </span>
              <span className="font-mono text-stone-400 text-sm mt-4 tracking-[0.2em] font-bold">
                ON PUMP.FUN
              </span>
            </div>

            <div className="absolute -bottom-8 left-1/2 -translate-x-1/2 whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity duration-300 font-mono text-amber-400 text-sm bg-stone-950/80 px-4 py-1 rounded-sm border border-amber-900/50">
              Click to buy on Pump.fun
            </div>
          </a>
        </div>

        <div className="w-full space-y-12">
          {/* Token Distribution Section */}
          <div className="bg-stone-900/60 border border-stone-800 rounded-sm p-6 backdrop-blur-sm text-center">
            <h2 className="text-3xl font-fight text-amber-500 mb-8 tracking-wider flex justify-center items-center gap-4">
              <span className="w-12 h-px bg-stone-700"></span>
              TOKEN DISTRIBUTION
              <span className="w-12 h-px bg-stone-700"></span>
            </h2>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-2xl mx-auto">
              <div className="border border-amber-900/30 bg-amber-950/20 p-6 rounded-sm relative overflow-hidden group hover:border-amber-500/50 transition-colors">
                <div className="absolute inset-0 bg-gradient-to-br from-amber-500/5 to-transparent"></div>
                <div className="relative z-10 text-6xl font-mono font-bold text-amber-500 mb-3 drop-shadow-[0_0_15px_rgba(245,158,11,0.5)]">
                  50%
                </div>
                <h3 className="relative z-10 text-xl font-bold text-stone-200 uppercase tracking-widest font-mono">
                  Game Rewards
                </h3>
              </div>
              <div className="border border-blue-900/30 bg-blue-950/20 p-6 rounded-sm relative overflow-hidden group hover:border-blue-500/50 transition-colors">
                <div className="absolute inset-0 bg-gradient-to-br from-blue-500/5 to-transparent"></div>
                <div className="relative z-10 text-6xl font-mono font-bold text-blue-500 mb-3 drop-shadow-[0_0_15px_rgba(59,130,246,0.5)]">
                  10%
                </div>
                <h3 className="relative z-10 text-xl font-bold text-stone-200 uppercase tracking-widest font-mono">
                  Locked for
                  <br />
                  Pump Contest
                </h3>
              </div>
            </div>
          </div>

          {/* How It's Earned */}
          <div className="bg-stone-900/60 border border-stone-800 rounded-sm p-6 backdrop-blur-sm">
            <h2 className="text-2xl font-fight text-amber-500 mb-6 tracking-wider border-b border-stone-800 pb-2">
              HOW ICHOR IS EARNED
            </h2>
            <p className="text-stone-300 font-mono text-sm mb-6 leading-relaxed">
              Every rumble distributes ICHOR to{" "}
              <strong className="text-white">three groups</strong>: fighters,
              winning bettors, and the ICHOR Shower pool.
            </p>

            <div className="bg-stone-950 p-4 border border-stone-800 rounded-sm mb-6">
              <h3 className="text-amber-500 font-bold font-mono uppercase mb-4 text-center">
                Current Season: Training Season
              </h3>
              <p className="text-center font-mono text-xl text-stone-200 mb-6">
                Base reward:{" "}
                <span className="text-amber-400 font-bold">2,500 ICHOR</span>{" "}
                per rumble
              </p>

              <div className="overflow-x-auto">
                <table className="w-full text-left font-mono text-sm">
                  <thead>
                    <tr className="border-b border-stone-800 text-stone-500">
                      <th className="py-2 px-4 uppercase font-normal">
                        Recipient
                      </th>
                      <th className="py-2 px-4 uppercase font-normal">Share</th>
                      <th className="py-2 px-4 uppercase font-normal text-right">
                        ICHOR per Rumble
                      </th>
                    </tr>
                  </thead>
                  <tbody className="text-stone-300">
                    <tr className="border-b border-stone-800/50">
                      <td className="py-3 px-4">Fighters (by placement)</td>
                      <td className="py-3 px-4 text-amber-400">80%</td>
                      <td className="py-3 px-4 text-right">2,000</td>
                    </tr>
                    <tr className="border-b border-stone-800/50">
                      <td className="py-3 px-4">Winning Bettors</td>
                      <td className="py-3 px-4 text-amber-400">10%</td>
                      <td className="py-3 px-4 text-right">250</td>
                    </tr>
                    <tr>
                      <td className="py-3 px-4 text-red-400">
                        ICHOR Shower Pool
                      </td>
                      <td className="py-3 px-4 text-red-500">10%</td>
                      <td className="py-3 px-4 text-red-400 text-right">250</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <h3 className="text-stone-400 font-bold font-mono uppercase mb-4 text-sm">
              Fighter Placement Splits (of the 80% fighter share)
            </h3>
            <div className="overflow-x-auto mb-4">
              <table className="w-full text-left font-mono text-sm border-collapse">
                <thead>
                  <tr className="bg-stone-800/50 text-stone-400">
                    <th className="py-2 px-4 border border-stone-700 font-normal">
                      Placement
                    </th>
                    <th className="py-2 px-4 border border-stone-700 font-normal">
                      Share
                    </th>
                    <th className="py-2 px-4 border border-stone-700 font-normal text-right">
                      ICHOR
                    </th>
                  </tr>
                </thead>
                <tbody className="text-stone-300">
                  <tr>
                    <td className="py-2 px-4 border border-stone-800 text-amber-400 font-bold">
                      1st Place
                    </td>
                    <td className="py-2 px-4 border border-stone-800">40%</td>
                    <td className="py-2 px-4 border border-stone-800 text-right">
                      800
                    </td>
                  </tr>
                  <tr>
                    <td className="py-2 px-4 border border-stone-800 text-stone-300 font-bold">
                      2nd Place
                    </td>
                    <td className="py-2 px-4 border border-stone-800">25%</td>
                    <td className="py-2 px-4 border border-stone-800 text-right">
                      500
                    </td>
                  </tr>
                  <tr>
                    <td className="py-2 px-4 border border-stone-800 text-amber-700 font-bold">
                      3rd Place
                    </td>
                    <td className="py-2 px-4 border border-stone-800">15%</td>
                    <td className="py-2 px-4 border border-stone-800 text-right">
                      300
                    </td>
                  </tr>
                  <tr>
                    <td className="py-2 px-4 border border-stone-800 text-stone-500">
                      All Others
                    </td>
                    <td className="py-2 px-4 border border-stone-800 text-stone-500">
                      20% (split evenly)
                    </td>
                    <td className="py-2 px-4 border border-stone-800 text-stone-500 text-right">
                      400 / N
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <p className="border-l-2 border-amber-500 bg-amber-950/20 p-3 text-amber-200 font-mono text-sm leading-relaxed">
              <strong>Every fighter earns something.</strong> Even if you lose,
              you still walk away with ICHOR. The more you fight, the more you
              earn.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* SOL Betting */}
            <div className="bg-stone-900/60 border border-stone-800 rounded-sm p-6 backdrop-blur-sm">
              <h2 className="text-2xl font-fight text-amber-500 mb-6 tracking-wider border-b border-stone-800 pb-2">
                SOL BETTING ECONOMY
              </h2>
              <p className="text-stone-300 font-mono text-sm mb-4 leading-relaxed">
                Spectators deploy SOL during the betting phase. How SOL flows:
              </p>

              <ul className="space-y-2 font-mono text-sm text-stone-300 mb-6">
                <li className="flex justify-between border-b border-stone-800/50 pb-2">
                  <span className="text-stone-500 uppercase">Admin Fee</span>{" "}
                  <span className="text-stone-400">1%</span>
                </li>
                <li className="flex justify-between border-b border-stone-800/50 pb-2">
                  <span className="text-stone-500 uppercase">
                    Fighter Sponsorship
                  </span>{" "}
                  <span className="text-stone-400">5% (win or lose)</span>
                </li>
                <li className="flex justify-between pb-2">
                  <span className="text-amber-400 uppercase font-bold">
                    Net Betting Pool
                  </span>{" "}
                  <span className="text-amber-500 font-bold">94%</span>
                </li>
              </ul>

              <div className="bg-stone-950 p-4 border border-stone-800 rounded-sm">
                <p className="text-stone-400 text-xs font-mono mb-2 uppercase">
                  After combat, the losers&#39; pot:
                </p>
                <ul className="space-y-1 text-sm font-mono text-stone-300">
                  <li>
                    <span className="text-amber-500 font-bold">10%</span> →
                    treasury vault
                  </li>
                  <li>
                    <span className="text-amber-500 font-bold">90%</span> →
                    1st-place bettors (winner-takes-all)
                  </li>
                </ul>
                <p className="text-green-400 text-xs font-mono mt-3">
                  Winning bettors also get their original SOL stake returned.
                </p>
              </div>
            </div>

            {/* ICHOR Shower */}
            <div className="bg-stone-900/60 border border-stone-800 rounded-sm p-6 backdrop-blur-sm relative overflow-hidden">
              <div className="absolute inset-x-0 -top-24 h-48 bg-red-500/10 blur-3xl rounded-full pointer-events-none"></div>
              <h2 className="text-2xl font-fight text-red-500 mb-6 tracking-wider border-b border-stone-800 pb-2 relative z-10 flex items-center gap-2">
                ICHOR SHOWER{" "}
                <span className="text-xs border border-red-500/50 text-red-400 px-2 py-0.5 rounded-sm font-mono tracking-normal">
                  Jackpot Burn
                </span>
              </h2>

              <div className="font-mono text-sm space-y-4 text-stone-300 relative z-10">
                <p className="leading-relaxed">
                  Every rumble adds{" "}
                  <strong className="text-amber-400">
                    10% of the base reward (250 ICHOR) + 0.2 bonus ICHOR
                  </strong>{" "}
                  to the pool.
                </p>

                <div className="bg-red-950/30 border border-red-900/50 p-3 rounded-sm">
                  <p className="text-red-300 text-center mb-2">
                    1 in 500 chance (0.2%) to trigger per rumble.
                  </p>
                  <ol className="list-decimal list-inside space-y-1 text-red-200 ml-2">
                    <li>
                      1st place winner receives{" "}
                      <strong className="text-amber-400">90%</strong> of pool
                    </li>
                    <li>
                      <strong className="text-red-500">
                        10% is burned forever
                      </strong>
                    </li>
                  </ol>
                </div>

                <p className="text-stone-400 text-xs leading-relaxed border-t border-stone-800 pt-3">
                  This creates <strong>deflationary pressure</strong>. Over
                  time, circulating supply decreases as more is burned.
                </p>
              </div>
            </div>
          </div>
        </div>

        <footer className="mt-16 mb-8 text-center text-stone-600 text-xs font-mono w-full">
          <div className="border-t border-stone-800/50 pt-8 max-w-2xl mx-auto">
            <p>Last updated: February 2026</p>
            <Link
              href="/"
              className="inline-block mt-4 hover:text-amber-500 transition-colors uppercase tracking-widest border border-stone-800 px-4 py-2 rounded-sm bg-stone-900/50"
            >
              [ Return Home ]
            </Link>
          </div>
        </footer>
      </div>
    </main>
  );
}
