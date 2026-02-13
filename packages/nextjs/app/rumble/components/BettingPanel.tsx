"use client";

import { useEffect, useState } from "react";
import FighterHP from "./FighterHP";

interface FighterOdds {
  fighterId: string;
  fighterName: string;
  imageUrl?: string | null;
  hp: number;
  solDeployed: number;
  betCount: number;
  impliedProbability: number;
  potentialReturn: number;
}

interface BettingPanelProps {
  slotIndex: number;
  fighters: FighterOdds[];
  totalPool: number;
  deadline: string | null;
  onPlaceBet?: (slotIndex: number, fighterId: string, amount: number) => void;
}

export default function BettingPanel({
  slotIndex,
  fighters,
  totalPool,
  deadline,
  onPlaceBet,
}: BettingPanelProps) {
  // Map of fighterId -> bet amount (allows betting on multiple fighters)
  const [bets, setBets] = useState<Map<string, string>>(new Map());
  const [timeLeft, setTimeLeft] = useState("");
  const [deploying, setDeploying] = useState<Set<string>>(new Set());

  // Countdown timer
  useEffect(() => {
    if (!deadline) return;
    const update = () => {
      const now = Date.now();
      const end = new Date(deadline).getTime();
      const diff = Math.max(0, end - now);
      const secs = Math.floor(diff / 1000);
      const mins = Math.floor(secs / 60);
      const remaining = secs % 60;
      setTimeLeft(
        diff <= 0
          ? "CLOSED"
          : `${mins}:${remaining.toString().padStart(2, "0")}`
      );
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [deadline]);

  const toggleFighter = (fighterId: string) => {
    setBets((prev) => {
      const next = new Map(prev);
      if (next.has(fighterId)) {
        next.delete(fighterId);
      } else {
        next.set(fighterId, "0.05");
      }
      return next;
    });
  };

  const updateAmount = (fighterId: string, amount: string) => {
    setBets((prev) => {
      const next = new Map(prev);
      next.set(fighterId, amount);
      return next;
    });
  };

  const handleDeploySingle = async (fighterId: string) => {
    const amountStr = bets.get(fighterId);
    if (!amountStr || !onPlaceBet) return;
    const amount = parseFloat(amountStr);
    if (isNaN(amount) || amount <= 0) return;

    setDeploying((prev) => new Set(prev).add(fighterId));
    try {
      await onPlaceBet(slotIndex, fighterId, amount);
      // Remove from bets after successful deploy
      setBets((prev) => {
        const next = new Map(prev);
        next.delete(fighterId);
        return next;
      });
    } finally {
      setDeploying((prev) => {
        const next = new Set(prev);
        next.delete(fighterId);
        return next;
      });
    }
  };

  const handleDeployAll = async () => {
    if (!onPlaceBet || bets.size === 0) return;
    // Deploy each bet sequentially (each needs a separate tx)
    const entries = [...bets.entries()];
    for (const [fighterId, amountStr] of entries) {
      const amount = parseFloat(amountStr);
      if (isNaN(amount) || amount <= 0) continue;
      setDeploying((prev) => new Set(prev).add(fighterId));
      try {
        await onPlaceBet(slotIndex, fighterId, amount);
        setBets((prev) => {
          const next = new Map(prev);
          next.delete(fighterId);
          return next;
        });
      } catch {
        // Stop on first failure
        break;
      } finally {
        setDeploying((prev) => {
          const next = new Set(prev);
          next.delete(fighterId);
          return next;
        });
      }
    }
  };

  const totalBetAmount = [...bets.values()].reduce(
    (sum, v) => sum + (parseFloat(v) || 0),
    0
  );

  const isClosed = timeLeft === "CLOSED";

  return (
    <div className="space-y-3">
      {/* Timer + Pool */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
          </span>
          <span className="font-mono text-xs text-amber-400 uppercase">
            Betting Open
          </span>
        </div>
        <span
          className={`font-mono text-sm font-bold ${
            isClosed ? "text-red-500" : "text-amber-400"
          }`}
        >
          {timeLeft || "--:--"}
        </span>
      </div>

      {/* Total Pool */}
      <div className="bg-stone-950/80 border border-amber-700/30 rounded-sm p-2 text-center">
        <span className="font-mono text-xs text-stone-500">TOTAL POOL</span>
        <p className="font-mono text-lg font-bold text-amber-400">
          {(totalPool ?? 0).toFixed(2)} SOL
        </p>
      </div>

      {/* Fighter Odds List — click to toggle selection */}
      <div className="space-y-1 max-h-80 overflow-y-auto">
        {fighters.map((f) => {
          const isSelected = bets.has(f.fighterId);
          const isDeploying = deploying.has(f.fighterId);

          return (
            <div key={f.fighterId} className="space-y-0">
              <button
                onClick={() => toggleFighter(f.fighterId)}
                className={`w-full flex items-center justify-between p-2 rounded-sm border transition-all text-left ${
                  isSelected
                    ? "border-amber-500 bg-amber-900/20"
                    : "border-stone-800 bg-stone-900/50 hover:border-stone-600"
                }`}
              >
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <FighterHP
                    name={f.fighterName}
                    hp={f.hp}
                    imageUrl={f.imageUrl}
                  />
                </div>
                <div className="text-right flex-shrink-0 ml-2">
                  <p className="font-mono text-xs text-amber-400">
                    {f.potentialReturn.toFixed(1)}x
                  </p>
                  <p className="font-mono text-[10px] text-stone-500">
                    {(f.impliedProbability * 100).toFixed(0)}%
                  </p>
                  <p className="font-mono text-[10px] text-stone-600">
                    {f.solDeployed.toFixed(2)} SOL
                  </p>
                </div>
              </button>

              {/* Inline bet controls when selected */}
              {isSelected && (
                <div className="flex items-center gap-1 px-2 py-1 bg-stone-900/80 border-x border-b border-amber-500/30 rounded-b-sm">
                  {/* Quick amount buttons */}
                  {[0.05, 0.1, 0.25, 0.5].map((amt) => (
                    <button
                      key={amt}
                      onClick={() => updateAmount(f.fighterId, String(amt))}
                      className={`text-[10px] font-mono px-2 py-0.5 rounded-sm transition-all ${
                        bets.get(f.fighterId) === String(amt)
                          ? "bg-amber-600 text-stone-950"
                          : "bg-stone-800 hover:bg-stone-700 text-stone-400"
                      }`}
                    >
                      {amt}
                    </button>
                  ))}
                  <input
                    type="number"
                    value={bets.get(f.fighterId) ?? ""}
                    onChange={(e) => updateAmount(f.fighterId, e.target.value)}
                    placeholder="SOL"
                    min="0.01"
                    step="0.01"
                    className="w-16 bg-stone-950 border border-stone-700 rounded-sm px-2 py-0.5 text-stone-200 font-mono text-xs focus:outline-none focus:border-amber-600"
                  />
                  <button
                    onClick={() => handleDeploySingle(f.fighterId)}
                    disabled={isClosed || !onPlaceBet || isDeploying}
                    className="px-2 py-0.5 bg-amber-600 hover:bg-amber-500 disabled:bg-stone-700 disabled:text-stone-500 text-stone-950 font-mono text-[10px] font-bold uppercase transition-all"
                  >
                    {isDeploying ? "..." : "BET"}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Deploy All button when multiple selected */}
      {bets.size > 1 && (
        <button
          onClick={handleDeployAll}
          disabled={isClosed || !onPlaceBet || deploying.size > 0}
          className="w-full py-2 bg-amber-600 hover:bg-amber-500 disabled:bg-stone-700 disabled:text-stone-500 text-stone-950 font-mono text-sm font-bold uppercase transition-all rounded-sm"
        >
          {deploying.size > 0
            ? "DEPLOYING..."
            : `DEPLOY ALL (${bets.size} fighters · ${totalBetAmount.toFixed(2)} SOL)`}
        </button>
      )}

      <p className="text-[10px] text-stone-600 font-mono text-center">
        Tap fighters to select · 1% admin + 5% sponsorship deducted
      </p>
    </div>
  );
}
