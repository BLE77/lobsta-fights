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
  fighterNames: Record<string, string>;
}

function getMoveIcon(move: string): string {
  if (move.includes("STRIKE")) return ">>>";
  if (move.includes("GUARD")) return "[=]";
  if (move === "DODGE") return "~~~";
  if (move === "CATCH") return "<< ";
  if (move === "SPECIAL") return "***";
  return "???";
}

function getMoveColor(move: string): string {
  if (move.includes("STRIKE")) return "text-red-400";
  if (move.includes("GUARD")) return "text-blue-400";
  if (move === "DODGE") return "text-green-400";
  if (move === "CATCH") return "text-purple-400";
  if (move === "SPECIAL") return "text-amber-400";
  return "text-stone-500";
}

function formatDamage(dmg: number): string {
  if (dmg === 0) return "MISS";
  return `-${dmg}`;
}

function damageColor(dmg: number): string {
  if (dmg === 0) return "text-stone-600";
  if (dmg >= 20) return "text-red-400 font-bold";
  if (dmg >= 10) return "text-orange-400";
  return "text-yellow-400";
}

export default function CombatFeed({
  turns,
  currentTurn,
  fighterNames,
}: CombatFeedProps) {
  const feedRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new turns
  useEffect(() => {
    if (feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [turns.length]);

  if (turns.length === 0) {
    return (
      <div className="flex items-center justify-center h-32">
        <span className="font-mono text-sm text-stone-600 animate-pulse">
          Waiting for combat to begin...
        </span>
      </div>
    );
  }

  return (
    <div
      ref={feedRef}
      className="space-y-2 max-h-64 overflow-y-auto pr-1 scrollbar-thin"
    >
      {/* Turn header */}
      <div className="sticky top-0 bg-stone-900/95 py-1 border-b border-stone-800">
        <span className="font-mono text-xs text-amber-500">
          TURN {currentTurn}/{20}
        </span>
      </div>

      {turns.map((turn) => (
        <div key={turn.turnNumber} className="space-y-1">
          {/* Turn separator */}
          <div className="flex items-center gap-2 mt-1">
            <div className="flex-1 h-px bg-stone-800" />
            <span className="font-mono text-[10px] text-stone-600">
              T{turn.turnNumber}
            </span>
            <div className="flex-1 h-px bg-stone-800" />
          </div>

          {/* Pairings */}
          {turn.pairings.map((p, i) => (
            <div
              key={`${turn.turnNumber}-${i}`}
              className="font-mono text-xs flex items-center gap-1 px-1"
            >
              {/* Fighter A */}
              <span className="text-stone-300 truncate max-w-[80px]">
                {p.fighterAName}
              </span>
              <span className={getMoveColor(p.moveA)}>
                {getMoveIcon(p.moveA)}
              </span>
              <span className={`text-[10px] ${damageColor(p.damageToB)}`}>
                {formatDamage(p.damageToB)}
              </span>

              <span className="text-stone-700 mx-0.5">|</span>

              {/* Fighter B */}
              <span className={`text-[10px] ${damageColor(p.damageToA)}`}>
                {formatDamage(p.damageToA)}
              </span>
              <span className={getMoveColor(p.moveB)}>
                {getMoveIcon(p.moveB)}
              </span>
              <span className="text-stone-300 truncate max-w-[80px]">
                {p.fighterBName}
              </span>
            </div>
          ))}

          {/* Bye */}
          {turn.bye && (
            <div className="font-mono text-[10px] text-stone-600 px-1">
              {fighterNames[turn.bye] || turn.bye} gets a bye
            </div>
          )}

          {/* Eliminations */}
          {turn.eliminations.map((elim) => (
            <div
              key={`elim-${turn.turnNumber}-${elim}`}
              className="font-mono text-xs text-red-500 px-1 py-0.5 bg-red-950/30 border-l-2 border-red-600 animate-elimination"
            >
              ELIMINATED: {fighterNames[elim] || elim}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
