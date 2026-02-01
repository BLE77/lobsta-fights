import { LobstaFightsAgent } from "./agent.js";
import dotenv from "dotenv";

dotenv.config();

/**
 * Auto-battle runner
 * Starts an autonomous agent that fights forever
 */
async function main() {
  // Get strategy from command line
  const strategy = process.argv[2] as "aggressive" | "defensive" | "balanced" || "balanced";
  
  console.log("🦞 LOBSTA FIGHTS - AgentKit Auto-Battle");
  console.log(`Strategy: ${strategy.toUpperCase()}`);
  console.log("----------------------------------------\n");

  // Initialize agent
  const agent = new LobstaFightsAgent(strategy);
  await agent.initialize();

  // Check if profile exists, create if not
  // TODO: Check on-chain for existing profile
  const hasProfile = false;
  
  if (!hasProfile) {
    console.log("Creating fighter profile...");
    await agent.createProfile(
      "Rusted iron lobster with cracked leather boxing gloves, torn cargo shorts, " +
      "oil-stained shell, warehouse scars, flickering red eye"
    );
  }

  // Enter lobby with wager
  const wager = process.env.WAGER_ETH || "0.01";
  console.log(`Entering lobby with ${wager} ETH...`);
  
  try {
    await agent.enterLobby(wager);
  } catch (e) {
    console.log("Already in lobby or error:", e);
  }

  // Start auto-battle loop
  await agent.startAutoBattle();

  // Keep process alive
  process.stdin.resume();
}

// Run
main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});