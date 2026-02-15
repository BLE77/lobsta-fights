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
const COOLDOWN_MS = 3_500;
const BETTING_HYPE_INTERVAL_MS = 20_000;
const BETTING_HYPE_CHECK_MS = 3_000;
const PLAYBACK_RATE = 1.12;

// ---------------------------------------------------------------------------
// Audio queue — plays mp3 clips sequentially
// ---------------------------------------------------------------------------

class AudioQueue {
  private queue: Array<{
    eventType: CommentaryEventType;
    context: string;
    voiceId: string;
    allowedNames: string[];
    clipKey?: string;
    retries: number;
  }> = [];
  private playing = false;
  private audioEl: HTMLAudioElement | null = null;
  private currentUrl: string | null = null;
  private currentClipKey: string | null = null;
  private _onStateChange: () => void;
  private _onUnavailable: (message: string) => void;
  private _onPlaybackBlocked: () => void;

  constructor(
    onStateChange: () => void,
    onUnavailable: (message: string) => void,
    onPlaybackBlocked: () => void,
  ) {
    this._onStateChange = onStateChange;
    this._onUnavailable = onUnavailable;
    this._onPlaybackBlocked = onPlaybackBlocked;
  }

  get isPlaying() {
    return this.playing;
  }

  get queueLength() {
    return this.queue.length;
  }

  dropPendingCombatNarration() {
    this.queue = this.queue.filter(
      (item) => item.eventType !== "big_hit" && item.eventType !== "elimination",
    );
    this._onStateChange();
  }

  enqueue(
    eventType: CommentaryEventType,
    context: string,
    voiceId: string,
    allowedNames: string[],
    clipKey?: string,
  ) {
    if (clipKey) {
      if (this.currentClipKey === clipKey) return;
      if (this.queue.some((queued) => queued.clipKey === clipKey)) return;
    }
    // Cap queue at 3 to avoid backlog
    if (this.queue.length >= 3) return;
    this.queue.push({ eventType, context, voiceId, allowedNames, clipKey, retries: 0 });
    if (!this.playing) this.playNext();
  }

  stop() {
    this.queue = [];
    if (this.audioEl) {
      this.audioEl.pause();
      this.audioEl.src = "";
    }
    this.cleanup();
    this.currentClipKey = null;
    this.playing = false;
    this._onStateChange();
  }

  setVolume(vol: number) {
    if (this.audioEl) this.audioEl.volume = vol;
  }

  resume() {
    if (!this.playing) this.playNext();
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
      this.currentClipKey = null;
      this._onStateChange();
      return;
    }

    this.playing = true;
    this.currentClipKey = item.clipKey ?? null;
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
          clipKey: item.clipKey,
        }),
      });

      if (!res.ok) {
        if (res.status === 503) {
          const payload = await res.json().catch(() => null);
          const code = typeof payload?.code === "string" ? payload.code : "";
          // Only hard-disable on configuration errors. Provider outages are transient.
          if (code === "COMMENTARY_NOT_CONFIGURED") {
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

          const nextRetry = item.retries + 1;
          if (nextRetry <= 5) {
            const retryAfterMs = Math.min(8_000, 1_000 * nextRetry);
            this.queue.unshift({ ...item, retries: nextRetry });
            this.playing = false;
            this.currentClipKey = null;
            this._onStateChange();
            setTimeout(() => {
              if (!this.playing) this.playNext();
            }, retryAfterMs);
            return;
          }

          const msg =
            payload?.error && typeof payload.error === "string"
              ? payload.error
              : "Commentary service is unavailable.";
          console.warn("[commentary] dropping item after repeated 503s:", msg);
          setTimeout(() => this.playNext(), 300);
          return;
        }
        if (res.status === 429) {
          const retryAfterSec = Number(res.headers.get("retry-after") ?? "1");
          const retryAfterMs = Math.max(1_000, Number.isFinite(retryAfterSec) ? retryAfterSec * 1_000 : 1_000);
          // Requeue the dropped item and retry later instead of hammering the API.
          this.queue.unshift(item);
          this.playing = false;
          this.currentClipKey = null;
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
      audio.playbackRate = PLAYBACK_RATE;

      audio.onended = () => {
        this.cleanup();
        this.currentClipKey = null;
        this.playNext();
      };
      audio.onerror = () => {
        this.cleanup();
        this.currentClipKey = null;
        this.playNext();
      };

      await audio.play();
    } catch (err) {
      const errMsg = String((err as any)?.message ?? "").toLowerCase();
      const errName = String((err as any)?.name ?? "").toLowerCase();
      if (errName.includes("notallowed") || errMsg.includes("not allowed")) {
        this.queue.unshift(item);
        this.playing = false;
        this.currentClipKey = null;
        this._onStateChange();
        this._onPlaybackBlocked();
        return;
      }
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
  const [enabled, setEnabled] = useState(true);
  const [volume, setVolume] = useState(0.8);
  const [isPlaying, setIsPlaying] = useState(false);
  const [serviceError, setServiceError] = useState<string | null>(null);
  const [needsAudioUnlock, setNeedsAudioUnlock] = useState(false);

  const queueRef = useRef<AudioQueue | null>(null);
  const lastRequestTime = useRef(0);
  const prevSeq = useRef(-1);
  const announcedBettingRumblesRef = useRef<Set<string>>(new Set());
  const announcedCombatRumblesRef = useRef<Set<string>>(new Set());
  const lastBettingHypeAtByRumbleRef = useRef<Map<string, number>>(new Map());
  const lastTurnSeenByRumbleRef = useRef<Map<string, number>>(new Map());

  // Load persisted prefs
  useEffect(() => {
    try {
      // Keep commentary on by default every load unless user disables in-session.
      setEnabled(true);
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
      },
      () => {
        setNeedsAudioUnlock(true);
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

  const unlockAudio = useCallback(() => {
    setNeedsAudioUnlock(false);
    queueRef.current?.resume();
  }, []);

  const getVoiceId = useCallback(() => {
    return process.env.NEXT_PUBLIC_ELEVENLABS_VOICE_A ?? "";
  }, []);

  const enqueueCandidate = useCallback((candidate: {
    eventType: CommentaryEventType;
    context: string;
    allowedNames?: string[];
    clipKey?: string;
  } | null) => {
    if (!candidate) return;
    const now = Date.now();
    if (now - lastRequestTime.current < COOLDOWN_MS) return;
    lastRequestTime.current = now;
    queueRef.current?.enqueue(
      candidate.eventType,
      candidate.context,
      getVoiceId(),
      candidate.allowedNames ?? [],
      candidate.clipKey,
    );
  }, [getVoiceId]);

  const toggleEnabled = useCallback(() => {
    setEnabled((prev) => {
      const next = !prev;
      if (next) {
        setServiceError(null);
      }
      try {
        localStorage.setItem(STORAGE_KEY, String(next));
      } catch {}
      return next;
    });
  }, []);

  // Process incoming SSE events
  useEffect(() => {
    if (!enabled || !lastEvent || eventSeq === prevSeq.current) return;
    prevSeq.current = eventSeq;

    const slot = slots?.find((s) => s.slotIndex === lastEvent.slotIndex);
    if (lastEvent.type === "turn_resolved") {
      const slotAny = slot as (CommentarySlotData & { rumbleId?: string }) | undefined;
      const rumbleId =
        typeof slotAny?.rumbleId === "string" && slotAny.rumbleId.length > 0
          ? slotAny.rumbleId
          : `slot-${lastEvent.slotIndex}`;
      const turnNum = Number(lastEvent.data?.turn?.turnNumber ?? lastEvent.data?.turnNumber ?? 0);
      const prevTurn = lastTurnSeenByRumbleRef.current.get(rumbleId) ?? 0;
      if (turnNum > prevTurn) {
        queueRef.current?.dropPendingCombatNarration();
        lastTurnSeenByRumbleRef.current.set(rumbleId, turnNum);
      }
    }
    const candidate = evaluateEvent(lastEvent, slot as CommentarySlotData | undefined);
    enqueueCandidate(candidate);
  }, [enabled, lastEvent, eventSeq, slots, enqueueCandidate]);

  // Fallback: announce betting/combat from polled slot state in case SSE open/start events were missed.
  useEffect(() => {
    if (!enabled || !slots?.length) return;

    for (const slot of slots) {
      const slotAny = slot as CommentarySlotData & { rumbleId?: string };
      const rumbleId = typeof slotAny.rumbleId === "string" ? slotAny.rumbleId : "";
      if (!rumbleId) continue;

      if (slotAny.state === "betting" && !announcedBettingRumblesRef.current.has(rumbleId)) {
        const candidate = evaluateEvent({ type: "betting_open", slotIndex: slotAny.slotIndex, data: {} }, slotAny);
        enqueueCandidate(candidate);
        announcedBettingRumblesRef.current.add(rumbleId);
      }

      if (slotAny.state === "combat" && !announcedCombatRumblesRef.current.has(rumbleId)) {
        const candidate = evaluateEvent({ type: "combat_started", slotIndex: slotAny.slotIndex, data: {} }, slotAny);
        enqueueCandidate(candidate);
        announcedCombatRumblesRef.current.add(rumbleId);
      }
    }
  }, [enabled, slots, enqueueCandidate]);

  // Continuous hype while betting is open so commentary stays alive pre-fight.
  useEffect(() => {
    if (!enabled || !slots?.length) return;

    const timer = setInterval(() => {
      const now = Date.now();
      const bettingSlots = slots
        .filter((slot) => slot.state === "betting")
        .map((slot) => slot as CommentarySlotData & {
          rumbleId?: string;
          bettingDeadline?: string | Date | null;
          totalPool?: number;
          odds?: Array<{ fighterName?: string; solDeployed?: number }>;
        })
        .filter((slot) => typeof slot.rumbleId === "string" && slot.rumbleId.length > 0);

      if (bettingSlots.length === 0) return;

      const target = bettingSlots.sort((a, b) => {
        const aDeadline = a.bettingDeadline ? new Date(a.bettingDeadline).getTime() : Number.MAX_SAFE_INTEGER;
        const bDeadline = b.bettingDeadline ? new Date(b.bettingDeadline).getTime() : Number.MAX_SAFE_INTEGER;
        return aDeadline - bDeadline;
      })[0];

      const rumbleId = target.rumbleId!;
      const lastAt = lastBettingHypeAtByRumbleRef.current.get(rumbleId) ?? 0;
      if (now - lastAt < BETTING_HYPE_INTERVAL_MS) return;

      const deadlineMs = target.bettingDeadline ? new Date(target.bettingDeadline).getTime() : now;
      const secondsLeft = Math.max(0, Math.ceil((deadlineMs - now) / 1000));
      const pool = Number(target.totalPool ?? 0);

      const leaders = (target.odds ?? [])
        .filter((odd) => typeof odd.fighterName === "string" && odd.fighterName.trim().length > 0)
        .sort((a, b) => Number(b.solDeployed ?? 0) - Number(a.solDeployed ?? 0))
        .slice(0, 2)
        .map((odd) => `${odd.fighterName} (${Number(odd.solDeployed ?? 0).toFixed(2)} SOL)`);

      const leaderText = leaders.length > 0 ? ` Current action leaders: ${leaders.join(", ")}.` : "";
      const context = `Betting is still open in slot ${target.slotIndex + 1}. ${secondsLeft}s until lock. Pool stands at ${pool.toFixed(2)} SOL.${leaderText} Place your bets now.`;
      const allowedNames = target.fighters
        .map((fighter) => fighter.name?.trim())
        .filter((name): name is string => Boolean(name));

      enqueueCandidate({
        eventType: "betting_open",
        context,
        allowedNames,
        clipKey: `hype:${rumbleId}:${Math.floor(secondsLeft / 20)}`,
      });
      lastBettingHypeAtByRumbleRef.current.set(rumbleId, now);
    }, BETTING_HYPE_CHECK_MS);

    return () => clearInterval(timer);
  }, [enabled, slots, enqueueCandidate]);

  return (
    <div className="flex items-center gap-2 bg-stone-900/80 border border-stone-700 rounded-sm px-2 py-1">
      {/* Toggle */}
      <button
        onClick={toggleEnabled}
        className={`flex items-center gap-1.5 font-mono text-[10px] transition-colors ${
          enabled ? "text-amber-400" : "text-stone-600 hover:text-stone-400"
        }`}
        title={
          serviceError
            ? `Commentary issue: ${serviceError}`
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
        <span>{enabled ? "LIVE" : "COMMENTARY"}</span>
      </button>

      {enabled && (
        <>
          {needsAudioUnlock && (
            <button
              onClick={unlockAudio}
              className="font-mono text-[9px] text-amber-400 border border-amber-700 rounded-sm px-1 transition-colors hover:text-amber-300"
              title="Tap to enable announcer audio"
            >
              TAP AUDIO
            </button>
          )}

          {/* Playing indicator */}
          {isPlaying && (
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
          )}

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
