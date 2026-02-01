/**
 * Bot Fight Test - Full Match Between Alpha and Beta
 *
 * This script:
 * 1. Registers both bot fighters (Alpha & Beta)
 * 2. Creates a match between them
 * 3. Runs the full fight with commit/reveal flow
 * 4. Shows play-by-play results
 *
 * Run: npx ts-node scripts/bot-fight-test.ts
 */

import crypto from "crypto";

const BASE_URL = process.env.API_URL || "http://localhost:3000";
const ADMIN_KEY = process.env.ADMIN_API_KEY || "test-admin-key";

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

function log(msg: string, color = colors.reset) {
  console.log(`${color}${msg}${colors.reset}`);
}

function createMoveHash(move: string, salt: string): string {
  return crypto.createHash("sha256").update(`${move}:${salt}`).digest("hex");
}

function generateSalt(): string {
  return crypto.randomBytes(16).toString("hex");
}

async function api(endpoint: string, method = "GET", body?: any) {
  const response = await fetch(`${BASE_URL}${endpoint}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return response.json();
}

async function getBotMove(botUrl: string, matchState: any): Promise<{ move: string; taunt: string }> {
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
    return { move: "MID_STRIKE", taunt: "..." }; // Fallback
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
    specialMove: "ALPHA BLAST",
    webhookUrl: `${BASE_URL}/api/bots/alpha`,
  });

  const betaReg = await api("/api/fighter/register", "POST", {
    walletAddress: `beta-test-${timestamp}`,
    name: "Beta - The Tactician",
    description: "Defensive counter-attacker. Reads your moves.",
    specialMove: "OMEGA STRIKE",
    webhookUrl: `${BASE_URL}/api/bots/beta`,
  });

  if (alphaReg.error || betaReg.error) {
    log(`Registration failed: ${alphaReg.error || betaReg.error}`, colors.red);
    return;
  }

  log(`  Alpha registered: ${alphaReg.fighter_id}`, colors.green);
  log(`  Beta registered: ${betaReg.fighter_id}`, colors.green);

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

  let matchState: any = {
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
      turnHistory: matchState.turnHistory.map((t: any) => ({
        your_move: t.move_a,
        opponent_move: t.move_b,
      })),
    });

    const betaDecision = await getBotMove(`${BASE_URL}/api/bots/beta`, {
      yourState: { hp: matchState.betaHp, meter: matchState.betaMeter },
      oppState: { hp: matchState.alphaHp, meter: matchState.alphaMeter },
      turnHistory: matchState.turnHistory.map((t: any) => ({
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

  const alphaDmgDealt = matchState.turnHistory.reduce((sum: number, t: any) => sum + t.damage_to_b, 0);
  const betaDmgDealt = matchState.turnHistory.reduce((sum: number, t: any) => sum + t.damage_to_a, 0);
  log(`  Alpha Total Damage Dealt: ${alphaDmgDealt}`, colors.blue);
  log(`  Beta Total Damage Dealt: ${betaDmgDealt}`, colors.cyan);

  log("\n[ TEST COMPLETE ]\n", colors.green);
}

runFight().catch(console.error);
