/**
 * Parse the on-chain rumble id (u64-ish integer) from our DB rumble id string.
 * Accepted formats:
 * - "1234567890"
 * - "rumble_1234567890"
 * - "rumble_1234567890_7" (legacy queue-manager id; maps to 12345678907)
 * - same with "-" separators
 */
export function parseOnchainRumbleIdNumber(rumbleId: string): number | null {
  const normalized = String(rumbleId ?? "").trim();
  if (!normalized) return null;

  let numeric = "";
  if (/^\d+$/.test(normalized)) {
    numeric = normalized;
  } else {
    const prefixed = normalized.match(/^rumble[_-](\d+)(?:[_-](\d+))?$/i);
    if (!prefixed) return null;
    numeric = `${prefixed[1]}${prefixed[2] ?? ""}`;
  }

  const parsed = Number(numeric);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return null;

  return parsed;
}
