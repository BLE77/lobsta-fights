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
  solDeployed?: number;
  isMyBet?: boolean;
  size?: "normal" | "large";
}

interface DamageEvent {
  id: number;
  amount: number;
}

export default function FighterHP({
  name,
  hp,
  maxHp = 100,
  imageUrl,
  isEliminated = false,
  placement,
  damageDealt,
  solDeployed,
  isMyBet,
  size = "normal",
  layout = "horizontal",
}: FighterHPProps & { layout?: "horizontal" | "vertical" }) {
  const hpPercent = Math.max(0, Math.min(100, (hp / maxHp) * 100));

  const prevHpRef = useRef(hp);
  // Track the delayed "catch-up" HP value for the red bar under the green bar
  const [catchUpHp, setCatchUpHp] = useState(hpPercent);
  const [showDamageFlash, setShowDamageFlash] = useState(false);
  const [damageEvents, setDamageEvents] = useState<DamageEvent[]>([]);
  const eventIdCounter = useRef(0);
  const [justEliminated, setJustEliminated] = useState(false);
  const damageRemovalTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Determine if we just got eliminated this render
    if (isEliminated && prevHpRef.current > 0 && hp === 0) {
      setJustEliminated(true);
      // Remove the extreme flash effect after animation completes
      const eliminateTimer = setTimeout(() => {
        setJustEliminated(false);
      }, 800);
      return () => clearTimeout(eliminateTimer);
    }
  }, [hp, isEliminated]);

  useEffect(() => {
    if (hp < prevHpRef.current) {
      const damageTaken = prevHpRef.current - hp;

      // 1) Trigger Shake
      setShowDamageFlash(true);
      const timer = setTimeout(() => setShowDamageFlash(false), 300); // intense-shake is 0.3s

      // 2) Trigger Catch-up HP Bar (delay before red bar drops)
      const catchUpTimer = setTimeout(() => {
        setCatchUpHp(Math.max(0, Math.min(100, (hp / maxHp) * 100)));
      }, 400); // 400ms delay before red starts dropping

      // 3) Push floating damage number
      const newEvent = { id: eventIdCounter.current++, amount: damageTaken };
      setDamageEvents((prev) => [...prev, newEvent]);

      // Clean up floating number after its animation (1.5s)
      damageRemovalTimerRef.current = setTimeout(() => {
        setDamageEvents((prev) => prev.filter((e) => e.id !== newEvent.id));
      }, 1500);

      prevHpRef.current = hp;
      return () => {
        clearTimeout(timer);
        clearTimeout(catchUpTimer);
        if (damageRemovalTimerRef.current) {
          clearTimeout(damageRemovalTimerRef.current);
        }
      };
    } else if (hp > prevHpRef.current) {
      // Healing (unlikely but safe to handle)
      setCatchUpHp(hpPercent);
    }
    prevHpRef.current = hp;
  }, [hp, maxHp, hpPercent]);

  // Determine container classes based on layout
  const containerClasses = layout === "vertical"
    ? `relative flex flex-col items-center justify-center gap-1 sm:gap-2 p-1 sm:p-2 rounded-sm transition-all duration-700`
    : `relative flex items-center gap-3 p-2 rounded-sm transition-all duration-700`;

  // Determine avatar block settings based on layout
  const avatarSizeClasses = layout === "vertical"
    ? "w-14 h-14 sm:w-20 sm:h-20"
    : size === "large" ? "w-12 h-12" : "w-8 h-8";

  return (
    <div
      className={`${containerClasses} ${isEliminated && !justEliminated ? "opacity-40" : ""
        } ${isMyBet && !isEliminated ? "ring-1 ring-cyan-500/50 bg-cyan-950/10" : "bg-stone-900/30"
        } ${showDamageFlash ? "animate-intense-shake bg-red-950/30" : "" // Use new intense shake
        }`}
    >
      {/* Floating Damage Numbers Overlay */}
      <div className="absolute inset-0 pointer-events-none z-50 flex items-center justify-center">
        {damageEvents.map((evt) => (
          <span
            key={evt.id}
            className="absolute font-fight text-red-500 text-lg drop-shadow-[0_2px_2px_rgba(0,0,0,0.8)] animate-float-up"
            style={{
              top: layout === "vertical" ? "0%" : "10%",
              left: layout === "vertical" ? "50%" : "40%",
              transform: layout === "vertical" ? "translateX(-50%)" : "none"
            }}
          >
            -{evt.amount}
          </span>
        ))}
      </div>

      {/* Avatar */}
      <div className={`relative flex-shrink-0 ${justEliminated ? "animate-elimination-death" : ""}`}>
        {imageUrl ? (
          <img
            src={imageUrl}
            alt={name}
            className={`${avatarSizeClasses} rounded-sm object-cover border transition-all duration-700 ${isEliminated || justEliminated ? "border-red-800 grayscale" : isMyBet ? "border-cyan-500" : "border-stone-700"
              }`}
          />
        ) : (
          <div
            className={`${avatarSizeClasses} rounded-sm flex items-center justify-center border ${isEliminated || justEliminated
              ? "border-red-800 bg-stone-900"
              : isMyBet
                ? "border-cyan-500 bg-stone-800"
                : "border-stone-700 bg-stone-800"
              }`}
          >
            <span className="text-stone-500 font-mono text-[9px]">BOT</span>
          </div>
        )}

        {/* Apply glitch overlay when dead/dying */}
        {(isEliminated || justEliminated) && (
          <div className="absolute inset-0 bg-red-900/20 mix-blend-screen pointer-events-none rounded-sm animate-glitch" style={{ opacity: justEliminated ? 0.8 : 0.2 }} />
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
          <span className="absolute -top-1 -right-1 text-[9px] bg-stone-950 rounded-sm px-0.5 text-red-500 font-bold leading-none border border-red-900">
            X
          </span>
        )}
      </div>

      {/* Name + HP bar */}
      <div className={`flex-1 min-w-0 ${layout === "vertical" ? "w-full text-center" : ""}`}>
        <div className={`flex items-center mb-0.5 ${layout === "vertical" ? "justify-center flex-col gap-0.5" : "justify-between"}`}>
          <span className={`flex items-center gap-1 truncate ${layout === "vertical" ? "justify-center w-full" : ""}`}>
            <span
              className={`font-mono ${layout === "vertical" ? "text-[10px] sm:text-sm" : size === "large" ? "text-sm" : "text-xs"} font-bold truncate ${isEliminated ? "text-stone-600 line-through decoration-red-500/50" : "text-stone-200"
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
            className={`font-mono ${layout === "vertical" ? "text-[8px] sm:text-[10px]" : size === "large" ? "text-xs" : "text-[10px]"} ${layout === "vertical" ? "" : "ml-2"} flex-shrink-0 ${isEliminated ? "text-stone-600" : "text-stone-400"
              }`}
          >
            {hp}/{maxHp}
          </span>
        </div>

        {/* HP Bar Container */}
        <div className={`relative w-full h-3 sm:h-4 bg-stone-800 rounded-sm overflow-hidden border border-stone-900 ${layout === "vertical" ? "mt-1" : ""}`}>
          {/* Background Catch-up Red Bar */}
          <div
            className="absolute top-0 left-0 h-full bg-red-500/80 rounded-r-sm shadow-[0_0_8px_rgba(239,68,68,0.5)]"
            style={{
              width: `${catchUpHp}%`,
              transition: 'width 600ms ease-in-out', // Slower transition
            }}
          />
          {/* Main HP Bar (Green/Yellow/Red) */}
          <div
            className="absolute top-0 left-0 h-full shadow-sm rounded-r-sm"
            style={{
              width: `${hpPercent}%`,
              backgroundColor: hpPercent > 60 ? 'rgb(34,197,94)' : hpPercent > 30 ? 'rgb(234,179,8)' : 'rgb(239,68,68)',
              transition: 'width 150ms ease-out, background-color 300ms ease-in-out', // Very fast snap
            }}
          />
          {/* Internal Text Overlay */}
          <div className="absolute inset-0 flex items-center justify-between px-1 sm:px-1.5 pointer-events-none z-10">
            {damageDealt !== undefined ? (
              <span className="font-mono text-[7px] sm:text-[9px] text-stone-100 drop-shadow-[0_1px_1px_rgba(0,0,0,0.8)] font-bold">
                DMG {damageDealt}
              </span>
            ) : <span />}
            {solDeployed !== undefined && solDeployed > 0 && (
              <span className="font-mono text-[7px] sm:text-[9px] text-amber-300 drop-shadow-[0_1px_1px_rgba(0,0,0,0.8)] font-bold">
                {solDeployed.toFixed(2)} SOL
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
