"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  evaluateEvent,
  buildFighterIntroContext,
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
const COOLDOWN_MS = 2_000;
const BETTING_HYPE_INTERVAL_MS = 20_000;
const BETTING_HYPE_CHECK_MS = 3_000;
const PLAYBACK_RATE = 1.12;

const AMBIENT_GAIN = 0.15;
const AMBIENT_DUCK_GAIN = 0.08;
const SFX_GAIN = 0.5;
const VOICE_GAIN = 1.0;

/** SFX map: eventType (+ optional threshold) → wav file */
const SFX_MAP: Record<string, string> = {
  betting_open: "/sounds/round-start.wav",
  combat_start: "/sounds/round-start.wav",
  elimination: "/sounds/ko-explosion.wav",
  big_hit_heavy: "/sounds/hit-heavy.wav",
  big_hit_light: "/sounds/hit-light.wav",
  payout: "/sounds/crowd-cheer.wav",
  ichor_shower: "/sounds/crowd-cheer.wav",
  fighter_intro: "/sounds/round-start.wav",
};

const ALL_SOUND_URLS = [
  "/sounds/ambient-arena.wav",
  "/sounds/round-start.wav",
  "/sounds/ko-explosion.wav",
  "/sounds/hit-heavy.wav",
  "/sounds/hit-light.wav",
  "/sounds/crowd-cheer.wav",
  "/sounds/radio-static.wav",
];

// Priority events that jump ahead in queue
const HIGH_PRIORITY_EVENTS = new Set<CommentaryEventType>(["elimination", "ichor_shower"]);

function deriveRumbleLabel(rumbleId: string | undefined, slotIndex: number): string {
  const raw = typeof rumbleId === "string" ? rumbleId.trim() : "";
  if (!raw) return `Rumble ${slotIndex + 1}`;
  const parts = raw.split(/[_-]+/).filter(Boolean);
  const numericTail = [...parts].reverse().find((part) => /^\d+$/.test(part));
  if (!numericTail) return `Rumble ${slotIndex + 1}`;
  if (numericTail.length <= 6) return `Rumble ${Number(numericTail)}`;
  return `Rumble ${numericTail.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// RadioMixer — Web Audio API based audio engine
// ---------------------------------------------------------------------------

class RadioMixer {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private ambientGain: GainNode | null = null;
  private sfxGain: GainNode | null = null;
  private voiceGain: GainNode | null = null;
  private ambientSource: AudioBufferSourceNode | null = null;
  private voicePlaying = false;

  private bufferCache = new Map<string, AudioBuffer>();
  private preloaded = false;

  private voiceQueue: Array<{
    eventType: CommentaryEventType;
    context: string;
    voiceId: string;
    allowedNames: string[];
    clipKey?: string;
    retries: number;
    priority: boolean;
  }> = [];
  private processingVoice = false;
  private currentClipKey: string | null = null;

  private _onStateChange: () => void;
  private _onUnavailable: (msg: string) => void;
  private _onPlaybackBlocked: () => void;

  constructor(
    onStateChange: () => void,
    onUnavailable: (msg: string) => void,
    onPlaybackBlocked: () => void,
  ) {
    this._onStateChange = onStateChange;
    this._onUnavailable = onUnavailable;
    this._onPlaybackBlocked = onPlaybackBlocked;
  }

  get isPlaying() {
    return this.voicePlaying;
  }

  get queueLength() {
    return this.voiceQueue.length;
  }

  get isAmbientPlaying() {
    return this.ambientSource !== null;
  }

  // --- Init & Teardown ---

  async init() {
    if (this.ctx) return;
    const AudioContextCtor =
      (globalThis as any).AudioContext ?? (globalThis as any).webkitAudioContext;
    if (!AudioContextCtor) {
      throw new Error("Web Audio API is not supported in this browser.");
    }
    const ctx = new AudioContextCtor();
    this.ctx = ctx;

    const masterGain = ctx.createGain();
    masterGain.gain.value = 0.8;
    masterGain.connect(ctx.destination);
    this.masterGain = masterGain;

    const ambientGain = ctx.createGain();
    ambientGain.gain.value = 0;
    ambientGain.connect(masterGain);
    this.ambientGain = ambientGain;

    const sfxGain = ctx.createGain();
    sfxGain.gain.value = SFX_GAIN;
    sfxGain.connect(masterGain);
    this.sfxGain = sfxGain;

    const voiceGain = ctx.createGain();
    voiceGain.gain.value = VOICE_GAIN;
    voiceGain.connect(masterGain);
    this.voiceGain = voiceGain;

    // Resume AudioContext (user gesture required)
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch {
        this._onPlaybackBlocked();
      }
    }
  }

  destroy() {
    this.stopAmbient();
    this.voiceQueue = [];
    this.processingVoice = false;
    this.currentClipKey = null;
    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
    }
    this.masterGain = null;
    this.ambientGain = null;
    this.sfxGain = null;
    this.voiceGain = null;
    this.bufferCache.clear();
    this.preloaded = false;
    this._onStateChange();
  }

  // --- Audio Buffer Loading ---

  private async loadBuffer(url: string): Promise<AudioBuffer | null> {
    if (this.bufferCache.has(url)) return this.bufferCache.get(url)!;
    if (!this.ctx) return null;
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const arrayBuf = await res.arrayBuffer();
      const audioBuf = await this.ctx.decodeAudioData(arrayBuf);
      this.bufferCache.set(url, audioBuf);
      return audioBuf;
    } catch {
      return null;
    }
  }

  async preloadAll() {
    if (this.preloaded) return;
    this.preloaded = true;
    await Promise.allSettled(ALL_SOUND_URLS.map((url) => this.loadBuffer(url)));
  }

  // --- Tune-In Effect ---

  async playTuneInEffect() {
    if (!this.ctx || !this.masterGain) return;

    // Generate 300ms white noise through bandpass filter (radio static)
    const duration = 0.3;
    const sampleRate = this.ctx.sampleRate;
    const numSamples = Math.floor(sampleRate * duration);
    const noiseBuffer = this.ctx.createBuffer(1, numSamples, sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < numSamples; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    const noiseSource = this.ctx.createBufferSource();
    noiseSource.buffer = noiseBuffer;

    const bandpass = this.ctx.createBiquadFilter();
    bandpass.type = "bandpass";
    bandpass.frequency.value = 2000;
    bandpass.Q.value = 5;

    const noiseGain = this.ctx.createGain();
    noiseGain.gain.value = 0.3;

    noiseSource.connect(bandpass);
    bandpass.connect(noiseGain);
    noiseGain.connect(this.masterGain);

    noiseSource.start();
    noiseSource.stop(this.ctx.currentTime + duration);

    // Also try playing the radio-static.wav file
    const staticBuf = await this.loadBuffer("/sounds/radio-static.wav");
    if (staticBuf && this.ctx && this.masterGain) {
      const staticSource = this.ctx.createBufferSource();
      staticSource.buffer = staticBuf;
      const staticGain = this.ctx.createGain();
      staticGain.gain.value = 0.25;
      staticSource.connect(staticGain);
      staticGain.connect(this.masterGain);
      staticSource.start();
    }
  }

  // --- Ambient Loop ---

  async startAmbient() {
    if (!this.ctx || !this.ambientGain || this.ambientSource) return;

    const buffer = await this.loadBuffer("/sounds/ambient-arena.wav");
    if (!buffer || !this.ctx || !this.ambientGain) return;

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(this.ambientGain);
    source.start();
    this.ambientSource = source;

    // Fade in over 800ms
    this.ambientGain.gain.setValueAtTime(0, this.ctx.currentTime);
    this.ambientGain.gain.linearRampToValueAtTime(AMBIENT_GAIN, this.ctx.currentTime + 0.8);
  }

  stopAmbient() {
    if (this.ambientSource) {
      try { this.ambientSource.stop(); } catch {}
      this.ambientSource = null;
    }
    if (this.ambientGain) {
      this.ambientGain.gain.value = 0;
    }
  }

  private duckAmbient() {
    if (!this.ctx || !this.ambientGain) return;
    this.ambientGain.gain.cancelScheduledValues(this.ctx.currentTime);
    this.ambientGain.gain.linearRampToValueAtTime(AMBIENT_DUCK_GAIN, this.ctx.currentTime + 0.15);
  }

  private unduckAmbient() {
    if (!this.ctx || !this.ambientGain) return;
    this.ambientGain.gain.cancelScheduledValues(this.ctx.currentTime);
    this.ambientGain.gain.linearRampToValueAtTime(AMBIENT_GAIN, this.ctx.currentTime + 0.3);
  }

  // --- SFX ---

  async playSfx(eventType: CommentaryEventType, damageAmount?: number) {
    if (!this.ctx || !this.sfxGain) return;

    let sfxKey = eventType as string;
    if (eventType === "big_hit") {
      sfxKey = (damageAmount ?? 0) >= 25 ? "big_hit_heavy" : "big_hit_light";
    }

    const url = SFX_MAP[sfxKey];
    if (!url) return;

    const buffer = await this.loadBuffer(url);
    if (!buffer || !this.ctx || !this.sfxGain) return;

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.sfxGain);
    source.start();
  }

  // --- Voice Queue ---

  dropPendingCombatNarration() {
    this.voiceQueue = this.voiceQueue.filter(
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
      if (this.voiceQueue.some((q) => q.clipKey === clipKey)) return;
    }
    // Cap queue at 5
    if (this.voiceQueue.length >= 5) return;

    const priority = HIGH_PRIORITY_EVENTS.has(eventType);
    const item = { eventType, context, voiceId, allowedNames, clipKey, retries: 0, priority };

    if (priority) {
      // Insert before non-priority items
      const insertIdx = this.voiceQueue.findIndex((q) => !q.priority);
      if (insertIdx >= 0) {
        this.voiceQueue.splice(insertIdx, 0, item);
      } else {
        this.voiceQueue.push(item);
      }
    } else {
      this.voiceQueue.push(item);
    }

    // Play SFX immediately
    this.playSfx(eventType);

    if (!this.processingVoice) this.processNextVoice();
  }

  stop() {
    this.voiceQueue = [];
    this.processingVoice = false;
    this.voicePlaying = false;
    this.currentClipKey = null;
    this.unduckAmbient();
    this._onStateChange();
  }

  setVolume(vol: number) {
    if (this.masterGain) {
      this.masterGain.gain.value = vol;
    }
  }

  resume() {
    if (this.ctx?.state === "suspended") {
      this.ctx.resume();
    }
    if (!this.processingVoice) this.processNextVoice();
  }

  private async processNextVoice() {
    const item = this.voiceQueue.shift();
    if (!item) {
      this.processingVoice = false;
      this.voicePlaying = false;
      this.currentClipKey = null;
      this.unduckAmbient();
      this._onStateChange();
      return;
    }

    this.processingVoice = true;
    this.voicePlaying = true;
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
          if (code === "COMMENTARY_NOT_CONFIGURED") {
            this.voiceQueue = [];
            this.processingVoice = false;
            this.voicePlaying = false;
            this._onStateChange();
            this._onUnavailable(payload?.error ?? "Commentary service is unavailable.");
            return;
          }
          const nextRetry = item.retries + 1;
          if (nextRetry <= 5) {
            const retryAfterMs = Math.min(8_000, 1_000 * nextRetry);
            this.voiceQueue.unshift({ ...item, retries: nextRetry });
            this.processingVoice = false;
            this.voicePlaying = false;
            this.currentClipKey = null;
            this._onStateChange();
            setTimeout(() => {
              if (!this.processingVoice) this.processNextVoice();
            }, retryAfterMs);
            return;
          }
          console.warn("[commentary] dropping item after repeated 503s");
          setTimeout(() => this.processNextVoice(), 300);
          return;
        }
        if (res.status === 429) {
          const retryAfterSec = Number(res.headers.get("retry-after") ?? "1");
          const retryAfterMs = Math.max(1_000, Number.isFinite(retryAfterSec) ? retryAfterSec * 1_000 : 1_000);
          this.voiceQueue.unshift(item);
          this.processingVoice = false;
          this.voicePlaying = false;
          this.currentClipKey = null;
          this._onStateChange();
          setTimeout(() => {
            if (!this.processingVoice) this.processNextVoice();
          }, retryAfterMs);
          return;
        }
        console.warn("[commentary] API error:", res.status);
        setTimeout(() => this.processNextVoice(), 300);
        return;
      }

      if (!this.ctx) {
        setTimeout(() => this.processNextVoice(), 300);
        return;
      }

      // Duck ambient during voice
      this.duckAmbient();

      const arrayBuf = await res.arrayBuffer();
      const audioBuf = await this.ctx.decodeAudioData(arrayBuf);

      const source = this.ctx.createBufferSource();
      source.buffer = audioBuf;
      source.playbackRate.value = PLAYBACK_RATE;
      source.connect(this.voiceGain!);

      source.onended = () => {
        this.currentClipKey = null;
        this.unduckAmbient();
        this.processNextVoice();
      };

      source.start();
    } catch (err) {
      const errMsg = String((err as any)?.message ?? "").toLowerCase();
      const errName = String((err as any)?.name ?? "").toLowerCase();
      if (errName.includes("notallowed") || errMsg.includes("not allowed")) {
        this.voiceQueue.unshift(item);
        this.processingVoice = false;
        this.voicePlaying = false;
        this.currentClipKey = null;
        this._onStateChange();
        this._onPlaybackBlocked();
        return;
      }
      console.warn("[commentary] playback error:", err);
      this.unduckAmbient();
      this.processNextVoice();
    }
  }
}

// ---------------------------------------------------------------------------
// Equalizer Bars Animation
// ---------------------------------------------------------------------------

function EqualizerBars({ active }: { active: boolean }) {
  if (!active) return null;
  return (
    <div className="flex items-end gap-[2px] h-3">
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          className="w-[2px] bg-red-500 rounded-sm"
          style={{
            animation: `eqBar 0.${4 + i * 2}s ease-in-out infinite alternate`,
            height: "40%",
          }}
        />
      ))}
      <style>{`
        @keyframes eqBar {
          0% { height: 20%; }
          100% { height: 100%; }
        }
      `}</style>
    </div>
  );
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
  const [isAmbientActive, setIsAmbientActive] = useState(false);
  const [hasUserGesture, setHasUserGesture] = useState(false);

  const mixerRef = useRef<RadioMixer | null>(null);
  const lastRequestTime = useRef(0);
  const prevSeq = useRef(-1);
  const announcedBettingRumblesRef = useRef<Set<string>>(new Set());
  const announcedCombatRumblesRef = useRef<Set<string>>(new Set());
  const enqueuedIntrosRef = useRef<Set<string>>(new Set());
  const lastBettingHypeAtByRumbleRef = useRef<Map<string, number>>(new Map());
  const lastTurnSeenByRumbleRef = useRef<Map<string, number>>(new Map());

  // Init mixer
  useEffect(() => {
    const mixer = new RadioMixer(
      () => {
        setIsPlaying(mixerRef.current?.isPlaying ?? false);
        setIsAmbientActive(mixerRef.current?.isAmbientPlaying ?? false);
      },
      (message) => {
        setServiceError(message);
      },
      () => {
        setNeedsAudioUnlock(true);
      },
    );
    mixerRef.current = mixer;
    return () => {
      mixer.destroy();
    };
  }, []);

  // Sync volume
  useEffect(() => {
    mixerRef.current?.setVolume(volume);
  }, [volume]);

  // Browser autoplay policy requires a user gesture before audio context can
  // start. Track first interaction and avoid eager audio init before that.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const userActivation = (navigator as Navigator & { userActivation?: { hasBeenActive?: boolean } }).userActivation;
    if (userActivation?.hasBeenActive) {
      setHasUserGesture(true);
      return;
    }
    const unlock = () => setHasUserGesture(true);
    window.addEventListener("pointerdown", unlock, { once: true, passive: true });
    window.addEventListener("keydown", unlock, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  // Start/stop ambient and preload on enable/disable
  useEffect(() => {
    const mixer = mixerRef.current;
    if (!mixer) return;
    let cancelled = false;

    if (enabled && hasUserGesture) {
      setNeedsAudioUnlock(false);
      (async () => {
        try {
          await mixer.init();
          if (cancelled) return;
          await mixer.preloadAll();
          if (cancelled) return;
          await mixer.playTuneInEffect();
          if (cancelled) return;
          await mixer.startAmbient();
          if (!cancelled) setIsAmbientActive(true);
        } catch (err: any) {
          if (cancelled) return;
          const message = err?.message ?? "Commentary audio unavailable on this browser/device.";
          setServiceError(String(message));
        }
      })();
    } else if (!enabled) {
      mixer.stop();
      mixer.stopAmbient();
      setIsAmbientActive(false);
      setNeedsAudioUnlock(false);
    } else {
      setNeedsAudioUnlock(true);
    }
    return () => {
      cancelled = true;
    };
  }, [enabled, hasUserGesture]);

  const unlockAudio = useCallback(async () => {
    setNeedsAudioUnlock(false);
    setHasUserGesture(true);
    const mixer = mixerRef.current;
    if (mixer) {
      await mixer.init();
      mixer.resume();
      if (enabled) {
        await mixer.startAmbient();
        setIsAmbientActive(true);
      }
    }
  }, [enabled]);

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
    mixerRef.current?.enqueue(
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

    try {
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
          mixerRef.current?.dropPendingCombatNarration();
          lastTurnSeenByRumbleRef.current.set(rumbleId, turnNum);
        }
      }
      const candidate = evaluateEvent(lastEvent, slot as CommentarySlotData | undefined);
      enqueueCandidate(candidate);
    } catch (err) {
      console.warn("[commentary] event handling skipped due to malformed payload", err);
    }
  }, [enabled, lastEvent, eventSeq, slots, enqueueCandidate]);

  // Fallback: announce betting/combat from polled slot state + fighter intros
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

        // Enqueue fighter intros (up to 4 notable fighters)
        if (!enqueuedIntrosRef.current.has(rumbleId)) {
          enqueuedIntrosRef.current.add(rumbleId);
          const fighters = Array.isArray(slotAny.fighters) ? slotAny.fighters : [];
          const introFighters = fighters.slice(0, 4);
          for (const fighter of introFighters) {
            const introContext = buildFighterIntroContext(fighter);
            if (!introContext) continue;
            // Use a small delay offset via clipKey uniqueness
            mixerRef.current?.enqueue(
              "fighter_intro",
              introContext,
              getVoiceId(),
              [fighter.name],
              `intro:${rumbleId}:${fighter.id}`,
            );
          }
        }
      }

      if (slotAny.state === "combat" && !announcedCombatRumblesRef.current.has(rumbleId)) {
        const candidate = evaluateEvent({ type: "combat_started", slotIndex: slotAny.slotIndex, data: {} }, slotAny);
        enqueueCandidate(candidate);
        announcedCombatRumblesRef.current.add(rumbleId);
      }
    }
  }, [enabled, slots, enqueueCandidate, getVoiceId]);

  // Continuous hype while betting is open
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
      const rumbleLabel = deriveRumbleLabel(rumbleId, target.slotIndex);
      const lastAt = lastBettingHypeAtByRumbleRef.current.get(rumbleId) ?? 0;
      if (now - lastAt < BETTING_HYPE_INTERVAL_MS) return;

      const deadlineMs = target.bettingDeadline ? new Date(target.bettingDeadline).getTime() : now;
      const secondsLeft = Math.max(0, Math.ceil((deadlineMs - now) / 1000));

      // Don't announce "betting is still open" once the deadline has passed
      if (secondsLeft <= 0) return;

      const pool = Number(target.totalPool ?? 0);

      const leaders = (target.odds ?? [])
        .filter((odd) => typeof odd.fighterName === "string" && odd.fighterName.trim().length > 0)
        .sort((a, b) => Number(b.solDeployed ?? 0) - Number(a.solDeployed ?? 0))
        .slice(0, 2)
        .map((odd) => `${odd.fighterName} (${Number(odd.solDeployed ?? 0).toFixed(2)} SOL)`);

      const leaderText = leaders.length > 0 ? ` Current action leaders: ${leaders.join(", ")}.` : "";

      const featured = target.fighters
        .map((fighter) => fighter.name?.trim())
        .filter((name): name is string => Boolean(name))
        .slice(0, 2);
      const loreBite =
        featured.length >= 2
          ? ` Tale of the tape: ${featured[0]} vs ${featured[1]}.`
          : featured.length === 1
            ? ` Eyes on ${featured[0]} right now.`
            : "";

      // Vary the hype template while keeping the same betting-open phrasing.
      const templates = [
        `Betting is still OPEN for ${rumbleLabel}. ${secondsLeft} seconds until lock in slot ${target.slotIndex + 1}. Pool stands at ${pool.toFixed(2)} SOL.${leaderText}${loreBite} Place your bets now!`,
        `Betting is still OPEN for ${rumbleLabel}. The clock is ticking at ${secondsLeft}s left. Total pool: ${pool.toFixed(2)} SOL.${leaderText}${loreBite}`,
        `Betting is still OPEN for ${rumbleLabel}. ${secondsLeft} seconds left in the window and ${pool.toFixed(2)} SOL on the line.${leaderText}${loreBite}`,
        `Betting is still OPEN for ${rumbleLabel}. Last call incoming: ${secondsLeft}s to deploy in slot ${target.slotIndex + 1}. Pool at ${pool.toFixed(2)} SOL.${leaderText}${loreBite}`,
        `Betting is still OPEN for ${rumbleLabel}. Combat is getting close at ${secondsLeft}s out. ${pool.toFixed(2)} SOL in the pool.${leaderText}${loreBite}`,
      ];
      const templateIndex = Math.floor(secondsLeft / 20) % templates.length;
      const context = templates[templateIndex];

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

  const showOnAir = enabled && (isPlaying || isAmbientActive);

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
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z"
            />
          ) : (
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3zM3 3l18 18"
            />
          )}
        </svg>

        {/* ON AIR label with red glow */}
        {showOnAir ? (
          <span
            className="text-red-500 font-bold tracking-wider"
            style={{
              textShadow: "0 0 6px rgba(239, 68, 68, 0.7), 0 0 12px rgba(239, 68, 68, 0.4)",
            }}
          >
            ON AIR
          </span>
        ) : (
          <span>{enabled ? "LIVE" : "COMMENTARY"}</span>
        )}
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

          {/* Equalizer bars when playing */}
          <EqualizerBars active={isPlaying} />

          {/* Ambient indicator (subtle) */}
          {!isPlaying && isAmbientActive && (
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-500/60 animate-pulse" />
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
