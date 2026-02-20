"use client";

import { useRef, useState, useEffect } from "react";

interface FighterHPProps {
  name: string;
  hp: number;
  maxHp?: number;
  imageUrl?: string | null;
  isEliminated?: boolean;
  placement?: number;
  damageDealt?: number;
  isMyBet?: boolean;
}

export default function FighterHP({
  name,
  hp,
  maxHp = 100,
  imageUrl,
  isEliminated = false,
  placement,
  damageDealt,
  isMyBet,
}: FighterHPProps) {
  const hpPercent = Math.max(0, Math.min(100, (hp / maxHp) * 100));

  const prevHpRef = useRef(hp);
  const [showDamageFlash, setShowDamageFlash] = useState(false);

  useEffect(() => {
    if (hp < prevHpRef.current) {
      setShowDamageFlash(true);
      const timer = setTimeout(() => setShowDamageFlash(false), 500);
      prevHpRef.current = hp;
      return () => clearTimeout(timer);
    }
    prevHpRef.current = hp;
  }, [hp]);

  return (
    <div
      className={`flex items-center gap-3 p-2 rounded-sm transition-all duration-700 ${isEliminated
          ? "opacity-40"
          : ""
        } ${isMyBet && !isEliminated ? "ring-1 ring-cyan-500/50 bg-cyan-950/10" : ""} ${showDamageFlash ? "animate-[shake_0.2s_ease-in-out] animate-damage-flash" : ""}`}
    >
      {/* Avatar */}
      <div className="relative flex-shrink-0">
        {imageUrl ? (
          <img
            src={imageUrl}
            alt={name}
            className={`w-8 h-8 rounded-sm object-cover border transition-all duration-700 ${isEliminated ? "border-red-800 grayscale" : isMyBet ? "border-cyan-500" : "border-stone-700"
              }`}
          />
        ) : (
          <div
            className={`w-8 h-8 rounded-sm flex items-center justify-center border ${isEliminated
                ? "border-red-800 bg-stone-900"
                : isMyBet
                  ? "border-cyan-500 bg-stone-800"
                  : "border-stone-700 bg-stone-800"
              }`}
          >
            <span className="text-stone-500 font-mono text-[9px]">BOT</span>
          </div>
        )}
        {placement && placement <= 3 && (
          <span
            className={`absolute -top-1 -left-1 text-[9px] font-mono font-bold px-0.5 rounded-sm ${placement === 1
                ? "bg-amber-500 text-stone-950"
                : placement === 2
                  ? "bg-stone-300 text-stone-950"
                  : "bg-amber-800 text-stone-200"
              }`}
          >
            {placement}
          </span>
        )}
        {isEliminated && (
          <span className="absolute -top-1 -right-1 text-[9px] text-red-500 font-bold">
            X
          </span>
        )}
      </div>

      {/* Name + HP bar */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between mb-0.5">
          <span className="flex items-center gap-1 truncate">
            <span
              className={`font-mono text-xs font-bold truncate ${isEliminated ? "text-stone-600 line-through decoration-red-500" : "text-stone-200"
                }`}
            >
              {name}
            </span>
            {isMyBet && !isEliminated && (
              <span className="font-mono text-[8px] px-1 py-px bg-cyan-900/50 text-cyan-400 border border-cyan-700/40 rounded-sm flex-shrink-0">
                BET
              </span>
            )}
          </span>
          <span
            className={`font-mono text-[10px] ml-2 flex-shrink-0 ${isEliminated ? "text-stone-600" : "text-stone-400"
              }`}
          >
            {hp}/{maxHp}
          </span>
        </div>

        {/* HP Bar */}
        <div className="w-full h-2 bg-stone-800 rounded-sm overflow-hidden">
          <div
            className="h-full shadow-sm rounded-r-sm"
            style={{
              width: `${hpPercent}%`,
              backgroundColor:
                hpPercent > 60 ? 'rgb(34,197,94)'
                  : hpPercent > 30 ? 'rgb(234,179,8)'
                    : 'rgb(239,68,68)',
              transition: 'width 500ms ease-out, background-color 400ms ease-in-out',
            }}
          />
        </div>

        {damageDealt !== undefined && (
          <span className="font-mono text-[9px] text-stone-600 mt-0.5 block">
            DMG: {damageDealt}
          </span>
        )}
      </div>
    </div>
  );
}
