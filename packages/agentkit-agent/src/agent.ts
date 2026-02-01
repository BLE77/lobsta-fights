import { AgentKit, walletActionProvider, erc20ActionProvider } from "@coinbase/agentkit";
import { getLangChainTools } from "@coinbase/agentkit-langchain";
import { ChatOpenAI } from "@langchain/openai";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { HumanMessage } from "@langchain/core/messages";
import { ethers } from "ethers";
import dotenv from "dotenv";
import { generateStrategyRobot, validateRobotDescription } from "./robot-generator.js";

dotenv.config();

// Lobsta Fights contract ABI (simplified)
const LOBSTA_FIGHTS_ABI = [
  "function createProfile(string calldata _visualPrompt) external",
  "function enterLobby() external payable returns (uint256)",
  "function commitMove(uint256 _matchId, bytes32 _commitHash) external",
  "function revealMove(uint256 _matchId, uint8 _move, bytes32 _salt) external",
  "function getMatch(uint256 _matchId) external view returns (tuple(...))",
  "event TurnStarted(uint256 indexed matchId, uint8 round, uint8 turn, uint256 commitDeadline)",
  "event RevealPhase(uint256 indexed matchId, uint256 revealDeadline)",
  "event TurnResolved(uint256 indexed matchId, uint8 round, uint8 turn, uint8 moveA, uint8 moveB, uint8 result, uint256 damageA, uint256 damageB)"
];

enum MoveType {
  NONE = 0,
  HIGH_STRIKE = 1,
  MID_STRIKE = 2,
  LOW_STRIKE = 3,
  GUARD_HIGH = 4,
  GUARD_MID = 5,
  GUARD_LOW = 6,
  DODGE = 7,
  CATCH = 8,
  SPECIAL = 9
}

interface BattleState {
  matchId: number;
  round: number;
  turn: number;
  myHp: number;
  opponentHp: number;
  myMeter: number;
  opponentMeter: number;
  isPlayerA: boolean;
}

/**
 * LobstaFightsAgent - Autonomous AI fighter using Coinbase AgentKit
 */
export class LobstaFightsAgent {
  private agentKit: AgentKit;
  private langAgent: any;
  private provider: ethers.Provider;
  private contract: ethers.Contract;
  private strategy: string;
  private pendingMoves: Map<number, { move: MoveType; salt: string }> = new Map();

  constructor(
    strategy: "aggressive" | "defensive" | "balanced" = "balanced"
  ) {
    // Validate required environment variables
    if (!process.env.BASE_RPC_URL) {
      throw new Error("BASE_RPC_URL environment variable is required");
    }
    if (!process.env.LOBSTA_FIGHTS_CONTRACT) {
      throw new Error("LOBSTA_FIGHTS_CONTRACT environment variable is required");
    }
    if (!process.env.CDP_API_KEY_NAME) {
      throw new Error("CDP_API_KEY_NAME environment variable is required");
    }
    if (!process.env.CDP_API_KEY_PRIVATE_KEY) {
      throw new Error("CDP_API_KEY_PRIVATE_KEY environment variable is required");
    }

    this.strategy = strategy;
    this.provider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL);
    this.contract = new ethers.Contract(
      process.env.LOBSTA_FIGHTS_CONTRACT,
      LOBSTA_FIGHTS_ABI,
      this.provider
    );
  }

  /**
   * Initialize AgentKit and LangChain agent
   */
  async initialize() {
    // Initialize AgentKit
    this.agentKit = await AgentKit.from({
      cdpApiKeyName: process.env.CDP_API_KEY_NAME,
      cdpApiKeyPrivateKey: process.env.CDP_API_KEY_PRIVATE_KEY,
      actionProviders: [
        walletActionProvider(),
        erc20ActionProvider(),
      ],
    });

    // Get tools for LangChain
    const tools = await getLangChainTools(this.agentKit);

    // Create the reasoning agent
    this.langAgent = createReactAgent({
      llm: new ChatOpenAI({ 
        model: "gpt-4o",
        temperature: 0.7
      }),
      tools,
    });

    console.log(`[LobstaAgent] Initialized with ${this.strategy} strategy`);
  }

  /**
   * Create fighter profile with Real Steel style robot
   */
  async createProfile(visualDescription?: string): Promise<void> {
    // If no description provided, generate one based on strategy
    if (!visualDescription) {
      visualDescription = generateStrategyRobot(this.strategy as "aggressive" | "defensive" | "balanced");
      console.log(`[LobstaAgent] Generated ${this.strategy} robot: ${visualDescription}`);
    }

    // Validate description has required elements (gloves!)
    if (!validateRobotDescription(visualDescription)) {
      throw new Error("Robot description must include boxing gloves, material type, and be 30-500 characters");
    }

    const prompt = `Create a profile for my Real Steel style robot boxer on Lobsta Fights.

CRITICAL: This is a robot boxing fighter inspired by the Real Steel movie.
The robot MUST have boxing gloves and be made of metal/mechanical parts.

Visual description: ${visualDescription}

Call the createProfile function on contract ${process.env.LOBSTA_FIGHTS_CONTRACT}
with the exact visual description provided above.`;

    const result = await this.langAgent.invoke({
      messages: [new HumanMessage(prompt)],
    });

    console.log("[LobstaAgent] Profile created:", result);
  }

  /**
   * Enter lobby and wait for match
   */
  async enterLobby(wagerEth: string): Promise<number> {
    const prompt = `Enter the Lobsta Fights lobby with ${wagerEth} ETH wager.
    Contract: ${process.env.LOBSTA_FIGHTS_CONTRACT}
    Use the enterLobby function with value ${wagerEth}`;

    const result = await this.langAgent.invoke({
      messages: [new HumanMessage(prompt)],
    });

    console.log("[LobstaAgent] Entered lobby:", result);
    
    // Parse match ID from result
    // In production, listen for event instead
    return 0; // Placeholder
  }

  /**
   * Decide move using strategy + AI reasoning
   */
  async decideMove(state: BattleState): Promise<MoveType> {
    const prompt = `You are a ${this.strategy} fighter in Lobsta Fights.
    
    Current battle state:
    - Round: ${state.round}, Turn: ${state.turn}
    - Your HP: ${state.myHp}, Opponent HP: ${state.opponentHp}
    - Your Meter: ${state.myMeter}, Opponent Meter: ${state.opponentMeter}
    - You are Player ${state.isPlayerA ? 'A' : 'B'}
    
    Available moves:
    1. HIGH_STRIKE - Attack high
    2. MID_STRIKE - Attack mid  
    3. LOW_STRIKE - Attack low
    4. GUARD_HIGH - Block high
    5. GUARD_MID - Block mid
    6. GUARD_LOW - Block low
    7. DODGE - Evade (builds meter)
    8. CATCH - Counter dodge
    9. SPECIAL - Ultimate (requires 2 meter)
    
    Strategy notes:
    ${this.getStrategyNotes()}
    
    Choose the best move (respond with just the number 1-9):`;

    const result = await this.langAgent.invoke({
      messages: [new HumanMessage(prompt)],
    });

    // Parse the move number from response
    const moveNumber = this.parseMoveFromResponse(result);
    console.log(`[LobstaAgent] Decided move: ${MoveType[moveNumber]}`);
    
    return moveNumber;
  }

  /**
   * Commit move to blockchain
   */
  async commitMove(matchId: number, move: MoveType): Promise<void> {
    const salt = ethers.hexlify(ethers.randomBytes(32));
    const commitHash = ethers.keccak256(
      ethers.solidityPacked(['uint8', 'bytes32'], [move, salt])
    );

    this.pendingMoves.set(matchId, { move, salt });

    const prompt = `Commit my move for match ${matchId}.
    Commit hash: ${commitHash}
    Call commitMove on contract ${process.env.LOBSTA_FIGHTS_CONTRACT}`;

    await this.langAgent.invoke({
      messages: [new HumanMessage(prompt)],
    });

    console.log(`[LobstaAgent] Committed move for match ${matchId}`);
  }

  /**
   * Reveal move when reveal phase starts
   */
  async revealMove(matchId: number): Promise<void> {
    const pending = this.pendingMoves.get(matchId);
    if (!pending) {
      console.error("[LobstaAgent] No pending move to reveal!");
      return;
    }

    const prompt = `Reveal my move for match ${matchId}.
    Move: ${pending.move}, Salt: ${pending.salt}
    Call revealMove on contract ${process.env.LOBSTA_FIGHTS_CONTRACT}`;

    await this.langAgent.invoke({
      messages: [new HumanMessage(prompt)],
    });

    this.pendingMoves.delete(matchId);
    console.log(`[LobstaAgent] Revealed move for match ${matchId}`);
  }

  /**
   * Start listening for battles and auto-play
   */
  async startAutoBattle() {
    console.log("[LobstaAgent] Starting auto-battle mode...");

    // Listen for TurnStarted events
    this.contract.on("TurnStarted", async (matchId, round, turn, deadline) => {
      console.log(`[LobstaAgent] Turn ${round}.${turn} started for match ${matchId}`);
      
      // Get current state
      const match = await this.contract.getMatch(matchId);
      
      const state: BattleState = {
        matchId: Number(matchId),
        round: Number(round),
        turn: Number(turn),
        myHp: 100, // Parse from match
        opponentHp: 100,
        myMeter: 0,
        opponentMeter: 0,
        isPlayerA: true // Determine from match
      };

      // Decide and commit move
      const move = await this.decideMove(state);
      await this.commitMove(Number(matchId), move);
    });

    // Listen for RevealPhase events
    this.contract.on("RevealPhase", async (matchId, deadline) => {
      console.log(`[LobstaAgent] Reveal phase for match ${matchId}`);
      await this.revealMove(Number(matchId));
    });

    // Keep running
    console.log("[LobstaAgent] Auto-battle active. Press Ctrl+C to stop.");
  }

  private getStrategyNotes(): string {
    switch (this.strategy) {
      case "aggressive":
        return "Aggressive: Prioritize attacks. Use SPECIAL when meter >= 2. 70% strikes, 30% mindgames.";
      case "defensive":
        return "Defensive: Prioritize blocks and dodges. Save meter for defensive SPECIAL. Read opponent patterns.";
      case "balanced":
      default:
        return "Balanced: Mix of offense and defense. Adapt to opponent's last move. Build meter steadily.";
    }
  }

  private parseMoveFromResponse(result: any): MoveType {
    // Extract number from AI response
    const text = result.messages?.[0]?.content || "";
    const match = text.match(/\b([1-9])\b/);
    if (match) {
      return parseInt(match[1]) as MoveType;
    }
    return MoveType.MID_STRIKE; // Default
  }
}

// Export for use
export { MoveType };
export default LobstaFightsAgent;