"use client";

export type SoundEffect =
  | "hit_light" | "hit_heavy" | "hit_special"
  | "block" | "dodge" | "catch"
  | "ko_explosion" | "round_start" | "crowd_cheer"
  | "bet_placed"
  | "ambient_arena" | "radio_static";

// ---- Synthesized sound generators ----
// Each function takes an AudioContext and a destination GainNode
// and plays a short procedural sound effect.

type SynthFn = (ctx: AudioContext, dest: GainNode) => void;

function synthHitLight(ctx: AudioContext, dest: GainNode) {
  const t = ctx.currentTime;
  // Quick noise burst — punchy snap
  const bufferSize = ctx.sampleRate * 0.08;
  const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / bufferSize, 3);
  }
  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuffer;

  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = 2000;
  filter.Q.value = 1.5;

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.6, t);
  gain.gain.exponentialRampToValueAtTime(0.01, t + 0.08);

  noise.connect(filter).connect(gain).connect(dest);
  noise.start(t);
  noise.stop(t + 0.08);
}

function synthHitHeavy(ctx: AudioContext, dest: GainNode) {
  const t = ctx.currentTime;
  // Deep thump + noise
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(150, t);
  osc.frequency.exponentialRampToValueAtTime(40, t + 0.15);

  const oscGain = ctx.createGain();
  oscGain.gain.setValueAtTime(0.8, t);
  oscGain.gain.exponentialRampToValueAtTime(0.01, t + 0.2);

  osc.connect(oscGain).connect(dest);
  osc.start(t);
  osc.stop(t + 0.2);

  // Noise crunch on top
  const bufferSize = ctx.sampleRate * 0.12;
  const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / bufferSize, 2);
  }
  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuffer;
  const noiseGain = ctx.createGain();
  noiseGain.gain.setValueAtTime(0.5, t);
  noiseGain.gain.exponentialRampToValueAtTime(0.01, t + 0.12);
  noise.connect(noiseGain).connect(dest);
  noise.start(t);
  noise.stop(t + 0.12);
}

function synthHitSpecial(ctx: AudioContext, dest: GainNode) {
  const t = ctx.currentTime;
  // Rising sweep into impact
  const sweep = ctx.createOscillator();
  sweep.type = "sawtooth";
  sweep.frequency.setValueAtTime(200, t);
  sweep.frequency.exponentialRampToValueAtTime(800, t + 0.1);
  sweep.frequency.exponentialRampToValueAtTime(100, t + 0.25);

  const sweepGain = ctx.createGain();
  sweepGain.gain.setValueAtTime(0.5, t);
  sweepGain.gain.setValueAtTime(0.7, t + 0.1);
  sweepGain.gain.exponentialRampToValueAtTime(0.01, t + 0.3);

  const dist = ctx.createWaveShaper();
  const curve = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const x = (i * 2) / 256 - 1;
    curve[i] = Math.tanh(x * 3);
  }
  dist.curve = curve;

  sweep.connect(dist).connect(sweepGain).connect(dest);
  sweep.start(t);
  sweep.stop(t + 0.3);

  // Impact noise
  synthHitHeavy(ctx, dest);
}

function synthBlock(ctx: AudioContext, dest: GainNode) {
  const t = ctx.currentTime;
  // Metallic clang
  const osc1 = ctx.createOscillator();
  osc1.type = "square";
  osc1.frequency.setValueAtTime(800, t);
  osc1.frequency.exponentialRampToValueAtTime(400, t + 0.1);

  const osc2 = ctx.createOscillator();
  osc2.type = "square";
  osc2.frequency.setValueAtTime(1200, t);
  osc2.frequency.exponentialRampToValueAtTime(600, t + 0.08);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.3, t);
  gain.gain.exponentialRampToValueAtTime(0.01, t + 0.12);

  osc1.connect(gain).connect(dest);
  osc2.connect(gain);
  osc1.start(t);
  osc2.start(t);
  osc1.stop(t + 0.12);
  osc2.stop(t + 0.12);
}

function synthDodge(ctx: AudioContext, dest: GainNode) {
  const t = ctx.currentTime;
  // Quick whoosh — filtered noise sweep
  const bufferSize = ctx.sampleRate * 0.2;
  const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    const env = Math.sin((i / bufferSize) * Math.PI);
    data[i] = (Math.random() * 2 - 1) * env;
  }
  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuffer;

  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.setValueAtTime(500, t);
  filter.frequency.exponentialRampToValueAtTime(3000, t + 0.15);
  filter.Q.value = 2;

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.4, t);
  gain.gain.exponentialRampToValueAtTime(0.01, t + 0.2);

  noise.connect(filter).connect(gain).connect(dest);
  noise.start(t);
  noise.stop(t + 0.2);
}

function synthCatch(ctx: AudioContext, dest: GainNode) {
  const t = ctx.currentTime;
  // Grab sound — low thud + squeeze
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(300, t);
  osc.frequency.exponentialRampToValueAtTime(80, t + 0.15);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.7, t);
  gain.gain.exponentialRampToValueAtTime(0.01, t + 0.2);

  osc.connect(gain).connect(dest);
  osc.start(t);
  osc.stop(t + 0.2);

  // Crunch
  const osc2 = ctx.createOscillator();
  osc2.type = "sawtooth";
  osc2.frequency.setValueAtTime(600, t + 0.05);
  osc2.frequency.exponentialRampToValueAtTime(200, t + 0.15);

  const gain2 = ctx.createGain();
  gain2.gain.setValueAtTime(0, t);
  gain2.gain.setValueAtTime(0.3, t + 0.05);
  gain2.gain.exponentialRampToValueAtTime(0.01, t + 0.15);

  osc2.connect(gain2).connect(dest);
  osc2.start(t);
  osc2.stop(t + 0.15);
}

function synthKoExplosion(ctx: AudioContext, dest: GainNode) {
  const t = ctx.currentTime;
  // Deep explosion — low rumble + noise burst
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(80, t);
  osc.frequency.exponentialRampToValueAtTime(20, t + 0.5);

  const oscGain = ctx.createGain();
  oscGain.gain.setValueAtTime(0.8, t);
  oscGain.gain.exponentialRampToValueAtTime(0.01, t + 0.5);

  osc.connect(oscGain).connect(dest);
  osc.start(t);
  osc.stop(t + 0.5);

  // Explosion noise
  const bufferSize = ctx.sampleRate * 0.4;
  const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / bufferSize, 1.5);
  }
  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuffer;

  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.setValueAtTime(3000, t);
  filter.frequency.exponentialRampToValueAtTime(200, t + 0.4);

  const noiseGain = ctx.createGain();
  noiseGain.gain.setValueAtTime(0.6, t);
  noiseGain.gain.exponentialRampToValueAtTime(0.01, t + 0.4);

  noise.connect(filter).connect(noiseGain).connect(dest);
  noise.start(t);
  noise.stop(t + 0.4);
}

function synthRoundStart(ctx: AudioContext, dest: GainNode) {
  const t = ctx.currentTime;
  // Boxing bell — two quick dings
  for (let i = 0; i < 2; i++) {
    const offset = i * 0.15;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(1200, t + offset);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.5, t + offset);
    gain.gain.exponentialRampToValueAtTime(0.01, t + offset + 0.3);

    osc.connect(gain).connect(dest);
    osc.start(t + offset);
    osc.stop(t + offset + 0.3);

    // Harmonic
    const osc2 = ctx.createOscillator();
    osc2.type = "sine";
    osc2.frequency.setValueAtTime(2400, t + offset);
    const gain2 = ctx.createGain();
    gain2.gain.setValueAtTime(0.2, t + offset);
    gain2.gain.exponentialRampToValueAtTime(0.01, t + offset + 0.2);
    osc2.connect(gain2).connect(dest);
    osc2.start(t + offset);
    osc2.stop(t + offset + 0.2);
  }
}

function synthCrowdCheer(ctx: AudioContext, dest: GainNode) {
  const t = ctx.currentTime;
  // Crowd noise — shaped noise with rising energy
  const duration = 1.2;
  const bufferSize = ctx.sampleRate * duration;
  const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    const progress = i / bufferSize;
    const envelope = Math.sin(progress * Math.PI) * (0.5 + 0.5 * Math.sin(progress * 20));
    data[i] = (Math.random() * 2 - 1) * envelope;
  }
  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuffer;

  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.setValueAtTime(1000, t);
  filter.frequency.linearRampToValueAtTime(2000, t + 0.3);
  filter.frequency.linearRampToValueAtTime(1500, t + duration);
  filter.Q.value = 0.5;

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.01, t);
  gain.gain.linearRampToValueAtTime(0.5, t + 0.2);
  gain.gain.setValueAtTime(0.5, t + duration - 0.3);
  gain.gain.exponentialRampToValueAtTime(0.01, t + duration);

  noise.connect(filter).connect(gain).connect(dest);
  noise.start(t);
  noise.stop(t + duration);

  // Victory fanfare on top
  const notes = [523, 659, 784, 1047]; // C5, E5, G5, C6
  notes.forEach((freq, i) => {
    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t + i * 0.12);
    g.gain.linearRampToValueAtTime(0.15, t + i * 0.12 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.01, t + i * 0.12 + 0.25);
    osc.connect(g).connect(dest);
    osc.start(t + i * 0.12);
    osc.stop(t + i * 0.12 + 0.25);
  });
}

function synthRadioStatic(ctx: AudioContext, dest: GainNode) {
  const t = ctx.currentTime;
  const duration = 0.3;
  const bufferSize = ctx.sampleRate * duration;
  const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    data[i] = (Math.random() * 2 - 1) * 0.3;
  }
  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuffer;

  const filter = ctx.createBiquadFilter();
  filter.type = "highpass";
  filter.frequency.value = 3000;

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.3, t);
  gain.gain.exponentialRampToValueAtTime(0.01, t + duration);

  noise.connect(filter).connect(gain).connect(dest);
  noise.start(t);
  noise.stop(t + duration);
}

// Synth-only sounds (game-like combat effects)
const SYNTH_MAP: Partial<Record<SoundEffect, SynthFn>> = {
  hit_light: synthHitLight,
  hit_heavy: synthHitHeavy,
  hit_special: synthHitSpecial,
  block: synthBlock,
  dodge: synthDodge,
  catch: synthCatch,
  radio_static: synthRadioStatic,
};

// File-based sounds (real audio files for atmospheric effects)
const FILE_SOUNDS: Partial<Record<SoundEffect, string>> = {
  ko_explosion: "/sounds/ko-explosion.mp3",
  round_start: "/sounds/round-start.mp3",
  crowd_cheer: "/sounds/crowd-cheer.mp3",
  bet_placed: "/sounds/bet-placed.mp3",
  ambient_arena: "/sounds/ambient-arena.mp3",
};

class UCFAudioManager {
  private context: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private buffers: Map<SoundEffect, AudioBuffer> = new Map();
  private ambientSource: AudioBufferSourceNode | null = null;
  private ambientGainNode: GainNode | null = null;
  private _muted: boolean;
  private _initialized: boolean = false;
  private _filesLoaded: boolean = false;

  constructor() {
    this._muted = typeof window !== "undefined"
      ? localStorage.getItem("ucf_muted") === "true"
      : true;
  }

  async init(): Promise<void> {
    if (this._initialized) return;
    if (typeof window === "undefined") return;

    try {
      this.context = new AudioContext();
      this.gainNode = this.context.createGain();
      this.gainNode.connect(this.context.destination);
      this.gainNode.gain.value = this._muted ? 0 : 0.5;
      this._initialized = true;
      console.log("[Audio] Synth engine initialized");

      // Load file-based sounds in background (don't block init)
      this._loadFiles();
    } catch (e) {
      console.warn("[Audio] Init failed:", e);
    }
  }

  private async _loadFiles(): Promise<void> {
    if (this._filesLoaded || !this.context) return;
    this._filesLoaded = true;

    const entries = Object.entries(FILE_SOUNDS) as [SoundEffect, string][];
    await Promise.allSettled(
      entries.map(async ([name, url]) => {
        try {
          const response = await fetch(url);
          if (!response.ok) return;
          const arrayBuffer = await response.arrayBuffer();
          const audioBuffer = await this.context!.decodeAudioData(arrayBuffer);
          this.buffers.set(name, audioBuffer);
        } catch {
          // Fall back to synth for this sound
        }
      })
    );
    console.log(`[Audio] Loaded ${this.buffers.size}/${entries.length} sound files`);
  }

  play(sound: SoundEffect): void {
    if (this._muted) return;
    if (sound === "ambient_arena") return; // use startAmbient() instead

    if (!this.context || !this.gainNode) {
      this.init().then(() => this._playSynth(sound));
      return;
    }

    this._playSynth(sound);
  }

  private _playSynth(sound: SoundEffect): void {
    if (!this.context || !this.gainNode || this._muted) return;

    const playNow = () => {
      // Try file-based buffer first
      const buffer = this.buffers.get(sound);
      if (buffer) {
        const source = this.context!.createBufferSource();
        source.buffer = buffer;
        source.connect(this.gainNode!);
        source.start(0);
        return;
      }

      // Fall back to synth
      const synthFn = SYNTH_MAP[sound];
      if (synthFn) {
        try {
          synthFn(this.context!, this.gainNode!);
        } catch (e) {
          console.warn("[Audio] Synth error:", e);
        }
      }
    };

    if (this.context.state === "suspended") {
      this.context.resume().then(playNow);
    } else {
      playNow();
    }
  }

  startAmbient(): void {
    // Background ambient disabled
  }

  private _startAmbientLoop(): void {
    // Background ambient disabled
  }

  stopAmbient(): void {
    if (this.ambientSource) {
      try { this.ambientSource.stop(); } catch { /* already stopped */ }
      this.ambientSource = null;
    }
    if (this.ambientGainNode) {
      try { this.ambientGainNode.disconnect(); } catch { /* ok */ }
      this.ambientGainNode = null;
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

  // Any damage at all -> light hit
  if (totalDmg > 0) return "hit_light";

  return "hit_light";
}
