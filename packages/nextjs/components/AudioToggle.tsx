"use client";

import { useState, useEffect } from "react";

export default function AudioToggle() {
  const [muted, setMuted] = useState(true);
  const [audioManager, setAudioManager] = useState<any>(null);

  useEffect(() => {
    // Dynamic import to avoid SSR issues
    import("../lib/audio").then((mod) => {
      if (mod.audioManager) {
        setAudioManager(mod.audioManager);
        setMuted(mod.audioManager.isMuted);
      }
    });
  }, []);

  if (!audioManager) return null;

  return (
    <button
      onClick={async () => {
        await audioManager.init();
        const newMuted = audioManager.toggleMute();
        setMuted(newMuted);
        if (!newMuted) {
          audioManager.play("round_start");
        }
      }}
      className="fixed bottom-4 right-4 z-50 px-3 py-1.5 bg-stone-800/90 border border-stone-700 rounded-sm text-stone-400 hover:text-amber-500 hover:border-amber-700 transition-all font-mono text-xs backdrop-blur-sm"
      title={muted ? "Enable sound effects" : "Mute sound effects"}
    >
      {muted ? "[SOUND OFF]" : "[SOUND ON]"}
    </button>
  );
}
