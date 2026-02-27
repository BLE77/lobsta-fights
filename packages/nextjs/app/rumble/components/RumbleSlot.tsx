"use client";

import { useEffect, useRef, useState } from "react";
import BettingPanel from "./BettingPanel";
import CombatFeed from "./CombatFeed";
import EliminationPopup from "./EliminationPopup";
import FighterHP from "./FighterHP";
import PayoutDisplay from "./PayoutDisplay";

// ---------------------------------------------------------------------------
// Types matching the API response shape (from api/rumble/status)
// ---------------------------------------------------------------------------

export interface SlotFighter {
  id: string;
  name: string;
  hp: number;
  maxHp: number;
  imageUrl: string | null;
  meter: number;
  totalDamageDealt: number;
  totalDamageTaken: number;
  eliminatedOnTurn: number | null;
  placement: number;
}

export interface SlotOdds {
  fighterId: string;
  fighterName: string;
  imageUrl: string | null;
  hp: number;
  solDeployed: number;
  betCount: number;
  impliedProbability: number;
  potentialReturn: number;
}

export interface SlotTurn {
  turnNumber: number;
  pairings: Array<{
    fighterA: string;
    fighterB: string;
    fighterAName: string;
    fighterBName: string;
    moveA: string;
    moveB: string;
    damageToA: number;
    damageToB: number;
  }>;
  eliminations: string[];
  bye?: string;
}

export interface SlotPayout {
  winnerBettorsPayout: number;
  placeBettorsPayout: number;
  showBettorsPayout: number;
  treasuryVault: number;
  totalPool: number;
  ichorMined: number;
  ichorShowerTriggered: boolean;
  ichorShowerAmount?: number;
}

export interface SlotData {
  slotIndex: number;
  rumbleId: string;
  rumbleNumber?: number | null;
  state: "idle" | "betting" | "combat" | "payout";
  fighters: SlotFighter[];
  odds: SlotOdds[];
  totalPool: number;
  bettingDeadline: string | null;
  nextTurnAt?: string | null;
  turnIntervalMs?: number | null;
  currentTurn: number;
  maxTurns?: number | null;
  remainingFighters?: number | null;
  turnPhase?: string | null;
  turns: SlotTurn[];
  payout: SlotPayout | null;
  fighterNames: Record<string, string>;
}

function formatCountdown(secondsRemaining: number): string {
  const safe = Math.max(0, Math.floor(secondsRemaining));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface RumbleSlotProps {
  slot: SlotData;
  onPlaceBet?: (slotIndex: number, fighterId: string, amount: number) => Promise<string | undefined> | void;
  onPlaceBatchBet?: (
    slotIndex: number,
    bets: Array<{ fighterId: string; amount: number }>,
  ) => Promise<string | undefined> | void;
  myBetAmounts?: Map<string, number>;
  lastCompletedResult?: {
    rumbleId: string;
    settledAtIso: string;
    placements: Array<{
      fighterId: string;
      fighterName: string;
      imageUrl: string | null;
      placement: number;
      hp: number;
      damageDealt: number;
    }>;
    payout: SlotPayout;
    myBetFighterIds?: string[];
  };
}

function getStateLabel(state: SlotData["state"]): {
  text: string;
  color: string;
  bgColor: string;
  borderColor: string;
} {
  switch (state) {
    case "idle":
      return {
        text: "IDLE",
        color: "text-stone-500",
        bgColor: "bg-stone-900/50",
        borderColor: "border-stone-800",
      };
    case "betting":
      return {
        text: "BETTING",
        color: "text-amber-400",
        bgColor: "bg-amber-900/10",
        borderColor: "border-amber-700/40",
      };
    case "combat":
      return {
        text: "COMBAT",
        color: "text-red-400",
        bgColor: "bg-red-900/10",
        borderColor: "border-red-700/40",
      };
    case "payout":
      return {
        text: "PAYOUT",
        color: "text-green-400",
        bgColor: "bg-green-900/10",
        borderColor: "border-green-700/40",
      };
    default:
      return {
        text: "IDLE",
        color: "text-stone-500",
        bgColor: "bg-stone-900/50",
        borderColor: "border-stone-800",
      };
  }
}

interface ActiveElimination {
  key: string;
  fighterName: string;
  imageUrl: string | null;
  placement: number;
  totalFighters: number;
}

export default function RumbleSlot({
  slot,
  onPlaceBet,
  onPlaceBatchBet,
  myBetAmounts,
  lastCompletedResult,
}: RumbleSlotProps) {
  const label = getStateLabel(slot.state);
  const myBetFighterIds = myBetAmounts ? new Set(myBetAmounts.keys()) : undefined;
  const [activeEliminations, setActiveEliminations] = useState<
    ActiveElimination[]
  >([]);
  const seenTurnsRef = useRef<number>(0);
  const [countdownNow, setCountdownNow] = useState(() => Date.now());
  const lastTurnChangeRef = useRef<{ turn: number; at: number }>({ turn: 0, at: Date.now() });
  const slotAnchorRef = useRef<{ targetSlot: number; currentSlot: number; anchoredAt: number } | null>(null);
  const lastCurrentTurnRef = useRef<number>(0);
  const containerShakeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const turnAnimationsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const eliminationTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Animation triggers
  const [showContainerShake, setShowContainerShake] = useState(false);
  const [turnAnimations, setTurnAnimations] = useState<{ turnNumber: number, pairings: any[] } | null>(null);

  // Hold the final combat turn visible for a few seconds before showing payout
  const FINAL_TURN_HOLD_MS = 5000;
  const [holdingFinalTurn, setHoldingFinalTurn] = useState(false);
  const [heldTurns, setHeldTurns] = useState<SlotTurn[]>([]);
  const [heldFighters, setHeldFighters] = useState<SlotFighter[]>([]);
  const [heldCurrentTurn, setHeldCurrentTurn] = useState(0);
  const prevStateRef = useRef<string>(slot.state);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (prevStateRef.current === "combat" && slot.state === "payout" && slot.turns.length > 0) {
      // Capture the final combat state before switching to payout view
      setHeldTurns(slot.turns);
      setHeldFighters(slot.fighters);
      setHeldCurrentTurn(slot.currentTurn);
      setHoldingFinalTurn(true);
      if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
      holdTimerRef.current = setTimeout(() => {
        setHoldingFinalTurn(false);
        setHeldTurns([]);
        setHeldFighters([]);
      }, FINAL_TURN_HOLD_MS);
    }
    prevStateRef.current = slot.state;
    return () => {
      if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    };
  }, [slot.state]);

  useEffect(() => {
    const curTurn = slot.currentTurn ?? 0;
    if (curTurn > 0 && curTurn !== lastTurnChangeRef.current.turn) {
      lastTurnChangeRef.current = { turn: curTurn, at: Date.now() };

      // Trigger animations for the new turn
      const currentTurnData = slot.turns.find(t => t.turnNumber === curTurn) || slot.turns[slot.turns.length - 1];
      if (currentTurnData) {
        setTurnAnimations({ turnNumber: curTurn, pairings: currentTurnData.pairings });

        // Check for massive damage or eliminations to trigger a slot-wide shake
        let shouldShake = false;
        if (currentTurnData.eliminations && currentTurnData.eliminations.length > 0) {
          shouldShake = true;
        }
        if (currentTurnData.pairings) {
          for (const p of currentTurnData.pairings) {
            if (p.damageToA >= 20 || p.damageToB >= 20) {
              shouldShake = true;
              break;
            }
          }
        }

        if (shouldShake) {
          setShowContainerShake(true);
          if (containerShakeTimeoutRef.current) {
            clearTimeout(containerShakeTimeoutRef.current);
          }
          containerShakeTimeoutRef.current = setTimeout(() => setShowContainerShake(false), 400); // Wait for intense-shake to finish
        }

        // Clear turn animations after 1s so they don't re-play if the component re-renders
        if (turnAnimationsTimeoutRef.current) {
          clearTimeout(turnAnimationsTimeoutRef.current);
        }
        turnAnimationsTimeoutRef.current = setTimeout(() => setTurnAnimations(null), 1000);
      }
    }
    return () => {
      if (containerShakeTimeoutRef.current) {
        clearTimeout(containerShakeTimeoutRef.current);
      }
      setShowContainerShake(false);
      if (turnAnimationsTimeoutRef.current) {
        clearTimeout(turnAnimationsTimeoutRef.current);
      }
      setTurnAnimations(null);
    };
  }, [slot.currentTurn, slot.turns]);

  useEffect(() => {
    return () => {
      eliminationTimeoutsRef.current.forEach(clearTimeout);
      eliminationTimeoutsRef.current.clear();
    };
  }, []);

  // Anchor slot-based timer: when we receive slot data, record when we got it
  useEffect(() => {
    const target = (slot as any).nextTurnTargetSlot as number | null;
    const current = (slot as any).currentSlot as number | null;
    if (target && current && target > current) {
      const turnChanged = slot.currentTurn !== lastCurrentTurnRef.current;
      if (turnChanged || !slotAnchorRef.current || slotAnchorRef.current.targetSlot !== target) {
        slotAnchorRef.current = { targetSlot: target, currentSlot: current, anchoredAt: Date.now() };
        lastCurrentTurnRef.current = slot.currentTurn;
      }
    } else if (!target) {
      slotAnchorRef.current = null;
    }
  }, [(slot as any).nextTurnTargetSlot, (slot as any).currentSlot, slot.currentTurn]);

  useEffect(() => {
    const trackCombat = slot.state === "combat";
    const trackBetting = slot.state === "betting" && !!slot.bettingDeadline;
    if (!trackCombat && !trackBetting) return;
    const timer = setInterval(() => setCountdownNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [slot.state, slot.bettingDeadline]);

  const liveCountdown = (() => {
    if (slot.state === "combat" && slotAnchorRef.current) {
      const { targetSlot, currentSlot, anchoredAt } = slotAnchorRef.current;
      const slotMs = (slot as any).slotMsEstimate ?? 400;
      const totalEtaMs = (targetSlot - currentSlot) * slotMs;
      const elapsed = countdownNow - anchoredAt;
      const remaining = Math.max(0, Math.ceil((totalEtaMs - elapsed) / 1_000));
      return { label: "NEXT TURN", seconds: remaining };
    }
    if (slot.state === "combat" && slot.nextTurnAt) {
      const targetMs = new Date(slot.nextTurnAt).getTime();
      if (!Number.isFinite(targetMs)) return null;
      return {
        label: "NEXT TURN",
        seconds: Math.max(0, Math.ceil((targetMs - countdownNow) / 1_000)),
      };
    }
    if (slot.state === "combat" && slot.turnIntervalMs) {
      const anchor = lastTurnChangeRef.current;
      const targetMs = anchor.at + slot.turnIntervalMs;
      const remaining = Math.max(0, Math.ceil((targetMs - countdownNow) / 1_000));
      return {
        label: "NEXT TURN",
        seconds: remaining,
      };
    }
    if (slot.state === "betting" && slot.bettingDeadline) {
      const BET_CLOSE_GUARD_MS = 12_000;
      const targetMs = new Date(slot.bettingDeadline).getTime() - BET_CLOSE_GUARD_MS;
      if (!Number.isFinite(targetMs)) return null;
      return {
        label: "FIRST TURN",
        seconds: Math.max(0, Math.ceil((targetMs - countdownNow) / 1_000)),
      };
    }
    return null;
  })();

  const nextTurnCountdownSeconds = liveCountdown?.seconds ?? null;

  useEffect(() => {
    if (slot.state !== "combat" || slot.turns.length === 0) {
      if (seenTurnsRef.current !== 0) {
        seenTurnsRef.current = 0;
        setActiveEliminations([]);
      }
      eliminationTimeoutsRef.current.forEach(clearTimeout);
      eliminationTimeoutsRef.current.clear();
      return;
    }

    const newTurns = slot.turns.filter(
      (t) => t.turnNumber > seenTurnsRef.current
    );
    if (newTurns.length === 0) return;

    const isInitialMount = seenTurnsRef.current === 0;

    seenTurnsRef.current = Math.max(
      ...slot.turns.map((t) => t.turnNumber)
    );

    // If this is the first time observing turns and there's already history,
    // skip replaying old eliminations to prevent them getting stuck on screen
    if (isInitialMount && slot.turns.length > 1) {
      return;
    }

    const fighterMap = new Map(slot.fighters.map((f) => [f.id, f]));
    const newEliminations: ActiveElimination[] = [];

    for (const turn of newTurns) {
      for (const elimId of turn.eliminations) {
        const fighter = fighterMap.get(elimId);
        const key = `${turn.turnNumber}-${elimId}`;
        newEliminations.push({
          key,
          fighterName:
            fighter?.name || slot.fighterNames[elimId] || elimId,
          imageUrl: fighter?.imageUrl ?? null,
          placement: fighter?.placement || slot.fighters.length,
          totalFighters: slot.fighters.length,
        });
      }
    }

    if (newEliminations.length === 0) return;

    setActiveEliminations((prev) => [...prev, ...newEliminations]);

    for (const elim of newEliminations) {
      const existing = eliminationTimeoutsRef.current.get(elim.key);
      if (existing) {
        clearTimeout(existing);
      }
      const timeout = setTimeout(() => {
        setActiveEliminations((prev) =>
          prev.filter((e) => e.key !== elim.key)
        );
        eliminationTimeoutsRef.current.delete(elim.key);
      }, 3000);
      eliminationTimeoutsRef.current.set(elim.key, timeout);
    }
  }, [slot.turns, slot.state, slot.fighters, slot.fighterNames]);

  return (
    <div
      className={`${label.bgColor} border ${label.borderColor} rounded-sm backdrop-blur-sm overflow-hidden transition-all ${showContainerShake ? "animate-intense-shake" : ""
        }`}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-stone-800/50 bg-stone-950/50">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-stone-600">
            SLOT {slot.slotIndex + 1}
          </span>
          <span className={`font-mono text-xs font-bold ${label.color}`}>
            [{label.text}]
          </span>
        </div>
        <div className="flex items-center gap-3">
          {liveCountdown && nextTurnCountdownSeconds !== null && (
            <span className="font-mono text-[10px] text-amber-300 whitespace-nowrap">
              {liveCountdown.label} {formatCountdown(nextTurnCountdownSeconds)}
            </span>
          )}
          {slot.rumbleNumber ? (
            <span className="font-mono text-[10px] text-amber-500/70 font-bold">
              RUMBLE #{slot.rumbleNumber}
            </span>
          ) : (
            <span className="font-mono text-[10px] text-stone-600 truncate max-w-[120px]">
              {slot.rumbleId}
            </span>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="p-4">
        {/* IDLE state */}
        {slot.state === "idle" && (
          <div className="animate-fade-in-up">
            {lastCompletedResult ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between text-[10px] font-mono uppercase">
                  <span className="text-stone-500">Last Rumble Result</span>
                  <span className="text-stone-600">
                    Waiting for next fighters
                  </span>
                </div>
                <PayoutDisplay
                  placements={lastCompletedResult.placements}
                  payout={lastCompletedResult.payout}
                  myBetFighterIds={lastCompletedResult.myBetFighterIds?.length
                    ? new Set(lastCompletedResult.myBetFighterIds)
                    : myBetFighterIds}
                />
              </div>
            ) : (
              <div className="flex items-center justify-center h-32">
                <div className="text-center">
                  <p className="font-mono text-sm text-stone-600">
                    Waiting for fighters...
                  </p>
                  <p className="font-mono text-[10px] text-stone-700 mt-1">
                    Rumble starts when queue fills
                  </p>
                </div>
              </div>
            )}
          </div>
        )}

        {/* BETTING state */}
        {slot.state === "betting" && (
          <div className="animate-fade-in-up">
            <BettingPanel
              slotIndex={slot.slotIndex}
              fighters={slot.odds}
              totalPool={slot.totalPool}
              deadline={slot.bettingDeadline}
              onPlaceBet={onPlaceBet}
              onPlaceBatchBet={onPlaceBatchBet}
              myBetAmounts={myBetAmounts}
            />
          </div>
        )}

        {/* COMBAT state */}
        {slot.state === "combat" && (
          <div className="animate-fade-in-up space-y-3">
            {/* Alive fighters HP bars + elimination overlays */}
            <div className="relative">
              <div className="space-y-4">
                {(() => {
                  const oddsMap = new Map(slot.odds.map(o => [o.fighterId, o.solDeployed]));
                  const currentTurnData = slot.turns.find(t => t.turnNumber === slot.currentTurn) || slot.turns[slot.turns.length - 1];
                  const hasPairings = currentTurnData && Array.isArray(currentTurnData.pairings) && currentTurnData.pairings.length > 0;

                  if (!hasPairings) {
                    return (
                      <div className="space-y-0.5">
                        <p className="font-mono text-[10px] text-stone-500 uppercase mb-1">
                          Deploying Fighters...
                        </p>
                        <div className="grid grid-cols-2 gap-x-2 gap-y-0.5">
                          {slot.fighters.map((f) => (
                            <FighterHP
                              key={f.id}
                              name={f.name}
                              hp={f.hp}
                              maxHp={f.maxHp}
                              imageUrl={f.imageUrl}
                              isEliminated={f.eliminatedOnTurn != null}
                              damageDealt={f.totalDamageDealt}
                              solDeployed={oddsMap.get(f.id)}
                              isMyBet={myBetFighterIds?.has(f.id)}
                            />
                          ))}
                        </div>
                      </div>
                    );
                  }

                  const activeFighterIds = new Set<string>();
                  currentTurnData.pairings.forEach(p => {
                    activeFighterIds.add(p.fighterA);
                    activeFighterIds.add(p.fighterB);
                  });

                  const fighterMap = new Map(slot.fighters.map(f => [f.id, f]));
                  const bench = slot.fighters.filter(f => !activeFighterIds.has(f.id));

                  return (
                    <div className="space-y-4">
                      <div className="flex items-center justify-between">
                        <p className="font-mono text-xs font-bold text-amber-500 uppercase">
                          Live Matchups // Turn {currentTurnData.turnNumber}
                        </p>
                        <p className="font-mono text-[10px] text-stone-500 uppercase">
                          ({slot.remainingFighters ?? slot.fighters.filter((f) => f.eliminatedOnTurn === null || f.eliminatedOnTurn === undefined).length} alive)
                        </p>
                      </div>

                      {/* Face-Off Rows */}
                      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 overflow-hidden">
                        {currentTurnData.pairings.map((p, idx) => {
                          const fA = fighterMap.get(p.fighterA);
                          const fB = fighterMap.get(p.fighterB);
                          if (!fA || !fB) return null;

                          // Determine clash animations based on turn active state
                          let aClass = "";
                          let bClass = "";
                          let vsColorClass = "";

                          if (turnAnimations && turnAnimations.turnNumber === currentTurnData.turnNumber) {
                            const aStrikes = ["HIGH_STRIKE", "MID_STRIKE", "LOW_STRIKE", "SPECIAL"].includes(p.moveA);
                            const bStrikes = ["HIGH_STRIKE", "MID_STRIKE", "LOW_STRIKE", "SPECIAL"].includes(p.moveB);

                            if (aStrikes && !bStrikes) {
                              aClass = "animate-clash-lunge";
                              bClass = "animate-clash-recoil";
                            } else if (bStrikes && !aStrikes) {
                              aClass = "animate-clash-recoil-reverse";
                              bClass = "animate-clash-lunge-reverse";
                            } else if (aStrikes && bStrikes) {
                              aClass = "animate-clash-lunge";
                              bClass = "animate-clash-lunge-reverse";
                            }

                            if (p.damageToA >= 10 || p.damageToB >= 10) vsColorClass = "animate-clash-flash-red";
                            else if (p.moveA === "DODGE" || p.moveB === "DODGE") vsColorClass = "animate-clash-flash-green";
                            else if (p.moveA?.startsWith("GUARD") || p.moveB?.startsWith("GUARD")) vsColorClass = "animate-clash-flash-blue";
                          }

                          const isLastOdd = currentTurnData.pairings.length % 2 !== 0 && idx === currentTurnData.pairings.length - 1;
                          const gridSpanClass = isLastOdd ? "xl:col-span-2 xl:w-[calc(50%-0.5rem)] xl:mx-auto" : "";

                          return (
                            <div key={`pairing-${idx}`} className={`flex items-center justify-between bg-stone-900/40 p-2 sm:p-4 rounded-sm border border-stone-800 relative z-10 w-full h-full ${gridSpanClass}`}>
                              {/* Fighter A (Left aligned taking up 40%) */}
                              <div className={`flex flex-col items-center w-[40%] ${aClass}`}>
                                <FighterHP
                                  name={fA.name}
                                  hp={fA.hp}
                                  maxHp={fA.maxHp}
                                  imageUrl={fA.imageUrl}
                                  isEliminated={fA.eliminatedOnTurn != null}
                                  damageDealt={fA.totalDamageDealt}
                                  solDeployed={oddsMap.get(fA.id)}
                                  isMyBet={myBetFighterIds?.has(fA.id)}
                                  layout="vertical"
                                />
                              </div>

                              {/* VS Badge (Centered taking up 20%) */}
                              <div className="flex flex-col items-center justify-center w-[20%] relative z-20">
                                <span className={`font-fight text-2xl md:text-3xl text-amber-500 opacity-60 ${vsColorClass}`}>VS</span>
                              </div>

                              {/* Fighter B (Right aligned taking up 40%) */}
                              <div className={`flex flex-col items-center w-[40%] ${bClass}`}>
                                <FighterHP
                                  name={fB.name}
                                  hp={fB.hp}
                                  maxHp={fB.maxHp}
                                  imageUrl={fB.imageUrl}
                                  isEliminated={fB.eliminatedOnTurn != null}
                                  damageDealt={fB.totalDamageDealt}
                                  solDeployed={oddsMap.get(fB.id)}
                                  isMyBet={myBetFighterIds?.has(fB.id)}
                                  layout="vertical"
                                />
                              </div>
                            </div>
                          );
                        })}
                      </div>

                      {/* The Bench / Graveyard */}
                      {bench.length > 0 && (
                        <div className="pt-2 border-t border-stone-800/50">
                          <p className="font-mono text-[10px] text-stone-600 uppercase mb-2">Bench / Graveyard</p>
                          <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 opacity-75">
                            {bench
                              .sort((a, b) => {
                                const aElim = a.eliminatedOnTurn != null;
                                const bElim = b.eliminatedOnTurn != null;
                                if (!aElim && bElim) return -1;
                                if (aElim && !bElim) return 1;
                                return 0;
                              })
                              .map((f) => (
                                <FighterHP
                                  key={f.id}
                                  name={f.name}
                                  hp={f.hp}
                                  maxHp={f.maxHp}
                                  imageUrl={f.imageUrl}
                                  isEliminated={f.eliminatedOnTurn != null}
                                  damageDealt={f.totalDamageDealt}
                                  solDeployed={oddsMap.get(f.id)}
                                  isMyBet={myBetFighterIds?.has(f.id)}
                                />
                              ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>

              {/* Elimination popups (overlay) */}
              {activeEliminations.length > 0 && (
                <div className="absolute top-4 right-4 z-50 pointer-events-none space-y-2 w-64">
                  {activeEliminations.map((elim) => (
                    <EliminationPopup
                      key={elim.key}
                      fighterName={elim.fighterName}
                      imageUrl={elim.imageUrl}
                      placement={elim.placement}
                      totalFighters={elim.totalFighters}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* Turn feed */}
            <div className="border-t border-stone-800 pt-2">
              <CombatFeed
                turns={slot.turns}
                currentTurn={slot.currentTurn}
                fighterNames={slot.fighterNames}
              />
            </div>
          </div>
        )}

        {/* PAYOUT state — hold final turn visible before showing results */}
        {slot.state === "payout" && holdingFinalTurn && heldTurns.length > 0 && (
          <div className="animate-fade-in-up space-y-3">
            {/* Final combat matchups */}
            {(() => {
              const finalTurn = heldTurns[heldTurns.length - 1];
              if (!finalTurn || !finalTurn.pairings?.length) return null;
              const fighterMap = new Map(heldFighters.map(f => [f.id, f]));
              const oddsMap = new Map(slot.odds.map(o => [o.fighterId, o.solDeployed]));
              return (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <p className="font-mono text-xs font-bold text-red-500 uppercase animate-pulse">
                      Final Blow // Turn {finalTurn.turnNumber}
                    </p>
                  </div>
                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 overflow-hidden">
                    {finalTurn.pairings.map((p, idx) => {
                      const fA = fighterMap.get(p.fighterA);
                      const fB = fighterMap.get(p.fighterB);
                      if (!fA || !fB) return null;
                      const isLastOdd = finalTurn.pairings.length % 2 !== 0 && idx === finalTurn.pairings.length - 1;
                      const gridSpanClass = isLastOdd ? "xl:col-span-2 xl:w-[calc(50%-0.5rem)] xl:mx-auto" : "";
                      return (
                        <div key={`final-pairing-${idx}`} className={`flex items-center justify-between bg-stone-900/40 p-2 sm:p-4 rounded-sm border border-red-800/60 relative z-10 w-full h-full ${gridSpanClass}`}>
                          <div className="flex flex-col items-center w-[40%]">
                            <FighterHP
                              name={fA.name}
                              hp={fA.hp}
                              maxHp={fA.maxHp}
                              imageUrl={fA.imageUrl}
                              isEliminated={fA.eliminatedOnTurn != null}
                              damageDealt={fA.totalDamageDealt}
                              solDeployed={oddsMap.get(fA.id)}
                              isMyBet={myBetFighterIds?.has(fA.id)}
                              layout="vertical"
                            />
                          </div>
                          <div className="flex flex-col items-center justify-center w-[20%] relative z-20">
                            <span className="font-fight text-2xl md:text-3xl text-red-500 opacity-80">VS</span>
                          </div>
                          <div className="flex flex-col items-center w-[40%]">
                            <FighterHP
                              name={fB.name}
                              hp={fB.hp}
                              maxHp={fB.maxHp}
                              imageUrl={fB.imageUrl}
                              isEliminated={fB.eliminatedOnTurn != null}
                              damageDealt={fB.totalDamageDealt}
                              solDeployed={oddsMap.get(fB.id)}
                              isMyBet={myBetFighterIds?.has(fB.id)}
                              layout="vertical"
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}
            {/* Turn feed showing the killing blow */}
            <div className="border-t border-stone-800 pt-2">
              <CombatFeed
                turns={heldTurns}
                currentTurn={heldCurrentTurn}
                fighterNames={slot.fighterNames}
              />
            </div>
          </div>
        )}
        {slot.state === "payout" && !holdingFinalTurn && slot.payout && (
          <div className="animate-fade-in-up">
            <PayoutDisplay
              placements={slot.fighters
                .filter((f) => f.placement > 0)
                .sort((a, b) => a.placement - b.placement)
                .map((f) => ({
                  fighterId: f.id,
                  fighterName: f.name,
                  imageUrl: f.imageUrl,
                  placement: f.placement,
                  hp: f.hp,
                  damageDealt: f.totalDamageDealt,
                }))}
              payout={slot.payout}
              myBetFighterIds={myBetFighterIds}
            />
          </div>
        )}
      </div>
    </div>
  );
}
