const DEFAULT_TREASURY_ADDRESS = "FXvriUM1dTwDeVXaWTSqGo14jPQk7363FQsQaUP1tvdE";

/**
 * Single source of truth for the treasury destination used by client bet txs
 * and server-side tx verification.
 */
export function getConfiguredTreasuryAddress(): string {
  return (
    process.env.NEXT_PUBLIC_TREASURY_ADDRESS ??
    process.env.TREASURY_ADDRESS ??
    DEFAULT_TREASURY_ADDRESS
  );
}

