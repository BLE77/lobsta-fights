export const MAX_TURNS_ERROR_TOKENS = [
  "maxturnsreached",
  "error number: 6033",
  "custom program error: 0x1791",
  "max combat turns reached",
];

function normalizeErrorText(err: unknown): string {
  if (typeof err === "string") return err.toLowerCase();
  if (err instanceof Error) {
    const message = typeof err.message === "string" ? err.message : "";
    const stack = typeof err.stack === "string" ? err.stack : "";
    return `${message}\n${stack}`.toLowerCase();
  }
  try {
    return JSON.stringify(err).toLowerCase();
  } catch {
    return String(err).toLowerCase();
  }
}

export function isMaxTurnsReachedError(err: unknown): boolean {
  const text = normalizeErrorText(err);
  return MAX_TURNS_ERROR_TOKENS.some((token) => text.includes(token));
}

export function shouldForceMaxTurnFallback(params: {
  currentTurn: number;
  maxCombatTurns: number;
  remainingFighters: number;
  turnResolved: boolean;
  currentSlot: bigint;
  revealCloseSlot: bigint;
}): boolean {
  return (
    params.turnResolved &&
    params.remainingFighters > 1 &&
    params.currentTurn >= params.maxCombatTurns &&
    params.currentSlot >= params.revealCloseSlot
  );
}
