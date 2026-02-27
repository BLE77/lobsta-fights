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
  onPlaceBet?: (slotIndex: number, fighterId: string, amount: number) => Promise<string | undefined> | void;
  onPlaceBatchBet?: (
    slotIndex: number,
    bets: Array<{ fighterId: string; amount: number }>,
  ) => Promise<string | undefined> | void;
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
  const [lastTxSignature, setLastTxSignature] = useState<string | null>(null);
  const [successFighterId, setSuccessFighterId] = useState<string | null>(null);

  // Countdown timer — offset by the on-chain close guard so the UI shows
  // CLOSED at the same moment the bet placement code rejects submissions.
  const BET_CLOSE_GUARD_MS = 12_000;
  useEffect(() => {
    if (!deadline) return;
    const deadlineMs = new Date(deadline).getTime();
    if (!Number.isFinite(deadlineMs)) {
      setTimeLeft("CLOSED");
      return;
    }
    const update = () => {
      const now = Date.now();
      const end = deadlineMs - BET_CLOSE_GUARD_MS;
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
      next.set(fighterId, prev.get(fighterId) ?? "0.01");
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
      const sig = await onPlaceBet(slotIndex, fighterId, amount);
      if (sig) setLastTxSignature(sig);
      // Clear selection after submit to avoid accidental re-sending in later batch deploys.
      setBets((prev) => {
        const next = new Map(prev);
        next.delete(fighterId);
        return next;
      });
      // Flash green on the fighter row for success feedback
      setSuccessFighterId(fighterId);
      setTimeout(() => setSuccessFighterId(null), 1500);
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
      let sig: string | undefined;
      if (onPlaceBatchBet) {
        sig = await onPlaceBatchBet(slotIndex, entries) ?? undefined;
      } else if (onPlaceBet) {
        for (const leg of entries) {
          sig = await onPlaceBet(slotIndex, leg.fighterId, leg.amount) ?? undefined;
        }
      }
      if (sig) setLastTxSignature(sig);
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
              <span className="animate-ping absolute inline-flex h-full w-full rounded-sm bg-amber-400 opacity-75"></span>
              <span className="relative inline-flex rounded-sm h-2 w-2 bg-amber-500"></span>
            </span>
          ) : (
            <span className={`inline-flex h-2 w-2 rounded-sm ${isClosed ? "bg-red-500" : "bg-stone-500"}`} />
          )}
          <span className={`font-mono text-xs uppercase ${isClosed ? "text-red-500" : "text-amber-400"}`}>
            {bettingInitialized ? (isClosed ? "Betting Closed" : "Betting Open") : "Initializing On-Chain..."}
          </span>
        </div>
        <span
          className={`font-mono text-sm font-bold ${isClosed ? "text-red-500" : "text-amber-400"
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

      {/* Last transaction explorer link */}
      {lastTxSignature && (
        <div className="flex items-center justify-between bg-stone-950/80 border border-green-700/30 rounded-sm px-2 py-1.5">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-green-400 text-[10px]">&#x2713;</span>
            <a
              href={`https://explorer.solana.com/tx/${lastTxSignature}?cluster=devnet`}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-[10px] text-green-400 hover:text-green-300 hover:underline truncate"
            >
              View on Explorer: {lastTxSignature.slice(0, 8)}...{lastTxSignature.slice(-8)}
            </a>
          </div>
          <button
            onClick={() => setLastTxSignature(null)}
            className="text-stone-600 hover:text-stone-400 text-[10px] font-mono ml-2 flex-shrink-0"
          >
            [x]
          </button>
        </div>
      )}

      {/* Fighter Odds List — click to toggle selection */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 max-h-[600px] overflow-y-auto p-1">
        {fighters.map((f) => {
          const isSelected = bets.has(f.fighterId);
          const isDeploying = deploying.has(f.fighterId);
          const myStake = myBetAmounts?.get(f.fighterId) ?? 0;
          const potentialReturn = Number.isFinite(Number(f.potentialReturn)) ? Number(f.potentialReturn) : 0;
          const impliedProbability = Number.isFinite(Number(f.impliedProbability)) ? Number(f.impliedProbability) : 0;
          const deployed = Number.isFinite(Number(f.solDeployed)) ? Number(f.solDeployed) : 0;

          return (
            <div key={f.fighterId} className="flex flex-col h-full bg-stone-900/50 rounded-sm">
              <button
                onClick={() => toggleFighter(f.fighterId)}
                className={`flex-1 flex flex-col p-2 rounded-t-sm border transition-all text-left hover:scale-[1.02] hover:ring-1 hover:ring-amber-500/50 relative overflow-hidden ${successFighterId === f.fighterId
                  ? "border-green-500 bg-green-900/20"
                  : isSelected
                    ? "border-amber-500 bg-amber-900/20 border-b-0"
                    : "border-stone-800 bg-transparent hover:border-stone-600"
                  } ${!isSelected ? "rounded-b-sm" : ""}`}
              >
                {/* Large Tile Avatar */}
                <div className="w-full aspect-square mb-2 rounded-sm overflow-hidden border border-stone-800 bg-stone-900 relative">
                  {f.imageUrl ? (
                    <img
                      src={f.imageUrl}
                      alt={f.fighterName}
                      className={`w-full h-full object-cover transition-all duration-700 ${myStake > 0 ? "border border-cyan-500" : ""
                        }`}
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <span className="font-mono text-[10px] text-stone-600">NO IMG</span>
                    </div>
                  )}

                  {/* HP Bar Overlay */}
                  <div className="absolute bottom-0 left-0 right-0 h-1 bg-stone-900 overflow-hidden">
                    <div
                      className="h-full bg-green-500/80 transition-all duration-500"
                      style={{ width: `${Math.max(0, Math.min(100, (f.hp / 100) * 100))}%` }}
                    />
                  </div>
                </div>

                {/* Info Text */}
                <div className="w-full flex-1 flex flex-col relative z-10">
                  <div className="flex items-center justify-between mb-1">
                    <h4 className="font-mono text-xs font-bold text-stone-200 truncate flex items-center gap-1">
                      {f.fighterName}
                      {myStake > 0 && (
                        <span className="font-mono text-[8px] px-1 py-px bg-cyan-900/50 text-cyan-400 border border-cyan-700/40 rounded-sm flex-shrink-0 leading-none">
                          BET
                        </span>
                      )}
                    </h4>
                  </div>

                  <div className="grid grid-cols-2 gap-1 mt-auto">
                    <div className="bg-stone-950/50 p-1 rounded-sm border border-stone-800">
                      <p className="font-mono text-[9px] text-stone-500 uppercase">Return</p>
                      <p className="font-mono text-xs text-amber-400 font-bold">{potentialReturn.toFixed(1)}x</p>
                    </div>
                    <div className="bg-stone-950/50 p-1 rounded-sm border border-stone-800">
                      <p className="font-mono text-[9px] text-stone-500 uppercase">Win %</p>
                      <p className="font-mono text-xs text-stone-300">{(impliedProbability * 100).toFixed(0)}%</p>
                    </div>
                  </div>

                  <div className="mt-1 flex items-center justify-between">
                    <p className="font-mono text-[9px] text-stone-500">
                      Pool: {deployed.toFixed(2)} SOL
                    </p>
                    {myStake > 0 && (
                      <p className="font-mono text-[9px] text-cyan-400">
                        You: {myStake.toFixed(2)}
                      </p>
                    )}
                  </div>
                </div>
              </button>

              {/* Inline bet controls when selected — animated slide */}
              <div className={`overflow-hidden transition-all duration-200 ${isSelected ? 'max-h-32 opacity-100' : 'max-h-0 opacity-0'}`}>
                <div className="flex flex-col gap-1 p-2 bg-stone-900/80 border-x border-b border-amber-500/50 rounded-b-sm shadow-inner shadow-black/50">
                  {/* Quick amount buttons */}
                  <div className="grid grid-cols-4 gap-1">
                    {[0.01, 0.025, 0.05, 0.1].map((amt) => (
                      <button
                        key={amt}
                        onClick={() => updateAmount(f.fighterId, String(amt))}
                        className={`text-[10px] font-mono py-1 rounded-sm border transition-all ${bets.get(f.fighterId) === String(amt)
                          ? "bg-amber-600 text-stone-950 border-amber-500"
                          : "bg-stone-950 hover:bg-stone-800 text-stone-400 border-stone-800 hover:border-stone-600"
                          }`}
                      >
                        {amt}
                      </button>
                    ))}
                  </div>

                  <div className="flex items-center gap-1 mt-1">
                    <input
                      type="number"
                      value={bets.get(f.fighterId) ?? ""}
                      onChange={(e) => updateAmount(f.fighterId, e.target.value)}
                      placeholder="SOL..."
                      min="0.01"
                      step="0.01"
                      className="flex-1 min-w-0 bg-stone-950 border border-stone-800 rounded-sm px-2 py-1 text-stone-200 font-mono text-xs focus:outline-none focus:border-amber-600 transition-colors"
                    />
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Deploy All button when multiple selected */}
      {deployableCount >= 1 && (
        <button
          onClick={handleDeployAll}
          disabled={!canSubmitBets || (!onPlaceBet && !onPlaceBatchBet) || deploying.size > 0}
          className="w-full py-2 bg-amber-600 hover:bg-amber-500 disabled:bg-stone-700 disabled:text-stone-500 text-stone-950 font-mono text-sm font-bold uppercase transition-all rounded-sm"
        >
          {deploying.size > 0
            ? "DEPLOYING..."
            : deployableCount === 1
              ? `DEPLOY (${totalBetAmount.toFixed(2)} SOL)`
              : `DEPLOY (${deployableCount} fighters · ${totalBetAmount.toFixed(2)} SOL)`}
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
