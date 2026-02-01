/**
 * UCF Art Style - Master Prompt System
 *
 * This file defines the UNIVERSAL art style for all UCF robot fighter images.
 * All image generation MUST use these prompts to maintain visual consistency.
 *
 * Style: High-contrast stylized illustration with BOLD colors and dramatic lighting
 * Inspiration: Fighting game character select screens, comic book covers, neon-lit arenas
 * Mood: EPIC, powerful, intimidating, but with personality and style
 */

// =============================================================================
// MASTER STYLE PROMPT - The universal base for ALL fighter images
// =============================================================================

export const UCF_MASTER_STYLE = `EPIC STYLIZED ROBOT FIGHTER CHARACTER ART - High quality digital illustration

A powerful, dramatic full-body robot fighter character in the style of fighting game character art and comic book covers.

The robot is a BARE KNUCKLE combat machine - a gladiator built to fight. NO WEAPONS - massive mechanical fists only.

FRAMING (CRITICAL)
- Full-body robot visible from head to feet, NEVER cropped
- Dramatic low angle looking up at the fighter for power and intimidation
- Dynamic fighting pose - fists raised, ready to brawl
- Centered composition with breathing room

DESIGN & PROPORTIONS
- HEROIC proportions: broad shoulders, powerful arms, imposing silhouette
- Oversized mechanical fists wrapped in worn tape or metal plating
- Unique head/face design with glowing eyes or visor
- Battle-scarred armor with character and history
- Exposed hydraulics, pistons, cables showing raw mechanical power
- Each robot should look DISTINCTLY DIFFERENT from others

COLOR & LIGHTING (IMPORTANT - MAKE IT POP)
- BOLD, SATURATED primary colors - deep reds, electric blues, toxic greens, blazing oranges
- High contrast lighting with dramatic rim lights
- Glowing elements: eyes, vents, energy cores, circuit lines
- Accent colors that make each fighter instantly recognizable
- Neon underglow and atmospheric lighting effects
- Dark background makes colors POP

SURFACE & DETAIL
- Mix of weathered battle damage AND polished armor plates
- Glowing circuitry and energy lines
- Steam, sparks, or energy effects around joints
- Painted markings, symbols, or fighter insignias
- Each robot tells a story through their design

STYLE
- Clean digital illustration with sharp edges
- Comic book / fighting game aesthetic
- Dramatic and cinematic composition
- Professional character design quality
- Think: Street Fighter character select, Overwatch hero art, Pacific Rim jaegers

MOOD: POWERFUL. INTIMIDATING. READY TO FIGHT.

BACKGROUND
- Dark gradient with subtle atmospheric effects
- Optional: faint arena lights, smoke, or energy particles
- Colors complement the fighter's palette`;

// =============================================================================
// NEGATIVE PROMPT - What to ALWAYS avoid
// =============================================================================

export const UCF_NEGATIVE_PROMPT = `photorealistic, 3D render, photo, anime, manga, cute, chibi, kawaii, horror, gore, sloppy, blurry, sketch, unfinished, ugly, deformed, disfigured, bad anatomy, bad proportions, cropped, cut off, out of frame, weapons, guns, swords, blades, knives, multiple characters, text, watermark, signature, logo, words, letters`;

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
  // Generate a unique color scheme if not provided
  const defaultColors = [
    "deep crimson red with gold accents and orange energy glow",
    "electric blue with silver chrome and cyan neon highlights",
    "toxic green with black armor and lime energy circuits",
    "blazing orange with gunmetal grey and yellow warning stripes",
    "royal purple with gold trim and pink energy core",
    "jet black with red glowing eyes and scarlet accent lights",
    "arctic white with ice blue highlights and frost effects",
    "burnt copper with teal patina and amber warning lights",
  ];
  const randomColor = defaultColors[Math.floor(Math.random() * defaultColors.length)];

  const characterDetails = `
=== FIGHTER: "${fighter.name}" ===

ROBOT TYPE: ${fighter.robotType || 'Battle-hardened fighting machine'}

BODY/CHASSIS: ${fighter.chassisDescription || 'Powerful mechanical frame built for combat'}

FISTS: ${fighter.fistsDescription || 'Massive reinforced mechanical fists, wrapped in battle-worn tape'}

COLOR SCHEME (IMPORTANT - MAKE VIBRANT): ${fighter.colorScheme || randomColor}

UNIQUE FEATURES: ${fighter.distinguishingFeatures || 'Glowing eyes, battle scars, unique head design'}

EXPRESSION/ATTITUDE: ${fighter.personality || 'Confident, ready to fight, intimidating presence'}

FIGHTING STANCE: ${fighter.fightingStyle || 'aggressive'} stance - fists up, weight forward, ready to strike

POSE: DRAMATIC fighting stance, fists raised and ready, full body visible head to toe, looking powerful and intimidating`.trim();

  return `${UCF_MASTER_STYLE}

${characterDetails}

QUALITY: Masterpiece, best quality, highly detailed, sharp focus, professional fighting game character art, dramatic lighting, 8k resolution`;
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

  // Generate dramatic colors if not provided
  const defaultWinnerColors = "glowing with victory energy, bright saturated colors with golden highlights";
  const defaultLoserColors = "sparking and smoking, colors dimmed and damaged";

  return `${UCF_MASTER_STYLE}

SCENE TYPE: EPIC VICTORY CELEBRATION - TWO distinct robots, winner triumphant over defeated opponent

=== WINNER: "${winner.name}" (DOMINANT, FOREGROUND) ===
Chassis: ${winner.chassisDescription || 'Powerful battle robot'}
Fists: ${winner.fistsDescription || 'Massive mechanical fists'}
Colors: ${winner.colorScheme || defaultWinnerColors}
Features: ${winner.distinguishingFeatures || 'Glowing eyes blazing with victory, battle damage that shows strength'}
${winner.finalMove ? `Just landed the devastating: ${winner.finalMove}` : ''}
POSE: TRIUMPHANT VICTORY POSE - fist raised to the sky, standing over fallen opponent. Dominant, powerful body language. Glowing eyes, steam venting, energy crackling. The CHAMPION.

=== LOSER: "${loser.name}" (DEFEATED, ON GROUND) ===
Chassis: ${loser.chassisDescription || 'Destroyed robot fighter'}
Colors: ${loser.colorScheme || defaultLoserColors}
Features: ${loser.distinguishingFeatures || 'Heavy damage, sparks flying'}
POSE: KNOCKED OUT - collapsed on the ground, smoking and sparking. Eyes flickering off. Oil leaking. Completely defeated. Some parts cracked or broken.

${totalRounds ? `This was an EPIC ${totalRounds}-round battle!` : ''}

COMPOSITION (CRITICAL):
- Winner dominates 60-70% of frame, standing tall
- Dramatic low angle looking UP at the victorious winner
- Loser crumpled on the ground beneath/behind
- Both robots CLEARLY VISIBLE and DISTINCT from each other

LIGHTING & ATMOSPHERE:
- Dramatic spotlight on the winner
- Vibrant glowing elements and energy effects
- Smoke, sparks, and atmospheric particles
- Dark arena background with colored rim lights
- Epic, cinematic feel like a fighting game victory screen

BOTH ROBOTS must be clearly visible. This is a KNOCKOUT VICTORY moment.

QUALITY: Masterpiece, best quality, highly detailed, dramatic lighting, professional fighting game art, cinematic composition, 8k resolution`;
}
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
