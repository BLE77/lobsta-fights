import type { PreGeneratedCommentaryClip } from "./commentary-generator";
import type { VoiceClipMeta } from "./rumble-persistence";

interface TurnPairingLike {
  fighterA?: string;
  fighterB?: string;
  damageToA?: number;
  damageToB?: number;
}

interface TurnLike {
  pairings?: TurnPairingLike[];
}

function toDamage(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function clipForLine(
  fighterId: string,
  fighterName: string,
  lineKey: string,
  clip: VoiceClipMeta | undefined,
): PreGeneratedCommentaryClip | null {
  if (!clip?.audio_url) return null;
  return {
    fighterId,
    fighterName,
    lineKey,
    clip,
  };
}

export function findVoiceClipForTurn(
  turn: TurnLike,
  fighterVoiceClips: Map<string, Record<string, VoiceClipMeta>>,
): PreGeneratedCommentaryClip | null {
  let best: { fighterId: string; damage: number } | null = null;

  for (const pairing of turn.pairings ?? []) {
    const fighterA = pairing.fighterA;
    const fighterB = pairing.fighterB;
    const damageToB = toDamage(pairing.damageToB);
    const damageToA = toDamage(pairing.damageToA);

    if (fighterA && (!best || damageToB > best.damage)) {
      best = { fighterId: fighterA, damage: damageToB };
    }
    if (fighterB && (!best || damageToA > best.damage)) {
      best = { fighterId: fighterB, damage: damageToA };
    }
  }

  if (!best) return null;

  const clips = fighterVoiceClips.get(best.fighterId);
  if (!clips) return null;

  const fighterName = best.fighterId;

  return (
    clipForLine(best.fighterId, fighterName, "special", clips.special) ??
    clipForLine(best.fighterId, fighterName, "attack", clips.attack) ??
    clipForLine(best.fighterId, fighterName, "intro", clips.intro)
  );
}
