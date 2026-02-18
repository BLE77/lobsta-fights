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

    fireAndPersist(data.rumbleId, candidate.clipKey ?? `turn-${data.turn.turnNumber}`, candidate.eventType, candidate.context, candidate.allowedNames);
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

    fireAndPersist(data.rumbleId, candidate.clipKey ?? "combat-start", candidate.eventType, candidate.context, candidate.allowedNames);
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

    fireAndPersist(data.rumbleId, candidate.clipKey ?? "payout", candidate.eventType, candidate.context, candidate.allowedNames);
  });
}
