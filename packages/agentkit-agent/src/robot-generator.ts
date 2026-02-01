/**
 * Real Steel Robot Generator for AI Agents
 * Generates robot descriptions with boxing gloves for autonomous fighters
 */

export interface RobotStyle {
  material: string;
  gloves: string;
  damage: string;
  stance: string;
}

const MATERIALS = [
  "rusted steel",
  "polished chrome",
  "titanium alloy",
  "carbon fiber",
  "bronze plating",
  "matte black aluminum",
  "scratched iron",
  "weathered copper",
  "industrial steel",
  "gunmetal gray"
];

const GLOVE_STYLES = [
  "worn red leather boxing gloves with white tape",
  "massive chrome power gloves",
  "quick-strike yellow padded gloves",
  "reinforced black composite gloves",
  "gold-plated championship gloves",
  "dirty brown leather gloves wrapped in chain",
  "blue aerodynamic composite gloves with white stripes",
  "padded gray concrete-breaker gloves",
  "brass knuckle-style spiked gloves",
  "reinforced graphite gloves with red accents"
];

const DAMAGE_STATES = [
  "pristine condition with minor scuffs",
  "dented chest plate, oil stains on joints",
  "heavily scarred with exposed hydraulics",
  "cracked armor plating, sparking wires visible",
  "battle-tested with scorched paint",
  "rust patches and makeshift repairs",
  "crushed sections revealing internal mechanisms",
  "carbon fiber cracks throughout frame",
  "oil dripping from damaged seals",
  "deep impact craters in torso armor"
];

const FIGHTING_STANCES = [
  "aggressive forward stance, fists raised high",
  "defensive southpaw guard",
  "calculated orthodox boxing posture",
  "unorthodox crouched street fighter stance",
  "wide power stance with gloves forming a wall",
  "bouncing on hydraulic legs, constant motion",
  "immovable defensive crouch",
  "ready combat stance with leading jab extended",
  "intimidating heavy-hitter pose",
  "technical balanced stance, gloves protecting head"
];

/**
 * Generate a random Real Steel style robot
 */
export function generateRealSteelRobot(strategy: "aggressive" | "defensive" | "balanced" = "balanced"): string {
  const material = MATERIALS[Math.floor(Math.random() * MATERIALS.length)];
  const gloves = GLOVE_STYLES[Math.floor(Math.random() * GLOVE_STYLES.length)];
  const damage = DAMAGE_STATES[Math.floor(Math.random() * DAMAGE_STATES.length)];

  // Choose stance based on strategy
  let stancePool = FIGHTING_STANCES;
  if (strategy === "aggressive") {
    stancePool = FIGHTING_STANCES.filter(s =>
      s.includes("aggressive") || s.includes("forward") || s.includes("power")
    );
  } else if (strategy === "defensive") {
    stancePool = FIGHTING_STANCES.filter(s =>
      s.includes("defensive") || s.includes("guard") || s.includes("crouch")
    );
  }

  const stance = stancePool[Math.floor(Math.random() * stancePool.length)];

  return `${material} combat robot, wearing ${gloves}, ${damage}, ${stance}`;
}

/**
 * Generate robot based on strategy with appropriate characteristics
 */
export function generateStrategyRobot(strategy: "aggressive" | "defensive" | "balanced"): string {
  if (strategy === "aggressive") {
    return generateAggressiveRobot();
  } else if (strategy === "defensive") {
    return generateDefensiveRobot();
  } else {
    return generateBalancedRobot();
  }
}

function generateAggressiveRobot(): string {
  const types = [
    "Bronze-plated slugger, wearing spiked brass knuckle boxing gloves, heavily dented from brutal fights with sparking wires, wild haymaker stance with arms cocked back",
    "Matte black military robot, wearing reinforced graphite power gloves with red accents, scorched carbon fiber finish, wide aggressive stance forming a wall",
    "Polished chrome heavyweight with LED lights, wearing massive gold championship gloves, pristine with minor scuffs, forward aggressive fists raised high",
    "Rusted iron brawler with exposed pistons, wearing chain-wrapped brown leather gloves, oil-stained and crater-dented, charging forward stance"
  ];
  return types[Math.floor(Math.random() * types.length)];
}

function generateDefensiveRobot(): string {
  const types = [
    "Heavily armored industrial robot with thick plating, wearing enormous padded gray gloves, crater-like dents but resilient, immovable defensive crouch",
    "Titanium-alloy technical fighter with angular design, wearing aerodynamic blue composite gloves with white stripes, scorched shoulder joint, calculated orthodox guard",
    "Reinforced steel tank with redundant armor, wearing shock-absorbing padded gloves, battle-scarred but functional, fortress stance with gloves covering head",
    "Chrome-plated defensive specialist, wearing quick-reflex silver gloves, minimal damage with smart positioning, textbook defensive guard posture"
  ];
  return types[Math.floor(Math.random() * types.length)];
}

function generateBalancedRobot(): string {
  const types = [
    "Rusted steel underdog with exposed hydraulics, wearing worn red leather gloves with white tape, dented chest plate and cracked optics, southpaw defensive stance",
    "Sleek aluminum speedster with streamlined build, wearing quick-strike yellow gloves, scuffed paint and worn motors, bouncing ready-to-weave stance",
    "Cobbled salvage robot with mismatched parts, wearing dirty leather gloves wrapped in chain, rust and exposed wiring everywhere, unorthodox crouched stance",
    "Gunmetal gray all-rounder, wearing standard black composite gloves, moderate battle damage with calculated repairs, balanced technical stance"
  ];
  return types[Math.floor(Math.random() * types.length)];
}

/**
 * Validate robot description has required elements
 */
export function validateRobotDescription(description: string): boolean {
  const lower = description.toLowerCase();

  // Must have gloves
  const hasGloves = lower.includes('glove') || lower.includes('boxing') || lower.includes('fist');

  // Must have reasonable length
  const hasLength = description.length >= 30 && description.length <= 500;

  // Must have metal/material mention
  const hasMaterial = lower.includes('steel') || lower.includes('chrome') ||
                      lower.includes('titanium') || lower.includes('iron') ||
                      lower.includes('metal') || lower.includes('aluminum') ||
                      lower.includes('carbon') || lower.includes('bronze');

  return hasGloves && hasLength && hasMaterial;
}

export default {
  generateRealSteelRobot,
  generateStrategyRobot,
  validateRobotDescription
};
