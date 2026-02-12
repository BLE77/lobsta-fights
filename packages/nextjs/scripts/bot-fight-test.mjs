/**
 * Bot Fight Test - Full Match Between Alpha and Beta
 */

import crypto from "crypto";

const BASE_URL = process.env.API_URL || "http://localhost:3000";
const INTERNAL_KEY = process.env.UCF_INTERNAL_KEY || process.env.CRON_SECRET || null;

// Colors for terminal output
const colors = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
};

function log(msg, color = colors.reset) {
  console.log(`${color}${msg}${colors.reset}`);
}

function createMoveHash(move, salt) {
  return crypto.createHash("sha256").update(`${move}:${salt}`).digest("hex");
}

function generateSalt() {
  return crypto.randomBytes(16).toString("hex");
}

async function api(endpoint, method = "GET", body) {
  const headers = { "Content-Type": "application/json" };
  if (INTERNAL_KEY) {
    headers["x-internal-key"] = INTERNAL_KEY;
  }

  const response = await fetch(`${BASE_URL}${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return response.json();
}

async function getBotMove(botUrl, matchState) {
  try {
    const response = await fetch(botUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "turn_request",
        your_state: matchState.yourState,
        opponent_state: matchState.oppState,
        turn_history: matchState.turnHistory,
      }),
    });
    return response.json();
  } catch (err) {
    return { move: "MID_STRIKE", taunt: "..." };
  }
}

async function runFight() {
  log("\n" + "=".repeat(70), colors.bold);
  log("   UNDERGROUND CLAW FIGHTS - BOT BATTLE TEST", colors.bold + colors.cyan);
  log("   Alpha (The Punisher) vs Beta (The Tactician)", colors.cyan);
  log("=".repeat(70) + "\n", colors.bold);

  // Step 1: Register fighters
  log("[ REGISTRATION ]", colors.yellow);

  const timestamp = Date.now();

  const alphaReg = await api("/api/fighter/register", "POST", {
    walletAddress: `alpha-test-${timestamp}`,
    name: "Alpha - The Punisher",
    description: "Heavy hitter. Loves strikes. Will destroy you.",
    webhookUrl: `${BASE_URL}/api/bots/alpha`,
    // Robot identity (required)
    robotType: "Heavy Brawler",
    chassisDescription: "Massive reinforced titanium frame with hydraulic limbs. 9 feet of pure destruction. Glowing red eyes, steam vents on shoulders, battle-scarred armor plating.",
    fistsDescription: "Oversized industrial wrecking-ball fists with reinforced tungsten knuckles and hydraulic piston amplifiers",
    fightingStyle: "aggressive",
    personality: "Cocky, relentless, loves violence",
    signatureMove: "ALPHA BLAST",
    victoryLine: "PUNISHMENT DELIVERED!",
    defeatLine: "Impossible... rebooting...",
    colorScheme: "crimson red and gunmetal black",
    distinguishingFeatures: "Cracked visor, smoking exhaust pipes, chains wrapped around arms",
  });

  if (alphaReg.error) {
    log(`Alpha registration failed: ${alphaReg.error}`, colors.red);
    return;
  }

  log(`  Alpha registered: ${alphaReg.fighter_id}`, colors.green);
  log(`  Image generating: ${alphaReg.image_generating}`, colors.green);

  // Wait for Alpha's image generation to start before registering Beta
  // This avoids potential rate limiting from concurrent Replicate API calls
  log("  Waiting 10s before registering Beta...", colors.yellow);
  await new Promise(resolve => setTimeout(resolve, 10000));

  const betaReg = await api("/api/fighter/register", "POST", {
    walletAddress: `beta-test-${timestamp}`,
    name: "Beta - The Tactician",
    description: "Defensive counter-attacker. Reads your moves.",
    webhookUrl: `${BASE_URL}/api/bots/beta`,
    // Robot identity (required)
    robotType: "Tactical Assassin",
    chassisDescription: "Sleek carbon-fiber exoskeleton with adaptive camouflage plating. Slim, agile frame built for precision. Multiple sensor arrays and targeting systems.",
    fistsDescription: "Precision-engineered combat fists with shock absorbers and nerve-disrupting contact points",
    fightingStyle: "tactical",
    personality: "Cold, calculating, always three steps ahead",
    signatureMove: "OMEGA STRIKE",
    victoryLine: "Calculated. Executed. Victory.",
    defeatLine: "Analyzing defeat... updating protocols...",
    colorScheme: "midnight blue and chrome silver",
    distinguishingFeatures: "Holographic HUD visor, retractable blade fins, pulsing data streams visible through translucent panels",
  });

  if (betaReg.error) {
    log(`Beta registration failed: ${betaReg.error}`, colors.red);
    return;
  }

  log(`  Beta registered: ${betaReg.fighter_id}`, colors.green);
  log(`  Image generating: ${betaReg.image_generating}`, colors.green);
  log("  Both fighters auto-verified - ready to fight!", colors.green);

  const alphaId = alphaReg.fighter_id;
  const betaId = betaReg.fighter_id;
  const alphaKey = alphaReg.api_key;
  const betaKey = betaReg.api_key;

  // Step 2: Create match
  log("\n[ MATCH CREATION ]", colors.yellow);

  const match = await api("/api/match/create", "POST", {
    fighter_a_id: alphaId,
    fighter_b_id: betaId,
    points_wager: 100,
  });

  if (match.error) {
    log(`Match creation failed: ${match.error}`, colors.red);
    return;
  }

  const matchId = match.match_id;
  log(`  Match ID: ${matchId}`, colors.green);
  log(`  Points Wager: ${match.points_wager}`, colors.green);

  // Step 3: Run the fight!
  log("\n" + "=".repeat(70), colors.bold);
  log("   FIGHT!", colors.bold + colors.red);
  log("=".repeat(70) + "\n", colors.bold);

  let matchState = {
    alphaHp: 100,
    betaHp: 100,
    alphaMeter: 0,
    betaMeter: 0,
    alphaRoundsWon: 0,
    betaRoundsWon: 0,
    currentRound: 1,
    currentTurn: 1,
    turnHistory: [],
  };

  let matchComplete = false;
  let winner = null;

  while (!matchComplete && matchState.currentTurn <= 30) {
    log(`--- Round ${matchState.currentRound}, Turn ${matchState.currentTurn} ---`, colors.magenta);
    log(`  Alpha: ${matchState.alphaHp} HP, ${matchState.alphaMeter} Meter`, colors.blue);
    log(`  Beta:  ${matchState.betaHp} HP, ${matchState.betaMeter} Meter`, colors.cyan);

    // Get moves from both bots
    const alphaDecision = await getBotMove(`${BASE_URL}/api/bots/alpha`, {
      yourState: { hp: matchState.alphaHp, meter: matchState.alphaMeter },
      oppState: { hp: matchState.betaHp, meter: matchState.betaMeter },
      turnHistory: matchState.turnHistory.map((t) => ({
        your_move: t.move_a,
        opponent_move: t.move_b,
      })),
    });

    const betaDecision = await getBotMove(`${BASE_URL}/api/bots/beta`, {
      yourState: { hp: matchState.betaHp, meter: matchState.betaMeter },
      oppState: { hp: matchState.alphaHp, meter: matchState.alphaMeter },
      turnHistory: matchState.turnHistory.map((t) => ({
        your_move: t.move_b,
        opponent_move: t.move_a,
      })),
    });

    log(`  Alpha chooses: ${alphaDecision.move} - "${alphaDecision.taunt}"`, colors.blue);
    log(`  Beta chooses:  ${betaDecision.move} - "${betaDecision.taunt}"`, colors.cyan);

    // Commit phase
    const saltA = generateSalt();
    const saltB = generateSalt();
    const hashA = createMoveHash(alphaDecision.move, saltA);
    const hashB = createMoveHash(betaDecision.move, saltB);

    await api("/api/match/commit", "POST", {
      match_id: matchId,
      fighter_id: alphaId,
      api_key: alphaKey,
      move_hash: hashA,
    });

    await api("/api/match/commit", "POST", {
      match_id: matchId,
      fighter_id: betaId,
      api_key: betaKey,
      move_hash: hashB,
    });

    // Reveal phase
    await api("/api/match/reveal", "POST", {
      match_id: matchId,
      fighter_id: alphaId,
      api_key: alphaKey,
      move: alphaDecision.move,
      salt: saltA,
    });

    const result = await api("/api/match/reveal", "POST", {
      match_id: matchId,
      fighter_id: betaId,
      api_key: betaKey,
      move: betaDecision.move,
      salt: saltB,
    });

    if (result.error) {
      log(`  Error: ${result.error}`, colors.red);
      break;
    }

    // Display result
    const tr = result.turn_result;
    let resultText = "";
    switch (tr.result) {
      case "A_HIT": resultText = `Alpha lands ${tr.move_a}! (${tr.damage_to_b} dmg)`; break;
      case "B_HIT": resultText = `Beta lands ${tr.move_b}! (${tr.damage_to_a} dmg)`; break;
      case "TRADE": resultText = `TRADE! Alpha: ${tr.damage_to_a} dmg, Beta: ${tr.damage_to_b} dmg`; break;
      case "A_DODGED": resultText = `Alpha dodges Beta's ${tr.move_b}!`; break;
      case "B_DODGED": resultText = `Beta dodges Alpha's ${tr.move_a}!`; break;
      case "A_BLOCKED": resultText = `Alpha blocks Beta's ${tr.move_b}!`; break;
      case "B_BLOCKED": resultText = `Beta blocks Alpha's ${tr.move_a}!`; break;
      case "BOTH_DEFEND": resultText = "Both defend - no damage!"; break;
    }
    log(`  >> ${resultText}`, colors.yellow);

    // Update state
    matchState.alphaHp = result.fighter_a_state.hp;
    matchState.betaHp = result.fighter_b_state.hp;
    matchState.alphaMeter = result.fighter_a_state.meter;
    matchState.betaMeter = result.fighter_b_state.meter;
    matchState.alphaRoundsWon = result.fighter_a_state.rounds_won;
    matchState.betaRoundsWon = result.fighter_b_state.rounds_won;
    matchState.currentRound = result.current_round;
    matchState.currentTurn = result.current_turn;
    matchState.turnHistory.push(tr);

    if (result.round_winner) {
      const roundWinner = result.round_winner === alphaId ? "Alpha" : "Beta";
      log(`\n  *** ROUND ${tr.round} WINNER: ${roundWinner}! ***`, colors.bold + colors.green);
      log(`  Score: Alpha ${matchState.alphaRoundsWon} - Beta ${matchState.betaRoundsWon}\n`, colors.green);
    }

    if (result.match_winner) {
      matchComplete = true;
      winner = result.match_winner === alphaId ? "Alpha" : "Beta";
    }

    log("");
  }

  // Final result
  log("=".repeat(70), colors.bold);
  if (winner) {
    const winnerColor = winner === "Alpha" ? colors.blue : colors.cyan;
    log(`   WINNER: ${winner.toUpperCase()}!`, colors.bold + winnerColor);
    log(`   Final Score: Alpha ${matchState.alphaRoundsWon} - Beta ${matchState.betaRoundsWon}`, winnerColor);
  } else {
    log("   Match ended without clear winner", colors.yellow);
  }
  log("=".repeat(70) + "\n", colors.bold);

  // Show fight stats
  log("[ FIGHT STATS ]", colors.yellow);
  log(`  Total Turns: ${matchState.turnHistory.length}`, colors.reset);
  log(`  Total Rounds: ${matchState.alphaRoundsWon + matchState.betaRoundsWon}`, colors.reset);

  const alphaDmgDealt = matchState.turnHistory.reduce((sum, t) => sum + t.damage_to_b, 0);
  const betaDmgDealt = matchState.turnHistory.reduce((sum, t) => sum + t.damage_to_a, 0);
  log(`  Alpha Total Damage Dealt: ${alphaDmgDealt}`, colors.blue);
  log(`  Beta Total Damage Dealt: ${betaDmgDealt}`, colors.cyan);

  // Check if images were generated
  log("\n[ IMAGE VERIFICATION ]", colors.yellow);
  log("  Waiting 30s for image generation to complete...", colors.yellow);

  // Poll for images
  let imagesReady = false;
  let attempts = 0;
  const maxAttempts = 15; // 15 attempts * 2s = 30s

  while (!imagesReady && attempts < maxAttempts) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    attempts++;

    // Fetch match details to get fighter images
    const matchResponse = await api(`/api/matches?id=${matchId}`);
    const matchDetails = matchResponse.match;

    if (matchDetails.fighter_a?.image_url && matchDetails.fighter_b?.image_url) {
      imagesReady = true;
      log(`  Alpha image: ${matchDetails.fighter_a.image_url}`, colors.green);
      log(`  Beta image: ${matchDetails.fighter_b.image_url}`, colors.green);
      if (matchDetails.result_image_url) {
        log(`  Result image: ${matchDetails.result_image_url}`, colors.green);
      }
    } else {
      log(`  Attempt ${attempts}/${maxAttempts}: Alpha=${matchDetails.fighter_a?.image_url ? 'ready' : 'pending'}, Beta=${matchDetails.fighter_b?.image_url ? 'ready' : 'pending'}`, colors.yellow);
    }
  }

  if (!imagesReady) {
    log("  WARNING: Images may not have generated in time", colors.red);
  }

  log("\n[ TEST COMPLETE ]\n", colors.green);
}

runFight().catch(console.error);
