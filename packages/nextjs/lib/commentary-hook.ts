// ---------------------------------------------------------------------------
// Commentary Hook — registers listeners on the orchestrator to pre-generate
// shared commentary clips (text + audio) so all spectators hear the same stream.
//
// Clips are persisted to Supabase (ucf_commentary_clips table) so the
// Vercel status API can read them even though Railway generates them.
// ---------------------------------------------------------------------------

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { RumbleOrchestrator } from "./rumble-orchestrator";
import {
  evaluateEvent,
  type CommentarySlotData,
  type CommentarySSEEvent,
} from "./commentary";
import { generateAndUploadCommentary } from "./commentary-generator";
import type { VoiceClipMeta } from "./rumble-persistence";

// ---------------------------------------------------------------------------
// Supabase client (same pattern as rumble-persistence)
// ---------------------------------------------------------------------------

const noStoreFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, cache: "no-store" });

function freshServiceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing Supabase env vars");
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: noStoreFetch },
  });
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CommentaryEntry {
  clipKey: string;
  text: string;
  audioUrl: string | null;
  eventType: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Supabase persistence — write (Railway) + read (Vercel)
// ---------------------------------------------------------------------------

async function persistClip(
  rumbleId: string,
  entry: CommentaryEntry,
): Promise<void> {
  try {
    const sb = freshServiceClient();
    await sb.from("ucf_commentary_clips").upsert(
      {
        rumble_id: rumbleId,
        clip_key: entry.clipKey,
        event_type: entry.eventType,
        text: entry.text,
        audio_url: entry.audioUrl,
        created_at: new Date(entry.createdAt).toISOString(),
      },
      { onConflict: "rumble_id,clip_key" },
    );
  } catch (err) {
    console.warn("[commentary-hook] persistClip failed:", err);
  }
}

/**
 * Read commentary clips for a rumble from Supabase.
 * Called by the status API (runs on Vercel, separate process from Railway).
 */
export async function getCommentaryForRumble(
  rumbleId: string,
): Promise<CommentaryEntry[]> {
  try {
    const sb = freshServiceClient();
    const { data, error } = await sb
      .from("ucf_commentary_clips")
      .select("clip_key, text, audio_url, event_type, created_at")
      .eq("rumble_id", rumbleId)
      .order("created_at", { ascending: true })
      .limit(20);
    if (error) throw error;
    if (!data) return [];
    return data.map((row) => ({
      clipKey: row.clip_key,
      text: row.text,
      audioUrl: row.audio_url,
      eventType: row.event_type,
      createdAt: new Date(row.created_at).getTime(),
    }));
  } catch (err) {
    console.warn("[commentary-hook] getCommentaryForRumble failed:", err);
    return [];
  }
}

// Prevent duplicate generation for the same clipKey
const inflightKeys = new Set<string>();

// ---------------------------------------------------------------------------
// Voice clip reuse — map combat events to pre-generated announcer voice clips
// ---------------------------------------------------------------------------

type VoiceLineKey =
  | "intro"
  | "hit_landed"
  | "special_landed"
  | "hit_taken"
  | "elim_killer"
  | "elim_victim"
  | "victory";

interface VoiceClipMatch {
  fighterId: string;
  fighterName: string;
  lineKey: VoiceLineKey;
  clip: VoiceClipMeta;
}

/**
 * Given turn data, find the most dramatic event and check if the relevant
 * fighter has a pre-generated voice clip for it. Returns the clip if found.
 *
 * Priority: special_landed > elim_killer > elim_victim > hit_landed > hit_taken
 */
function findVoiceClipForTurn(
  turnData: any,
  fighterVoiceClips: Map<string, Record<string, VoiceClipMeta>>,
): VoiceClipMatch | null {
  const pairings: any[] = turnData?.pairings ?? [];
  const eliminations: string[] = turnData?.eliminations ?? [];

  // Helper to look up a clip for a fighter
  const getClip = (fighterId: string, key: VoiceLineKey): VoiceClipMeta | null => {
    const clips = fighterVoiceClips.get(fighterId);
    if (!clips) return null;
    const clip = clips[key];
    return clip?.audio_url ? clip : null;
  };

  // 1. SPECIAL moves that landed
  for (const p of pairings) {
    if (p.moveA === "SPECIAL" && Number(p.damageToB ?? 0) > 0) {
      const clip = getClip(p.fighterA, "special_landed");
      if (clip) return { fighterId: p.fighterA, fighterName: p.fighterAName ?? p.fighterA, lineKey: "special_landed", clip };
    }
    if (p.moveB === "SPECIAL" && Number(p.damageToA ?? 0) > 0) {
      const clip = getClip(p.fighterB, "special_landed");
      if (clip) return { fighterId: p.fighterB, fighterName: p.fighterBName ?? p.fighterB, lineKey: "special_landed", clip };
    }
  }

  // 2. Eliminations — killer clip first, then victim
  if (eliminations.length > 0) {
    for (const p of pairings) {
      const bDead = eliminations.includes(p.fighterB);
      const aDead = eliminations.includes(p.fighterA);
      if (bDead) {
        const clip = getClip(p.fighterA, "elim_killer");
        if (clip) return { fighterId: p.fighterA, fighterName: p.fighterAName ?? p.fighterA, lineKey: "elim_killer", clip };
      }
      if (aDead) {
        const clip = getClip(p.fighterB, "elim_killer");
        if (clip) return { fighterId: p.fighterB, fighterName: p.fighterBName ?? p.fighterB, lineKey: "elim_killer", clip };
      }
    }
    // Victim clips
    for (const victimId of eliminations) {
      const clip = getClip(victimId, "elim_victim");
      if (clip) return { fighterId: victimId, fighterName: victimId, lineKey: "elim_victim", clip };
    }
  }

  // 3. Big hits — attacker's hit_landed
  const BIG_HIT = 18;
  const bigHits = pairings
    .filter((p: any) => Number(p.damageToA ?? 0) >= BIG_HIT || Number(p.damageToB ?? 0) >= BIG_HIT)
    .sort((a: any, b: any) => {
      const aMax = Math.max(Number(a.damageToA ?? 0), Number(a.damageToB ?? 0));
      const bMax = Math.max(Number(b.damageToA ?? 0), Number(b.damageToB ?? 0));
      return bMax - aMax;
    });

  for (const p of bigHits) {
    if (Number(p.damageToB ?? 0) >= BIG_HIT) {
      const clip = getClip(p.fighterA, "hit_landed");
      if (clip) return { fighterId: p.fighterA, fighterName: p.fighterAName ?? p.fighterA, lineKey: "hit_landed", clip };
    }
    if (Number(p.damageToA ?? 0) >= BIG_HIT) {
      const clip = getClip(p.fighterB, "hit_landed");
      if (clip) return { fighterId: p.fighterB, fighterName: p.fighterBName ?? p.fighterB, lineKey: "hit_landed", clip };
    }
  }

  // 4. Hit taken (defender perspective) — use for biggest hit received
  for (const p of bigHits) {
    if (Number(p.damageToA ?? 0) >= BIG_HIT) {
      const clip = getClip(p.fighterA, "hit_taken");
      if (clip) return { fighterId: p.fighterA, fighterName: p.fighterAName ?? p.fighterA, lineKey: "hit_taken", clip };
    }
    if (Number(p.damageToB ?? 0) >= BIG_HIT) {
      const clip = getClip(p.fighterB, "hit_taken");
      if (clip) return { fighterId: p.fighterB, fighterName: p.fighterBName ?? p.fighterB, lineKey: "hit_taken", clip };
    }
  }

  return null;
}

/**
 * Build a map of fighterId → voice_clips from the orchestrator's combat state.
 */
function collectVoiceClips(
  orchestrator: RumbleOrchestrator,
  slotIndex: number,
): Map<string, Record<string, VoiceClipMeta>> {
  const result = new Map<string, Record<string, VoiceClipMeta>>();
  const combatState = orchestrator.getCombatState(slotIndex);
  if (!combatState) return result;

  for (const [fid, profile] of combatState.fighterProfiles) {
    if (profile.voiceClips && Object.keys(profile.voiceClips).length > 0) {
      result.set(fid, profile.voiceClips);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Build a CommentarySlotData from orchestrator state for evaluateEvent()
// ---------------------------------------------------------------------------

function buildSlotData(
  slotIndex: number,
  rumbleId: string,
  state: "betting" | "combat" | "payout",
  fighters: Array<{
    id: string;
    name: string;
    hp: number;
    eliminatedOnTurn: number | null;
    placement: number;
  }>,
  currentTurn: number,
): CommentarySlotData {
  return {
    slotIndex,
    rumbleId,
    state,
    fighters: fighters.map((f) => ({
      id: f.id,
      name: f.name,
      hp: f.hp,
      maxHp: 100,
      eliminatedOnTurn: f.eliminatedOnTurn,
      placement: f.placement,
      robotMeta: null,
    })),
    currentTurn,
    payout: null,
  };
}

// ---------------------------------------------------------------------------
// Helper: generate + persist a clip
// ---------------------------------------------------------------------------

/**
 * Use a pre-generated voice clip directly — no LLM, no TTS, no upload.
 * Persists to ucf_commentary_clips so the frontend picks it up.
 */
function firePregenClip(
  rumbleId: string,
  clipKey: string,
  eventType: string,
  match: VoiceClipMatch,
): void {
  const fullKey = `${rumbleId}:${clipKey}`;
  if (inflightKeys.has(fullKey)) return;
  inflightKeys.add(fullKey);

  const entry: CommentaryEntry = {
    clipKey,
    text: match.clip.text,
    audioUrl: match.clip.audio_url,
    eventType,
    createdAt: Date.now(),
  };

  persistClip(rumbleId, entry)
    .then(() => {
      console.log(
        `[commentary-hook] Reused pre-gen clip: ${match.lineKey} for ${match.fighterName} (${clipKey})`,
      );
    })
    .catch((err) => {
      console.warn(`[commentary-hook] Failed to persist pre-gen clip:`, err);
    })
    .finally(() => {
      inflightKeys.delete(fullKey);
    });
}

function fireAndPersist(
  rumbleId: string,
  clipKey: string,
  eventType: string,
  context: string,
  allowedNames: string[],
): void {
  const fullKey = `${rumbleId}:${clipKey}`;
  if (inflightKeys.has(fullKey)) return;
  inflightKeys.add(fullKey);

  generateAndUploadCommentary(
    rumbleId,
    clipKey,
    eventType as any,
    context,
    allowedNames,
  )
    .then((result) => {
      if (result) {
        const entry: CommentaryEntry = {
          clipKey,
          text: result.text,
          audioUrl: result.audioUrl,
          eventType,
          createdAt: Date.now(),
        };
        persistClip(rumbleId, entry);
        console.log(
          `[commentary-hook] Generated clip: ${clipKey} (${result.audioUrl ? "uploaded" : "no-upload"})`,
        );
      }
    })
    .catch((err) => {
      console.warn(`[commentary-hook] ${eventType} generation failed:`, err);
    })
    .finally(() => {
      inflightKeys.delete(fullKey);
    });
}

// ---------------------------------------------------------------------------
// Register commentary listeners on orchestrator
// ---------------------------------------------------------------------------

export function registerCommentaryHook(orchestrator: RumbleOrchestrator): void {
  if (!process.env.ELEVENLABS_API_KEY) {
    console.log("[commentary-hook] No ELEVENLABS_API_KEY, skipping registration");
    return;
  }

  console.log("[commentary-hook] Registering shared commentary listeners");

  // ---- turn_resolved ----
  orchestrator.on("turn_resolved", (data) => {
    const combatState = orchestrator.getCombatState(data.slotIndex);
    if (!combatState) return;

    const fighters = combatState.fighters.map((f) => ({
      id: f.id,
      name: combatState.fighterProfiles.get(f.id)?.name ?? f.name,
      hp: f.hp,
      eliminatedOnTurn: f.eliminatedOnTurn,
      placement: f.placement,
    }));

    const slotData = buildSlotData(data.slotIndex, data.rumbleId, "combat", fighters, data.turn.turnNumber);
    const sseEvent: CommentarySSEEvent = {
      type: "turn_resolved",
      slotIndex: data.slotIndex,
      data: { turn: data.turn, remainingFighters: data.remainingFighters },
    };

    const candidate = evaluateEvent(sseEvent, slotData);
    if (!candidate) return;

    const clipKey = candidate.clipKey ?? `turn-${data.turn.turnNumber}`;

    // Try to reuse a pre-generated voice clip for the star fighter of this turn
    const voiceClips = collectVoiceClips(orchestrator, data.slotIndex);
    if (voiceClips.size > 0) {
      const match = findVoiceClipForTurn(data.turn, voiceClips);
      if (match) {
        firePregenClip(data.rumbleId, clipKey, candidate.eventType, match);
        return;
      }
    }

    fireAndPersist(data.rumbleId, clipKey, candidate.eventType, candidate.context, candidate.allowedNames);
  });

  // ---- combat_started ----
  orchestrator.on("combat_started", (data) => {
    const combatState = orchestrator.getCombatState(data.slotIndex);
    const fighters = data.fighters.map((fid) => ({
      id: fid,
      name: combatState?.fighterProfiles.get(fid)?.name ?? fid.slice(0, 8),
      hp: 100,
      eliminatedOnTurn: null,
      placement: 0,
    }));

    const slotData = buildSlotData(data.slotIndex, data.rumbleId, "combat", fighters, 0);
    const candidate = evaluateEvent({ type: "combat_started", slotIndex: data.slotIndex, data: {} }, slotData);
    if (!candidate) return;

    const clipKey = candidate.clipKey ?? "combat-start";

    // Pick a random fighter's intro clip if available
    const voiceClips = collectVoiceClips(orchestrator, data.slotIndex);
    if (voiceClips.size > 0) {
      // Deterministic pick based on rumbleId so it's consistent
      const fighterIds = [...voiceClips.keys()];
      let hash = 0;
      for (let i = 0; i < data.rumbleId.length; i++) hash = (hash * 31 + data.rumbleId.charCodeAt(i)) | 0;
      const picked = fighterIds[Math.abs(hash) % fighterIds.length];
      const clips = voiceClips.get(picked);
      const introClip = clips?.intro;
      if (introClip?.audio_url) {
        const name = combatState?.fighterProfiles.get(picked)?.name ?? picked;
        firePregenClip(data.rumbleId, clipKey, candidate.eventType, {
          fighterId: picked,
          fighterName: name,
          lineKey: "intro",
          clip: introClip,
        });
        return;
      }
    }

    fireAndPersist(data.rumbleId, clipKey, candidate.eventType, candidate.context, candidate.allowedNames);
  });

  // ---- betting_open ----
  orchestrator.on("betting_open", (data) => {
    const combatState = orchestrator.getCombatState(data.slotIndex);
    const fighters = data.fighters.map((fid) => ({
      id: fid,
      name: combatState?.fighterProfiles.get(fid)?.name ?? fid.slice(0, 8),
      hp: 100,
      eliminatedOnTurn: null,
      placement: 0,
    }));

    const slotData = buildSlotData(data.slotIndex, data.rumbleId, "betting", fighters, 0);
    const candidate = evaluateEvent({ type: "betting_open", slotIndex: data.slotIndex, data: {} }, slotData);
    if (!candidate) return;

    fireAndPersist(data.rumbleId, candidate.clipKey ?? "betting-open", candidate.eventType, candidate.context, candidate.allowedNames);
  });

  // ---- rumble_complete ----
  orchestrator.on("rumble_complete", (data) => {
    const combatState = orchestrator.getCombatState(data.slotIndex);
    const fighters = data.result.fighters.map((f) => ({
      id: f.id,
      name: combatState?.fighterProfiles.get(f.id)?.name ?? f.name,
      hp: f.hp,
      eliminatedOnTurn: f.eliminatedOnTurn,
      placement: f.placement,
    }));

    const slotData = buildSlotData(data.slotIndex, data.rumbleId, "payout", fighters, data.result.totalTurns);
    slotData.payout = { totalPool: 0, ichorShowerTriggered: false };
    const candidate = evaluateEvent(
      { type: "rumble_complete", slotIndex: data.slotIndex, data: { result: data.result, winner: data.result.winner } },
      slotData,
    );
    if (!candidate) return;

    const clipKey = candidate.clipKey ?? "payout";

    // Use winner's victory clip if available
    const winnerId = data.result.winner;
    if (winnerId) {
      const voiceClips = collectVoiceClips(orchestrator, data.slotIndex);
      const winnerClips = voiceClips.get(winnerId);
      const victoryClip = winnerClips?.victory;
      if (victoryClip?.audio_url) {
        const name = combatState?.fighterProfiles.get(winnerId)?.name ?? winnerId;
        firePregenClip(data.rumbleId, clipKey, candidate.eventType, {
          fighterId: winnerId,
          fighterName: name,
          lineKey: "victory",
          clip: victoryClip,
        });
        return;
      }
    }

    fireAndPersist(data.rumbleId, clipKey, candidate.eventType, candidate.context, candidate.allowedNames);
  });
}
