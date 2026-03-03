/**
 * Parse the on-chain rumble id (u64-ish integer) from our DB rumble id string.
 * Accepted formats:
 * - "1234567890"
 * - "rumble_1234567890"
 * - same with "-" separators
 *
 * NOTE:
 * Queue-manager IDs like "rumble_<timestamp>_<counter>" are *not* on-chain
 * rumble numbers and must return null. On-chain numeric IDs should come from
 * `ucf_rumbles.rumble_number`.
 */
export function parseOnchainRumbleIdNumber(rumbleId: string): number | null {
  const normalized = String(rumbleId ?? "").trim();
  if (!normalized) return null;

  let numeric = "";
  if (/^\d+$/.test(normalized)) {
    numeric = normalized;
  } else {
    const prefixed = normalized.match(/^rumble[_-](\d+)$/i);
    if (!prefixed) return null;
    numeric = prefixed[1];
  }

  const parsed = Number(numeric);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return null;

  return parsed;
}
