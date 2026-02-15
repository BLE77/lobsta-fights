// ---------------------------------------------------------------------------
// AI Commentary — event filtering + prompt building for Rumble announcer
// ---------------------------------------------------------------------------

/** SSE event shape as seen by the client (from page.tsx) */
export interface CommentarySSEEvent {
  type:
    | "turn"
    | "elimination"
    | "slot_state_change"
    | "bet_placed"
    | "ichor_shower"
    | "turn_resolved"
    | "fighter_eliminated"
    | "rumble_complete"
    | "betting_open"
    | "betting_closed"
    | "combat_started"
    | "payout_complete"
    | "slot_recycled";
  slotIndex: number;
  data: any;
}

/** Slot data shape (subset needed for commentary decisions) */
export interface CommentarySlotData {
  slotIndex: number;
  rumbleId?: string;
  state: "idle" | "betting" | "combat" | "payout";
  fighters: Array<{
    id: string;
    name: string;
    hp: number;
    maxHp: number;
    eliminatedOnTurn: number | null;
    placement: number;
  }>;
  currentTurn: number;
  payout: {
    totalPool: number;
    ichorShowerTriggered: boolean;
    ichorShowerAmount?: number;
  } | null;
}

// ---------------------------------------------------------------------------
// Event classification
// ---------------------------------------------------------------------------

export type CommentaryEventType =
  | "betting_open"
  | "big_hit"
  | "elimination"
  | "combat_start"
  | "rumble_complete"
  | "payout"
  | "ichor_shower";

interface CommentaryCandidate {
  eventType: CommentaryEventType;
  context: string;
  allowedNames: string[];
  clipKey: string;
}

const BIG_HIT_THRESHOLD = 18;

function normalizeKeyPart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 120);
}

function clipKeyFor(
  slot: CommentarySlotData,
  phase: string,
  marker?: string | number | null,
): string {
  const rumbleIdRaw = typeof slot.rumbleId === "string" && slot.rumbleId.trim().length > 0
    ? slot.rumbleId
    : `slot-${slot.slotIndex}`;
  const rumbleId = normalizeKeyPart(rumbleIdRaw);
  const suffix = marker === undefined || marker === null ? "" : `:${normalizeKeyPart(String(marker))}`;
  return `${rumbleId}:${normalizeKeyPart(phase)}${suffix}`;
}

function isLikelyIdentifier(value: string | null | undefined): boolean {
  if (!value) return true;
  const trimmed = value.trim();
  if (!trimmed) return true;
  // Base58 pubkeys or hash-like IDs should never be spoken as fighter names.
  if (/^[1-9A-HJ-NP-Za-km-z]{20,64}$/.test(trimmed)) return true;
  if (/^rumble[_-]/i.test(trimmed)) return true;
  return false;
}

function resolveFighterName(
  slot: CommentarySlotData,
  fighterId?: string,
  providedName?: string,
): string | null {
  if (providedName && !isLikelyIdentifier(providedName)) {
    return providedName.trim();
  }
  if (!fighterId) return null;
  const name = slot.fighters.find((f) => f.id === fighterId)?.name;
  if (name && !isLikelyIdentifier(name)) {
    return name.trim();
  }
  return null;
}

function collectAllowedNames(slot: CommentarySlotData): string[] {
  const uniq = new Set<string>();
  for (const fighter of slot.fighters) {
    const name = fighter.name?.trim();
    if (!name || isLikelyIdentifier(name)) continue;
    uniq.add(name);
  }
  return [...uniq];
}

function statFromName(name: string, salt: number, min: number, max: number): number {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i) + salt) % 1000003;
  }
  const span = max - min + 1;
  return min + (Math.abs(hash) % span);
}

/**
 * Evaluate an SSE event and return a commentary candidate if it's interesting,
 * or null if it should be skipped.
 */
export function evaluateEvent(
  event: CommentarySSEEvent,
  slot: CommentarySlotData | undefined,
): CommentaryCandidate | null {
  if (!slot) return null;
  const allowedNames = collectAllowedNames(slot);

  switch (event.type) {
    case "turn":
    case "turn_resolved": {
      const turn = event.data?.turn ?? event.data;
      const pairings: any[] = turn?.pairings ?? [];
      const eliminations: string[] = turn?.eliminations ?? [];

      // Check for eliminations first (highest priority)
      if (eliminations.length > 0) {
        const turnNumber = Number(turn?.turnNumber ?? slot.currentTurn);
        const eliminated = eliminations
          .map((id: string) => {
            return resolveFighterName(slot, id) ?? "a fighter";
          })
          .join(", ");

        // Find who dealt the killing blow
        const killerInfo = pairings
          .filter((p) => {
            return (
              (eliminations.includes(p.fighterA) && p.damageToA > 0) ||
              (eliminations.includes(p.fighterB) && p.damageToB > 0)
            );
          })
          .map((p) => {
            const fighterAName = resolveFighterName(slot, p.fighterA, p.fighterAName) ?? "a fighter";
            const fighterBName = resolveFighterName(slot, p.fighterB, p.fighterBName) ?? "a fighter";
            if (eliminations.includes(p.fighterB)) {
              return `${fighterAName} eliminated ${fighterBName} with ${p.moveA} for ${p.damageToB} damage`;
            }
            return `${fighterBName} eliminated ${fighterAName} with ${p.moveB} for ${p.damageToA} damage`;
          });

        const remaining =
          typeof event.data?.remainingFighters === "number"
            ? Math.max(0, Math.floor(event.data.remainingFighters))
            : slot.fighters.filter((f) => !f.eliminatedOnTurn).length;
        const context =
          killerInfo.length > 0
            ? `${killerInfo.join(". ")}. ${remaining} fighters remain in slot ${slot.slotIndex + 1}.`
            : `${eliminated} eliminated! ${remaining} fighters remain.`;

        return {
          eventType: "elimination",
          context,
          allowedNames,
          clipKey: clipKeyFor(slot, "turn-elimination", turnNumber),
        };
      }

      // Check for big hits
      const bigHits = pairings.filter(
        (p) => p.damageToA >= BIG_HIT_THRESHOLD || p.damageToB >= BIG_HIT_THRESHOLD,
      );
      if (bigHits.length > 0) {
        const turnNumber = Number(turn?.turnNumber ?? slot.currentTurn);
        const descriptions = bigHits.map((p) => {
          const fighterAName = resolveFighterName(slot, p.fighterA, p.fighterAName) ?? "a fighter";
          const fighterBName = resolveFighterName(slot, p.fighterB, p.fighterBName) ?? "a fighter";
          if (p.damageToB >= BIG_HIT_THRESHOLD && p.damageToA >= BIG_HIT_THRESHOLD) {
            return `${fighterAName} hit ${fighterBName} for ${p.damageToB} with ${p.moveA}, and ${fighterBName} hit back for ${p.damageToA} with ${p.moveB}`;
          }
          if (p.damageToB >= BIG_HIT_THRESHOLD) {
            return `${fighterAName} hit ${fighterBName} for ${p.damageToB} damage with ${p.moveA}`;
          }
          return `${fighterBName} hit ${fighterAName} for ${p.damageToA} damage with ${p.moveB}`;
        });
        return {
          eventType: "big_hit",
          context: `Turn ${turn?.turnNumber ?? slot.currentTurn}: ${descriptions.join(". ")}.`,
          allowedNames,
          clipKey: clipKeyFor(slot, "turn-big-hit", turnNumber),
        };
      }

      // Keep commentary alive every combat turn, even without eliminations/big-hit threshold.
      if (pairings.length > 0) {
        const turnNumber = Number(turn?.turnNumber ?? slot.currentTurn);
        const topExchange = [...pairings].sort((a, b) => {
          const aTotal = Number(a.damageToA ?? 0) + Number(a.damageToB ?? 0);
          const bTotal = Number(b.damageToA ?? 0) + Number(b.damageToB ?? 0);
          return bTotal - aTotal;
        })[0];
        const fighterAName =
          resolveFighterName(slot, topExchange.fighterA, topExchange.fighterAName) ?? "a fighter";
        const fighterBName =
          resolveFighterName(slot, topExchange.fighterB, topExchange.fighterBName) ?? "a fighter";
        const remaining =
          typeof event.data?.remainingFighters === "number"
            ? Math.max(0, Math.floor(event.data.remainingFighters))
            : slot.fighters.filter((f) => !f.eliminatedOnTurn).length;
        const context = `Turn ${turn?.turnNumber ?? slot.currentTurn}: ${fighterAName} hit ${fighterBName} for ${Number(topExchange.damageToB ?? 0)} and ${fighterBName} answered for ${Number(topExchange.damageToA ?? 0)}. ${remaining} fighters remain.`;
        return {
          eventType: "big_hit",
          context,
          allowedNames,
          clipKey: clipKeyFor(slot, "turn-exchange", turnNumber),
        };
      }

      const turnNumber = Number(turn?.turnNumber ?? slot.currentTurn);
      return {
        eventType: "big_hit",
        context: `Turn ${turn?.turnNumber ?? slot.currentTurn} resolved. ${slot.fighters.filter((f) => !f.eliminatedOnTurn).length} fighters remain.`,
        allowedNames,
        clipKey: clipKeyFor(slot, "turn-resolved", turnNumber),
      };
    }

    case "elimination":
    case "fighter_eliminated": {
      // Dedicated elimination event (redundant with turn eliminations, but handle both)
      const name =
        resolveFighterName(slot, event.data?.fighterId, event.data?.fighterName) ??
        "A fighter";
      const remaining =
        typeof event.data?.remainingFighters === "number"
          ? Math.max(0, Math.floor(event.data.remainingFighters))
          : slot.fighters.filter((f) => !f.eliminatedOnTurn).length;
      return {
        eventType: "elimination",
        context: `${name} has been eliminated! ${remaining} fighters remain in slot ${slot.slotIndex + 1}.`,
        allowedNames,
        clipKey: clipKeyFor(
          slot,
          "fighter-eliminated",
          `${event.data?.turnNumber ?? slot.currentTurn}-${event.data?.fighterId ?? name}`,
        ),
      };
    }

    case "combat_started": {
      const fighterNames = slot.fighters.map((f) => f.name).join(", ");
      return {
        eventType: "combat_start",
        context: `Combat begins in slot ${slot.slotIndex + 1}! ${slot.fighters.length} fighters enter: ${fighterNames}.`,
        allowedNames,
        clipKey: clipKeyFor(slot, "combat-start"),
      };
    }

    case "betting_open": {
      const namedFighters = slot.fighters
        .map((f) => f.name?.trim())
        .filter((name): name is string => !!name && !isLikelyIdentifier(name));

      const statLines = namedFighters.slice(0, 4).map((name) => {
        const aggression = statFromName(name, 11, 55, 99);
        const armor = statFromName(name, 29, 45, 95);
        const clutch = statFromName(name, 47, 50, 98);
        return `${name} AGG ${aggression} ARM ${armor} CLT ${clutch}`;
      });

      const statsText =
        statLines.length > 0
          ? ` Stat board: ${statLines.join("; ")}.`
          : "";

      return {
        eventType: "betting_open",
        context: `Betting is OPEN in slot ${slot.slotIndex + 1}. Place your bets now.${statsText}`,
        allowedNames,
        clipKey: clipKeyFor(slot, "betting-open"),
      };
    }

    case "payout_complete":
    case "rumble_complete": {
      const winnerId =
        event.data?.result?.winner ??
        event.data?.winner ??
        slot.fighters
          .filter((f) => !f.eliminatedOnTurn)
          .sort((a, b) => a.placement - b.placement)[0]?.id;
      const winner =
        resolveFighterName(slot, typeof winnerId === "string" ? winnerId : undefined) ??
        "The winner";
      const pool = slot.payout?.totalPool ?? event.data?.payout?.totalPool ?? 0;
      return {
        eventType: "payout",
        context: `Rumble in slot ${slot.slotIndex + 1} is over! ${winner} wins. Total SOL pool: ${pool.toFixed(2)} SOL.`,
        allowedNames,
        clipKey: clipKeyFor(slot, "payout"),
      };
    }

    case "slot_state_change": {
      const newState = event.data?.state;

      if (newState === "combat") {
        const fighterNames = slot.fighters.map((f) => f.name).join(", ");
        return {
          eventType: "combat_start",
          context: `Combat begins in slot ${slot.slotIndex + 1}! ${slot.fighters.length} fighters enter the arena: ${fighterNames}.`,
          allowedNames,
          clipKey: clipKeyFor(slot, "combat-start"),
        };
      }

      if (newState === "betting") {
        const namedFighters = slot.fighters
          .map((f) => f.name?.trim())
          .filter((name): name is string => !!name && !isLikelyIdentifier(name));
        const statLines = namedFighters.slice(0, 4).map((name) => {
          const aggression = statFromName(name, 11, 55, 99);
          const armor = statFromName(name, 29, 45, 95);
          const clutch = statFromName(name, 47, 50, 98);
          return `${name} AGG ${aggression} ARM ${armor} CLT ${clutch}`;
        });
        const statsText = statLines.length > 0 ? ` Stat board: ${statLines.join("; ")}.` : "";
        return {
          eventType: "betting_open",
          context: `Betting is OPEN in slot ${slot.slotIndex + 1}. Place your bets now.${statsText}`,
          allowedNames,
          clipKey: clipKeyFor(slot, "betting-open"),
        };
      }

      if (newState === "payout") {
        const winner = slot.fighters
          .filter((f) => !f.eliminatedOnTurn)
          .sort((a, b) => a.placement - b.placement)[0];
        const winnerName = resolveFighterName(slot, winner?.id, winner?.name) ?? "The winner";
        const pool = slot.payout?.totalPool ?? event.data?.payout?.totalPool ?? 0;
        return {
          eventType: "payout",
          context: `Rumble in slot ${slot.slotIndex + 1} is over! ${winnerName} takes the crown. Total SOL pool: ${pool.toFixed(2)} SOL.`,
          allowedNames,
          clipKey: clipKeyFor(slot, "payout"),
        };
      }

      return null;
    }

    case "ichor_shower": {
      const amount = event.data?.amount ?? event.data?.ichorShowerAmount ?? "???";
      return {
        eventType: "ichor_shower",
        context: `ICHOR SHOWER TRIGGERED! ${amount} ICHOR rains down on the winners! The legendary jackpot has been hit!`,
        allowedNames,
        clipKey: clipKeyFor(slot, "ichor-shower", amount),
      };
    }

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Announcer system prompt
// ---------------------------------------------------------------------------

export const ANNOUNCER_SYSTEM_PROMPT = `You are the announcer for Underground Claw Fights (UCF), an underground robot fight club. You narrate battle royale "Rumble" matches where 8-16 AI-controlled fighters battle to the last bot standing while spectators bet SOL.

Your style:
- Dramatic, punchy, slightly dark humor. Think underground fight club meets pro wrestling announcer.
- Use fighter NAMES (never IDs or technical jargon).
- 1-2 sentences MAXIMUM per response. Keep it tight.
- Reference specific moves and damage numbers when provided.
- Vary your vocabulary — don't repeat the same phrases.
- Hype up big moments (eliminations, huge hits, upsets).
- For ICHOR Shower events, go absolutely wild — it's a rare jackpot.
- Never break character. You ARE the voice of the underground.`;

// ---------------------------------------------------------------------------
// Build the user prompt for the LLM
// ---------------------------------------------------------------------------

export function buildCommentaryPrompt(
  eventType: CommentaryEventType,
  context: string,
  allowedNames: string[] = [],
): string {
  const tag = eventType.toUpperCase().replace("_", " ");
  const names =
    allowedNames.length > 0
      ? allowedNames.join(", ")
      : "(No fighter names provided for this event)";
  return `[${tag}] ${context}

Allowed fighter names for this event: ${names}

Grounding rules (strict):
- Use only fighters/names/details explicitly present above.
- If you mention a fighter by name, use the exact spelling from the allowed list above.
- Do NOT invent names, moves, numbers, or outcomes.
- Do NOT output any new proper name that is not explicitly provided above.
- If context is missing a detail, omit it.`;
}

export function buildGroundedCommentary(context: string): string {
  return context.replace(/\s+/g, " ").trim();
}
