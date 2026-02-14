import fs from "node:fs";
import path from "node:path";

interface RumbleSessionState {
  minRumbleTimestampMs: number;
  resetAtIso: string;
}

const g = globalThis as unknown as { __rumbleSessionState?: RumbleSessionState | null };
const SESSION_FILE_NAME = ".rumble-session.json";

function sessionFilePath(): string {
  return path.resolve(process.cwd(), SESSION_FILE_NAME);
}

function isValidTimestampMs(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1_600_000_000_000 &&
    value < 9_999_999_999_999
  );
}

function parseSessionState(raw: unknown): RumbleSessionState | null {
  if (!raw || typeof raw !== "object") return null;
  const minTs =
    (raw as any).minRumbleTimestampMs ??
    ((): number | null => {
      // Backward compat for previous reset marker.
      const legacy = (raw as any).minRumbleIdNum;
      if (typeof legacy !== "number" || !Number.isSafeInteger(legacy) || legacy <= 0) return null;
      const ts = Number(String(legacy).slice(0, 13));
      return Number.isSafeInteger(ts) ? ts : null;
    })();
  const resetAtIso = String((raw as any).resetAtIso ?? "");
  if (!isValidTimestampMs(minTs)) return null;
  if (!resetAtIso) return null;
  return { minRumbleTimestampMs: minTs, resetAtIso };
}

export function getRumbleSessionState(): RumbleSessionState | null {
  try {
    const file = sessionFilePath();
    if (!fs.existsSync(file)) {
      g.__rumbleSessionState = null;
      return null;
    }
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const state = parseSessionState(parsed);
    g.__rumbleSessionState = state;
    return state;
  } catch {
    g.__rumbleSessionState = null;
    return null;
  }
}

export function getRumbleSessionMinTimestampMs(): number | null {
  return getRumbleSessionState()?.minRumbleTimestampMs ?? null;
}

export function setRumbleSessionMinTimestampMs(minRumbleTimestampMs: number): RumbleSessionState {
  if (!isValidTimestampMs(minRumbleTimestampMs)) {
    throw new Error("Invalid minRumbleTimestampMs");
  }
  const state: RumbleSessionState = {
    minRumbleTimestampMs,
    resetAtIso: new Date().toISOString(),
  };
  fs.writeFileSync(sessionFilePath(), `${JSON.stringify(state, null, 2)}\n`, "utf8");
  g.__rumbleSessionState = state;
  return state;
}

/**
 * Session floor for rumble IDs generated as rumble_<Date.now()>_<counter>.
 */
export function setRumbleSessionNow(): RumbleSessionState {
  return setRumbleSessionMinTimestampMs(Date.now());
}
