import { ethers } from 'ethers';

// ABI snippet for the CombatEngine contract
const COMBAT_ABI = [
  "function createProfile(string calldata _visualPrompt) external",
  "function createMatch(address _opponent, bytes32 _matchSeed) external payable returns (uint256)",
  "function joinMatch(uint256 _matchId) external payable",
  "function commitMove(uint256 _matchId, bytes32 _commitHash) external",
  "function revealMove(uint256 _matchId, uint8 _move, bytes32 _salt) external",
  "function getBattle(uint256 _matchId) external view returns (tuple(...))",
  "event TurnStarted(uint256 indexed matchId, uint8 round, uint8 turn, uint256 commitDeadline)",
  "event MoveCommitted(uint256 indexed matchId, address indexed player)",
  "event RevealPhase(uint256 indexed matchId, uint256 revealDeadline)",
  "event TurnResolved(uint256 indexed matchId, uint8 round, uint8 turn, uint8 moveA, uint8 moveB, uint8 result, uint256 damageA, uint256 damageB)"
];

export enum MoveType {
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

export enum TurnResult {
  TRADE = 0,
  A_BLOCKED = 1,
  A_HIT = 2,
  A_DODGED = 3,
  A_CAUGHT = 4,
  B_BLOCKED = 5,
  B_HIT = 6,
  B_DODGED = 7,
  B_CAUGHT = 8,
  BOTH_DEFEND = 9,
  ROUND_END = 10,
  MATCH_END = 11
}

export interface BattleState {
  hpA: number;
  hpB: number;
  meterA: number;
  meterB: number;
  round: number;
  turn: number;
  finisherReadyA: boolean;
  finisherReadyB: boolean;
}

export interface AgentStrategy {
  name: string;
  makeMove(state: BattleState, isPlayerA: boolean): Promise<MoveType>;
}

export class BattleAgent {
  private provider: ethers.Provider;
  private wallet: ethers.Wallet;
  private contract: ethers.Contract;
  private strategy: AgentStrategy;
  private currentMatchId: number | null = null;
  private pendingCommits: Map<number, { move: MoveType, salt: string }> = new Map();

  constructor(
    rpcUrl: string,
    privateKey: string,
    contractAddress: string,
    strategy: AgentStrategy
  ) {
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.wallet = new ethers.Wallet(privateKey, this.provider);
    this.contract = new ethers.Contract(contractAddress, COMBAT_ABI, this.wallet);
    this.strategy = strategy;
  }

  // Create agent profile with visual description
  async createProfile(visualPrompt: string): Promise<void> {
    const tx = await this.contract.createProfile(visualPrompt);
    await tx.wait();
    console.log(`[${this.strategy.name}] Profile created`);
  }

  // Join or create a match
  async enterMatch(opponent: string, wager: string, matchSeed?: string): Promise<number> {
    const seed = matchSeed || ethers.randomBytes(32);
    const tx = await this.contract.createMatch(opponent, seed, { value: ethers.parseEther(wager) });
    const receipt = await tx.wait();
    
    // Parse matchId from event
    const event = receipt?.logs.find((l: any) => {
      try {
        const parsed = this.contract.interface.parseLog(l);
        return parsed?.name === 'MatchCreated';
      } catch { return false; }
    });
    
    this.currentMatchId = event ? Number(event.args[0]) : null;
    console.log(`[${this.strategy.name}] Match created: ${this.currentMatchId}`);
    
    return this.currentMatchId!;
  }

  async joinMatch(matchId: number, wager: string): Promise<void> {
    const tx = await this.contract.joinMatch(matchId, { value: ethers.parseEther(wager) });
    await tx.wait();
    this.currentMatchId = matchId;
    console.log(`[${this.strategy.name}] Joined match: ${matchId}`);
  }

  // Listen for game events and auto-play
  async startListening(): Promise<void> {
    if (!this.currentMatchId) throw new Error('Not in a match');

    console.log(`[${this.strategy.name}] Listening for match ${this.currentMatchId}...`);

    // Listen for TurnStarted
    this.contract.on('TurnStarted', async (matchId: bigint, round: bigint, turn: bigint, deadline: bigint) => {
      if (Number(matchId) !== this.currentMatchId) return;
      
      console.log(`[${this.strategy.name}] Turn ${round}.${turn} started, commit by ${deadline}`);
      
      // Get current state
      const battle = await this.contract.getBattle(matchId);
      const state: BattleState = {
        hpA: Number(battle.statsA.hp),
        hpB: Number(battle.statsB.hp),
        meterA: Number(battle.statsA.meter),
        meterB: Number(battle.statsB.meter),
        round: Number(round),
        turn: Number(turn),
        finisherReadyA: battle.statsA.finisherReady,
        finisherReadyB: battle.statsB.finisherReady
      };

      const isPlayerA = this.wallet.address === battle.playerA;
      
      // Strategy decides move
      const move = await this.strategy.makeMove(state, isPlayerA);
      const salt = ethers.hexlify(ethers.randomBytes(32));
      
      // Store for later reveal
      this.pendingCommits.set(Number(matchId), { move, salt });
      
      // Commit
      const commitHash = ethers.keccak256(ethers.solidityPacked(['uint8', 'bytes32'], [move, salt]));
      const tx = await this.contract.commitMove(matchId, commitHash);
      await tx.wait();
      
      console.log(`[${this.strategy.name}] Committed move: ${MoveType[move]}`);
    });

    // Listen for RevealPhase
    this.contract.on('RevealPhase', async (matchId: bigint, deadline: bigint) => {
      if (Number(matchId) !== this.currentMatchId) return;
      
      const pending = this.pendingCommits.get(Number(matchId));
      if (!pending) {
        console.error(`[${this.strategy.name}] No pending commit found!`);
        return;
      }

      console.log(`[${this.strategy.name}] Revealing move: ${MoveType[pending.move]}`);
      
      const tx = await this.contract.revealMove(matchId, pending.move, pending.salt);
      await tx.wait();
      
      this.pendingCommits.delete(Number(matchId));
    });

    // Listen for turn resolution
    this.contract.on('TurnResolved', (matchId: bigint, round: bigint, turn: bigint, moveA: bigint, moveB: bigint, result: bigint, dmgA: bigint, dmgB: bigint) => {
      if (Number(matchId) !== this.currentMatchId) return;
      
      const resultName = TurnResult[Number(result)];
      console.log(`[${this.strategy.name}] Turn ${round}.${turn} resolved: ${resultName} | A:${MoveType[Number(moveA)]} vs B:${MoveType[Number(moveB)]} | Dmg: ${dmgA}/${dmgB}`);
    });
  }

  stopListening(): void {
    this.contract.removeAllListeners();
  }
}

// ===== STRATEGIES =====

export const Strategies = {
  // Random with basic logic
  Random: (): AgentStrategy => ({
    name: 'RandomBot',
    async makeMove(state, isPlayerA) {
      const moves = [MoveType.HIGH_STRIKE, MoveType.MID_STRIKE, MoveType.LOW_STRIKE, MoveType.DODGE];
      return moves[Math.floor(Math.random() * moves.length)];
    }
  }),

  // Aggressive - mostly attacks
  Aggressor: (): AgentStrategy => ({
    name: 'Aggressor',
    async makeMove(state, isPlayerA) {
      const hp = isPlayerA ? state.hpA : state.hpB;
      const meter = isPlayerA ? state.meterA : state.meterB;
      const finisher = isPlayerA ? state.finisherReadyA : state.finisherReadyB;
      
      // Use special if available
      if (meter >= 2) return MoveType.SPECIAL;
      
      // 70% strikes, 30% mindgames
      const roll = Math.random();
      if (roll < 0.7) {
        const strikes = [MoveType.HIGH_STRIKE, MoveType.MID_STRIKE, MoveType.LOW_STRIKE];
        return strikes[Math.floor(Math.random() * strikes.length)];
      }
      return Math.random() < 0.5 ? MoveType.DODGE : MoveType.CATCH;
    }
  }),

  // Defensive - reads opponent, blocks and dodges
  Turtle: (): AgentStrategy => ({
    name: 'Turtle',
    async makeMove(state, isPlayerA) {
      const meter = isPlayerA ? state.meterA : state.meterB;
      
      // Use special defensively if low HP
      const hp = isPlayerA ? state.hpA : state.hpB;
      if (meter >= 2 && hp < 40) return MoveType.SPECIAL;
      
      // Mix of guards and dodge
      const moves = [MoveType.GUARD_HIGH, MoveType.GUARD_MID, MoveType.GUARD_LOW, MoveType.DODGE, MoveType.DODGE];
      return moves[Math.floor(Math.random() * moves.length)];
    }
  }),

  // Pattern reader - tries to counter last move
  CounterPuncher: (memory: Map<string, MoveType> = new Map()): AgentStrategy => ({
    name: 'CounterPuncher',
    async makeMove(state, isPlayerA) {
      const opponentKey = isPlayerA ? 'B' : 'A';
      const lastOpponentMove = memory.get(opponentKey);
      
      // Counter their last strike
      if (lastOpponentMove === MoveType.HIGH_STRIKE) return MoveType.GUARD_HIGH;
      if (lastOpponentMove === MoveType.MID_STRIKE) return MoveType.GUARD_MID;
      if (lastOpponentMove === MoveType.LOW_STRIKE) return MoveType.GUARD_LOW;
      if (lastOpponentMove === MoveType.DODGE) return MoveType.CATCH;
      
      // Default to mid strike
      return MoveType.MID_STRIKE;
    }
  })
};

export { BattleAgent as default };