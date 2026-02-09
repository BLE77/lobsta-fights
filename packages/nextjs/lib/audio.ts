"use client";

export type SoundEffect =
  | "hit_light" | "hit_heavy" | "hit_special"
  | "block" | "dodge" | "catch"
  | "ko_explosion" | "round_start" | "crowd_cheer"
  | "ambient_arena";

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
};

class UCFAudioManager {
  private context: AudioContext | null = null;
  private buffers: Map<SoundEffect, AudioBuffer> = new Map();
  private ambientSource: AudioBufferSourceNode | null = null;
  private gainNode: GainNode | null = null;
  private _muted: boolean;
  private loaded: boolean = false;
  private loading: boolean = false;

  constructor() {
    this._muted = typeof window !== "undefined"
      ? localStorage.getItem("ucf_muted") !== "false" // Default muted
      : true;
  }

  async init(): Promise<void> {
    if (this.loaded || this.loading) return;
    if (typeof window === "undefined") return;

    this.loading = true;

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
    } catch {
      // AudioContext not supported
    } finally {
      this.loading = false;
    }
  }

  play(sound: SoundEffect): void {
    if (!this.context || !this.gainNode || this._muted) return;

    const buffer = this.buffers.get(sound);
    if (!buffer) return;

    // Resume context if suspended (browser autoplay policy)
    if (this.context.state === "suspended") {
      this.context.resume();
    }

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gainNode);
    source.start(0);
  }

  startAmbient(): void {
    if (!this.context || !this.gainNode || this._muted) return;
    this.stopAmbient();

    const buffer = this.buffers.get("ambient_arena");
    if (!buffer) return;

    if (this.context.state === "suspended") {
      this.context.resume();
    }

    this.ambientSource = this.context.createBufferSource();
    this.ambientSource.buffer = buffer;
    this.ambientSource.loop = true;

    // Lower volume for ambient
    const ambientGain = this.context.createGain();
    ambientGain.gain.value = 0.15;
    this.ambientSource.connect(ambientGain);
    ambientGain.connect(this.gainNode);

    this.ambientSource.start(0);
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
      localStorage.setItem("ucf_muted", String(!this._muted));
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
