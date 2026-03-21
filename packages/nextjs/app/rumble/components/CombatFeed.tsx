"use client";

import { useEffect, useMemo, useRef } from "react";

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
  compact?: boolean;
}

function isOpaqueFighterToken(value: string | undefined | null): boolean {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return false;
  return (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw) ||
    /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(raw)
  );
}

function formatFallbackFighterLabel(value: string | undefined | null): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return "UNKNOWN FIGHTER";
  if (isOpaqueFighterToken(raw)) return "UNKNOWN FIGHTER";
  return raw;
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

function renderDamageBadge(dmg: number, compact: boolean) {
  return (
    <span className={`${compact ? "text-[9px]" : "text-[10px]"} text-red-400 font-bold`}>
      -{dmg}
    </span>
  );
}

function isCounterOutcome(
  dmgTaken: number,
  strikerMove: string,
  defenderMove: string,
): boolean {
  return dmgTaken > 0 && isStrike(strikerMove) && isMatchingGuard(strikerMove, defenderMove);
}

function isCatchPunish(
  dmgTaken: number,
  attackerMove: string,
  defenderMove: string,
): boolean {
  return dmgTaken > 0 && attackerMove === "CATCH" && defenderMove === "DODGE";
}

function renderOutcomeSummary(
  pairing: Pairing,
  fighterAName: string,
  fighterBName: string,
  compact: boolean,
) {
  const damageToA = Math.max(0, Number(pairing.damageToA ?? 0));
  const damageToB = Math.max(0, Number(pairing.damageToB ?? 0));
  const textSize = compact ? "text-[9px]" : "text-[10px]";

  if (damageToA > 0 && damageToB > 0) {
    return (
      <>
        <span className="text-amber-400 font-semibold">Trade hits.</span>{" "}
        <span className="text-stone-300">{fighterAName}</span>{" "}
        {renderDamageBadge(damageToA, compact)}
        <span className="text-stone-600">, </span>
        <span className="text-stone-300">{fighterBName}</span>{" "}
        {renderDamageBadge(damageToB, compact)}
      </>
    );
  }

  if (isCounterOutcome(damageToA, pairing.moveA, pairing.moveB)) {
    return (
      <>
        <span className="text-blue-400 font-semibold">{fighterBName} blocks and counters.</span>{" "}
        <span className="text-stone-300">{fighterAName}</span>{" "}
        {renderDamageBadge(damageToA, compact)}
      </>
    );
  }

  if (isCounterOutcome(damageToB, pairing.moveB, pairing.moveA)) {
    return (
      <>
        <span className="text-blue-400 font-semibold">{fighterAName} blocks and counters.</span>{" "}
        <span className="text-stone-300">{fighterBName}</span>{" "}
        {renderDamageBadge(damageToB, compact)}
      </>
    );
  }

  if (isCatchPunish(damageToA, pairing.moveB, pairing.moveA)) {
    return (
      <>
        <span className="text-purple-400 font-semibold">{fighterBName} catches the dodge.</span>{" "}
        <span className="text-stone-300">{fighterAName}</span>{" "}
        {renderDamageBadge(damageToA, compact)}
      </>
    );
  }

  if (isCatchPunish(damageToB, pairing.moveA, pairing.moveB)) {
    return (
      <>
        <span className="text-purple-400 font-semibold">{fighterAName} catches the dodge.</span>{" "}
        <span className="text-stone-300">{fighterBName}</span>{" "}
        {renderDamageBadge(damageToB, compact)}
      </>
    );
  }

  if (damageToA > 0) {
    return (
      <>
        <span className={`${getMoveColor(pairing.moveB)} font-semibold`}>
          {fighterBName} lands {getMoveLabel(pairing.moveB)}.
        </span>{" "}
        <span className="text-stone-300">{fighterAName}</span>{" "}
        {renderDamageBadge(damageToA, compact)}
      </>
    );
  }

  if (damageToB > 0) {
    return (
      <>
        <span className={`${getMoveColor(pairing.moveA)} font-semibold`}>
          {fighterAName} lands {getMoveLabel(pairing.moveA)}.
        </span>{" "}
        <span className="text-stone-300">{fighterBName}</span>{" "}
        {renderDamageBadge(damageToB, compact)}
      </>
    );
  }

  if (pairing.moveA === "DODGE" && pairing.moveB === "DODGE") {
    return <span className="text-green-400 font-semibold">Both evade. No damage.</span>;
  }

  if ((isStrike(pairing.moveA) || pairing.moveA === "SPECIAL") && pairing.moveB === "DODGE") {
    return <span className="text-green-400 font-semibold">{fighterBName} dodges clean. No damage.</span>;
  }

  if ((isStrike(pairing.moveB) || pairing.moveB === "SPECIAL") && pairing.moveA === "DODGE") {
    return <span className="text-green-400 font-semibold">{fighterAName} dodges clean. No damage.</span>;
  }

  if (isGuard(pairing.moveA) && isGuard(pairing.moveB)) {
    return <span className="text-blue-400 font-semibold">Both defend. No damage.</span>;
  }

  return <span className={`${textSize} text-stone-500`}>No contact. No damage.</span>;
}

export default function CombatFeed({
  turns,
  currentTurn,
  fighterNames,
  compact = false,
}: CombatFeedProps) {
  const feedRef = useRef<HTMLDivElement>(null);
  const latestResolvedTurnNumber = turns.length > 0 ? turns[turns.length - 1].turnNumber : 0;
  const showingPendingTurn = currentTurn > latestResolvedTurnNumber;
  const fighterNameLookup = useMemo(() => {
    const lookup = new Map<string, string>();
    for (const [fighterId, fighterName] of Object.entries(fighterNames)) {
      const id = String(fighterId ?? "").trim();
      const name = String(fighterName ?? "").trim();
      if (!id || !name || isOpaqueFighterToken(name)) continue;
      lookup.set(id, name);
      lookup.set(id.toLowerCase(), name);
    }
    for (const turn of turns) {
      for (const pairing of turn.pairings) {
        const candidates: Array<[string, string]> = [
          [pairing.fighterA, pairing.fighterAName],
          [pairing.fighterB, pairing.fighterBName],
        ];
        for (const [fighterId, fighterName] of candidates) {
          const id = String(fighterId ?? "").trim();
          const name = String(fighterName ?? "").trim();
          if (!id || !name || isOpaqueFighterToken(name)) continue;
          lookup.set(id, name);
          lookup.set(id.toLowerCase(), name);
        }
      }
    }
    return lookup;
  }, [fighterNames, turns]);

  const resolveFighterLabel = (fighterId: string | undefined, fallbackName?: string): string => {
    const id = String(fighterId ?? "").trim();
    const fallback = String(fallbackName ?? "").trim();
    const fromLookup = fighterNameLookup.get(id) || fighterNameLookup.get(id.toLowerCase());
    if (fromLookup) return fromLookup;
    if (fallback && !isOpaqueFighterToken(fallback)) return fallback;
    return formatFallbackFighterLabel(id || fallback);
  };

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
                  className="w-1.5 h-1.5 bg-amber-500 rounded-sm animate-bounce"
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
      className={
        compact
          ? "space-y-1.5 pr-0"
          : "space-y-2 max-h-64 overflow-y-auto pr-1 scrollbar-thin relative pb-4"
      }
      style={{ maskImage: "linear-gradient(to bottom, black 85%, transparent)", WebkitMaskImage: "linear-gradient(to bottom, black 85%, transparent)" }}
    >
      {!compact && (
        <div className="sticky top-0 bg-stone-900/95 py-1 border-b border-stone-800 text-center">
          <div className="flex flex-col items-center gap-0.5">
            <span className="font-mono text-xs text-amber-500">
              TURN {currentTurn}
            </span>
            {showingPendingTurn && (
              <span className="font-mono text-[9px] text-stone-500 uppercase">
                resolving on-chain
              </span>
            )}
          </div>
        </div>
      )}

      {turns.slice().reverse().map((turn) => (
        <div key={turn.turnNumber} className="space-y-1.5">
          {(() => {
            const involvedFighters = new Set<string>();
            for (const pairing of turn.pairings) {
              involvedFighters.add(pairing.fighterA);
              involvedFighters.add(pairing.fighterB);
            }
            if (turn.bye) involvedFighters.add(turn.bye);

            return (
              <>
          {/* Turn separator */}
          {compact ? (
            <div className="font-mono text-[10px] text-stone-500 uppercase">
              Turn {turn.turnNumber}
            </div>
          ) : (
            <div className="flex items-center gap-2 mt-1">
              <div className="flex-1 h-px bg-stone-800" />
              <span className="font-mono text-[10px] text-stone-600">
                T{turn.turnNumber}
              </span>
              <div className="flex-1 h-px bg-stone-800" />
            </div>
          )}

          {/* Pairings — centered, each on its own line */}
          {turn.pairings.map((p, i) => {
            const fighterAName = resolveFighterLabel(p.fighterA, p.fighterAName);
            const fighterBName = resolveFighterLabel(p.fighterB, p.fighterBName);
            return (
              <div
                key={`${turn.turnNumber}-${i}`}
                className={`font-mono text-center py-1 ${compact ? "text-[11px]" : "text-xs"}`}
              >
                <div className={`${compact ? "text-[10px]" : "text-[11px]"} text-stone-300`}>
                  <span className="text-stone-200">{fighterAName}</span>{" "}
                  <span className={`${getMoveColor(p.moveA)} ${compact ? "text-[9px]" : "text-[10px]"}`}>
                    [{getMoveLabel(p.moveA)}]
                  </span>
                  <span className="text-stone-700 mx-2">vs</span>
                  <span className="text-stone-200">{fighterBName}</span>{" "}
                  <span className={`${getMoveColor(p.moveB)} ${compact ? "text-[9px]" : "text-[10px]"}`}>
                    [{getMoveLabel(p.moveB)}]
                  </span>
                </div>
                <div className={`${compact ? "text-[9px]" : "text-[10px]"} mt-0.5`}>
                  {renderOutcomeSummary(p, fighterAName, fighterBName, compact)}
                </div>
              </div>
            );
          })}

          {/* Bye */}
          {turn.bye && (
            <div className={`font-mono text-stone-600 text-center ${compact ? "text-[9px]" : "text-[10px]"}`}>
              {resolveFighterLabel(turn.bye)} gets a bye
            </div>
          )}

          {/* Eliminations */}
          {turn.eliminations.map((elim) => (
            <div
              key={`elim-${turn.turnNumber}-${elim}`}
              className={`font-mono text-red-500 py-0.5 bg-red-950/30 border-l-2 border-red-600 text-center animate-elimination ${compact ? "text-[10px]" : "text-xs"}`}
            >
              {involvedFighters.has(elim) ? "ELIMINATED" : "ALSO ELIMINATED THIS TURN"}: {resolveFighterLabel(elim)}
            </div>
          ))}
              </>
            );
          })()}
        </div>
      ))}
    </div>
  );
}
