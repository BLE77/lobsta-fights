"use client";

interface IchorShowerPoolProps {
  currentPool: number;
  rumblesSinceLastTrigger: number;
  isNearTrigger: boolean;
}

export default function IchorShowerPool({
  currentPool,
  rumblesSinceLastTrigger,
  isNearTrigger,
}: IchorShowerPoolProps) {
  // At 1/500 odds and 0.3 ICHOR per Rumble accumulation,
  // expected trigger is around ~500 Rumbles with ~150 ICHOR pooled.
  const expectedTrigger = 500;
  const progressPercent = Math.min(
    100,
    (rumblesSinceLastTrigger / expectedTrigger) * 100
  );

  return (
    <div
      className={`bg-stone-900/90 border rounded-sm p-4 backdrop-blur-sm transition-all ${
        isNearTrigger
          ? "border-amber-500/70 shadow-lg shadow-amber-500/10"
          : "border-stone-700"
      }`}
    >
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-mono text-sm text-amber-500 uppercase font-bold">
          Ichor Shower
        </h3>
        <span className="font-mono text-[10px] text-stone-600">
          1/500 chance
        </span>
      </div>

      {/* Pool amount */}
      <div
        className={`text-center py-3 mb-3 rounded-sm border ${
          isNearTrigger
            ? "bg-amber-900/30 border-amber-700/50"
            : "bg-stone-950/80 border-stone-800"
        }`}
      >
        <span className="font-mono text-[10px] text-stone-500 uppercase block">
          Jackpot Pool
        </span>
        <p
          className={`font-mono text-2xl font-bold ${
            isNearTrigger ? "text-amber-400 animate-pulse" : "text-amber-500"
          }`}
        >
          {currentPool.toFixed(4)}
        </p>
        <span className="font-mono text-xs text-amber-600">ICHOR</span>
      </div>

      {/* Progress bar */}
      <div className="mb-2">
        <div className="flex items-center justify-between mb-1">
          <span className="font-mono text-[10px] text-stone-500">
            Rumbles Since Last Trigger
          </span>
          <span className="font-mono text-[10px] text-stone-400">
            {rumblesSinceLastTrigger}
          </span>
        </div>
        <div className="w-full h-1.5 bg-stone-800 rounded-sm overflow-hidden">
          <div
            className={`h-full transition-all duration-700 ${
              isNearTrigger
                ? "bg-amber-400 shadow-sm shadow-amber-400/50"
                : "bg-amber-700"
            }`}
            style={{ width: `${progressPercent}%` }}
          />
        </div>
        <p className="font-mono text-[9px] text-stone-600 mt-1 text-right">
          ~{expectedTrigger} avg to trigger
        </p>
      </div>

      {/* Info */}
      <div className="text-center">
        <p className="font-mono text-[10px] text-stone-600">
          90% to lucky winner | 10% burned
        </p>
        <p className="font-mono text-[10px] text-stone-600">
          +0.3 ICHOR added per Rumble
        </p>
      </div>
    </div>
  );
}
