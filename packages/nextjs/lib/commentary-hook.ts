// ---------------------------------------------------------------------------
// Commentary Hook — registers listeners on the orchestrator to pre-generate
// shared commentary clips (text + audio) so all spectators hear the same stream.
// ---------------------------------------------------------------------------

import type { RumbleOrchestrator } from "./rumble-orchestrator";
import {
  evaluateEvent,
  type CommentarySlotData,
  type CommentarySSEEvent,
} from "./commentary";
import { generateAndUploadCommentary, type CommentaryClipResult } from "./commentary-generator";

// ---------------------------------------------------------------------------
// In-memory commentary store — keyed by rumbleId, holds latest clips
// ---------------------------------------------------------------------------

export interface CommentaryEntry {
  clipKey: string;
  text: string;
  audioUrl: string | null;
  eventType: string;
  createdAt: number;
}

/** Per-rumble commentary log (latest N entries) */
const MAX_ENTRIES_PER_RUMBLE = 20;
const commentaryStore = new Map<string, CommentaryEntry[]>();

export function getCommentaryForRumble(rumbleId: string): CommentaryEntry[] {
  return commentaryStore.get(rumbleId) ?? [];
}

export function getLatestCommentary(rumbleId: string): CommentaryEntry | null {
  const entries = commentaryStore.get(rumbleId);
  if (!entries || entries.length === 0) return null;
  return entries[entries.length - 1];
}

export function clearCommentaryForRumble(rumbleId: string): void {
  commentaryStore.delete(rumbleId);
}

function storeEntry(rumbleId: string, entry: CommentaryEntry): void {
  let entries = commentaryStore.get(rumbleId);
  if (!entries) {
    entries = [];
    commentaryStore.set(rumbleId, entries);
  }
  entries.push(entry);
  // Trim old entries
  if (entries.length > MAX_ENTRIES_PER_RUMBLE) {
    entries.splice(0, entries.length - MAX_ENTRIES_PER_RUMBLE);
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
// Register commentary listeners on orchestrator
// ---------------------------------------------------------------------------

export function registerCommentaryHook(orchestrator: RumbleOrchestrator): void {
  // Guard: skip if no ElevenLabs key (commentary won't work)
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

    const slotData = buildSlotData(
      data.slotIndex,
      data.rumbleId,
      "combat",
      fighters,
      data.turn.turnNumber,
    );

    const sseEvent: CommentarySSEEvent = {
      type: "turn_resolved",
      slotIndex: data.slotIndex,
      data: {
        turn: data.turn,
        remainingFighters: data.remainingFighters,
      },
    };

    const candidate = evaluateEvent(sseEvent, slotData);
    if (!candidate) return;

    const clipKey = candidate.clipKey ?? `turn-${data.turn.turnNumber}`;
    const fullKey = `${data.rumbleId}:${clipKey}`;
    if (inflightKeys.has(fullKey)) return;
    inflightKeys.add(fullKey);

    generateAndUploadCommentary(
      data.rumbleId,
      clipKey,
      candidate.eventType,
      candidate.context,
      candidate.allowedNames,
    )
      .then((result) => {
        if (result) {
          storeEntry(data.rumbleId, {
            clipKey,
            text: result.text,
            audioUrl: result.audioUrl,
            eventType: candidate.eventType,
            createdAt: Date.now(),
          });
          console.log(`[commentary-hook] Generated clip: ${clipKey} (${result.audioUrl ? "uploaded" : "no-upload"})`);
        }
      })
      .catch((err) => {
        console.warn("[commentary-hook] turn_resolved generation failed:", err);
      })
      .finally(() => {
        inflightKeys.delete(fullKey);
      });
  });

  // ---- combat_started ----
  orchestrator.on("combat_started", (data) => {
    const combatState = orchestrator.getCombatState(data.slotIndex);
    const fighters = data.fighters.map((fid) => {
      const profile = combatState?.fighterProfiles.get(fid);
      return {
        id: fid,
        name: profile?.name ?? fid.slice(0, 8),
        hp: 100,
        eliminatedOnTurn: null,
        placement: 0,
      };
    });

    const slotData = buildSlotData(data.slotIndex, data.rumbleId, "combat", fighters, 0);
    const sseEvent: CommentarySSEEvent = {
      type: "combat_started",
      slotIndex: data.slotIndex,
      data: {},
    };

    const candidate = evaluateEvent(sseEvent, slotData);
    if (!candidate) return;

    const clipKey = candidate.clipKey ?? "combat-start";
    const fullKey = `${data.rumbleId}:${clipKey}`;
    if (inflightKeys.has(fullKey)) return;
    inflightKeys.add(fullKey);

    generateAndUploadCommentary(
      data.rumbleId,
      clipKey,
      candidate.eventType,
      candidate.context,
      candidate.allowedNames,
    )
      .then((result) => {
        if (result) {
          storeEntry(data.rumbleId, {
            clipKey,
            text: result.text,
            audioUrl: result.audioUrl,
            eventType: candidate.eventType,
            createdAt: Date.now(),
          });
        }
      })
      .catch((err) => console.warn("[commentary-hook] combat_started failed:", err))
      .finally(() => inflightKeys.delete(fullKey));
  });

  // ---- betting_open ----
  orchestrator.on("betting_open", (data) => {
    const combatState = orchestrator.getCombatState(data.slotIndex);
    const fighters = data.fighters.map((fid) => {
      const profile = combatState?.fighterProfiles.get(fid);
      return {
        id: fid,
        name: profile?.name ?? fid.slice(0, 8),
        hp: 100,
        eliminatedOnTurn: null,
        placement: 0,
      };
    });

    const slotData = buildSlotData(data.slotIndex, data.rumbleId, "betting", fighters, 0);
    const sseEvent: CommentarySSEEvent = {
      type: "betting_open",
      slotIndex: data.slotIndex,
      data: {},
    };

    const candidate = evaluateEvent(sseEvent, slotData);
    if (!candidate) return;

    const clipKey = candidate.clipKey ?? "betting-open";
    const fullKey = `${data.rumbleId}:${clipKey}`;
    if (inflightKeys.has(fullKey)) return;
    inflightKeys.add(fullKey);

    generateAndUploadCommentary(
      data.rumbleId,
      clipKey,
      candidate.eventType,
      candidate.context,
      candidate.allowedNames,
    )
      .then((result) => {
        if (result) {
          storeEntry(data.rumbleId, {
            clipKey,
            text: result.text,
            audioUrl: result.audioUrl,
            eventType: candidate.eventType,
            createdAt: Date.now(),
          });
        }
      })
      .catch((err) => console.warn("[commentary-hook] betting_open failed:", err))
      .finally(() => inflightKeys.delete(fullKey));
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
    slotData.payout = {
      totalPool: 0,
      ichorShowerTriggered: false,
    };
    const sseEvent: CommentarySSEEvent = {
      type: "rumble_complete",
      slotIndex: data.slotIndex,
      data: { result: data.result, winner: data.result.winner },
    };

    const candidate = evaluateEvent(sseEvent, slotData);
    if (!candidate) return;

    const clipKey = candidate.clipKey ?? "payout";
    const fullKey = `${data.rumbleId}:${clipKey}`;
    if (inflightKeys.has(fullKey)) return;
    inflightKeys.add(fullKey);

    generateAndUploadCommentary(
      data.rumbleId,
      clipKey,
      candidate.eventType,
      candidate.context,
      candidate.allowedNames,
    )
      .then((result) => {
        if (result) {
          storeEntry(data.rumbleId, {
            clipKey,
            text: result.text,
            audioUrl: result.audioUrl,
            eventType: candidate.eventType,
            createdAt: Date.now(),
          });
        }
      })
      .catch((err) => console.warn("[commentary-hook] rumble_complete failed:", err))
      .finally(() => inflightKeys.delete(fullKey));
  });

  // ---- payout_complete (cleanup) ----
  orchestrator.on("slot_recycled", (data) => {
    // Clean up old commentary entries after a delay
    // We keep them around for a bit so late-joining spectators can catch up
    setTimeout(() => {
      // Find rumble IDs that are no longer active for this slot
      for (const [rumbleId] of commentaryStore) {
        const entries = commentaryStore.get(rumbleId);
        if (!entries || entries.length === 0) continue;
        const oldest = entries[0].createdAt;
        if (Date.now() - oldest > 10 * 60 * 1000) {
          commentaryStore.delete(rumbleId);
        }
      }
    }, 60_000);
  });
}
