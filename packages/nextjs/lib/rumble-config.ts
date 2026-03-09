const ONCHAIN_MAX_FIGHTERS_PER_RUMBLE = 16;
const DEFAULT_FIGHTERS_PER_RUMBLE = 12;
const DEFAULT_MIN_FIGHTERS_TO_START = 12;

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function readIntEnv(name: string): number | null {
  const raw = Number(process.env[name] ?? "");
  return Number.isFinite(raw) ? Math.floor(raw) : null;
}

export const FIGHTERS_PER_RUMBLE = (() => {
  const configured = readIntEnv("FIGHTERS_PER_RUMBLE");
  if (configured === null) return DEFAULT_FIGHTERS_PER_RUMBLE;
  return clampInt(configured, DEFAULT_MIN_FIGHTERS_TO_START, ONCHAIN_MAX_FIGHTERS_PER_RUMBLE);
})();

export const MIN_FIGHTERS_TO_START = (() => {
  const configured = readIntEnv("RUMBLE_MIN_FIGHTERS_TO_START");
  if (configured === null) return Math.min(DEFAULT_MIN_FIGHTERS_TO_START, FIGHTERS_PER_RUMBLE);
  return clampInt(configured, 2, FIGHTERS_PER_RUMBLE);
})();

export const RUMBLE_ONCHAIN_MAX_FIGHTERS = ONCHAIN_MAX_FIGHTERS_PER_RUMBLE;
