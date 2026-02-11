"use client";

interface PlacementEntry {
  fighterId: string;
  fighterName: string;
  imageUrl?: string | null;
  placement: number;
  hp: number;
  damageDealt: number;
}

interface PayoutInfo {
  winnerBettorsPayout: number;
  placeBettorsPayout: number;
  showBettorsPayout: number;
  treasuryVault: number;
  totalPool: number;
  ichorMined: number;
  ichorShowerTriggered: boolean;
  ichorShowerAmount?: number;
}

interface PayoutDisplayProps {
  placements: PlacementEntry[];
  payout: PayoutInfo;
}

function getPlacementBadge(p: number): { text: string; style: string } {
  switch (p) {
    case 1:
      return {
        text: "1ST",
        style: "bg-amber-500 text-stone-950 font-bold",
      };
    case 2:
      return {
        text: "2ND",
        style: "bg-stone-300 text-stone-950 font-bold",
      };
    case 3:
      return {
        text: "3RD",
        style: "bg-amber-800 text-stone-200 font-bold",
      };
    default:
      return {
        text: `${p}TH`,
        style: "bg-stone-700 text-stone-400",
      };
  }
}

export default function PayoutDisplay({
  placements,
  payout,
}: PayoutDisplayProps) {
  const winner = placements[0];

  return (
    <div className="space-y-4">
      {/* Winner Banner */}
      {winner && (
        <div className="text-center py-3 border border-amber-600/50 bg-amber-900/20 rounded-sm">
          <p className="font-fight-glow text-2xl text-amber-400 mb-1">
            WINNER
          </p>
          <div className="flex items-center justify-center gap-3">
            {winner.imageUrl ? (
              <img
                src={winner.imageUrl}
                alt={winner.fighterName}
                className="w-10 h-10 rounded-sm border border-amber-600 object-cover"
              />
            ) : (
              <div className="w-10 h-10 rounded-sm bg-stone-800 flex items-center justify-center border border-amber-600">
                <span className="text-amber-500 font-mono text-xs">BOT</span>
              </div>
            )}
            <span className="font-mono text-lg font-bold text-amber-400">
              {winner.fighterName}
            </span>
          </div>
          <p className="font-mono text-xs text-stone-500 mt-1">
            HP: {winner.hp} | DMG Dealt: {winner.damageDealt}
          </p>
        </div>
      )}

      {/* Placements List */}
      <div className="space-y-1">
        <p className="font-mono text-xs text-stone-500 uppercase">
          Final Placements
        </p>
        {placements.slice(0, 8).map((p) => {
          const badge = getPlacementBadge(p.placement);
          return (
            <div
              key={p.fighterId}
              className="flex items-center gap-2 py-1 px-2 rounded-sm"
            >
              <span
                className={`font-mono text-[10px] px-1.5 py-0.5 rounded-sm ${badge.style}`}
              >
                {badge.text}
              </span>
              {p.imageUrl ? (
                <img
                  src={p.imageUrl}
                  alt={p.fighterName}
                  className="w-6 h-6 rounded-sm object-cover border border-stone-700"
                />
              ) : (
                <div className="w-6 h-6 rounded-sm bg-stone-800 flex items-center justify-center border border-stone-700">
                  <span className="text-stone-500 font-mono text-[8px]">
                    B
                  </span>
                </div>
              )}
              <span
                className={`font-mono text-xs truncate ${
                  p.placement <= 3 ? "text-stone-200" : "text-stone-500"
                }`}
              >
                {p.fighterName}
              </span>
              <span className="font-mono text-[10px] text-stone-600 ml-auto">
                HP:{p.hp}
              </span>
            </div>
          );
        })}
        {placements.length > 8 && (
          <p className="font-mono text-[10px] text-stone-600 text-center">
            +{placements.length - 8} more fighters
          </p>
        )}
      </div>

      {/* Payout Breakdown */}
      <div className="border-t border-stone-800 pt-3 space-y-1">
        <p className="font-mono text-xs text-stone-500 uppercase mb-2">
          Payout Breakdown
        </p>

        <div className="grid grid-cols-2 gap-1 text-xs font-mono">
          <span className="text-stone-500">1st Place Bettors</span>
          <span className="text-green-400 text-right">
            {payout.winnerBettorsPayout.toFixed(4)} SOL
          </span>

          <span className="text-stone-500">2nd Place Bettors</span>
          <span className="text-green-400 text-right">
            {payout.placeBettorsPayout.toFixed(4)} SOL
          </span>

          <span className="text-stone-500">3rd Place Bettors</span>
          <span className="text-green-400 text-right">
            {payout.showBettorsPayout.toFixed(4)} SOL
          </span>

          <span className="text-stone-600">Treasury</span>
          <span className="text-stone-600 text-right">
            {payout.treasuryVault.toFixed(4)} SOL
          </span>
        </div>

        {/* ICHOR mined */}
        <div className="mt-2 pt-2 border-t border-stone-800 flex items-center justify-between">
          <span className="font-mono text-xs text-stone-500">ICHOR Mined</span>
          <span className="font-mono text-xs text-amber-400 font-bold">
            {payout.ichorMined.toFixed(4)} ICHOR
          </span>
        </div>
      </div>

      {/* Ichor Shower Banner */}
      {payout.ichorShowerTriggered && (
        <div className="border border-amber-500 bg-amber-900/30 rounded-sm p-3 text-center animate-pulse">
          <p className="font-fight-glow text-xl text-amber-400">
            ICHOR SHOWER
          </p>
          <p className="font-mono text-sm text-amber-300 mt-1">
            {payout.ichorShowerAmount?.toFixed(4)} ICHOR jackpot triggered!
          </p>
        </div>
      )}
    </div>
  );
}
