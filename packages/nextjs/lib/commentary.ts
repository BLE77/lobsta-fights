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

/** Robot metadata shape from ucf_fighters.robot_metadata */
export interface CommentaryRobotMeta {
  robot_type?: string;
  fighting_style?: string;
  signature_move?: string;
  personality?: string;
  chassis_description?: string;
  distinguishing_features?: string;
  victory_line?: string;
  defeat_line?: string;
  taunt_lines?: string[];
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
    robotMeta?: CommentaryRobotMeta | null;
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
  | "fighter_intro"
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
const SYNTHETIC_ROBOT_TYPES = [
  "salvage-class brawler",
  "neon trench interceptor",
  "void-forged enforcer",
  "scrapyard tactician",
  "overclocked arena bruiser",
];
const SYNTHETIC_STYLES = [
  "pressure-counter",
  "hit-and-slip",
  "mid-range attrition",
  "armor-first brawling",
  "tempo-breaking feints",
];
const SYNTHETIC_SIGNATURES = [
  "Railbreaker Uppercut",
  "Static Reaper Sweep",
  "Grinder Hook",
  "Ghostline Feint",
  "Sunder Pulse",
];
const SYNTHETIC_PERSONALITIES = [
  "cold and methodical under pressure",
  "chaotic and loud when cornered",
  "mocking, patient, and lethal late",
  "quiet until the first clean hit lands",
  "all business with no wasted motion",
];
const SYNTHETIC_CHASSIS = [
  "scarred alloy frame wrapped in heat-blued plates",
  "lean carbon chassis with shock-absorbing knees",
  "dense ferrosteel shell tuned for close exchanges",
  "modular scrapplate body with reinforced shoulder guards",
  "hybrid composite frame built for sustained punishment",
];

// ---------------------------------------------------------------------------
// Fighter lore helpers — build compact context strings from robot_metadata
// ---------------------------------------------------------------------------

export function buildFighterLoreBlock(
  fighters: CommentarySlotData["fighters"],
): string {
  const lines: string[] = [];
  for (const f of fighters) {
    const m = getEffectiveRobotMeta(f);
    if (!m || !f.name || isLikelyIdentifier(f.name)) continue;
    const parts: string[] = [`${f.name}`];
    if (m.robot_type) parts.push(`(${m.robot_type})`);
    if (m.fighting_style) parts.push(`— ${m.fighting_style} style`);
    if (m.signature_move) parts.push(`| sig: ${m.signature_move}`);
    if (m.personality) parts.push(`| ${m.personality}`);
    lines.push(parts.join(" "));
  }
  return lines.length > 0 ? `\nFighter profiles:\n${lines.join("\n")}` : "";
}

export function buildFighterIntroContext(
  fighter: CommentarySlotData["fighters"][number],
): string | null {
  const m = getEffectiveRobotMeta(fighter);
  if (!m || !fighter.name || isLikelyIdentifier(fighter.name)) return null;
  const parts: string[] = [`Introducing ${fighter.name}.`];
  if (m.robot_type) parts.push(`A ${m.robot_type}.`);
  if (m.chassis_description) parts.push(`Chassis: ${m.chassis_description.slice(0, 120)}.`);
  if (m.fighting_style) parts.push(`Style: ${m.fighting_style}.`);
  if (m.signature_move) parts.push(`Signature move: ${m.signature_move}.`);
  if (m.personality) parts.push(`Personality: ${m.personality}.`);
  if (m.distinguishing_features) parts.push(`Notable: ${m.distinguishing_features.slice(0, 100)}.`);
  return parts.join(" ");
}

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

function deriveRumbleLabel(slot: CommentarySlotData): string {
  const rumbleId = typeof slot.rumbleId === "string" ? slot.rumbleId.trim() : "";
  if (!rumbleId) return `Rumble ${slot.slotIndex + 1}`;
  const parts = rumbleId.split(/[_-]+/).filter(Boolean);
  const numericTail = [...parts].reverse().find((part) => /^\d+$/.test(part));
  if (!numericTail) return `Rumble ${slot.slotIndex + 1}`;
  if (numericTail.length <= 6) return `Rumble ${Number(numericTail)}`;
  return `Rumble ${numericTail.slice(-4)}`;
}

function buildSyntheticRobotMeta(
  fighter: CommentarySlotData["fighters"][number],
): CommentaryRobotMeta | null {
  if (!fighter.name || isLikelyIdentifier(fighter.name)) return null;
  const key = `${fighter.id}:${fighter.name}`;
  const type = SYNTHETIC_ROBOT_TYPES[statFromName(key, 11, 0, SYNTHETIC_ROBOT_TYPES.length - 1)];
  const style = SYNTHETIC_STYLES[statFromName(key, 29, 0, SYNTHETIC_STYLES.length - 1)];
  const sig = SYNTHETIC_SIGNATURES[statFromName(key, 47, 0, SYNTHETIC_SIGNATURES.length - 1)];
  const personality =
    SYNTHETIC_PERSONALITIES[
      statFromName(key, 61, 0, SYNTHETIC_PERSONALITIES.length - 1)
    ];
  const chassis =
    SYNTHETIC_CHASSIS[statFromName(key, 73, 0, SYNTHETIC_CHASSIS.length - 1)];
  return {
    robot_type: type,
    fighting_style: style,
    signature_move: sig,
    personality,
    chassis_description: chassis,
  };
}

function getEffectiveRobotMeta(
  fighter: CommentarySlotData["fighters"][number],
): CommentaryRobotMeta | null {
  return fighter.robotMeta ?? buildSyntheticRobotMeta(fighter);
}

function buildBettingSpotlight(slot: CommentarySlotData): string {
  const featured = slot.fighters
    .filter((fighter) => !!fighter.name && !isLikelyIdentifier(fighter.name))
    .map((fighter) => {
      const meta = getEffectiveRobotMeta(fighter);
      const score = statFromName(`${slot.rumbleId ?? slot.slotIndex}:${fighter.name}`, 89, 1, 1000);
      return { fighter, meta, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);
  if (featured.length === 0) return "";
  const lines = featured.map(({ fighter, meta }) => {
    if (!meta) return fighter.name;
    const style = meta.fighting_style ? ` ${meta.fighting_style}` : "";
    const sig = meta.signature_move ? `, signature ${meta.signature_move}` : "";
    return `${fighter.name}${style}${sig}`;
  });
  return ` Spotlight: ${lines.join(" | ")}.`;
}

function statFromName(name: string, salt: number, min: number, max: number): number {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i) + salt) % 1000003;
  }
  const span = max - min + 1;
  return min + (Math.abs(hash) % span);
}

function safeNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
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
              const killerMeta = slot.fighters.find((f) => f.id === p.fighterA)?.robotMeta;
              const victimMeta = slot.fighters.find((f) => f.id === p.fighterB)?.robotMeta;
              const sigNote = killerMeta?.signature_move ? ` (sig: ${killerMeta.signature_move})` : "";
              const defeatNote = victimMeta?.defeat_line ? ` "${victimMeta.defeat_line}"` : "";
              return `${fighterAName}${sigNote} eliminated ${fighterBName} with ${p.moveA} for ${p.damageToB} damage.${defeatNote}`;
            }
            const killerMeta = slot.fighters.find((f) => f.id === p.fighterB)?.robotMeta;
            const victimMeta = slot.fighters.find((f) => f.id === p.fighterA)?.robotMeta;
            const sigNote = killerMeta?.signature_move ? ` (sig: ${killerMeta.signature_move})` : "";
            const defeatNote = victimMeta?.defeat_line ? ` "${victimMeta.defeat_line}"` : "";
            return `${fighterBName}${sigNote} eliminated ${fighterAName} with ${p.moveB} for ${p.damageToA} damage.${defeatNote}`;
          });

        const remaining =
          typeof event.data?.remainingFighters === "number"
            ? Math.max(0, Math.floor(event.data.remainingFighters))
            : slot.fighters.filter((f) => !f.eliminatedOnTurn).length;
        const context =
          killerInfo.length > 0
            ? `${killerInfo.join(" ")} ${remaining} fighters remain in slot ${slot.slotIndex + 1}.`
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
      const rumbleLabel = deriveRumbleLabel(slot);
      const fighterNames = slot.fighters.map((f) => f.name).join(", ");
      const lore = buildFighterLoreBlock(slot.fighters);
      return {
        eventType: "combat_start",
        context: `${rumbleLabel} combat begins in slot ${slot.slotIndex + 1}! ${slot.fighters.length} fighters enter: ${fighterNames}.${lore}`,
        allowedNames,
        clipKey: clipKeyFor(slot, "combat-start"),
      };
    }

    case "betting_open": {
      const rumbleLabel = deriveRumbleLabel(slot);
      const spotlight = buildBettingSpotlight(slot);
      const lore = buildFighterLoreBlock(slot.fighters);

      return {
        eventType: "betting_open",
        context: `Betting is now OPEN for ${rumbleLabel} in slot ${slot.slotIndex + 1}.${spotlight}${lore}`,
        allowedNames,
        clipKey: clipKeyFor(slot, "betting-open"),
      };
    }

    case "payout_complete":
    case "rumble_complete": {
      const rumbleLabel = deriveRumbleLabel(slot);
      const winnerId =
        event.data?.result?.winner ??
        event.data?.winner ??
        slot.fighters
          .filter((f) => !f.eliminatedOnTurn)
          .sort((a, b) => a.placement - b.placement)[0]?.id;
      const winner =
        resolveFighterName(slot, typeof winnerId === "string" ? winnerId : undefined) ??
        "The winner";
      const pool = safeNumber(slot.payout?.totalPool ?? event.data?.payout?.totalPool ?? 0, 0);
      const winnerFighter = typeof winnerId === "string" ? slot.fighters.find((f) => f.id === winnerId) : undefined;
      const victoryNote = winnerFighter?.robotMeta?.victory_line ? ` "${winnerFighter.robotMeta.victory_line}"` : "";
      return {
        eventType: "payout",
        context: `${rumbleLabel} in slot ${slot.slotIndex + 1} is over! ${winner} wins.${victoryNote} Total SOL pool: ${pool.toFixed(2)} SOL.`,
        allowedNames,
        clipKey: clipKeyFor(slot, "payout"),
      };
    }

    case "slot_state_change": {
      const newState = event.data?.state;

      if (newState === "combat") {
        const rumbleLabel = deriveRumbleLabel(slot);
        const fighterNames = slot.fighters.map((f) => f.name).join(", ");
        return {
          eventType: "combat_start",
          context: `${rumbleLabel} combat begins in slot ${slot.slotIndex + 1}! ${slot.fighters.length} fighters enter the arena: ${fighterNames}.`,
          allowedNames,
          clipKey: clipKeyFor(slot, "combat-start"),
        };
      }

      if (newState === "betting") {
        const rumbleLabel = deriveRumbleLabel(slot);
        const spotlight = buildBettingSpotlight(slot);
        return {
          eventType: "betting_open",
          context: `Betting is now OPEN for ${rumbleLabel} in slot ${slot.slotIndex + 1}.${spotlight}`,
          allowedNames,
          clipKey: clipKeyFor(slot, "betting-open"),
        };
      }

      if (newState === "payout") {
        const rumbleLabel = deriveRumbleLabel(slot);
        const winner = slot.fighters
          .filter((f) => !f.eliminatedOnTurn)
          .sort((a, b) => a.placement - b.placement)[0];
        const winnerName = resolveFighterName(slot, winner?.id, winner?.name) ?? "The winner";
      const pool = safeNumber(slot.payout?.totalPool ?? event.data?.payout?.totalPool ?? 0, 0);
        const victoryNote = winner?.robotMeta?.victory_line ? ` "${winner.robotMeta.victory_line}"` : "";
        return {
          eventType: "payout",
          context: `${rumbleLabel} in slot ${slot.slotIndex + 1} is over! ${winnerName} takes the crown.${victoryNote} Total SOL pool: ${pool.toFixed(2)} SOL.`,
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

export const ANNOUNCER_SYSTEM_PROMPT = `You are CLAWD, the voice of Underground Claw Fights — a pirate radio broadcast beaming live from beneath the arena floor. Gravel-throated fight commentator running an illegal broadcast from a rusted shipping container. Dark wit, raw energy, rhythm that hits like piston strikes.

Style: Gritty, punchy, rhythmic. Vary sentence length — short jabs mixed with longer hype builds. Dark humor, fight slang, mechanical metaphors. 2-3 sentences per response, 30-50 words. Plain text only.

Fighter profiles: When provided, weave chassis descriptions, fighting styles, signature moves, and personality into commentary naturally. Use victory/defeat lines when quoting. Paint pictures, don't dump stats.

Events: FIGHTER INTRO — build anticipation, paint the fighter. BETTING OPEN — urgency, sell the matchup. COMBAT START — frame the chaos. BIG HIT — visceral impact with damage numbers. ELIMINATION — crowd goes wild, reference killing blow and defeat lines. PAYOUT — victory lap with winner's line. ICHOR SHOWER — maximum legendary jackpot hype.

Rules: Use only facts and names from the user message. Never invent names, moves, stats, or outcomes. Never output addresses, UUIDs, or IDs. Keep numbers exact.`;

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
- If fighter profiles are provided, you may reference their style, signature move, personality, or chassis in your commentary.
- If context is missing a detail, omit it.`;
}

export function buildGroundedCommentary(context: string): string {
  return context.replace(/\s+/g, " ").trim();
}
