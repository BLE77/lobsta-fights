"use client";

import { useState } from "react";
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
  const [selectedFighter, setSelectedFighter] = useState<string | null>(null);
  const [betAmount, setBetAmount] = useState("");
  const [timeLeft, setTimeLeft] = useState("");

  // Countdown timer
  useState(() => {
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
  });

  const handleBet = () => {
    if (!selectedFighter || !betAmount || !onPlaceBet) return;
    const amount = parseFloat(betAmount);
    if (isNaN(amount) || amount <= 0) return;
    onPlaceBet(slotIndex, selectedFighter, amount);
    setBetAmount("");
  };

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
            timeLeft === "CLOSED" ? "text-red-500" : "text-amber-400"
          }`}
        >
          {timeLeft || "--:--"}
        </span>
      </div>

      {/* Total Pool */}
      <div className="bg-stone-950/80 border border-amber-700/30 rounded-sm p-2 text-center">
        <span className="font-mono text-xs text-stone-500">TOTAL POOL</span>
        <p className="font-mono text-lg font-bold text-amber-400">
          {totalPool.toFixed(2)} SOL
        </p>
      </div>

      {/* Fighter Odds List */}
      <div className="space-y-1 max-h-60 overflow-y-auto">
        {fighters.map((f) => (
          <button
            key={f.fighterId}
            onClick={() => setSelectedFighter(f.fighterId)}
            className={`w-full flex items-center justify-between p-2 rounded-sm border transition-all text-left ${
              selectedFighter === f.fighterId
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
        ))}
      </div>

      {/* Bet Input */}
      {selectedFighter && (
        <div className="flex gap-2">
          <input
            type="number"
            value={betAmount}
            onChange={(e) => setBetAmount(e.target.value)}
            placeholder="SOL amount"
            min="0.001"
            step="0.01"
            className="flex-1 bg-stone-950 border border-stone-700 rounded-sm px-3 py-2 text-stone-200 font-mono text-sm focus:outline-none focus:border-amber-600"
          />
          <button
            onClick={handleBet}
            disabled={timeLeft === "CLOSED"}
            className="px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:bg-stone-700 disabled:text-stone-500 text-stone-950 font-mono text-sm font-bold uppercase transition-all"
          >
            Deploy
          </button>
        </div>
      )}

      <p className="text-[10px] text-stone-600 font-mono text-center">
        1% admin fee + 5% fighter sponsorship deducted
      </p>
    </div>
  );
}
