/**
 * UCF System Test Script
 *
 * Tests the complete fight flow:
 * 1. Register two test fighters
 * 2. Create a match between them
 * 3. Both commit moves (using commit-reveal)
 * 4. Both reveal moves
 * 5. Verify combat resolution
 *
 * Run with: npx ts-node scripts/test-ucf-system.ts
 */

import crypto from "crypto";

const BASE_URL = process.env.API_URL || "http://localhost:3000";

// Helper to create move hash (same as lib/combat.ts)
function createMoveHash(move: string, salt: string): string {
  return crypto.createHash("sha256").update(`${move}:${salt}`).digest("hex");
}

function generateSalt(): string {
  return crypto.randomBytes(16).toString("hex");
}

async function apiCall(endpoint: string, method: string, body?: any) {
  const url = `${BASE_URL}${endpoint}`;
  console.log(`\n[API] ${method} ${endpoint}`);

  const response = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await response.json();

  if (!response.ok) {
    console.error(`[ERROR] ${response.status}:`, data);
    throw new Error(data.error || "API call failed");
  }

  console.log("[RESULT]", JSON.stringify(data, null, 2));
  return data;
}

async function runTests() {
  console.log("=".repeat(60));
  console.log("UCF SYSTEM TEST");
  console.log("=".repeat(60));

  // Step 1: Register two test fighters
  console.log("\n--- STEP 1: Register Test Fighters ---");

  const fighterA = await apiCall("/api/fighter/register", "POST", {
    walletAddress: `test-wallet-a-${Date.now()}`,
    name: "Test Bot Alpha",
    description: "Test fighter A for system verification",
    specialMove: "Alpha Strike",
    webhookUrl: "http://localhost:3000/api/sample-bot/fight",
  });

  const fighterB = await apiCall("/api/fighter/register", "POST", {
    walletAddress: `test-wallet-b-${Date.now()}`,
    name: "Test Bot Beta",
    description: "Test fighter B for system verification",
    specialMove: "Beta Blast",
    webhookUrl: "http://localhost:3000/api/sample-bot/fight",
  });

  console.log(`\nFighter A: ${fighterA.fighter_id} (${fighterA.points} points)`);
  console.log(`Fighter B: ${fighterB.fighter_id} (${fighterB.points} points)`);

  // Step 2: Verify fighters (normally admin does this)
  console.log("\n--- STEP 2: Verify Fighters (Admin) ---");

  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey) {
    console.log("[SKIP] No ADMIN_API_KEY set - fighters need manual verification");
    console.log("Run: POST /api/admin/verify-fighter with admin_key and fighter_id");
    return;
  }

  await apiCall("/api/admin/verify-fighter", "POST", {
    admin_key: adminKey,
    fighter_id: fighterA.fighter_id,
  });

  await apiCall("/api/admin/verify-fighter", "POST", {
    admin_key: adminKey,
    fighter_id: fighterB.fighter_id,
  });

  // Step 3: Create a match
  console.log("\n--- STEP 3: Create Match ---");

  const match = await apiCall("/api/match/create", "POST", {
    fighter_a_id: fighterA.fighter_id,
    fighter_b_id: fighterB.fighter_id,
    points_wager: 100,
  });

  const matchId = match.match_id;
  console.log(`\nMatch created: ${matchId}`);

  // Step 4: Both fighters commit moves
  console.log("\n--- STEP 4: Commit Moves (Commit-Reveal Phase 1) ---");

  const moveA = "HIGH_STRIKE";
  const saltA = generateSalt();
  const hashA = createMoveHash(moveA, saltA);

  const moveB = "GUARD_HIGH"; // This should block the high strike
  const saltB = generateSalt();
  const hashB = createMoveHash(moveB, saltB);

  console.log(`\nFighter A commits: ${moveA} (salt: ${saltA.slice(0, 8)}...)`);
  console.log(`Hash A: ${hashA}`);

  await apiCall("/api/match/commit", "POST", {
    match_id: matchId,
    fighter_id: fighterA.fighter_id,
    api_key: fighterA.api_key,
    move_hash: hashA,
  });

  console.log(`\nFighter B commits: ${moveB} (salt: ${saltB.slice(0, 8)}...)`);
  console.log(`Hash B: ${hashB}`);

  const commitResult = await apiCall("/api/match/commit", "POST", {
    match_id: matchId,
    fighter_id: fighterB.fighter_id,
    api_key: fighterB.api_key,
    move_hash: hashB,
  });

  console.log(`\nMatch state after both commit: ${commitResult.state}`);

  // Step 5: Both fighters reveal moves
  console.log("\n--- STEP 5: Reveal Moves (Commit-Reveal Phase 2) ---");

  await apiCall("/api/match/reveal", "POST", {
    match_id: matchId,
    fighter_id: fighterA.fighter_id,
    api_key: fighterA.api_key,
    move: moveA,
    salt: saltA,
  });

  const revealResult = await apiCall("/api/match/reveal", "POST", {
    match_id: matchId,
    fighter_id: fighterB.fighter_id,
    api_key: fighterB.api_key,
    move: moveB,
    salt: saltB,
  });

  // Step 6: Verify result
  console.log("\n--- STEP 6: Verify Combat Resolution ---");
  console.log(`\nTurn Result: ${revealResult.turn_result.result}`);
  console.log(`Move A: ${revealResult.turn_result.move_a}`);
  console.log(`Move B: ${revealResult.turn_result.move_b}`);
  console.log(`Damage to A: ${revealResult.turn_result.damage_to_a}`);
  console.log(`Damage to B: ${revealResult.turn_result.damage_to_b}`);

  // Verify the expected outcome
  if (moveA === "HIGH_STRIKE" && moveB === "GUARD_HIGH") {
    if (
      revealResult.turn_result.result === "B_BLOCKED" &&
      revealResult.turn_result.damage_to_b === 0
    ) {
      console.log("\n[PASS] Combat resolution correct! GUARD_HIGH blocked HIGH_STRIKE");
    } else {
      console.log("\n[FAIL] Unexpected result - guard should have blocked");
    }
  }

  // Step 7: Test cheat prevention
  console.log("\n--- STEP 7: Test Cheat Prevention ---");

  // Try to reveal with wrong salt (should fail)
  try {
    await apiCall("/api/match/reveal", "POST", {
      match_id: matchId,
      fighter_id: fighterA.fighter_id,
      api_key: fighterA.api_key,
      move: "LOW_STRIKE", // Different move than committed
      salt: saltA,
    });
    console.log("[FAIL] Should have rejected wrong move");
  } catch (e: any) {
    if (e.message.includes("already revealed") || e.message.includes("hash")) {
      console.log("[PASS] System correctly rejected attempt to change move");
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log("TEST COMPLETE");
  console.log("=".repeat(60));
}

runTests().catch(console.error);
