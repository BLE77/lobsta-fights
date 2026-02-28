"use client";

interface IchorShowerPoolProps {
  currentPool: number;
}

export default function IchorShowerPool({
  currentPool,
}: IchorShowerPoolProps) {
  return (
    <div className="bg-stone-950/60 border border-stone-700 rounded-sm p-4 backdrop-blur-md">
      <h3 className="font-mono text-sm text-amber-500 uppercase font-bold mb-2">
        Ichor Shower
      </h3>

      {/* Pool amount */}
      <div className="text-center py-3 mb-3 rounded-sm border bg-stone-950/80 border-stone-800">
        <span className="font-mono text-[10px] text-stone-500 uppercase block">
          Jackpot Pool
        </span>
        <p className="font-mono text-2xl font-bold text-amber-500">
          {currentPool.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}
        </p>
        <span className="font-mono text-xs text-amber-600">ICHOR</span>
      </div>

      {/* Info — mysterious, no probability shown */}
      <div className="text-center space-y-1">
        <p className="font-mono text-[10px] text-stone-500">
          Pool grows with every Rumble
        </p>
        <p className="font-mono text-[10px] text-stone-600">
          When it triggers, one lucky winner takes it all
        </p>
        <p className="font-mono text-[10px] text-amber-700 mt-2">
          All $ICHOR functions are on Devnet.
          <br />
          Only SOL betting is live on Mainnet.
        </p>
      </div>
    </div>
  );
}
