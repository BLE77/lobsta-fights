const DEFAULT_TREASURY_ADDRESS = "FXvriUM1dTwDeVXaWTSqGo14jPQk7363FQsQaUP1tvdE";

/**
 * Single source of truth for the treasury destination used by client bet txs
 * and server-side tx verification (devnet/combat).
 */
export function getConfiguredTreasuryAddress(): string {
  return (
    process.env.NEXT_PUBLIC_TREASURY_ADDRESS ??
    process.env.TREASURY_ADDRESS ??
    DEFAULT_TREASURY_ADDRESS
  );
}

/**
 * Mainnet treasury address for betting operations.
 * MUST be explicitly configured — no default to prevent real SOL going to wrong address.
 */
export function getMainnetTreasuryAddress(): string {
  const addr =
    process.env.NEXT_PUBLIC_MAINNET_TREASURY_ADDRESS ??
    process.env.MAINNET_TREASURY_ADDRESS;
  if (!addr) {
    throw new Error(
      "MAINNET_TREASURY_ADDRESS is not set. " +
      "Set NEXT_PUBLIC_MAINNET_TREASURY_ADDRESS or MAINNET_TREASURY_ADDRESS env var before enabling mainnet betting."
    );
  }
  return addr;
}

