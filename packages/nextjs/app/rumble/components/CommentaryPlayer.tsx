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
const COOLDOWN_MS = 600;
const BETTING_HYPE_INTERVAL_MS = 20_000;
const BETTING_HYPE_CHECK_MS = 3_000;
const BETTING_HYPE_STALE_MS = 6_000;
const GENERAL_STALE_MS = 10_000;
const PLAYBACK_RATE = 1.12;

const AMBIENT_GAIN = 0.10;
const AMBIENT_DUCK_GAIN = 0.04;
const SFX_GAIN = 0.5;
const VOICE_GAIN = 1.0;

/** SFX map: eventType (+ optional threshold) → mp3 file */
const SFX_MAP: Record<string, string> = {
  betting_open: "/sounds/round-start.mp3",
  combat_start: "/sounds/round-start.mp3",
  elimination: "/sounds/ko-explosion.mp3",
  payout: "/sounds/crowd-cheer.mp3",
  ichor_shower: "/sounds/crowd-cheer.mp3",
  fighter_intro: "/sounds/round-start.mp3",
};

const AMBIENT_PLAYLIST = [
  "/sounds/chrome-knuckles.mp3",
  "/sounds/ucf-1.mp3",
  "/sounds/ucf-2.mp3",
];

const ALL_SOUND_URLS = [
  ...AMBIENT_PLAYLIST,
  "/sounds/round-start.mp3",
  "/sounds/ko-explosion.mp3",
  "/sounds/crowd-cheer.mp3",
];

// Priority events that jump ahead in queue
const HIGH_PRIORITY_EVENTS = new Set<CommentaryEventType>(["elimination", "ichor_shower"]);

function deriveRumbleLabel(rumbleId: string | undefined, slotIndex: number, rumbleNumber?: number | null): string {
  if (rumbleNumber != null && rumbleNumber > 0) {
    return `Rumble #${rumbleNumber}`;
  }
  const raw = typeof rumbleId === "string" ? rumbleId.trim() : "";
  if (!raw) return `Rumble ${slotIndex + 1}`;
  const parts = raw.split(/[_-]+/).filter(Boolean);
  const numericTail = [...parts].reverse().find((part) => /^\d+$/.test(part));
  if (!numericTail) return `Rumble ${slotIndex + 1}`;
  if (numericTail.length <= 6) return `Rumble #${Number(numericTail)}`;
  return `Rumble #${numericTail.slice(-4)}`;
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
  private playlistIndex = 0;

  private voiceQueue: Array<{
    eventType: CommentaryEventType;
    context: string;
    voiceId: string;
    allowedNames: string[];
    clipKey?: string;
    audioUrl?: string;
    retries: number;
    priority: boolean;
    enqueuedAt: number;
  }> = [];
  private processingVoice = false;
  private currentClipKey: string | null = null;

  private _onStateChange: () => void;
  private _onUnavailable: (msg: string) => void;
  private _onPlaybackBlocked: () => void;
  private _globalMuteHandler: ((e: Event) => void) | null = null;
  private _globalMuted = false;
  private _savedVolume = 0.8;

  constructor(
    onStateChange: () => void,
    onUnavailable: (msg: string) => void,
    onPlaybackBlocked: () => void,
  ) {
    this._onStateChange = onStateChange;
    this._onUnavailable = onUnavailable;
    this._onPlaybackBlocked = onPlaybackBlocked;

    // Listen for global mute from AudioToggle
    this._globalMuteHandler = (e: Event) => {
      const muted = (e as CustomEvent).detail?.muted;
      this._globalMuted = !!muted;
      if (this.masterGain) {
        if (muted) {
          this._savedVolume = this.masterGain.gain.value;
          this.masterGain.gain.value = 0;
        } else {
          this.masterGain.gain.value = this._savedVolume;
        }
      }
    };
    if (typeof window !== "undefined") {
      window.addEventListener("ucf-global-mute", this._globalMuteHandler);
    }
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

  /** Drop all pending voice items without stopping current playback */
  clearQueue() {
    this.voiceQueue = [];
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
    if (this._globalMuteHandler && typeof window !== "undefined") {
      window.removeEventListener("ucf-global-mute", this._globalMuteHandler);
    }
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

    // Radio static is synth-only (no file needed)
  }

  // --- Ambient Loop ---

  async startAmbient() {
    if (!this.ctx || !this.ambientGain || this.ambientSource) return;
    // Shuffle start position so it's not always the same first track
    this.playlistIndex = Math.floor(Math.random() * AMBIENT_PLAYLIST.length);
    await this.playNextAmbientTrack();
  }

  private async playNextAmbientTrack() {
    if (!this.ctx || !this.ambientGain) return;
    const url = AMBIENT_PLAYLIST[this.playlistIndex % AMBIENT_PLAYLIST.length];
    const buffer = await this.loadBuffer(url);
    if (!buffer || !this.ctx || !this.ambientGain) return;
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = false;
    source.connect(this.ambientGain);
    this.ambientGain.gain.value = AMBIENT_GAIN;
    source.onended = () => {
      // Advance to next track when current one finishes
      if (this.ambientSource === source) {
        this.ambientSource = null;
        this.playlistIndex++;
        this.playNextAmbientTrack();
      }
    };
    source.start();
    this.ambientSource = source;
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
    const combatTypes = new Set<CommentaryEventType>(["big_hit", "elimination", "combat_start"]);
    this.voiceQueue = this.voiceQueue.filter(
      (item) => !combatTypes.has(item.eventType),
    );
    this._onStateChange();
  }

  /** Drop queued items matching any of the given event types */
  dropByEventType(...types: CommentaryEventType[]) {
    const typeSet = new Set(types);
    this.voiceQueue = this.voiceQueue.filter((item) => !typeSet.has(item.eventType));
    this._onStateChange();
  }

  enqueue(
    eventType: CommentaryEventType,
    context: string,
    voiceId: string,
    allowedNames: string[],
    clipKey?: string,
    audioUrl?: string,
  ) {
    if (clipKey) {
      if (this.currentClipKey === clipKey) return;
      if (this.voiceQueue.some((q) => q.clipKey === clipKey)) return;
    }
    // Cap queue at 5
    if (this.voiceQueue.length >= 5) return;

    const priority = HIGH_PRIORITY_EVENTS.has(eventType);
    const item = {
      eventType,
      context,
      voiceId,
      allowedNames,
      clipKey,
      audioUrl,
      retries: 0,
      priority,
      enqueuedAt: Date.now(),
    };

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
    this._savedVolume = vol;
    if (this.masterGain && !this._globalMuted) {
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

    const age = Date.now() - item.enqueuedAt;
    const staleLimit = item.eventType === "betting_open" ? BETTING_HYPE_STALE_MS : GENERAL_STALE_MS;
    if (age > staleLimit) {
      this.processNextVoice();
      return;
    }

    this.processingVoice = true;
    this.voicePlaying = true;
    this.currentClipKey = item.clipKey ?? null;
    this._onStateChange();

    try {
      let res: Response;

      // If we have a pre-generated audio URL from the server, fetch that directly
      // instead of calling the commentary API (shared stream — all viewers hear same audio)
      if (item.audioUrl) {
        res = await fetch(item.audioUrl);
        if (!res.ok) {
          console.warn("[commentary] Pre-generated audio fetch failed, falling back to API");
          // Fall through to API generation
          res = await this.fetchFromCommentaryApi(item);
        }
      } else {
        res = await this.fetchFromCommentaryApi(item);
      }

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

  private async fetchFromCommentaryApi(item: {
    eventType: CommentaryEventType;
    context: string;
    voiceId: string;
    allowedNames: string[];
    clipKey?: string;
  }): Promise<Response> {
    return fetch("/api/rumble/commentary", {
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
      {/* eqBar keyframe defined in globals.css */}
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
  const announcedPayoutRumblesRef = useRef<Set<string>>(new Set());
  const enqueuedIntrosRef = useRef<Set<string>>(new Set());
  const lastBettingHypeAtByRumbleRef = useRef<Map<string, number>>(new Map());
  const lastTurnSeenByRumbleRef = useRef<Map<string, number>>(new Map());
  const playedSharedClipsRef = useRef<Set<string>>(new Set());
  const initialSeedDoneRef = useRef(false);

  // Pre-seed tracking refs on first slot arrival so we don't replay
  // intros/announcements for fights already in progress after a page refresh.
  useEffect(() => {
    if (initialSeedDoneRef.current || !slots?.length) return;
    initialSeedDoneRef.current = true;

    for (const slot of slots) {
      const slotAny = slot as CommentarySlotData & {
        rumbleId?: string;
        turns?: Array<{ turnNumber: number }>;
        commentary?: Array<{ clipKey: string; audioUrl: string | null }>;
      };
      const rumbleId = typeof slotAny.rumbleId === "string" ? slotAny.rumbleId : "";
      if (!rumbleId) continue;

      // Mark state-transition announcements as done
      if (slotAny.state === "betting" || slotAny.state === "combat" || slotAny.state === "payout") {
        announcedBettingRumblesRef.current.add(rumbleId);
        enqueuedIntrosRef.current.add(rumbleId);
      }
      if (slotAny.state === "combat" || slotAny.state === "payout") {
        announcedCombatRumblesRef.current.add(rumbleId);
      }
      if (slotAny.state === "payout") {
        announcedPayoutRumblesRef.current.add(rumbleId);
      }

      // Mark current turn as seen
      const turnCount = typeof slotAny.currentTurn === "number" ? slotAny.currentTurn : 0;
      if (turnCount > 0) {
        lastTurnSeenByRumbleRef.current.set(rumbleId, turnCount);
      }

      // Mark shared clips as played
      const commentary = slotAny.commentary;
      if (Array.isArray(commentary)) {
        for (const clip of commentary) {
          if (clip.audioUrl && clip.clipKey) {
            playedSharedClipsRef.current.add(`${rumbleId}:${clip.clipKey}`);
          }
        }
      }
    }
  }, [slots]);

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

  // Restore enabled state from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === "false") setEnabled(false);
    } catch {}
  }, []);

  // Browser autoplay policy requires a user gesture before audio context can
  // start. Track first interaction and avoid eager audio init before that.
  // Listen for mousemove + scroll too so the user doesn't need to explicitly click.
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
    window.addEventListener("mousemove", unlock, { once: true, passive: true });
    window.addEventListener("scroll", unlock, { once: true, passive: true });
    window.addEventListener("touchstart", unlock, { once: true, passive: true });
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
      window.removeEventListener("mousemove", unlock);
      window.removeEventListener("scroll", unlock);
      window.removeEventListener("touchstart", unlock);
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
        // Pre-seed tracking refs with current active rumbles so we don't
        // replay intros/announcements for fights already in progress.
        if (slots?.length) {
          for (const slot of slots) {
            const slotAny = slot as CommentarySlotData & { rumbleId?: string };
            const rumbleId = typeof slotAny.rumbleId === "string" ? slotAny.rumbleId : "";
            if (!rumbleId) continue;
            if (slotAny.state === "betting" || slotAny.state === "combat" || slotAny.state === "payout") {
              announcedBettingRumblesRef.current.add(rumbleId);
              enqueuedIntrosRef.current.add(rumbleId);
            }
            if (slotAny.state === "combat" || slotAny.state === "payout") {
              announcedCombatRumblesRef.current.add(rumbleId);
            }
            if (slotAny.state === "payout") {
              announcedPayoutRumblesRef.current.add(rumbleId);
            }
            // Mark current turn as seen so we don't replay old turn narration
            const turnCount = typeof (slotAny as any).currentTurn === "number" ? (slotAny as any).currentTurn : 0;
            if (turnCount > 0) {
              lastTurnSeenByRumbleRef.current.set(rumbleId, turnCount);
            }
          }
        }
        // Also mark all existing shared commentary clips as played
        if (slots?.length) {
          for (const slot of slots) {
            const slotAny = slot as CommentarySlotData & { rumbleId?: string; commentary?: Array<{ clipKey: string; audioUrl: string | null }> };
            const commentary = slotAny.commentary;
            if (!Array.isArray(commentary)) continue;
            for (const clip of commentary) {
              if (clip.audioUrl && clip.clipKey) {
                playedSharedClipsRef.current.add(`${slotAny.rumbleId ?? ""}:${clip.clipKey}`);
              }
            }
          }
        }
        // Clear any stale queue items from a previous session
        mixerRef.current?.clearQueue();
      }
      try {
        localStorage.setItem(STORAGE_KEY, String(next));
      } catch {}
      return next;
    });
  }, [slots]);

  // Shared commentary stream: pick up pre-generated clips from status API
  // These take priority over client-side generation — all viewers hear the same audio.
  useEffect(() => {
    if (!enabled || !slots?.length) return;
    const mixer = mixerRef.current;
    if (!mixer) return;

    for (const slot of slots) {
      const slotAny = slot as CommentarySlotData & {
        rumbleId?: string;
        commentary?: Array<{
          clipKey: string;
          text: string;
          audioUrl: string | null;
          eventType: string;
          createdAt: number;
        }>;
      };
      const commentary = slotAny.commentary;
      if (!Array.isArray(commentary) || commentary.length === 0) continue;

      for (const clip of commentary) {
        if (!clip.audioUrl || !clip.clipKey) continue;
        const fullKey = `${slotAny.rumbleId ?? ""}:${clip.clipKey}`;
        if (playedSharedClipsRef.current.has(fullKey)) continue;
        playedSharedClipsRef.current.add(fullKey);

        // Enqueue with the pre-generated audio URL — mixer will fetch it directly
        mixer.enqueue(
          (clip.eventType as CommentaryEventType) ?? "big_hit",
          clip.text,
          getVoiceId(),
          [],
          clip.clipKey,
          clip.audioUrl,
        );
      }
    }
  }, [enabled, slots, getVoiceId]);

  // Process incoming SSE events — generate client-side commentary for turns
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
          const introFighters = fighters.slice(0, 2);
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
        // Flush stale betting lines — combat is starting, "betting still open" is irrelevant
        const mixer = mixerRef.current;
        if (mixer) {
          if (typeof mixer.dropByEventType === "function") {
            mixer.dropByEventType("betting_open");
          } else {
            mixer.clearQueue();
          }
        }
        const candidate = evaluateEvent({ type: "combat_started", slotIndex: slotAny.slotIndex, data: {} }, slotAny);
        enqueueCandidate(candidate);
        announcedCombatRumblesRef.current.add(rumbleId);
      }

      if (slotAny.state === "payout" && !announcedPayoutRumblesRef.current.has(rumbleId)) {
        const candidate = evaluateEvent({ type: "rumble_complete", slotIndex: slotAny.slotIndex, data: {} }, slotAny);
        enqueueCandidate(candidate);
        announcedPayoutRumblesRef.current.add(rumbleId);
      }
    }
  }, [enabled, slots, enqueueCandidate, getVoiceId]);

  // Poll-based combat narration: detect new turns from polled slot data.
  // This is the PRIMARY path for combat commentary — SSE events only arrive
  // when the worker runs in the same process (Railway), not on Vercel or local dev.
  useEffect(() => {
    if (!enabled || !slots?.length) return;

    for (const slot of slots) {
      const slotAny = slot as CommentarySlotData & {
        rumbleId?: string;
        turns?: Array<{
          turnNumber: number;
          pairings: Array<{
            fighterA: string;
            fighterB: string;
            fighterAName?: string;
            fighterBName?: string;
            moveA: string;
            moveB: string;
            damageToA: number;
            damageToB: number;
          }>;
          eliminations: string[];
          bye?: string;
        }>;
      };
      if (slotAny.state !== "combat" && slotAny.state !== "payout") continue;
      const rumbleId = typeof slotAny.rumbleId === "string" ? slotAny.rumbleId : "";
      if (!rumbleId) continue;

      const currentTurn = typeof slotAny.currentTurn === "number" ? slotAny.currentTurn : 0;
      const prevTurn = lastTurnSeenByRumbleRef.current.get(rumbleId) ?? 0;
      if (currentTurn <= prevTurn) continue;

      // New turn(s) detected — narrate the latest one
      lastTurnSeenByRumbleRef.current.set(rumbleId, currentTurn);

      const turns = Array.isArray(slotAny.turns) ? slotAny.turns : [];
      const latestTurn = turns.find((t) => t.turnNumber === currentTurn) ?? turns[turns.length - 1];
      if (!latestTurn || !latestTurn.pairings?.length) continue;

      // Build a synthetic turn_resolved event from polled turn data
      const remaining = slotAny.fighters.filter((f) => !f.eliminatedOnTurn).length;
      const candidate = evaluateEvent(
        {
          type: "turn_resolved",
          slotIndex: slotAny.slotIndex,
          data: {
            turn: {
              turnNumber: latestTurn.turnNumber,
              pairings: latestTurn.pairings,
              eliminations: latestTurn.eliminations ?? [],
            },
            remainingFighters: remaining,
          },
        },
        slotAny,
      );
      enqueueCandidate(candidate);
    }
  }, [enabled, slots, enqueueCandidate]);

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
      const rumbleLabel = deriveRumbleLabel(rumbleId, target.slotIndex, (target as any).rumbleNumber);
      const lastAt = lastBettingHypeAtByRumbleRef.current.get(rumbleId) ?? 0;
      if (now - lastAt < BETTING_HYPE_INTERVAL_MS) return;

      const deadlineMs = target.bettingDeadline ? new Date(target.bettingDeadline).getTime() : now;
      if (deadlineMs <= now) return;

      const leaders = (target.odds ?? [])
        .filter((odd) => typeof odd.fighterName === "string" && odd.fighterName.trim().length > 0)
        .sort((a, b) => Number(b.solDeployed ?? 0) - Number(a.solDeployed ?? 0))
        .slice(0, 2)
        .map((odd) => odd.fighterName!);

      const leaderText = leaders.length > 0 ? ` Eyes on ${leaders.join(" and ")}.` : "";

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

      // Vary the hype template
      const templates = [
        `Betting is still OPEN for ${rumbleLabel}. Place your bets now!${leaderText}${loreBite}`,
        `Betting window is active for ${rumbleLabel}. Fighters are ready.${leaderText}${loreBite}`,
        `Bets are live for ${rumbleLabel}. Who are you backing?${leaderText}${loreBite}`,
        `Last call for ${rumbleLabel}. Combat is approaching.${leaderText}${loreBite}`,
        `Deploy your SOL for ${rumbleLabel}. The arena awaits.${leaderText}${loreBite}`,
      ];
      const templateIndex = Math.floor(now / BETTING_HYPE_INTERVAL_MS) % templates.length;
      const context = templates[templateIndex];

      const allowedNames = target.fighters
        .map((fighter) => fighter.name?.trim())
        .filter((name): name is string => Boolean(name));

      enqueueCandidate({
        eventType: "betting_open",
        context,
        allowedNames,
        clipKey: `hype:${rumbleId}:${Math.floor(now / BETTING_HYPE_INTERVAL_MS)}`,
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
              className="font-mono text-[10px] text-amber-400 bg-amber-900/40 border border-amber-600 rounded-sm px-2 py-0.5 transition-colors hover:text-amber-300 hover:bg-amber-800/50 animate-pulse"
              title="Tap to enable announcer audio"
            >
              TAP TO LISTEN
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
