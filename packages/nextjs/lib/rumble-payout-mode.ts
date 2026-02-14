export type RumblePayoutMode = "instant" | "accrue_claim";

/**
 * Runtime payout mode switch.
 * - instant: winners are marked paid immediately in persistence.
 * - accrue_claim: winners are marked pending and must claim.
 */
export function getRumblePayoutMode(): RumblePayoutMode {
  const raw = (process.env.RUMBLE_PAYOUT_MODE ?? "accrue_claim").trim().toLowerCase();
  return raw === "instant" ? "instant" : "accrue_claim";
}

export function isAccrueClaimMode(): boolean {
  return getRumblePayoutMode() === "accrue_claim";
}
