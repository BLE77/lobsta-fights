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
import {
  generateAndUploadCommentary,
  type PreGeneratedCommentaryClip,
} from "./commentary-generator";
import { findVoiceClipForTurn } from "./commentary-voice-clips";
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
  /** Explicit source tag so the frontend knows exactly how to handle broken URLs */
  source: "pregen" | "dynamic";
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
        source: entry.source,
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
      .select("clip_key, text, audio_url, event_type, created_at, source")
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
      source: (row.source === "pregen" ? "pregen" : "dynamic") as "pregen" | "dynamic",
    }));
  } catch (err) {
    console.warn("[commentary-hook] getCommentaryForRumble failed:", err);
    return [];
  }
}

// Prevent duplicate generation for the same clipKey
const inflightKeys = new Set<string>();

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

function fireAndPersist(
  rumbleId: string,
  clipKey: string,
  eventType: string,
  context: string,
  allowedNames: string[],
  preGeneratedClip: PreGeneratedCommentaryClip | null = null,
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
    { preGeneratedClip },
  )
    .then((result) => {
      if (result) {
        const entry: CommentaryEntry = {
          clipKey,
          text: result.text,
          audioUrl: result.audioUrl,
          eventType,
          createdAt: Date.now(),
          source: result.source === "pre_generated" ? "pregen" : "dynamic",
        };
        persistClip(rumbleId, entry);
        if (result.source === "pre_generated" && result.preGeneratedClip) {
          console.log(
            `[commentary-hook] Persisted pre-gen clip: ${result.preGeneratedClip.lineKey} for ${result.preGeneratedClip.fighterName} (${clipKey})`,
          );
        } else {
          console.log(
            `[commentary-hook] Generated dynamic clip: ${clipKey} (${result.audioUrl ? "uploaded" : "no-upload"})`,
          );
        }
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
    console.log("[commentary-hook] No ELEVENLABS_API_KEY; running in text-only commentary mode");
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
    const match = voiceClips.size > 0 ? findVoiceClipForTurn(data.turn, voiceClips) : null;

    fireAndPersist(
      data.rumbleId,
      clipKey,
      candidate.eventType,
      candidate.context,
      candidate.allowedNames,
      match,
    );
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
      if (introClip) {
        const name = combatState?.fighterProfiles.get(picked)?.name ?? picked;
        fireAndPersist(
          data.rumbleId,
          clipKey,
          candidate.eventType,
          candidate.context,
          candidate.allowedNames,
          {
            fighterId: picked,
            fighterName: name,
            lineKey: "intro",
            clip: introClip,
          },
        );
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
      if (victoryClip) {
        const name = combatState?.fighterProfiles.get(winnerId)?.name ?? winnerId;
        fireAndPersist(
          data.rumbleId,
          clipKey,
          candidate.eventType,
          candidate.context,
          candidate.allowedNames,
          {
            fighterId: winnerId,
            fighterName: name,
            lineKey: "victory",
            clip: victoryClip,
          },
        );
        return;
      }
    }

    fireAndPersist(data.rumbleId, clipKey, candidate.eventType, candidate.context, candidate.allowedNames);
  });
}
