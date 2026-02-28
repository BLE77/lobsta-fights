"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

export default function BottomNav() {
    const [open, setOpen] = useState(false);
    const pathname = usePathname();
    const isRumblePage = pathname?.startsWith("/rumble");

    return (
        <div
            className={`fixed left-0 w-full z-50 flex pointer-events-none ${isRumblePage ? "top-0 justify-end items-start pt-2 pr-4" : "top-0 justify-center items-start pt-2"
                }`}
        >
            {/* Toggle button - always visible */}
            <button
                onClick={() => setOpen(!open)}
                className={`pointer-events-auto absolute bg-stone-900/80 backdrop-blur-xl border border-stone-700/50 rounded-full w-8 h-8 flex items-center justify-center shadow-lg hover:bg-stone-800/80 transition-all z-10 cursor-pointer ${isRumblePage ? "top-2 right-4" : "top-2 left-1/2 -translate-x-1/2"
                    }`}
                style={{ display: open ? 'none' : 'flex' }}
            >
                <span className="text-amber-500 text-sm">☰</span>
            </button>

            <div
                onMouseLeave={() => setOpen(false)}
                className={`pointer-events-auto bg-stone-900/60 backdrop-blur-xl border border-stone-700/50 rounded-2xl px-3 py-2 shadow-[0_10px_40px_rgba(0,0,0,0.8)] flex items-center gap-1 overflow-x-auto max-w-[92vw] touch-pan-x hide-scrollbar transition-transform duration-500 ease-out ${open ? "translate-y-0" : "-translate-y-24"
                    }`}>

                {/* Home */}
                <Link href="/" className="sub-group flex flex-col items-center justify-center h-24 w-[5.25rem] min-w-[5.25rem] rounded-xl hover:bg-stone-800/50 transition-all cursor-pointer relative origin-bottom hover:scale-110 hover:-translate-y-1">
                    <div className="w-14 h-14 flex items-center justify-center mb-1">
                        <img src="/favicon.svg" alt="Home" className="w-12 h-12 object-contain drop-shadow-lg sub-group-hover:drop-shadow-[0_0_10px_rgba(245,158,11,0.5)] transition-all" />
                    </div>
                    <span className="absolute -top-10 scale-0 sub-group-hover:scale-100 transition-transform bg-stone-950/90 text-amber-500 font-mono text-[10px] px-2 py-1 rounded border border-amber-900/50 whitespace-nowrap opacity-0 sub-group-hover:opacity-100">Home</span>
                </Link>

                <style dangerouslySetInnerHTML={{
                    __html: `
          .sub-group:hover span { opacity: 1; transform: scale(1); }
          .sub-group span { transition: all 0.2s; pointer-events: none; }
        `}} />

                <div className="w-px h-16 bg-stone-700/50 mx-1 flex-shrink-0"></div>

                {/* Arena */}
                <Link href="/rumble" className="sub-group flex flex-col items-center justify-center h-24 w-[5.25rem] min-w-[5.25rem] rounded-xl hover:bg-stone-800/50 transition-all cursor-pointer relative origin-bottom hover:scale-110 hover:-translate-y-1">
                    <div className="w-14 h-14 flex items-center justify-center mb-1">
                        <img src="/transparent-cage.png" alt="Arena" className="w-14 h-14 object-contain drop-shadow-lg sub-group-hover:drop-shadow-[0_0_10px_rgba(239,68,68,0.5)] transition-all" />
                    </div>
                    <span className="absolute -top-10 scale-0 sub-group-hover:scale-100 transition-transform bg-stone-950/90 text-red-400 font-mono text-[10px] px-2 py-1 rounded border border-red-900/50 whitespace-nowrap opacity-0 sub-group-hover:opacity-100">Arena</span>
                </Link>

                {/* Build In Public */}
                <Link href="/bip" className="sub-group flex flex-col items-center justify-center h-24 w-[5.25rem] min-w-[5.25rem] rounded-xl hover:bg-stone-800/50 transition-all cursor-pointer relative origin-bottom hover:scale-110 hover:-translate-y-1">
                    <div className="w-14 h-14 flex items-center justify-center mb-1">
                        <img
                            src="/todo-image.png"
                            alt="Dev Log"
                            className="w-12 h-12 object-contain drop-shadow-lg sub-group-hover:drop-shadow-[0_0_10px_rgba(168,162,158,0.5)] transition-all"
                            onError={(e) => {
                                const target = e.target as HTMLImageElement;
                                if (!target.src.endsWith("todo-image.jpg")) {
                                    target.src = "/todo-image.jpg";
                                }
                            }}
                        />
                    </div>
                    <span className="absolute -top-10 scale-0 sub-group-hover:scale-100 transition-transform bg-stone-950/90 text-stone-300 font-mono text-[10px] px-2 py-1 rounded border border-stone-700 whitespace-nowrap opacity-0 sub-group-hover:opacity-100">Dev Log</span>
                </Link>

                {/* Tokenomics */}
                <Link href="/tokenomics" className="sub-group flex flex-col items-center justify-center h-24 w-[5.25rem] min-w-[5.25rem] rounded-xl hover:bg-stone-800/50 transition-all cursor-pointer relative origin-bottom hover:scale-110 hover:-translate-y-1">
                    <div className="w-14 h-14 flex items-center justify-center mb-1">
                        <img
                            src="/ichor-bottle.png"
                            alt="Tokenomics"
                            className="w-12 h-12 object-contain drop-shadow-lg sub-group-hover:drop-shadow-[0_0_15px_rgba(245,158,11,0.6)] transition-all"
                            onError={(e) => {
                                const target = e.target as HTMLImageElement;
                                target.style.display = "none";
                                target.nextElementSibling?.classList.remove("hidden");
                            }}
                        />
                        <div className="hidden w-12 h-12 rounded-full bg-amber-900/30 border border-amber-500/50 flex items-center justify-center group-hover:border-amber-400">
                            <span className="font-fight text-amber-500 text-xl">$</span>
                        </div>
                    </div>
                    <span className="absolute -top-10 scale-0 sub-group-hover:scale-100 transition-transform bg-stone-950/90 text-amber-400 font-mono text-[10px] px-2 py-1 rounded border border-amber-900/50 whitespace-nowrap opacity-0 sub-group-hover:opacity-100">Tokenomics</span>
                </Link>

                {/* Buy ICHOR Pump.fun */}
                <a href="https://pump.fun/coin/F7GyEoy3YJ4nJqK8TmqqV7Q3dpdnM1wHY1j5vdxMpump" target="_blank" rel="noopener noreferrer" className="sub-group flex flex-col items-center justify-center h-24 w-[5.25rem] min-w-[5.25rem] rounded-xl hover:bg-stone-800/50 transition-all cursor-pointer relative origin-bottom hover:scale-110 hover:-translate-y-1">
                    <div className="w-14 h-14 flex items-center justify-center mb-1">
                        <img
                            src="/pill.png"
                            alt="Buy $ICHOR"
                            className="w-12 h-10 object-contain drop-shadow-lg sub-group-hover:drop-shadow-[0_0_15px_rgba(34,197,94,0.6)] transition-all"
                            onError={(e) => {
                                const target = e.target as HTMLImageElement;
                                target.style.display = "none";
                                target.nextElementSibling?.classList.remove("hidden");
                            }}
                        />
                        <div className="hidden w-12 h-12 rounded-full bg-green-900/30 border border-green-500/50 flex items-center justify-center group-hover:border-green-400">
                            <span className="font-fight text-green-500 text-sm">BUY</span>
                        </div>
                    </div>
                    <span className="absolute -top-10 scale-0 sub-group-hover:scale-100 transition-transform bg-stone-950/90 text-green-400 font-mono text-[10px] px-2 py-1 rounded border border-green-900/50 whitespace-nowrap opacity-0 sub-group-hover:opacity-100">Pump.fun</span>
                </a>

            </div>

            {/* Required for hiding scrollbar in overflowing flex container */}
            <style dangerouslySetInnerHTML={{
                __html: `
        .hide-scrollbar::-webkit-scrollbar {
          display: none;
        }
        .hide-scrollbar {
          -ms-overflow-style: none;
          scrollbar-width: none;
        }
      `}} />
        </div>
    );
}
