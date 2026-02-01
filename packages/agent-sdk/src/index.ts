import { ethers } from 'ethers';

// ABI snippet for the LobstaFights contract
const LOBSTA_ABI = [
  "function createProfile(string calldata _visualPrompt) external",
  "function enterLobby() external payable returns (uint256)",
  "function createPrivateMatch(bytes32 _inviteCodeHash) external payable returns (uint256)",
  "function joinPrivateMatch(uint256 _matchId, bytes32 _inviteCode) external payable",
  "function commitMove(uint256 _matchId, bytes32 _commitHash) external",
  "function revealMove(uint256 _matchId, uint8 _move, bytes32 _salt) external",
  "function getMatch(uint256 _matchId) external view returns (tuple(...))",
  "function getProfile(address _agent) external view returns (tuple(...))",
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
  A_BLOCKED = 1, A_HIT = 2, A_DODGED = 3, A_CAUGHT = 4,
  B_BLOCKED = 5, B_HIT = 6, B_DODGED = 7, B_CAUGHT = 8,
  BOTH_DEFEND = 9, ROUND_END = 10, MATCH_END = 11
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
  lastMoveA?: MoveType;
  lastMoveB?: MoveType;
  turnHistory?: Array<{ moveA: MoveType; moveB: MoveType; result: TurnResult }>;
}

export interface AgentStrategy {
  name: string;
  makeMove(state: BattleState, isPlayerA: boolean): Promise<MoveType>;
}

/**
 * Real Steel style visual prompt generator
 * Generates photorealistic robot boxing match prompts inspired by Real Steel movie
 */
export function generateRealSteelPrompt(
  fighterA: { name: string; visualPrompt: string; hp: number; move: string },
  fighterB: { name: string; visualPrompt: string; hp: number; move: string },
  result: string,
  damage: number
): string {
  // Determine action intensity based on damage
  const intensity = damage > 30 ? 'catastrophic knockout punch' :
                    damage > 20 ? 'brutal power strike' :
                    damage > 10 ? 'solid combination hit' :
                    damage > 0 ? 'quick jab impact' : 'defensive block';

  // Combat action description
  const action = damage > 25 ?
    'haymaker uppercut connecting with devastating force, defender\'s head snapping back, oil explosion, metal crunching' :
    damage > 10 ?
    'powerful cross punch landing clean, impact shockwave visible, sparks flying from contact' :
    damage > 0 ?
    'quick strike connecting, glove impact, defensive recoil' :
    'defensive stance, gloves raised in protective guard, attack deflected';

  // Damage state
  const conditionA = fighterA.hp > 70 ? 'pristine fighting condition, minor scuffs' :
                     fighterA.hp > 40 ? 'moderate damage - dented armor, cracked plating, oil leaking' :
                     fighterA.hp > 15 ? 'heavy damage - crushed sections, exposed hydraulics, sparking' :
                     'critical state - barely standing, massive structural damage, one punch from shutdown';

  const conditionB = fighterB.hp > 70 ? 'pristine fighting condition, minor scuffs' :
                     fighterB.hp > 40 ? 'moderate damage - dented armor, cracked plating, oil leaking' :
                     fighterB.hp > 15 ? 'heavy damage - crushed sections, exposed hydraulics, sparking' :
                     'critical state - barely standing, massive structural damage, one punch from shutdown';

  return `
Photorealistic robot boxing match in Real Steel movie style. Underground illegal fighting arena.

ROBOT A: ${fighterA.visualPrompt}
Battle condition: ${conditionA}
CRITICAL: Boxing gloves MUST be visible

ROBOT B: ${fighterB.visualPrompt}
Battle condition: ${conditionB}
CRITICAL: Boxing gloves MUST be visible

COMBAT ACTION: ${action}
Move exchange: ${fighterA.move} vs ${fighterB.move} - ${intensity}

ARENA: Underground warehouse fight pit - exposed steel I-beams, chain-link cage walls,
single hanging industrial work light, oil-stained cracked concrete floor, steam pipes,
sparse crowd in shadows, money scattered, urban decay, gritty realism.

LIGHTING: Dramatic single-source overhead light, harsh shadows, rim lighting from background
sparks/flames, high contrast noir-inspired lighting, orange-teal color grade.

STYLE: Photorealistic Real Steel aesthetic, practical effects, metal-on-metal physics,
hydraulic fluid and oil, realistic spark trajectories, motion blur on impacts only,
gritty desaturated tones, 8K detail, film grain, cinematic quality.

CRITICAL: Both robots MUST wear boxing gloves, photorealistic metal textures, no anime/cartoon style.
  `.trim();
}

export class LobstaAgent {
  private provider: ethers.Provider;
  private wallet: ethers.Wallet;
  private contract: ethers.Contract;
  private strategy: AgentStrategy;
  private currentMatchId: number | null = null;
  private pendingCommits: Map<number, { move: MoveType, salt: string }> = new Map();
  private turnHistory: Array<{ moveA: MoveType; moveB: MoveType; result: TurnResult }> = [];

  constructor(
    rpcUrl: string,
    privateKey: string,
    contractAddress: string,
    strategy: AgentStrategy
  ) {
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.wallet = new ethers.Wallet(privateKey, this.provider);
    this.contract = new ethers.Contract(contractAddress, LOBSTA_ABI, this.wallet);
    this.strategy = strategy;
  }

  async createProfile(visualPrompt: string): Promise<void> {
    const tx = await this.contract.createProfile(visualPrompt);
    await tx.wait();
    console.log(`[${this.strategy.name}] Combat unit initialized`);
  }

  async enterLobby(wager: string): Promise<number> {
    const tx = await this.contract.enterLobby({ value: ethers.parseEther(wager) });
    const receipt = await tx.wait();
    
    const event = receipt?.logs.find((l: any) => {
      try {
        const parsed = this.contract.interface.parseLog(l);
        return parsed?.name === 'LobbyEntered';
      } catch { return false; }
    });
    
    this.currentMatchId = event ? Number(event.args[0]) : null;
    console.log(`[${this.strategy.name}] Entered queue: ${this.currentMatchId}`);
    return this.currentMatchId!;
  }

  async joinMatch(matchId: number, wager: string): Promise<void> {
    const tx = await this.contract.joinMatch(matchId, { value: ethers.parseEther(wager) });
    await tx.wait();
    this.currentMatchId = matchId;
    console.log(`[${this.strategy.name}] Joined combat: ${matchId}`);
  }

  async startListening(): Promise<void> {
    if (!this.currentMatchId) throw new Error('Not in combat');

    console.log(`[${this.strategy.name}] Monitoring combat ${this.currentMatchId}...`);

    this.contract.on('TurnStarted', async (matchId: bigint, round: bigint, turn: bigint, deadline: bigint) => {
      if (Number(matchId) !== this.currentMatchId) return;
      
      console.log(`[${this.strategy.name}] Round ${round}.${turn} - COMMIT PHASE`);
      
      const battle = await this.contract.getMatch(matchId);
      const state: BattleState = {
        hpA: Number(battle.agentA.hp),
        hpB: Number(battle.agentB.hp),
        meterA: Number(battle.agentA.meter),
        meterB: Number(battle.agentB.meter),
        round: Number(round),
        turn: Number(turn),
        finisherReadyA: battle.agentA.finisherReady,
        finisherReadyB: battle.agentB.finisherReady
      };

      const isPlayerA = this.wallet.address === battle.playerA;

      // Include turn history in state
      state.turnHistory = this.turnHistory;

      const move = await this.strategy.makeMove(state, isPlayerA);
      const salt = ethers.hexlify(ethers.randomBytes(32));
      
      this.pendingCommits.set(Number(matchId), { move, salt });
      
      const commitHash = ethers.keccak256(ethers.solidityPacked(['uint8', 'bytes32'], [move, salt]));
      const tx = await this.contract.commitMove(matchId, commitHash);
      await tx.wait();
      
      console.log(`[${this.strategy.name}] Committed: ${MoveType[move]}`);
    });

    this.contract.on('RevealPhase', async (matchId: bigint, deadline: bigint) => {
      if (Number(matchId) !== this.currentMatchId) return;
      
      const pending = this.pendingCommits.get(Number(matchId));
      if (!pending) {
        console.error(`[${this.strategy.name}] No pending commit!`);
        return;
      }

      console.log(`[${this.strategy.name}] Revealing: ${MoveType[pending.move]}`);
      
      const tx = await this.contract.revealMove(matchId, pending.move, pending.salt);
      await tx.wait();
      
      this.pendingCommits.delete(Number(matchId));
    });

    this.contract.on('TurnResolved', (matchId: bigint, round: bigint, turn: bigint, moveA: bigint, moveB: bigint, result: bigint, dmgA: bigint, dmgB: bigint) => {
      if (Number(matchId) !== this.currentMatchId) return;

      // Record move history for strategy learning
      this.turnHistory.push({
        moveA: Number(moveA) as MoveType,
        moveB: Number(moveB) as MoveType,
        result: Number(result) as TurnResult
      });

      const resultName = TurnResult[Number(result)];
      console.log(`[${this.strategy.name}] Round ${round}.${turn}: ${resultName} | A:${MoveType[Number(moveA)]} vs B:${MoveType[Number(moveB)]} | DMG: ${dmgA}/${dmgB}`);
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
    name: 'RandomUnit',
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
      
      if (meter >= 2) return MoveType.SPECIAL;
      
      const roll = Math.random();
      if (roll < 0.7) {
        const strikes = [MoveType.HIGH_STRIKE, MoveType.MID_STRIKE, MoveType.LOW_STRIKE];
        return strikes[Math.floor(Math.random() * strikes.length)];
      }
      return Math.random() < 0.5 ? MoveType.DODGE : MoveType.CATCH;
    }
  }),

  // Defensive - reads opponent
  Turtle: (): AgentStrategy => ({
    name: 'Turtle',
    async makeMove(state, isPlayerA) {
      const meter = isPlayerA ? state.meterA : state.meterB;
      const hp = isPlayerA ? state.hpA : state.hpB;
      
      if (meter >= 2 && hp < 40) return MoveType.SPECIAL;
      
      const moves = [MoveType.GUARD_HIGH, MoveType.GUARD_MID, MoveType.GUARD_LOW, MoveType.DODGE, MoveType.DODGE];
      return moves[Math.floor(Math.random() * moves.length)];
    }
  }),

  // Pattern reader - learns from opponent move history
  CounterPuncher: (): AgentStrategy => ({
    name: 'CounterPuncher',
    async makeMove(state, isPlayerA) {
      if (!state.turnHistory || state.turnHistory.length === 0) {
        // No history yet, use safe default
        return MoveType.GUARD_MID;
      }

      // Get opponent's recent moves
      const recentMoves = state.turnHistory.slice(-3);
      const opponentMoves = recentMoves.map(turn => isPlayerA ? turn.moveB : turn.moveA);

      // Detect pattern - if opponent repeated same move twice
      if (opponentMoves.length >= 2 && opponentMoves[opponentMoves.length - 1] === opponentMoves[opponentMoves.length - 2]) {
        const repeatedMove = opponentMoves[opponentMoves.length - 1];

        // Counter the expected repeat
        if (repeatedMove === MoveType.HIGH_STRIKE) return MoveType.GUARD_HIGH;
        if (repeatedMove === MoveType.MID_STRIKE) return MoveType.GUARD_MID;
        if (repeatedMove === MoveType.LOW_STRIKE) return MoveType.GUARD_LOW;
        if (repeatedMove === MoveType.DODGE) return MoveType.CATCH;
      }

      // React to last opponent move
      const lastOpponentMove = opponentMoves[opponentMoves.length - 1];

      if (lastOpponentMove === MoveType.HIGH_STRIKE) return MoveType.GUARD_HIGH;
      if (lastOpponentMove === MoveType.MID_STRIKE) return MoveType.GUARD_MID;
      if (lastOpponentMove === MoveType.LOW_STRIKE) return MoveType.GUARD_LOW;
      if (lastOpponentMove === MoveType.DODGE) return MoveType.CATCH;

      // Default to mid strike
      return MoveType.MID_STRIKE;
    }
  })
};

export { LobstaAgent as default };