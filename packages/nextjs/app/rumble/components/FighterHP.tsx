"use client";

interface FighterHPProps {
  name: string;
  hp: number;
  maxHp?: number;
  imageUrl?: string | null;
  isEliminated?: boolean;
  placement?: number;
  damageDealt?: number;
  isMyBet?: boolean;
}

export default function FighterHP({
  name,
  hp,
  maxHp = 100,
  imageUrl,
  isEliminated = false,
  placement,
  damageDealt,
  isMyBet,
}: FighterHPProps) {
  const hpPercent = Math.max(0, Math.min(100, (hp / maxHp) * 100));

  const barColor =
    hpPercent > 60
      ? "bg-green-500"
      : hpPercent > 30
      ? "bg-yellow-500"
      : "bg-red-500";

  const barGlow =
    hpPercent > 60
      ? "shadow-green-500/30"
      : hpPercent > 30
      ? "shadow-yellow-500/30"
      : "shadow-red-500/30";

  return (
    <div
      className={`flex items-center gap-3 p-2 rounded-sm transition-all ${
        isEliminated
          ? "opacity-40 line-through decoration-red-500"
          : ""
      } ${isMyBet && !isEliminated ? "ring-1 ring-cyan-500/50 bg-cyan-950/10" : ""}`}
    >
      {/* Avatar */}
      <div className="relative flex-shrink-0">
        {imageUrl ? (
          <img
            src={imageUrl}
            alt={name}
            className={`w-8 h-8 rounded-sm object-cover border ${
              isEliminated ? "border-red-800 grayscale" : isMyBet ? "border-cyan-500" : "border-stone-700"
            }`}
          />
        ) : (
          <div
            className={`w-8 h-8 rounded-sm flex items-center justify-center border ${
              isEliminated
                ? "border-red-800 bg-stone-900"
                : isMyBet
                ? "border-cyan-500 bg-stone-800"
                : "border-stone-700 bg-stone-800"
            }`}
          >
            <span className="text-stone-500 font-mono text-[9px]">BOT</span>
          </div>
        )}
        {placement && placement <= 3 && (
          <span
            className={`absolute -top-1 -left-1 text-[9px] font-mono font-bold px-0.5 rounded-sm ${
              placement === 1
                ? "bg-amber-500 text-stone-950"
                : placement === 2
                ? "bg-stone-300 text-stone-950"
                : "bg-amber-800 text-stone-200"
            }`}
          >
            {placement}
          </span>
        )}
        {isEliminated && (
          <span className="absolute -top-1 -right-1 text-[9px] text-red-500 font-bold">
            X
          </span>
        )}
      </div>

      {/* Name + HP bar */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between mb-0.5">
          <span className="flex items-center gap-1 truncate">
            <span
              className={`font-mono text-xs font-bold truncate ${
                isEliminated ? "text-stone-600" : "text-stone-200"
              }`}
            >
              {name}
            </span>
            {isMyBet && !isEliminated && (
              <span className="font-mono text-[8px] px-1 py-px bg-cyan-900/50 text-cyan-400 border border-cyan-700/40 rounded-sm flex-shrink-0">
                BET
              </span>
            )}
          </span>
          <span
            className={`font-mono text-[10px] ml-2 flex-shrink-0 ${
              isEliminated ? "text-stone-600" : "text-stone-400"
            }`}
          >
            {hp}/{maxHp}
          </span>
        </div>

        {/* HP Bar */}
        <div className="w-full h-2 bg-stone-800 rounded-sm overflow-hidden">
          <div
            className={`h-full ${barColor} shadow-sm ${barGlow} transition-all duration-500 ease-out`}
            style={{ width: `${hpPercent}%` }}
          />
        </div>

        {damageDealt !== undefined && (
          <span className="font-mono text-[9px] text-stone-600 mt-0.5 block">
            DMG: {damageDealt}
          </span>
        )}
      </div>
    </div>
  );
}
