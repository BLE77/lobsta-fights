"use client";

export type SoundEffect =
  | "hit_light" | "hit_heavy" | "hit_special"
  | "block" | "dodge" | "catch"
  | "ko_explosion" | "round_start" | "crowd_cheer"
  | "ambient_arena" | "radio_static";

const SOUND_FILES: Record<SoundEffect, string> = {
  hit_light: "/sounds/hit-light.wav",
  hit_heavy: "/sounds/hit-heavy.wav",
  hit_special: "/sounds/hit-special.wav",
  block: "/sounds/block.wav",
  dodge: "/sounds/dodge.wav",
  catch: "/sounds/catch.wav",
  ko_explosion: "/sounds/ko-explosion.wav",
  round_start: "/sounds/round-start.wav",
  crowd_cheer: "/sounds/crowd-cheer.wav",
  ambient_arena: "/sounds/ambient-arena.wav",
  radio_static: "/sounds/radio-static.wav",
};

class UCFAudioManager {
  private context: AudioContext | null = null;
  private buffers: Map<SoundEffect, AudioBuffer> = new Map();
  private ambientSource: AudioBufferSourceNode | null = null;
  private gainNode: GainNode | null = null;
  private _muted: boolean;
  private loaded: boolean = false;
  private initPromise: Promise<void> | null = null;

  constructor() {
    this._muted = typeof window !== "undefined"
      ? localStorage.getItem("ucf_muted") === "true"
      : true;
  }

  init(): Promise<void> {
    if (this.loaded) return Promise.resolve();
    if (this.initPromise) return this.initPromise;
    if (typeof window === "undefined") return Promise.resolve();

    this.initPromise = this._doInit();
    return this.initPromise;
  }

  private async _doInit(): Promise<void> {
    try {
      this.context = new AudioContext();
      this.gainNode = this.context.createGain();
      this.gainNode.connect(this.context.destination);
      this.gainNode.gain.value = this._muted ? 0 : 0.5;

      // Load all sounds in parallel
      const entries = Object.entries(SOUND_FILES) as [SoundEffect, string][];
      await Promise.allSettled(
        entries.map(async ([name, url]) => {
          try {
            const response = await fetch(url);
            if (!response.ok) return;
            const arrayBuffer = await response.arrayBuffer();
            const audioBuffer = await this.context!.decodeAudioData(arrayBuffer);
            this.buffers.set(name, audioBuffer);
          } catch {
            // Silently skip missing sounds
          }
        })
      );

      this.loaded = true;
      console.log(`[Audio] Loaded ${this.buffers.size}/${entries.length} sound buffers`);
    } catch (e) {
      console.warn("[Audio] Init failed:", e);
      this.initPromise = null;
    }
  }

  play(sound: SoundEffect): void {
    if (this._muted) return;

    // If not yet loaded, wait for init then play
    if (!this.context || !this.gainNode) {
      this.init().then(() => this._playImmediate(sound));
      return;
    }

    this._playImmediate(sound);
  }

  private _playImmediate(sound: SoundEffect): void {
    if (!this.context || !this.gainNode || this._muted) return;

    const buffer = this.buffers.get(sound);
    if (!buffer) return;

    const playNow = () => {
      const source = this.context!.createBufferSource();
      source.buffer = buffer;
      source.connect(this.gainNode!);
      source.start(0);
    };

    // Resume context if suspended (browser autoplay policy)
    if (this.context.state === "suspended") {
      this.context.resume().then(playNow);
    } else {
      playNow();
    }
  }

  startAmbient(): void {
    if (this._muted) return;

    if (!this.context || !this.gainNode) {
      this.init().then(() => this._startAmbientImmediate());
      return;
    }

    this._startAmbientImmediate();
  }

  private _startAmbientImmediate(): void {
    if (!this.context || !this.gainNode || this._muted) return;
    this.stopAmbient();

    const buffer = this.buffers.get("ambient_arena");
    if (!buffer) return;

    const startLoop = () => {
      this.ambientSource = this.context!.createBufferSource();
      this.ambientSource.buffer = buffer;
      this.ambientSource.loop = true;

      // Lower volume for ambient
      const ambientGain = this.context!.createGain();
      ambientGain.gain.value = 0.15;
      this.ambientSource.connect(ambientGain);
      ambientGain.connect(this.gainNode!);

      this.ambientSource.start(0);
    };

    if (this.context.state === "suspended") {
      this.context.resume().then(startLoop);
    } else {
      startLoop();
    }
  }

  stopAmbient(): void {
    if (this.ambientSource) {
      try { this.ambientSource.stop(); } catch { /* already stopped */ }
      this.ambientSource = null;
    }
  }

  toggleMute(): boolean {
    this._muted = !this._muted;
    if (typeof window !== "undefined") {
      localStorage.setItem("ucf_muted", String(this._muted));
    }

    if (this.gainNode) {
      this.gainNode.gain.value = this._muted ? 0 : 0.5;
    }

    if (this._muted) {
      this.stopAmbient();
    }

    return this._muted;
  }

  get isMuted(): boolean {
    return this._muted;
  }
}

// Singleton instance
export const audioManager = typeof window !== "undefined"
  ? new UCFAudioManager()
  : (null as unknown as UCFAudioManager);

const STRIKE_MOVES = new Set(["HIGH_STRIKE", "MID_STRIKE", "LOW_STRIKE", "SPECIAL"]);
const GUARD_MOVES = new Set(["GUARD_HIGH", "GUARD_MID", "GUARD_LOW"]);

/** Pick the most impactful sound for a single pairing in a turn. */
export function soundForPairing(p: {
  moveA: string;
  moveB: string;
  damageToA: number;
  damageToB: number;
}): SoundEffect {
  const totalDmg = p.damageToA + p.damageToB;

  // Special move landed
  if (p.moveA === "SPECIAL" && p.damageToB > 0) return "hit_special";
  if (p.moveB === "SPECIAL" && p.damageToA > 0) return "hit_special";

  // Catch
  if (p.moveA === "CATCH" || p.moveB === "CATCH") return "catch";

  // Dodge — no damage dealt
  if (p.moveA === "DODGE" || p.moveB === "DODGE") {
    if (totalDmg === 0) return "dodge";
  }

  // Guard blocked an attack
  if (
    (GUARD_MOVES.has(p.moveA) && STRIKE_MOVES.has(p.moveB)) ||
    (GUARD_MOVES.has(p.moveB) && STRIKE_MOVES.has(p.moveA))
  ) {
    if (totalDmg <= 5) return "block";
  }

  // Both defend / no action
  if (GUARD_MOVES.has(p.moveA) && GUARD_MOVES.has(p.moveB)) return "block";

  // Heavy hit (>=18 damage to someone)
  if (p.damageToA >= 18 || p.damageToB >= 18) return "hit_heavy";

  // Any damage at all → light hit
  if (totalDmg > 0) return "hit_light";

  return "hit_light";
}
