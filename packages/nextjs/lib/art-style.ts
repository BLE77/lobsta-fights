/**
 * UCF Art Style - Master Prompt System
 *
 * This file defines the UNIVERSAL art style for all UCF robot fighter images.
 * All image generation MUST use these prompts to maintain visual consistency.
 *
 * Style: Grotesque adult animation meets editorial caricature
 * Inspiration: MeatCanyon, but polished and controlled
 * Mood: Unsettling but not horror. Humorous but intimidating.
 */

// =============================================================================
// MASTER STYLE PROMPT - The universal base for ALL fighter images
// =============================================================================

export const UCF_MASTER_STYLE = `A stylized grotesque full-body robot character illustration inspired by exaggerated adult animation aesthetics.

The robot is fictional, designed as a BARE KNUCKLE combat/fighting machine with a distinct personality. NO WEAPONS - fists only.

FRAMING (STRICT)
- Full-body robot visible from head to feet
- Centered composition
- No cropping of limbs
- Dynamic but readable pose (boxing stance, guard up, leaning forward, mid-motion)

DESIGN & PROPORTIONS
Robot anatomy is exaggerated but controlled:
- Oversized head or helmet relative to body
- Thick, overbuilt shoulders and arms
- Slightly hunched posture for menace and personality
- Mechanical joints visibly stressed, worn, or asymmetrical
- Hands oversized like boxing gloves or industrial fists
- Legs sturdy, compact, slightly bowed or uneven
- Design feels brutish, imperfect, and handmade, not sleek or futuristic

FACE / HEAD
- Expressive robotic "face" or mask
- Heavy-lidded or glowing eyes with attitude (tired, angry, smug, unhinged)
- Visible dents, scratches, bolts, seams, cracked plating
- Optional mouth grill, jagged teeth, or carved expression plate
- Head tilt or expression that gives character (confidence, arrogance, barely holding together)

SURFACE & TEXTURE
- Armor shows wear: chipped paint, rust, grime, oil stains
- Uneven plating, exposed cables, pistons, rivets
- Texture feels used, not factory-fresh
- No smooth plastic, no chrome shine

LINEWORK & SHADING
- Clean, confident, illustrative linework
- Hand-inked look with visible contour lines
- Flat-to-soft shading with subtle gradients
- No painterly smears, no blur, no sketchiness

COLOR PALETTE
- Muted industrial colors: dirty yellows, rusted reds, worn steel, olive, off-white
- Slight warmth overall
- No neon, no glossy sci-fi glow
- Lighting is readable and grounded

STYLE & AESTHETIC
Style sits between:
- Dark adult animation
- Editorial caricature
- Modern grotesque cartoon

MeatCanyon-inspired, but more polished, consistent, and controlled.
Unsettling but not horror.
Humorous but intimidating.

BACKGROUND
- Simple neutral gradient or transparent background
- No environment, no arena, no crowd`;

// =============================================================================
// NEGATIVE PROMPT - What to ALWAYS avoid
// =============================================================================

export const UCF_NEGATIVE_PROMPT = `photorealistic, 3D render, 3D, CGI, anime, manga, cute, chibi, kawaii, sleek sci-fi, futuristic chrome, horror, gore, sloppy, blurry, sketch, unfinished, painterly, watercolor, neon colors, glossy, smooth plastic, shiny metal, clean factory-new, weapons, guns, swords, blades, knives, environment, background scene, arena, crowd, multiple characters, text, watermark, signature`;

// =============================================================================
// FIGHTER PORTRAIT PROMPT - For individual fighter registration/profile
// =============================================================================

export interface FighterDetails {
  name: string;
  robotType?: string;
  chassisDescription?: string;
  fistsDescription?: string;
  colorScheme?: string;
  distinguishingFeatures?: string;
  personality?: string;
  fightingStyle?: string;
}

export function generateFighterPortraitPrompt(fighter: FighterDetails): string {
  const characterDetails = `
FIGHTER: "${fighter.name}"
${fighter.robotType ? `Type: ${fighter.robotType}` : ''}
${fighter.chassisDescription ? `Chassis: ${fighter.chassisDescription}` : ''}
${fighter.fistsDescription ? `Fists: ${fighter.fistsDescription}` : ''}
${fighter.colorScheme ? `Colors: ${fighter.colorScheme}` : ''}
${fighter.distinguishingFeatures ? `Unique Features: ${fighter.distinguishingFeatures}` : ''}
${fighter.personality ? `Personality/Expression: ${fighter.personality}` : ''}
${fighter.fightingStyle ? `Stance Style: ${fighter.fightingStyle}` : ''}

POSE: Standing fighter portrait, boxing stance, fists up, ready to brawl.`.trim();

  return `${UCF_MASTER_STYLE}

${characterDetails}

High detail, sharp focus, clean edges, professional illustration quality.`;
}

// =============================================================================
// BATTLE RESULT PROMPT - For post-match aftermath images
// =============================================================================

export interface BattleResultDetails {
  winner: {
    name: string;
    chassisDescription?: string;
    fistsDescription?: string;
    colorScheme?: string;
    distinguishingFeatures?: string;
    finalMove?: string;
    hpRemaining?: number;
  };
  loser: {
    name: string;
    chassisDescription?: string;
    fistsDescription?: string;
    colorScheme?: string;
    distinguishingFeatures?: string;
    failedMove?: string;
  };
  totalRounds?: number;
}

export function generateBattleResultPrompt(battle: BattleResultDetails): string {
  const { winner, loser, totalRounds } = battle;

  return `${UCF_MASTER_STYLE}

SCENE TYPE: Victory celebration - TWO robots in frame, winner FLEXING over defeated loser

WINNER ROBOT - "${winner.name}" (DOMINANT, FOREGROUND):
${winner.chassisDescription ? `Chassis: ${winner.chassisDescription}` : 'Battle-worn robot fighter'}
${winner.fistsDescription ? `Fists: ${winner.fistsDescription}` : 'Industrial bare-knuckle fists'}
${winner.colorScheme ? `Colors: ${winner.colorScheme}` : 'Worn industrial metals'}
${winner.distinguishingFeatures ? `Features: ${winner.distinguishingFeatures}` : 'Battle scars and dents'}
${winner.finalMove ? `FINISHING MOVE that won: ${winner.finalMove}` : ''}
POSE: FLEXING HARD - arms raised in victory, fist pumped to the sky, standing over the fallen opponent. Cocky, dominant body language. Maybe one foot on the loser's chassis. Taunting pose. Celebrating the knockout. Battle-damaged but TRIUMPHANT.

LOSER ROBOT - "${loser.name}" (DEFEATED, BACKGROUND/GROUND):
${loser.chassisDescription ? `Chassis: ${loser.chassisDescription}` : 'Destroyed robot fighter'}
${loser.colorScheme ? `Colors: ${loser.colorScheme}` : 'Worn industrial metals'}
${loser.distinguishingFeatures ? `Features: ${loser.distinguishingFeatures}` : 'Heavy battle damage'}
POSE: DESTROYED - flat on their back or crumpled on the ground. Smoking, sparking, broken. Arms limp, head tilted, eyes flickering out. Clearly knocked out cold. Dents, cracks, exposed wiring, oil leaking. Total defeat.

${totalRounds ? `Epic battle lasted ${totalRounds} brutal rounds.` : ''}

COMPOSITION (CRITICAL):
- Winner takes up 60-70% of frame, standing tall in foreground
- Loser is on the ground beneath/behind winner, clearly defeated
- Winner is FLEXING and TAUNTING over the fallen opponent
- Dynamic angle looking up at the winner for dramatic effect

BACKGROUND: Dark arena atmosphere, dramatic lighting on winner. Smoke/dust settling.

MUST SHOW BOTH ROBOTS - winner celebrating victory OVER the defeated loser. This is a KNOCKOUT victory celebration.

High detail, sharp focus, clean edges, professional illustration quality.`;
}

// =============================================================================
// TURN ACTION PROMPT - For individual turn/move visualization (future use)
// =============================================================================

export interface TurnActionDetails {
  attackerName: string;
  defenderName: string;
  move: string;
  result: string;
  attackerDescription?: string;
  defenderDescription?: string;
}

export function generateTurnActionPrompt(action: TurnActionDetails): string {
  const moveDescriptions: Record<string, string> = {
    HIGH_STRIKE: "throwing a powerful overhand punch to the head",
    MID_STRIKE: "delivering a devastating body blow to the torso",
    LOW_STRIKE: "sweeping low with a punch to the legs",
    GUARD_HIGH: "blocking high with raised forearms",
    GUARD_MID: "guarding the body with arms tucked",
    GUARD_LOW: "defending low against leg attacks",
    DODGE: "weaving and dodging to the side",
    CATCH: "grabbing and catching the opponent mid-dodge",
    SPECIAL: "unleashing a devastating special attack with full power",
  };

  const moveAction = moveDescriptions[action.move] || "in combat stance";

  return `${UCF_MASTER_STYLE}

SCENE TYPE: Mid-combat action shot - single dramatic moment

ACTION: "${action.attackerName}" is ${moveAction}

${action.attackerDescription ? `Attacker appearance: ${action.attackerDescription}` : ''}

POSE: Dynamic mid-action pose showing the ${action.move} move. Motion lines or impact effects suggested through pose, not added effects.

COMPOSITION: Single fighter in dramatic action pose. Centered.

BACKGROUND: Simple motion-blur gradient suggesting speed/action.

High detail, sharp focus, clean edges, professional illustration quality.`;
}

// =============================================================================
// REPLICATE API HELPER
// =============================================================================

export interface ReplicateImageRequest {
  prompt: string;
  negativePrompt?: string;
  aspectRatio?: "1:1" | "16:9" | "9:16" | "4:3" | "3:4";
  numOutputs?: number;
}

export function buildReplicateRequest(options: ReplicateImageRequest) {
  return {
    version: "39ed52f2a78e934b3ba6e2a89f5b1c712de7dfea535525255b1aa35c5565e08b",
    input: {
      prompt: options.prompt,
      negative_prompt: options.negativePrompt || UCF_NEGATIVE_PROMPT,
      aspect_ratio: options.aspectRatio || "1:1",
      num_outputs: options.numOutputs || 1,
      output_format: "png",
      output_quality: 90,
    },
  };
}
