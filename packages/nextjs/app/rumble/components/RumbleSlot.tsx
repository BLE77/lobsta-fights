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
  state: "idle" | "betting" | "combat" | "payout";
  fighters: SlotFighter[];
  odds: SlotOdds[];
  totalPool: number;
  bettingDeadline: string | null;
  nextTurnAt?: string | null;
  turnIntervalMs?: number | null;
  currentTurn: number;
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
  onPlaceBet?: (slotIndex: number, fighterId: string, amount: number) => void;
  onPlaceBatchBet?: (
    slotIndex: number,
    bets: Array<{ fighterId: string; amount: number }>,
  ) => Promise<void> | void;
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
  // Track when the current turn last changed (client-side anchor for countdown)
  const lastTurnChangeRef = useRef<{ turn: number; at: number }>({ turn: 0, at: Date.now() });

  useEffect(() => {
    const curTurn = slot.currentTurn ?? 0;
    if (curTurn > 0 && curTurn !== lastTurnChangeRef.current.turn) {
      lastTurnChangeRef.current = { turn: curTurn, at: Date.now() };
    }
  }, [slot.currentTurn]);

  useEffect(() => {
    const trackCombat = slot.state === "combat";
    const trackBetting = slot.state === "betting" && !!slot.bettingDeadline;
    if (!trackCombat && !trackBetting) return;
    const timer = setInterval(() => setCountdownNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [slot.state, slot.bettingDeadline]);

  const liveCountdown = (() => {
    if (slot.state === "combat" && slot.nextTurnAt) {
      const targetMs = new Date(slot.nextTurnAt).getTime();
      if (!Number.isFinite(targetMs)) return null;
      return {
        label: "NEXT TURN",
        seconds: Math.max(0, Math.ceil((targetMs - countdownNow) / 1_000)),
      };
    }
    // Fallback: compute countdown from when we last saw the turn number change
    if (slot.state === "combat" && !slot.nextTurnAt && slot.turnIntervalMs) {
      const anchor = lastTurnChangeRef.current;
      const targetMs = anchor.at + slot.turnIntervalMs;
      const remaining = Math.max(0, Math.ceil((targetMs - countdownNow) / 1_000));
      return {
        label: "NEXT TURN",
        seconds: remaining,
      };
    }
    if (slot.state === "betting" && slot.bettingDeadline) {
      // Offset by bet close guard so the countdown matches when betting
      // actually closes for the user (12s before the on-chain deadline).
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

  // Track new eliminations from incoming turns
  useEffect(() => {
    if (slot.state !== "combat" || slot.turns.length === 0) {
      // Reset when not in combat
      if (seenTurnsRef.current !== 0) {
        seenTurnsRef.current = 0;
        setActiveEliminations([]);
      }
      return;
    }

    const newTurns = slot.turns.filter(
      (t) => t.turnNumber > seenTurnsRef.current
    );
    if (newTurns.length === 0) return;

    seenTurnsRef.current = Math.max(
      ...slot.turns.map((t) => t.turnNumber)
    );

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

    // Auto-remove after 3 seconds
    const keys = newEliminations.map((e) => e.key);
    setTimeout(() => {
      setActiveEliminations((prev) =>
        prev.filter((e) => !keys.includes(e.key))
      );
    }, 3000);
  }, [slot.turns, slot.state, slot.fighters, slot.fighterNames]);

  return (
    <div
      className={`${label.bgColor} border ${label.borderColor} rounded-sm backdrop-blur-sm overflow-hidden transition-all`}
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
          <span className="font-mono text-[10px] text-stone-600 truncate max-w-[120px]">
            {slot.rumbleId}
          </span>
        </div>
      </div>

      {/* Content */}
      <div className="p-4">
        {/* IDLE state */}
        {slot.state === "idle" && (
          lastCompletedResult ? (
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
                myBetFighterIds={myBetFighterIds}
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
          )
        )}

        {/* BETTING state */}
        {slot.state === "betting" && (
          <BettingPanel
            slotIndex={slot.slotIndex}
            fighters={slot.odds}
            totalPool={slot.totalPool}
            deadline={slot.bettingDeadline}
            onPlaceBet={onPlaceBet}
            onPlaceBatchBet={onPlaceBatchBet}
            myBetAmounts={myBetAmounts}
          />
        )}

        {/* COMBAT state */}
        {slot.state === "combat" && (
          <div className="space-y-3">
            {/* Alive fighters HP bars */}
            <div className="space-y-0.5">
              <p className="font-mono text-[10px] text-stone-500 uppercase mb-1">
                Fighters ({slot.fighters.filter((f) => f.hp > 0).length} alive)
              </p>
              <div className="grid grid-cols-2 gap-x-2 gap-y-0.5">
                {slot.fighters
                  .sort((a, b) => {
                    // Alive first, then by HP descending
                    if (a.hp > 0 && b.hp <= 0) return -1;
                    if (a.hp <= 0 && b.hp > 0) return 1;
                    return b.hp - a.hp;
                  })
                  .map((f) => (
                    <FighterHP
                      key={f.id}
                      name={f.name}
                      hp={f.hp}
                      maxHp={f.maxHp}
                      imageUrl={f.imageUrl}
                      isEliminated={f.hp <= 0}
                      damageDealt={f.totalDamageDealt}
                      isMyBet={myBetFighterIds?.has(f.id)}
                    />
                  ))}
              </div>
            </div>

            {/* Elimination popups */}
            {activeEliminations.length > 0 && (
              <div className="space-y-2">
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

        {/* PAYOUT state */}
        {slot.state === "payout" && slot.payout && (
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
        )}
      </div>
    </div>
  );
}
