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
// VICTORY POSE PROMPT - Generated once at registration, reused for all wins
// =============================================================================

export function generateVictoryPosePrompt(fighter: FighterDetails): string {
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

  return `EPIC ROBOT BOXING VICTORY CELEBRATION - Professional fighting game victory screen art

SETTING: UNDERGROUND ROBOT BOXING ARENA (CRITICAL - THIS IS THE BACKGROUND)
- Gritty, industrial underground fight club arena
- Worn boxing ring with frayed ropes and battle-stained canvas
- Chain-link cage surrounding the ring
- Harsh overhead spotlights cutting through smoke and steam
- Neon signs and graffiti on concrete walls: "UCF", "UNDERGROUND CLAW FIGHTS"
- Crowd silhouettes in darkness, cheering
- Sparks and debris on the ring floor
- Atmosphere: smoky, gritty, intense - like an illegal underground robot fight club

=== CHAMPION: "${fighter.name}" - VICTORY POSE (CENTER FRAME, DOMINANT) ===
Robot Design:
- Robot Type: ${fighter.robotType || 'Battle-hardened fighting machine'}
- Chassis: ${fighter.chassisDescription || 'Powerful humanoid battle robot with heavy armor plating'}
- Fists: ${fighter.fistsDescription || 'Massive reinforced mechanical fists, wrapped in battle-worn tape'}
- Colors: ${fighter.colorScheme || randomColor}
- Unique Features: ${fighter.distinguishingFeatures || 'Glowing eyes, battle scars, distinctive head design'}
- Expression: ${fighter.personality || 'Confident, victorious, intimidating presence'}

VICTORY POSE (CRITICAL - TRIUMPHANT CELEBRATION):
- Standing TALL in CENTER of boxing ring, FULL BODY visible head to toe
- ONE FIST RAISED HIGH TO THE SKY in triumph
- Other fist clenched at side or beating chest
- Head tilted back in victorious roar
- Glowing eyes blazing bright with victory
- Steam venting from joints, sparks crackling with energy
- Battle damage visible - dents, scratches that show they EARNED victories
- Body language: DOMINANT, POWERFUL, CHAMPION
- Fighter takes up 70% of the frame - this is THEIR moment

COMPOSITION (CRITICAL):
- Single fighter ONLY - no other robots or characters
- Winner standing TALL in CENTER
- Low camera angle looking UP at the champion
- Boxing ring ropes and corner posts visible
- Arena atmosphere: smoke, spotlights, crowd shadows

LIGHTING:
- Harsh spotlight from above on the champion
- Dramatic rim lighting in the fighter's colors
- Neon glow from arena signs (red, blue, green)
- Smoke catching the light beams
- All glowing elements (eyes, core, vents) blazing bright at maximum intensity

STYLE: Comic book / fighting game victory screen. Bold colors, high contrast, dramatic and epic. Clean digital illustration, not photorealistic.

QUALITY: Masterpiece, best quality, highly detailed, sharp focus, professional fighting game character art, dramatic cinematic lighting, 8k resolution`;
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

  return `EPIC ROBOT BOXING VICTORY SCENE - Professional fighting game victory screen art

SETTING: UNDERGROUND ROBOT BOXING ARENA (CRITICAL - THIS IS THE BACKGROUND)
- Gritty, industrial underground fight club arena
- Worn boxing ring with frayed ropes and oil-stained canvas
- Chain-link cage surrounding the ring
- Harsh overhead spotlights cutting through smoke and steam
- Neon signs and graffiti on concrete walls: "UCF", "UNDERGROUND CLAW FIGHTS"
- Crowd silhouettes in darkness, cheering
- Sparks, debris, and oil splatter on the ring floor
- Atmosphere: smoky, gritty, intense - like an illegal underground robot fight club

=== WINNER: "${winner.name}" - THE CHAMPION (CENTER FRAME, DOMINANT) ===
Robot Design:
- Chassis: ${winner.chassisDescription || 'Powerful humanoid battle robot with heavy armor plating'}
- Fists: ${winner.fistsDescription || 'Massive reinforced mechanical fists, dented from combat'}
- Colors: ${winner.colorScheme || defaultWinnerColors}
- Unique Features: ${winner.distinguishingFeatures || 'Glowing eyes, battle scars, distinctive head design'}
${winner.finalMove ? `- Final winning move was: ${winner.finalMove}` : ''}

WINNER POSE (CRITICAL - VICTORY CELEBRATION):
- Standing TALL in CENTER of boxing ring
- ONE FIST RAISED HIGH TO THE SKY in triumph
- Other fist clenched at side or beating chest
- Head tilted back in victorious roar
- Glowing eyes blazing bright with victory
- Steam venting from joints, sparks crackling
- Battle damage that shows they EARNED this win
- Body language: DOMINANT, POWERFUL, CHAMPION

=== LOSER: "${loser.name}" - KNOCKED OUT (ON THE CANVAS) ===
Robot Design:
- Chassis: ${loser.chassisDescription || 'Defeated battle robot, heavily damaged'}
- Colors: ${loser.colorScheme || defaultLoserColors}
- Features: ${loser.distinguishingFeatures || 'Cracked armor, sparking circuits'}

LOSER POSE (ON THE GROUND):
- Collapsed/crumpled on the boxing ring canvas
- Face down or on their back, clearly KNOCKED OUT
- Eyes flickering/dimmed/offline
- Oil and hydraulic fluid leaking
- Smoke rising from damaged components
- Some armor plates cracked or fallen off
- Completely defeated, not getting back up

${totalRounds ? `EPIC ${totalRounds}-ROUND BATTLE that ended in a devastating knockout!` : 'KNOCKOUT VICTORY!'}

COMPOSITION (CRITICAL):
- Winner standing TALL in CENTER, taking up 60% of frame
- Loser on the canvas at winner's feet
- Low camera angle looking UP at the champion
- Boxing ring ropes and corner posts visible
- Arena atmosphere: smoke, spotlights, crowd shadows
- Both robots must be CLEARLY DISTINCT - different colors, different designs

LIGHTING:
- Harsh spotlight from above on the winner
- Dramatic rim lighting in winner's colors
- Neon glow from arena signs (red, blue, green)
- Smoke catching the light beams
- Winner's glowing elements (eyes, core) blazing bright
- Loser's lights dimmed/flickering

STYLE: Comic book / fighting game victory screen. Bold colors, high contrast, dramatic and epic. Clean digital illustration, not photorealistic.

QUALITY: Masterpiece, best quality, highly detailed, sharp focus, professional fighting game art, dramatic cinematic lighting, 8k resolution`;
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
