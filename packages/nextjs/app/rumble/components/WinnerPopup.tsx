"use client";

import { useEffect, useState, useRef } from "react";

interface WinnerPopupProps {
  fighterName: string;
  imageUrl: string | null;
  solWon: number;
  onDismiss: () => void;
}

export default function WinnerPopup({
  fighterName,
  imageUrl,
  solWon,
  onDismiss,
}: WinnerPopupProps) {
  const [phase, setPhase] = useState<"enter" | "visible" | "exit">("enter");
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    // Play the winner sound
    try {
      const audio = new Audio("/sounds/winner-reveal.mp3");
      audio.volume = 0.6;
      audio.play().catch(() => {});
      audioRef.current = audio;
    } catch {}

    // Animate in
    const enterTimer = setTimeout(() => setPhase("visible"), 50);

    // Auto-dismiss after 6 seconds
    const dismissTimer = setTimeout(() => {
      setPhase("exit");
      setTimeout(onDismiss, 500);
    }, 6000);

    return () => {
      clearTimeout(enterTimer);
      clearTimeout(dismissTimer);
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, [onDismiss]);

  const handleClick = () => {
    setPhase("exit");
    setTimeout(onDismiss, 500);
  };

  return (
    <div
      onClick={handleClick}
      className={`fixed inset-0 z-[9999] flex items-center justify-center cursor-pointer transition-all duration-500 ${
        phase === "enter"
          ? "opacity-0"
          : phase === "exit"
          ? "opacity-0 scale-95"
          : "opacity-100"
      }`}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" />

      {/* Glow pulses */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] rounded-full bg-amber-500/10 animate-ping" style={{ animationDuration: "2s" }} />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[400px] h-[400px] rounded-full bg-amber-400/15 animate-ping" style={{ animationDuration: "1.5s", animationDelay: "0.3s" }} />
      </div>

      {/* Content */}
      <div
        className={`relative flex flex-col items-center gap-5 transition-all duration-700 ${
          phase === "visible" ? "scale-100 translate-y-0" : "scale-90 translate-y-4"
        }`}
      >
        {/* YOU WON text */}
        <div className="text-center">
          <p className="font-mono text-sm text-amber-600 tracking-[0.3em] uppercase mb-1">
            Your fighter won
          </p>
          <h1 className="font-fight-glow text-5xl sm:text-6xl text-amber-400 animate-winner-pulse">
            YOU WON
          </h1>
        </div>

        {/* Fighter image */}
        <div className="relative">
          <div className="absolute -inset-3 bg-amber-500/20 rounded-lg blur-xl animate-pulse" />
          {imageUrl ? (
            <img
              src={imageUrl}
              alt={fighterName}
              className="relative w-36 h-36 sm:w-44 sm:h-44 rounded-lg border-3 border-amber-500 object-cover shadow-2xl shadow-amber-500/30"
            />
          ) : (
            <div className="relative w-36 h-36 sm:w-44 sm:h-44 rounded-lg bg-stone-800 flex items-center justify-center border-3 border-amber-500 shadow-2xl shadow-amber-500/30">
              <span className="text-amber-500 font-mono text-2xl">BOT</span>
            </div>
          )}
        </div>

        {/* Fighter name */}
        <p className="font-mono text-xl sm:text-2xl font-bold text-amber-400 text-center">
          {fighterName}
        </p>

        {/* SOL amount */}
        {solWon > 0 && (
          <div className="flex items-center gap-2 bg-green-900/40 border border-green-600/50 rounded-lg px-5 py-3">
            <span className="text-green-400 text-2xl sm:text-3xl font-bold font-mono">
              +{solWon.toFixed(4)}
            </span>
            <span className="text-green-500 text-lg font-mono">SOL</span>
          </div>
        )}

        {/* Tap to dismiss */}
        <p className="font-mono text-xs text-stone-600 mt-2 animate-pulse">
          tap anywhere to dismiss
        </p>
      </div>
    </div>
  );
}
