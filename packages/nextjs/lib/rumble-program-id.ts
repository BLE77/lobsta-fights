// Mainnet betting lives on the dedicated 2Tv... deployment. Never rewrite that
// configured program ID to the devnet/ER combat program.
const CANONICAL_MAINNET_RUMBLE_ENGINE_ID = "2TvW4EfbmMe566ZQWZWd8kX34iFR2DM3oBUpjwpRJcqC";
const LEGACY_MAINNET_RUMBLE_ENGINE_IDS = new Set([
  "638DcfW6NaBweznnzmJe4PyxCw51s3CTkykUNskWnxTU",
]);

export function getCanonicalMainnetRumbleEngineId(): string {
  return CANONICAL_MAINNET_RUMBLE_ENGINE_ID;
}

export function isLegacyMainnetRumbleEngineId(value: string | null | undefined): boolean {
  const normalized = String(value ?? "").trim();
  return normalized.length > 0 && LEGACY_MAINNET_RUMBLE_ENGINE_IDS.has(normalized);
}

export function resolveMainnetRumbleEngineId(
  candidates: Array<string | null | undefined>,
  fallback: string,
): string {
  for (const candidate of candidates) {
    const normalized = String(candidate ?? "").trim();
    if (!normalized) continue;
    if (
      normalized === CANONICAL_MAINNET_RUMBLE_ENGINE_ID ||
      isLegacyMainnetRumbleEngineId(normalized)
    ) {
      return CANONICAL_MAINNET_RUMBLE_ENGINE_ID;
    }
    return CANONICAL_MAINNET_RUMBLE_ENGINE_ID;
  }

  if (
    String(fallback).trim() === CANONICAL_MAINNET_RUMBLE_ENGINE_ID ||
    isLegacyMainnetRumbleEngineId(fallback)
  ) {
    return CANONICAL_MAINNET_RUMBLE_ENGINE_ID;
  }

  return CANONICAL_MAINNET_RUMBLE_ENGINE_ID;
}
