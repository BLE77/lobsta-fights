"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  evaluateEvent,
  type CommentarySSEEvent,
  type CommentarySlotData,
  type CommentaryEventType,
} from "~~/lib/commentary";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CommentaryPlayerProps {
  /** Current rumble status (all slots) */
  slots: CommentarySlotData[] | undefined;
  /** Most recent raw SSE event from the page */
  lastEvent: CommentarySSEEvent | null;
  /** Monotonically increasing counter so we re-fire even for duplicate-shaped events */
  eventSeq: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORAGE_KEY = "ucf_commentary";
const STORAGE_VOICE_KEY = "ucf_commentary_voice";
const COOLDOWN_MS = 7_000; // Keep safely under API rate limits (10/min)

// ---------------------------------------------------------------------------
// Audio queue — plays mp3 clips sequentially
// ---------------------------------------------------------------------------

class AudioQueue {
  private queue: Array<{
    eventType: CommentaryEventType;
    context: string;
    voiceId: string;
    allowedNames: string[];
  }> = [];
  private playing = false;
  private audioEl: HTMLAudioElement | null = null;
  private currentUrl: string | null = null;
  private _onStateChange: () => void;
  private _onUnavailable: (message: string) => void;

  constructor(onStateChange: () => void, onUnavailable: (message: string) => void) {
    this._onStateChange = onStateChange;
    this._onUnavailable = onUnavailable;
  }

  get isPlaying() {
    return this.playing;
  }

  get queueLength() {
    return this.queue.length;
  }

  enqueue(
    eventType: CommentaryEventType,
    context: string,
    voiceId: string,
    allowedNames: string[],
  ) {
    // Cap queue at 3 to avoid backlog
    if (this.queue.length >= 3) return;
    this.queue.push({ eventType, context, voiceId, allowedNames });
    if (!this.playing) this.playNext();
  }

  stop() {
    this.queue = [];
    if (this.audioEl) {
      this.audioEl.pause();
      this.audioEl.src = "";
    }
    this.cleanup();
    this.playing = false;
    this._onStateChange();
  }

  setVolume(vol: number) {
    if (this.audioEl) this.audioEl.volume = vol;
  }

  private cleanup() {
    if (this.currentUrl) {
      URL.revokeObjectURL(this.currentUrl);
      this.currentUrl = null;
    }
  }

  private async playNext() {
    const item = this.queue.shift();
    if (!item) {
      this.playing = false;
      this._onStateChange();
      return;
    }

    this.playing = true;
    this._onStateChange();

    try {
      const res = await fetch("/api/rumble/commentary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eventType: item.eventType,
          context: item.context,
          voiceId: item.voiceId,
          allowedNames: item.allowedNames,
        }),
      });

      if (!res.ok) {
        if (res.status === 503) {
          const payload = await res.json().catch(() => null);
          const msg =
            payload?.error && typeof payload.error === "string"
              ? payload.error
              : "Commentary service is unavailable.";
          this.queue = [];
          this.playing = false;
          this._onStateChange();
          this._onUnavailable(msg);
          return;
        }
        if (res.status === 429) {
          const retryAfterSec = Number(res.headers.get("retry-after") ?? "1");
          const retryAfterMs = Math.max(1_000, Number.isFinite(retryAfterSec) ? retryAfterSec * 1_000 : 1_000);
          // Requeue the dropped item and retry later instead of hammering the API.
          this.queue.unshift(item);
          this.playing = false;
          this._onStateChange();
          setTimeout(() => {
            if (!this.playing) this.playNext();
          }, retryAfterMs);
          return;
        }
        console.warn("[commentary] API error:", res.status);
        setTimeout(() => this.playNext(), 300);
        return;
      }

      const blob = await res.blob();
      this.cleanup();
      const url = URL.createObjectURL(blob);
      this.currentUrl = url;

      const audio = new Audio(url);
      this.audioEl = audio;

      audio.onended = () => {
        this.cleanup();
        this.playNext();
      };
      audio.onerror = () => {
        this.cleanup();
        this.playNext();
      };

      await audio.play();
    } catch (err) {
      console.warn("[commentary] playback error:", err);
      this.cleanup();
      this.playNext();
    }
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function CommentaryPlayer({
  slots,
  lastEvent,
  eventSeq,
}: CommentaryPlayerProps) {
  const [enabled, setEnabled] = useState(false);
  const [voice, setVoice] = useState<"A" | "B">("A");
  const [volume, setVolume] = useState(0.8);
  const [isPlaying, setIsPlaying] = useState(false);
  const [serviceError, setServiceError] = useState<string | null>(null);

  const queueRef = useRef<AudioQueue | null>(null);
  const lastRequestTime = useRef(0);
  const prevSeq = useRef(-1);

  // Load persisted prefs
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === "true") setEnabled(true);
      const storedVoice = localStorage.getItem(STORAGE_VOICE_KEY);
      if (storedVoice === "B") setVoice("B");
    } catch {}
  }, []);

  // Init audio queue
  useEffect(() => {
    queueRef.current = new AudioQueue(
      () => {
        setIsPlaying(queueRef.current?.isPlaying ?? false);
      },
      (message) => {
        setServiceError(message);
        setEnabled(false);
      },
    );
    return () => {
      queueRef.current?.stop();
    };
  }, []);

  // Sync volume
  useEffect(() => {
    queueRef.current?.setVolume(volume);
  }, [volume]);

  // Stop audio when disabled
  useEffect(() => {
    if (!enabled) {
      queueRef.current?.stop();
    }
  }, [enabled]);

  const toggleEnabled = useCallback(() => {
    if (serviceError) return;
    setEnabled((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(STORAGE_KEY, String(next));
      } catch {}
      return next;
    });
  }, [serviceError]);

  const toggleVoice = useCallback(() => {
    setVoice((prev) => {
      const next = prev === "A" ? "B" : "A";
      try {
        localStorage.setItem(STORAGE_VOICE_KEY, next);
      } catch {}
      return next;
    });
  }, []);

  // Process incoming SSE events
  useEffect(() => {
    if (!enabled || !lastEvent || eventSeq === prevSeq.current) return;
    prevSeq.current = eventSeq;

    const slot = slots?.find((s) => s.slotIndex === lastEvent.slotIndex);
    const candidate = evaluateEvent(lastEvent, slot as CommentarySlotData | undefined);
    if (!candidate) return;

    // Enforce cooldown
    const now = Date.now();
    if (now - lastRequestTime.current < COOLDOWN_MS) return;
    lastRequestTime.current = now;

    const voiceId =
      voice === "B"
        ? process.env.NEXT_PUBLIC_ELEVENLABS_VOICE_B ?? ""
        : process.env.NEXT_PUBLIC_ELEVENLABS_VOICE_A ?? "";

    queueRef.current?.enqueue(
      candidate.eventType,
      candidate.context,
      voiceId,
      candidate.allowedNames ?? [],
    );
  }, [enabled, lastEvent, eventSeq, slots, voice]);

  return (
    <div className="flex items-center gap-2 bg-stone-900/80 border border-stone-700 rounded-sm px-2 py-1">
      {/* Toggle */}
      <button
        onClick={toggleEnabled}
        className={`flex items-center gap-1.5 font-mono text-[10px] transition-colors ${
          serviceError
            ? "text-stone-700 cursor-not-allowed"
            : enabled
              ? "text-amber-400"
              : "text-stone-600 hover:text-stone-400"
        }`}
        title={
          serviceError
            ? serviceError
            : enabled
              ? "Disable AI commentary"
              : "Enable AI commentary"
        }
      >
        {/* Mic icon */}
        <svg
          className="w-3 h-3"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={2}
          stroke="currentColor"
        >
          {enabled ? (
            <>
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z"
              />
            </>
          ) : (
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3zM3 3l18 18"
            />
          )}
        </svg>
        <span>{serviceError ? "COMM OFF" : enabled ? "LIVE" : "COMMENTARY"}</span>
      </button>

      {enabled && (
        <>
          {/* Playing indicator */}
          {isPlaying && (
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
          )}

          {/* Voice A/B toggle */}
          <button
            onClick={toggleVoice}
            className="font-mono text-[9px] text-stone-500 hover:text-stone-300 border border-stone-700 rounded-sm px-1 transition-colors"
            title="Switch announcer voice"
          >
            {voice}
          </button>

          {/* Volume */}
          <input
            type="range"
            min={0}
            max={1}
            step={0.1}
            value={volume}
            onChange={(e) => setVolume(parseFloat(e.target.value))}
            className="w-12 h-1 accent-amber-500 cursor-pointer"
            title={`Volume: ${Math.round(volume * 100)}%`}
          />
        </>
      )}
    </div>
  );
}
