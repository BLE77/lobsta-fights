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
  onPlaceBatchBet?: (
    slotIndex: number,
    bets: Array<{ fighterId: string; amount: number }>,
  ) => Promise<void> | void;
  myBetAmounts?: Map<string, number>;
}

export default function BettingPanel({
  slotIndex,
  fighters,
  totalPool,
  deadline,
  onPlaceBet,
  onPlaceBatchBet,
  myBetAmounts,
}: BettingPanelProps) {
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
      if (prev.has(fighterId)) {
        next.delete(fighterId);
        return next;
      }
      next.set(fighterId, prev.get(fighterId) ?? "0.05");
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
      // Clear selection after submit to avoid accidental re-sending in later batch deploys.
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
    const entries = [...bets.entries()]
      .map(([fighterId, amountStr]) => ({
        fighterId,
        amount: parseFloat(amountStr),
      }))
      .filter((e) => Number.isFinite(e.amount) && e.amount > 0);
    if (entries.length === 0) return;

    setDeploying(new Set(entries.map((e) => e.fighterId)));
    try {
      if (onPlaceBatchBet) {
        await onPlaceBatchBet(slotIndex, entries);
      } else if (onPlaceBet) {
        for (const leg of entries) {
          await onPlaceBet(slotIndex, leg.fighterId, leg.amount);
        }
      }
      // Clear submitted selections so subsequent bets only include newly selected fighters.
      setBets(new Map());
    } finally {
      setDeploying(new Set());
    }
  };

  const totalBetAmount = [...bets.values()].reduce(
    (sum, v) => sum + (parseFloat(v) || 0),
    0
  );
  const myStakeEntries = myBetAmounts ? [...myBetAmounts.entries()] : [];
  const myStakeTotal = myStakeEntries.reduce((sum, [, amount]) => sum + amount, 0);
  const deployableCount = [...bets.values()].filter(v => (parseFloat(v) || 0) > 0).length;

  const bettingInitialized = !!deadline;
  const isClosed = bettingInitialized && timeLeft === "CLOSED";
  const canSubmitBets = bettingInitialized && !isClosed;

  return (
    <div className="space-y-3">
      {/* Timer + Pool */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {bettingInitialized && !isClosed ? (
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
            </span>
          ) : (
            <span className={`inline-flex h-2 w-2 rounded-full ${isClosed ? "bg-red-500" : "bg-stone-500"}`} />
          )}
          <span className={`font-mono text-xs uppercase ${isClosed ? "text-red-500" : "text-amber-400"}`}>
            {bettingInitialized ? (isClosed ? "Betting Closed" : "Betting Open") : "Initializing On-Chain..."}
          </span>
        </div>
        <span
          className={`font-mono text-sm font-bold ${
            isClosed ? "text-red-500" : "text-amber-400"
          }`}
        >
          {bettingInitialized ? timeLeft || "--:--" : "--:--"}
        </span>
      </div>

      {/* Total Pool */}
      <div className="bg-stone-950/80 border border-amber-700/30 rounded-sm p-2 text-center">
        <span className="font-mono text-xs text-stone-500">TOTAL POOL</span>
        <p className="font-mono text-lg font-bold text-amber-400">
          {(totalPool ?? 0).toFixed(2)} SOL
        </p>
      </div>

      {myStakeEntries.length > 0 && (
        <div className="bg-stone-950/80 border border-amber-700/30 rounded-sm p-2">
          <p className="font-mono text-[10px] text-cyan-400 uppercase">
            Your Active Bets
          </p>
          <div className="space-y-1 mt-1">
            {myStakeEntries
              .sort((a, b) => b[1] - a[1])
              .map(([fighterId, amount]) => {
                const fighterName =
                  fighters.find(f => f.fighterId === fighterId)?.fighterName ?? fighterId;
                return (
                  <div key={fighterId} className="flex items-center justify-between">
                    <span className="font-mono text-[11px] text-stone-300 truncate max-w-[70%]">
                      {fighterName}
                    </span>
                    <span className="font-mono text-[11px] text-cyan-300">
                      {amount.toFixed(3)} SOL
                    </span>
                  </div>
                );
              })}
          </div>
          <p className="font-mono text-[10px] text-stone-500 mt-2">
            TOTAL STAKED: <span className="text-cyan-300">{myStakeTotal.toFixed(3)} SOL</span>
          </p>
        </div>
      )}

      {/* Fighter Odds List — click to toggle selection */}
      <div className="space-y-1 max-h-80 overflow-y-auto">
        {fighters.map((f) => {
          const isSelected = bets.has(f.fighterId);
          const isDeploying = deploying.has(f.fighterId);
          const myStake = myBetAmounts?.get(f.fighterId) ?? 0;
          const potentialReturn = Number.isFinite(Number(f.potentialReturn)) ? Number(f.potentialReturn) : 0;
          const impliedProbability = Number.isFinite(Number(f.impliedProbability)) ? Number(f.impliedProbability) : 0;
          const deployed = Number.isFinite(Number(f.solDeployed)) ? Number(f.solDeployed) : 0;

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
                    {potentialReturn.toFixed(1)}x
                  </p>
                  <p className="font-mono text-[10px] text-stone-500">
                    {(impliedProbability * 100).toFixed(0)}%
                  </p>
                  <p className="font-mono text-[10px] text-stone-600">
                    {deployed.toFixed(2)} SOL
                  </p>
                  {myStake > 0 && (
                    <p className="font-mono text-[10px] text-cyan-400">
                      YOU: {myStake.toFixed(3)} SOL
                    </p>
                  )}
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
                    disabled={!canSubmitBets || !onPlaceBet || isDeploying}
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
      {deployableCount > 1 && (
        <button
          onClick={handleDeployAll}
          disabled={!canSubmitBets || (!onPlaceBet && !onPlaceBatchBet) || deploying.size > 0}
          className="w-full py-2 bg-amber-600 hover:bg-amber-500 disabled:bg-stone-700 disabled:text-stone-500 text-stone-950 font-mono text-sm font-bold uppercase transition-all rounded-sm"
        >
          {deploying.size > 0
            ? "DEPLOYING..."
            : `DEPLOY ALL (${deployableCount} fighters · ${totalBetAmount.toFixed(2)} SOL)`}
        </button>
      )}

      <p className="text-[10px] text-stone-600 font-mono text-center">
        {bettingInitialized
          ? "Select one or more fighters · 1% admin + 5% sponsorship deducted"
          : "Stand by while on-chain rumble initializes. Betting opens when timer appears."}
      </p>
    </div>
  );
}
