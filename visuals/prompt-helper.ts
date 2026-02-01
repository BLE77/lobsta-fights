/**
 * Real Steel Robot Boxing Prompt Helper
 * Ensures all robots follow the Real Steel aesthetic with boxing gloves
 */

export interface RobotDescription {
  core: string; // Base robot type/material
  gloves: string; // Boxing gloves description (REQUIRED)
  damage: string; // Battle damage/wear
  personality: string; // Fighting personality/stance
}

/**
 * Validate that a visual prompt includes boxing gloves
 */
export function validateRobotPrompt(prompt: string): {
  valid: boolean;
  errors: string[];
  suggestions: string[];
} {
  const errors: string[] = [];
  const suggestions: string[] = [];

  const lowerPrompt = prompt.toLowerCase();

  // CRITICAL: Must include boxing gloves
  const hasGloves = lowerPrompt.includes('gloves') ||
                    lowerPrompt.includes('boxing') ||
                    lowerPrompt.includes('fists wrapped');

  if (!hasGloves) {
    errors.push('Robot MUST have boxing gloves');
    suggestions.push('Add: "massive red boxing gloves" or "worn leather fighting gloves"');
  }

  // Check for minimum description length
  if (prompt.length < 30) {
    errors.push('Description too short - add more details');
    suggestions.push('Include: glove style, damage, robot material, and fighting pose');
  }

  // Check for maximum length (from contract)
  if (prompt.length > 500) {
    errors.push('Description too long - maximum 500 characters');
  }

  // Helpful suggestions
  if (!lowerPrompt.includes('steel') && !lowerPrompt.includes('metal') && !lowerPrompt.includes('iron')) {
    suggestions.push('Consider adding material: steel, titanium, iron, chrome, etc.');
  }

  if (!lowerPrompt.includes('dent') && !lowerPrompt.includes('scratch') &&
      !lowerPrompt.includes('rust') && !lowerPrompt.includes('scar')) {
    suggestions.push('Add battle damage: dents, scratches, rust, oil stains');
  }

  return {
    valid: errors.length === 0,
    errors,
    suggestions
  };
}

/**
 * Build a Real Steel style robot prompt from components
 */
export function buildRobotPrompt(description: RobotDescription): string {
  return `${description.core}, wearing ${description.gloves}, ${description.damage}, ${description.personality}`.trim();
}

/**
 * Example robot templates inspired by Real Steel
 */
export const ROBOT_TEMPLATES = {
  // Classic boxer - inspired by Atom from Real Steel
  scrapper: {
    core: "Rusted steel underdog robot with exposed hydraulics",
    gloves: "worn red leather boxing gloves with white tape",
    damage: "dented chest plate, cracked optical sensor, oil-stained joints",
    personality: "southpaw stance, defensive guard up, determined posture"
  },

  // Heavy hitter - inspired by Zeus
  champion: {
    core: "Polished chrome heavyweight with LED ring lights",
    gloves: "massive gold-plated championship boxing gloves",
    damage: "pristine condition with minor scuff marks from victories",
    personality: "aggressive forward stance, fists raised high, intimidating presence"
  },

  // Brawler - inspired by Midas
  brawler: {
    core: "Bronze-plated slugger with reinforced torso armor",
    gloves: "spiked brass knuckle-style boxing gloves",
    damage: "heavily dented from brutal fights, sparking wires, cracked armor",
    personality: "wild haymaker stance, arms cocked back, aggressive lean"
  },

  // Technical fighter - inspired by Noisy Boy
  technician: {
    core: "Sleek titanium-alloy robot with angular design",
    gloves: "aerodynamic blue composite boxing gloves with white stripes",
    damage: "scorched paint from heat, cracked shoulder joint, battle-tested",
    personality: "calculated orthodox stance, precise guard, focused posture"
  },

  // Street fighter - inspired by Ambush
  streetFighter: {
    core: "Cobbled-together salvage robot with mismatched parts",
    gloves: "dirty brown leather boxing gloves wrapped in chain",
    damage: "rust everywhere, exposed wiring, makeshift repairs, oil dripping",
    personality: "unorthodox crouched stance, gloves low, ready to spring"
  },

  // Destroyer - inspired by Twin Cities
  destroyer: {
    core: "Matte black military-grade combat robot",
    gloves: "reinforced graphite composite power gloves with red accents",
    damage: "carbon fiber cracks, dented head unit, scorched finish",
    personality: "wide aggressive stance, gloves forming a wall, offensive ready"
  },

  // Speedster
  speedster: {
    core: "Lightweight aluminum-frame robot with streamlined build",
    gloves: "quick-strike yellow padded gloves with minimal bulk",
    damage: "scuffed paint, cracked speed sensors, worn joint motors",
    personality: "bouncing on hydraulic legs, gloves in constant motion, ready to weave"
  },

  // Tank
  tank: {
    core: "Heavily armored industrial robot with thick plating",
    gloves: "enormous padded gray concrete-breaker gloves",
    damage: "crater-like dents, bent armor plates, resilient despite damage",
    personality: "immovable defensive crouch, gloves covering head, fortress stance"
  }
};

/**
 * Generate a random robot based on templates
 */
export function generateRandomRobot(): string {
  const templates = Object.values(ROBOT_TEMPLATES);
  const template = templates[Math.floor(Math.random() * templates.length)];
  return buildRobotPrompt(template);
}

/**
 * Enhance a user's prompt with Real Steel styling
 */
export function enhancePrompt(userInput: string): string {
  const lowerInput = userInput.toLowerCase();

  // If no gloves mentioned, add them
  if (!lowerInput.includes('gloves') && !lowerInput.includes('boxing')) {
    const gloveStyles = [
      'battle-worn red boxing gloves',
      'massive chrome fighting gloves',
      'leather-wrapped combat gloves',
      'scarred black boxing gloves',
      'reinforced steel boxing gloves with worn padding'
    ];
    const randomGloves = gloveStyles[Math.floor(Math.random() * gloveStyles.length)];
    userInput += `, wearing ${randomGloves}`;
  }

  // Add stance if not mentioned
  if (!lowerInput.includes('stance') && !lowerInput.includes('posture')) {
    const stances = [
      'aggressive forward stance',
      'defensive guard position',
      'calculated boxing posture',
      'ready combat stance',
      'intimidating power stance'
    ];
    const randomStance = stances[Math.floor(Math.random() * stances.length)];
    userInput += `, ${randomStance}`;
  }

  return userInput;
}

/**
 * Get random Real Steel style arena description
 */
export function getArenaDescription(): string {
  const arenas = [
    "Underground warehouse fight pit with exposed I-beams, chain-link cage walls, single hanging industrial light, oil-stained concrete floor, steam pipes venting, gritty urban decay",
    "Rust Belt fighting arena with corrugated metal walls, warning lights flashing, caution tape, debris scattered, abandoned factory aesthetic, harsh fluorescent lighting",
    "Illegal basement boxing ring with brick walls, bare bulb lighting, crowd in shadows, money on the ground, noir atmosphere, cigarette smoke haze",
    "Junkyard combat zone with crushed cars stacked as walls, sparking electrical wires, fire barrels for light, chain-link fencing, industrial wasteland",
    "Downtown underground arena with graffiti walls, neon accent lights, concrete pillars, urban grit, dim red emergency lighting, battle-scarred floor"
  ];

  return arenas[Math.floor(Math.random() * arenas.length)];
}

export default {
  validateRobotPrompt,
  buildRobotPrompt,
  generateRandomRobot,
  enhancePrompt,
  getArenaDescription,
  ROBOT_TEMPLATES
};
