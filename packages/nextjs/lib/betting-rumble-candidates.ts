import { PublicKey } from "@solana/web3.js";
import { parseOnchainRumbleIdNumber } from "~~/lib/rumble-id";
import {
  extractRumbleFighterIds,
  type BettingReadyMarker,
  getBettingReadyMarker,
  hasMinimumRumbleFighters,
  lookupFighterWallets,
  loadActiveRumbles,
  MIN_ACTIVE_RUMBLE_FIGHTERS,
} from "~~/lib/rumble-persistence";

export type BettingRumbleCandidate = {
  rumbleId: string;
  rumbleNumber: number | null;
  fighterIds: string[];
  createdAtMs: number;
  source: "local" | "persisted" | "marker";
};

type LocalBettingSlotCandidate = {
  state?: unknown;
  rumbleId?: unknown;
  bettingDeadline?: unknown;
  fighters?: unknown;
};

const BETTING_READY_MARKER_GRACE_MS = Math.max(
  30_000,
  Number(process.env.RUMBLE_BETTING_READY_MARKER_GRACE_MS ?? "600000"),
);

function parseIsoMs(value: string | null | undefined): number {
  if (!value) return Number.NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function normalizeWalletAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new PublicKey(value).toBase58();
  } catch {
    return null;
  }
}

export function isBettingReadyMarkerCurrent(
  marker: Pick<BettingReadyMarker, "armedAtIso" | "bettingDeadlineIso">,
  nowMs: number = Date.now(),
): boolean {
  const armedAtMs = parseIsoMs(marker.armedAtIso);
  const bettingDeadlineMs = parseIsoMs(marker.bettingDeadlineIso);
  if (!Number.isFinite(armedAtMs) || !Number.isFinite(bettingDeadlineMs)) return false;
  if (bettingDeadlineMs < armedAtMs) return false;
  if (armedAtMs > nowMs + BETTING_READY_MARKER_GRACE_MS) return false;
  return nowMs <= bettingDeadlineMs + BETTING_READY_MARKER_GRACE_MS;
}

export async function reconcileOnchainFighterIds(
  candidateFighterIds: string[],
  onchainFighterWallets: Array<PublicKey | string>,
): Promise<string[] | null> {
  if (candidateFighterIds.length === 0 || onchainFighterWallets.length === 0) return null;

  const walletLookup = await lookupFighterWallets(candidateFighterIds);
  const fighterIdByWallet = new Map<string, string>();

  for (const fighterId of candidateFighterIds) {
    const normalizedWallet =
      normalizeWalletAddress(fighterId) ??
      normalizeWalletAddress(walletLookup.get(fighterId));
    if (!normalizedWallet) return null;
    if (fighterIdByWallet.has(normalizedWallet)) return null;
    fighterIdByWallet.set(normalizedWallet, fighterId);
  }

  const resolvedFighterIds: string[] = [];
  for (const wallet of onchainFighterWallets) {
    const normalizedWallet =
      typeof wallet === "string"
        ? normalizeWalletAddress(wallet)
        : wallet.toBase58();
    if (!normalizedWallet) return null;
    const fighterId = fighterIdByWallet.get(normalizedWallet);
    if (!fighterId) return null;
    resolvedFighterIds.push(fighterId);
  }

  return resolvedFighterIds.length === onchainFighterWallets.length ? resolvedFighterIds : null;
}

export function compareBettingRumbleCandidates(
  a: BettingRumbleCandidate,
  b: BettingRumbleCandidate,
): number {
  if (a.rumbleNumber !== null || b.rumbleNumber !== null) {
    if (a.rumbleNumber === null) return 1;
    if (b.rumbleNumber === null) return -1;
    if (b.rumbleNumber !== a.rumbleNumber) return b.rumbleNumber - a.rumbleNumber;
  }
  return b.createdAtMs - a.createdAtMs;
}

export async function loadBettingRumbleCandidatesForSlot(
  slotIndex: number,
): Promise<BettingRumbleCandidate[]> {
  const candidates: BettingRumbleCandidate[] = [];
  const marker = await getBettingReadyMarker(slotIndex).catch(() => null);

  if (
    marker?.rumbleId &&
    marker.fighterIds.length >= MIN_ACTIVE_RUMBLE_FIGHTERS &&
    isBettingReadyMarkerCurrent(marker)
  ) {
    candidates.push({
      rumbleId: marker.rumbleId,
      rumbleNumber: marker.rumbleNumber,
      fighterIds: marker.fighterIds,
      createdAtMs: new Date(marker.armedAtIso).getTime() || Date.now(),
      source: "marker",
    });
  }

  const active = await loadActiveRumbles();
  for (const row of active) {
    if (Number(row.slot_index) !== slotIndex) continue;
    if (String(row.status ?? "").toLowerCase() !== "betting") continue;
    if (!hasMinimumRumbleFighters(row.fighters)) continue;

    const createdAtMs = new Date(row.created_at).getTime();
    if (!Number.isFinite(createdAtMs)) continue;

    candidates.push({
      rumbleId: row.id,
      createdAtMs,
      fighterIds: extractRumbleFighterIds(row.fighters),
      rumbleNumber:
        Number.isSafeInteger(Number((row as any).rumble_number)) && Number((row as any).rumble_number) >= 0
          ? Number((row as any).rumble_number)
          : null,
      source: "persisted",
    });
  }

  candidates.sort(compareBettingRumbleCandidates);

  const deduped = new Map<string, BettingRumbleCandidate>();
  for (const candidate of candidates) {
    if (!candidate.rumbleId) continue;
    if (!deduped.has(candidate.rumbleId)) {
      deduped.set(candidate.rumbleId, candidate);
    }
  }

  return [...deduped.values()];
}

export function prependLocalBettingCandidate(
  candidates: BettingRumbleCandidate[],
  localSlot: LocalBettingSlotCandidate | null,
): BettingRumbleCandidate[] {
  if (
    !localSlot ||
    localSlot.state !== "betting" ||
    !localSlot.rumbleId ||
    !localSlot.bettingDeadline ||
    !Array.isArray(localSlot.fighters) ||
    localSlot.fighters.length < MIN_ACTIVE_RUMBLE_FIGHTERS
  ) {
    return candidates;
  }

  const localRumbleId = String(localSlot.rumbleId).trim();
  const localRumbleNumber = parseOnchainRumbleIdNumber(localRumbleId);
  if (localRumbleNumber === null) {
    return candidates;
  }

  const localCandidate: BettingRumbleCandidate = {
    rumbleId: localRumbleId,
    rumbleNumber: localRumbleNumber,
    fighterIds: localSlot.fighters.map((fighterId) => String(fighterId)).filter(Boolean),
    createdAtMs: Date.now(),
    source: "local",
  };

  const deduped = candidates.filter((candidate) => candidate.rumbleId !== localCandidate.rumbleId);
  return [localCandidate, ...deduped].sort(compareBettingRumbleCandidates);
}
