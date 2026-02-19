"use client";

import { useEffect, useRef } from "react";

interface Pairing {
  fighterA: string;
  fighterB: string;
  fighterAName: string;
  fighterBName: string;
  moveA: string;
  moveB: string;
  damageToA: number;
  damageToB: number;
}

interface TurnEvent {
  turnNumber: number;
  pairings: Pairing[];
  eliminations: string[];
  bye?: string;
}

interface CombatFeedProps {
  turns: TurnEvent[];
  currentTurn: number;
  maxTurns: number;
  fighterNames: Record<string, string>;
}

function getMoveLabel(move: string | undefined | null): string {
  const m = typeof move === "string" ? move : "";
  if (m === "HIGH_STRIKE") return "HI-STRIKE";
  if (m === "MID_STRIKE") return "MID-STRIKE";
  if (m === "LOW_STRIKE") return "LO-STRIKE";
  if (m === "GUARD_HIGH") return "GUARD-HI";
  if (m === "GUARD_MID") return "GUARD-MID";
  if (m === "GUARD_LOW") return "GUARD-LO";
  if (m === "DODGE") return "DODGE";
  if (m === "CATCH") return "CATCH";
  if (m === "SPECIAL") return "SPECIAL";
  return m || "???";
}

function getMoveColor(move: string | undefined | null): string {
  const safeMove = typeof move === "string" ? move : "";
  if (safeMove.includes("STRIKE")) return "text-red-400";
  if (safeMove.includes("GUARD")) return "text-blue-400";
  if (safeMove === "DODGE") return "text-green-400";
  if (safeMove === "CATCH") return "text-purple-400";
  if (safeMove === "SPECIAL") return "text-amber-400";
  return "text-stone-500";
}

function isStrike(move: string | undefined | null): boolean {
  return move === "HIGH_STRIKE" || move === "MID_STRIKE" || move === "LOW_STRIKE";
}

function isGuard(move: string | undefined | null): boolean {
  return move === "GUARD_HIGH" || move === "GUARD_MID" || move === "GUARD_LOW";
}

function isMatchingGuard(strike: string | undefined | null, guard: string | undefined | null): boolean {
  return (
    (strike === "HIGH_STRIKE" && guard === "GUARD_HIGH") ||
    (strike === "MID_STRIKE" && guard === "GUARD_MID") ||
    (strike === "LOW_STRIKE" && guard === "GUARD_LOW")
  );
}

function describeDamage(
  dmg: number,
  attackerMove: string,
  defenderMove: string,
): { label: string; className: string } {
  if (dmg > 0) {
    if (dmg >= 20) return { label: `-${dmg}`, className: "text-red-400 font-bold" };
    if (dmg >= 10) return { label: `-${dmg}`, className: "text-orange-400" };
    return { label: `-${dmg}`, className: "text-yellow-400" };
  }

  if ((isStrike(attackerMove) || attackerMove === "SPECIAL") && defenderMove === "DODGE") {
    return { label: "DODGED", className: "text-green-400 font-semibold" };
  }
  if (isStrike(attackerMove) && isGuard(defenderMove) && isMatchingGuard(attackerMove, defenderMove)) {
    return { label: "BLOCKED", className: "text-blue-400 font-semibold" };
  }
  return { label: "MISS", className: "text-stone-600" };
}

export default function CombatFeed({
  turns,
  currentTurn,
  maxTurns,
  fighterNames,
}: CombatFeedProps) {
  const feedRef = useRef<HTMLDivElement>(null);

  // Newest turns first — scroll to top when new turns arrive
  useEffect(() => {
    if (feedRef.current) {
      feedRef.current.scrollTop = 0;
    }
  }, [turns.length]);

  if (turns.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-32 gap-2">
        {currentTurn > 0 ? (
          <>
            <span className="font-mono text-sm text-amber-400 animate-pulse">
              Turn {currentTurn} in progress...
            </span>
            <span className="font-mono text-[10px] text-stone-600">
              On-chain combat active
            </span>
          </>
        ) : (
          <>
            <span className="font-mono text-sm text-amber-500 animate-pulse">
              COMBAT STARTING
            </span>
            <div className="flex gap-1">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="w-1.5 h-1.5 bg-amber-500 rounded-full animate-bounce"
                  style={{ animationDelay: `${i * 150}ms` }}
                />
              ))}
            </div>
            <span className="font-mono text-[10px] text-stone-600">
              Initializing on-chain combat...
            </span>
          </>
        )}
      </div>
    );
  }

  return (
    <div
      ref={feedRef}
      className="space-y-2 max-h-64 overflow-y-auto pr-1 scrollbar-thin"
    >
      {/* Turn header */}
      <div className="sticky top-0 bg-stone-900/95 py-1 border-b border-stone-800 text-center">
        <span className="font-mono text-xs text-amber-500">
          TURN {currentTurn}/{maxTurns}
        </span>
      </div>

      {turns.slice().reverse().map((turn) => (
        <div key={turn.turnNumber} className="space-y-1.5">
          {/* Turn separator */}
          <div className="flex items-center gap-2 mt-1">
            <div className="flex-1 h-px bg-stone-800" />
            <span className="font-mono text-[10px] text-stone-600">
              T{turn.turnNumber}
            </span>
            <div className="flex-1 h-px bg-stone-800" />
          </div>

          {/* Pairings — centered, each on its own line */}
          {turn.pairings.map((p, i) => {
            const aToB = describeDamage(p.damageToB, p.moveA, p.moveB);
            const bToA = describeDamage(p.damageToA, p.moveB, p.moveA);
            return (
              <div
                key={`${turn.turnNumber}-${i}`}
                className="font-mono text-xs text-center py-0.5"
              >
                {/* Fighter A: name + move + damage */}
                <span className="text-stone-300">{p.fighterAName}</span>
                {" "}
                <span className={`${getMoveColor(p.moveA)} text-[10px]`}>
                  {getMoveLabel(p.moveA)}
                </span>
                {" "}
                <span className={`text-[10px] ${aToB.className}`}>
                  {aToB.label}
                </span>

                <span className="text-stone-700 mx-1">|</span>

                {/* Fighter B: damage + move + name */}
                <span className={`text-[10px] ${bToA.className}`}>
                  {bToA.label}
                </span>
                {" "}
                <span className={`${getMoveColor(p.moveB)} text-[10px]`}>
                  {getMoveLabel(p.moveB)}
                </span>
                {" "}
                <span className="text-stone-300">{p.fighterBName}</span>
              </div>
            );
          })}

          {/* Bye */}
          {turn.bye && (
            <div className="font-mono text-[10px] text-stone-600 text-center">
              {fighterNames[turn.bye] || turn.bye} gets a bye
            </div>
          )}

          {/* Eliminations */}
          {turn.eliminations.map((elim) => (
            <div
              key={`elim-${turn.turnNumber}-${elim}`}
              className="font-mono text-xs text-red-500 py-0.5 bg-red-950/30 border-l-2 border-red-600 text-center animate-elimination"
            >
              ELIMINATED: {fighterNames[elim] || elim}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
