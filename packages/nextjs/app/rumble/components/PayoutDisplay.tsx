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
  myBetFighterIds?: Set<string>;
}

function getPlacementStyle(p: number): {
  badge: string;
  badgeStyle: string;
  rowStyle: string;
  nameStyle: string;
} {
  switch (p) {
    case 1:
      return {
        badge: "1ST",
        badgeStyle: "bg-amber-500 text-stone-950 font-bold",
        rowStyle: "bg-amber-900/20 border border-amber-600/40",
        nameStyle: "text-amber-400 font-bold",
      };
    case 2:
      return {
        badge: "2ND",
        badgeStyle: "bg-stone-300 text-stone-950 font-bold",
        rowStyle: "bg-stone-800/40 border border-stone-600/30",
        nameStyle: "text-stone-200",
      };
    case 3:
      return {
        badge: "3RD",
        badgeStyle: "bg-amber-800 text-stone-200 font-bold",
        rowStyle: "bg-stone-800/30 border border-stone-700/30",
        nameStyle: "text-stone-300",
      };
    default:
      return {
        badge: `${p}TH`,
        badgeStyle: "bg-stone-700 text-stone-400",
        rowStyle: "border border-transparent",
        nameStyle: "text-stone-500",
      };
  }
}

export default function PayoutDisplay({
  placements,
  payout,
  myBetFighterIds,
}: PayoutDisplayProps) {
  const winnerBettorsPayout = Number.isFinite(Number(payout.winnerBettorsPayout))
    ? Number(payout.winnerBettorsPayout)
    : 0;
  const treasuryVault = Number.isFinite(Number(payout.treasuryVault))
    ? Number(payout.treasuryVault)
    : 0;
  const ichorMined = Number.isFinite(Number(payout.ichorMined)) ? Number(payout.ichorMined) : 0;
  const ichorShowerAmount = Number.isFinite(Number(payout.ichorShowerAmount))
    ? Number(payout.ichorShowerAmount)
    : 0;
  const winner = placements[0];
  const iWon = winner && myBetFighterIds?.has(winner.fighterId);
  const iLost = myBetFighterIds && myBetFighterIds.size > 0 && !iWon;

  return (
    <div className="space-y-4">
      {/* Season Badge */}
      <div className="text-center">
        <span className="font-mono text-[10px] text-amber-600 bg-amber-900/30 border border-amber-700/30 px-2 py-0.5 rounded-sm">
          TRAINING SEASON — {ichorMined.toLocaleString()} ICHOR/FIGHT
        </span>
      </div>

      {/* Winner Banner */}
      {winner && (
        <div className="text-center py-6 border border-amber-600/50 bg-amber-900/20 rounded-sm">
          <p className="font-fight-glow text-2xl text-amber-400 mb-3">
            WINNER
          </p>
          <div className="flex flex-col items-center gap-3">
            {winner.imageUrl ? (
              <img
                src={winner.imageUrl}
                alt={winner.fighterName}
                className="w-28 h-28 rounded-sm border-3 border-amber-500 object-cover shadow-lg shadow-amber-500/20"
              />
            ) : (
              <div className="w-28 h-28 rounded-sm bg-stone-800 flex items-center justify-center border-3 border-amber-500 shadow-lg shadow-amber-500/20">
                <span className="text-amber-500 font-mono text-lg">BOT</span>
              </div>
            )}
            <div className="text-center">
              <span className="font-mono text-xl font-bold text-amber-400 block">
                {winner.fighterName}
              </span>
              <span className="font-mono text-xs text-stone-400 mt-1 block">
                HP: {winner.hp} | DMG: {winner.damageDealt}
              </span>
            </div>
          </div>

          {/* Your bet result */}
          {iWon && (
            <p className="font-mono text-sm text-green-400 font-bold mt-3 bg-green-900/30 border border-green-700/40 inline-block px-3 py-1 rounded-sm">
              YOU WON — You bet on this fighter!
            </p>
          )}
          {iLost && (
            <p className="font-mono text-sm text-red-400 font-bold mt-3 bg-red-900/30 border border-red-700/40 inline-block px-3 py-1 rounded-sm">
              YOU LOST — Your fighter didn&apos;t win
            </p>
          )}
          {!myBetFighterIds || myBetFighterIds.size === 0 ? (
            <p className="font-mono text-[10px] text-green-500 mt-3">
              Bettors on this fighter win the entire pot
            </p>
          ) : null}
        </div>
      )}

      {/* All Fighters - Full Results */}
      <div className="space-y-1">
        <p className="font-mono text-xs text-stone-500 uppercase">
          All Fighters — Final Results
        </p>
        {placements.map((p) => {
          const style = getPlacementStyle(p.placement);
          const isMyBet = myBetFighterIds?.has(p.fighterId);
          return (
            <div
              key={p.fighterId}
              className={`flex items-center gap-2 py-1.5 px-2 rounded-sm ${style.rowStyle} ${
                isMyBet ? "ring-1 ring-cyan-500/60" : ""
              }`}
            >
              <span
                className={`font-mono text-[10px] px-1.5 py-0.5 rounded-sm flex-shrink-0 w-8 text-center ${style.badgeStyle}`}
              >
                {style.badge}
              </span>

              {p.imageUrl ? (
                <img
                  src={p.imageUrl}
                  alt={p.fighterName}
                  className={`w-7 h-7 rounded-sm object-cover border flex-shrink-0 ${
                    p.placement === 1 ? "border-amber-500" : "border-stone-700"
                  }`}
                />
              ) : (
                <div
                  className={`w-7 h-7 rounded-sm bg-stone-800 flex items-center justify-center border flex-shrink-0 ${
                    p.placement === 1 ? "border-amber-500" : "border-stone-700"
                  }`}
                >
                  <span className="text-stone-500 font-mono text-[8px]">
                    BOT
                  </span>
                </div>
              )}

              <span
                className={`font-mono text-xs truncate flex-1 min-w-0 ${style.nameStyle}`}
              >
                {p.fighterName}
              </span>

              {isMyBet && (
                <span className="font-mono text-[9px] px-1.5 py-0.5 bg-cyan-900/40 text-cyan-400 border border-cyan-700/40 rounded-sm flex-shrink-0">
                  YOUR BET
                </span>
              )}

              <div className="flex items-center gap-2 flex-shrink-0 text-right">
                <span className="font-mono text-[10px] text-stone-600">
                  HP:{p.hp}
                </span>
                <span className="font-mono text-[10px] text-stone-600">
                  DMG:{p.damageDealt}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Payout Breakdown */}
      <div className="border-t border-stone-800 pt-3 space-y-2">
        <p className="font-mono text-xs text-stone-500 uppercase">
          Bettor Payouts — Winner Takes All
        </p>

        <div className="bg-stone-950/60 border border-stone-800 rounded-sm p-2 space-y-1">
          <div className="flex justify-between text-xs font-mono">
            <span className="text-amber-400">
              Winner Bettors (100%)
            </span>
            <span className="text-green-400 font-bold">
              {winnerBettorsPayout.toFixed(4)} SOL
            </span>
          </div>
          <div className="border-t border-stone-800 pt-1 flex justify-between text-xs font-mono">
            <span className="text-stone-600">Treasury (1%)</span>
            <span className="text-stone-600">
              {treasuryVault.toFixed(4)} SOL
            </span>
          </div>
        </div>

        <p className="font-mono text-[10px] text-stone-600 text-center">
          Bet on the winner, take the whole pot. Everyone else loses.
        </p>

        {/* ICHOR mined */}
        <div className="pt-2 border-t border-stone-800 flex items-center justify-between">
          <span className="font-mono text-xs text-stone-500">
            ICHOR Mined
          </span>
          <span className="font-mono text-xs text-amber-400 font-bold">
            {ichorMined.toLocaleString()} ICHOR
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
            {ichorShowerAmount.toFixed(4)} ICHOR jackpot triggered!
          </p>
        </div>
      )}
    </div>
  );
}
