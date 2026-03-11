import { parseOnchainRumbleIdNumber } from "~~/lib/rumble-id";
import {
  extractRumbleFighterIds,
  getBettingReadyMarker,
  hasMinimumRumbleFighters,
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

  if (marker?.rumbleId && marker.fighterIds.length >= MIN_ACTIVE_RUMBLE_FIGHTERS) {
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
