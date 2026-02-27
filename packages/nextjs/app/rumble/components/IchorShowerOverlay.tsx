"use client";

import { useEffect, useRef, useState } from "react";

interface IchorShowerOverlayProps {
  amount: number;
  onComplete?: () => void;
}

export default function IchorShowerOverlay({ amount, onComplete }: IchorShowerOverlayProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [phase, setPhase] = useState<"intro" | "main" | "outro">("intro");
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    // Intro text animates in
    const mainTimer = setTimeout(() => setPhase("main"), 400);
    // Start outro after video ends or 6s
    const outroTimer = setTimeout(() => setPhase("outro"), 6000);
    // Fully dismiss
    const dismissTimer = setTimeout(() => {
      setVisible(false);
      onComplete?.();
    }, 7200);

    return () => {
      clearTimeout(mainTimer);
      clearTimeout(outroTimer);
      clearTimeout(dismissTimer);
    };
  }, [onComplete]);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.play().catch(() => {});
    }
  }, []);

  if (!visible) return null;

  return (
    <div
      className={`fixed inset-0 z-[9999] flex items-center justify-center transition-opacity duration-700 ${
        phase === "outro" ? "opacity-0" : "opacity-100"
      }`}
    >
      {/* Video background */}
      <video
        ref={videoRef}
        src="/ichor-shower.mp4"
        muted
        playsInline
        className="absolute inset-0 w-full h-full object-cover"
      />

      {/* Dark overlay for text readability */}
      <div className="absolute inset-0 bg-black/40" />

      {/* Text content */}
      <div className="relative z-10 flex flex-col items-center gap-2 px-4">
        {/* ICHOR */}
        <h1
          className={`font-fight text-7xl sm:text-8xl md:text-9xl text-transparent bg-clip-text bg-gradient-to-b from-yellow-300 via-amber-400 to-orange-600 drop-shadow-[0_0_40px_rgba(255,200,0,0.8)] tracking-wider transition-all duration-500 ${
            phase === "intro"
              ? "opacity-0 scale-150 blur-sm"
              : "opacity-100 scale-100 blur-0"
          }`}
          style={{
            textShadow:
              "0 0 20px rgba(255,200,0,0.6), 0 0 60px rgba(255,150,0,0.4), 0 0 100px rgba(255,100,0,0.2)",
            WebkitTextStroke: "1px rgba(255,200,0,0.3)",
          }}
        >
          ICHOR
        </h1>

        {/* SHOWER */}
        <h1
          className={`font-fight text-7xl sm:text-8xl md:text-9xl text-transparent bg-clip-text bg-gradient-to-b from-yellow-300 via-amber-400 to-orange-600 drop-shadow-[0_0_40px_rgba(255,200,0,0.8)] tracking-wider transition-all duration-700 delay-200 ${
            phase === "intro"
              ? "opacity-0 scale-150 blur-sm"
              : "opacity-100 scale-100 blur-0"
          }`}
          style={{
            textShadow:
              "0 0 20px rgba(255,200,0,0.6), 0 0 60px rgba(255,150,0,0.4), 0 0 100px rgba(255,100,0,0.2)",
            WebkitTextStroke: "1px rgba(255,200,0,0.3)",
          }}
        >
          SHOWER
        </h1>

        {/* Jackpot amount */}
        <div
          className={`mt-4 transition-all duration-500 delay-700 ${
            phase === "intro"
              ? "opacity-0 translate-y-4"
              : "opacity-100 translate-y-0"
          }`}
        >
          <p className="font-mono text-lg sm:text-xl text-amber-300 text-center tracking-widest uppercase">
            1/500 Jackpot Triggered
          </p>
          <p className="font-fight text-3xl sm:text-4xl text-amber-400 text-center mt-1 animate-pulse">
            {amount.toFixed(2)} ICHOR
          </p>
        </div>
      </div>

      {/* Corner flares */}
      <div className="absolute top-0 left-0 w-32 h-32 bg-gradient-radial from-amber-500/30 to-transparent animate-pulse" />
      <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-radial from-amber-500/30 to-transparent animate-pulse delay-300" />
      <div className="absolute bottom-0 left-0 w-32 h-32 bg-gradient-radial from-amber-500/30 to-transparent animate-pulse delay-500" />
      <div className="absolute bottom-0 right-0 w-32 h-32 bg-gradient-radial from-amber-500/30 to-transparent animate-pulse delay-700" />
    </div>
  );
}
