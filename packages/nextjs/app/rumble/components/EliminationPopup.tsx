"use client";

import { useEffect, useState } from "react";

interface EliminationPopupProps {
  fighterName: string;
  imageUrl: string | null;
  placement: number;
  totalFighters: number;
}

export default function EliminationPopup({
  fighterName,
  imageUrl,
  placement,
  totalFighters,
}: EliminationPopupProps) {
  const [fading, setFading] = useState(false);

  useEffect(() => {
    const fadeTimer = setTimeout(() => setFading(true), 2500);
    return () => clearTimeout(fadeTimer);
  }, []);

  const placementSuffix =
    placement === 1
      ? "st"
      : placement === 2
      ? "nd"
      : placement === 3
      ? "rd"
      : "th";

  return (
    <div
      className={`pointer-events-none flex items-center gap-3 px-4 py-3 rounded-sm bg-red-950/80 border border-red-700/60 backdrop-blur-sm animate-elimination-popup ${
        fading ? "opacity-0" : "opacity-100"
      } transition-opacity duration-500`}
    >
      {/* Fighter image */}
      <div className="relative flex-shrink-0">
        {imageUrl ? (
          <img
            src={imageUrl}
            alt={fighterName}
            className="w-16 h-16 rounded-sm object-cover border-2 border-red-500 animate-elimination-glow"
          />
        ) : (
          <div className="w-16 h-16 rounded-sm flex items-center justify-center border-2 border-red-500 bg-stone-900 animate-elimination-glow">
            <span className="text-stone-500 font-mono text-xs">BOT</span>
          </div>
        )}
        <span className="absolute -top-1 -right-1 text-sm text-red-500 font-bold">
          X
        </span>
      </div>

      {/* Info */}
      <div className="min-w-0">
        <p className="font-mono text-sm font-bold text-red-400 truncate">
          {fighterName}
        </p>
        <p className="font-mono text-xs text-red-500 font-bold tracking-wider">
          ELIMINATED
        </p>
        <p className="font-mono text-[10px] text-stone-500">
          {placement}
          {placementSuffix} of {totalFighters}
        </p>
      </div>
    </div>
  );
}
