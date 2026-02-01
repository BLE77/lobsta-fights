// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title CombatEngine
 * @notice AI Agent Battle Arena - Turn-based fighter with commit-reveal
 * @dev MVP: 10 moves, 0-3 meter, first to 2 rounds, robot visuals
 */
contract CombatEngine {
    
    // ============ Enums ============
    
    enum MoveType { 
        NONE,
        HIGH_STRIKE, MID_STRIKE, LOW_STRIKE,  // Attacks
        GUARD_HIGH, GUARD_MID, GUARD_LOW,      // Blocks
        DODGE, CATCH,                          // Mindgames
        SPECIAL                                 // Meter move
    }
    
    enum TurnResult { 
        TRADE,              // Both struck
        A_BLOCKED, A_HIT, A_DODGED, A_CAUGHT,
        B_BLOCKED, B_HIT, B_DODGED, B_CAUGHT,
        BOTH_DEFEND,        // Guards/Catch with no strike
        ROUND_END, MATCH_END
    }
    
    enum BattleState { 
        PENDING, ACTIVE, COMMIT_PHASE, REVEAL_PHASE, 
        RESOLVED, ROUND_END, FINISHED, CANCELLED 
    }
    
    // ============ Structs ============
    
    struct Agent {
        address wallet;
        string visualPrompt;      // Robot + gloves + shorts
        bytes32 promptHash;
        uint256 hp;
        uint256 roundsWon;
        uint8 meter;              // 0-3
        bool finisherReady;       // 2 clean hits
        uint8 consecutiveMisses;  // For anti-stall
        
        // Turn state
        bytes32 moveCommit;
        MoveType revealedMove;
        bool hasCommitted;
        bool hasRevealed;
    }
    
    struct Round {
        uint8 turnCount;
        TurnResult[] history;
    }
    
    struct Battle {
        uint256 id;
        address playerA;
        address playerB;
        Agent agentA;
        Agent agentB;
        
        BattleState state;
        uint8 currentRound;
        uint256 wagerAmount;
        bytes32 matchSeed;
        
        uint256 commitDeadline;
        uint256 revealDeadline;
        
        address winner;
        Round[] rounds;
        uint256 createdAt;
    }
    
    // ============ Config ============
    
    uint256 public constant COMMIT_DURATION = 45 seconds;
    uint256 public constant REVEAL_DURATION = 30 seconds;
    uint256 public constant MAX_TURNS_PER_ROUND = 9;
    uint256 public constant MAX_MISSES = 2;  // Auto-forfeit
    
    uint256 public constant BASE_DAMAGE = 20;
    uint256 public constant COUNTER_DAMAGE = 35;  // Wrong guard
    uint256 public constant FINISHER_DAMAGE = 50;
    uint256 public constant SPECIAL_DAMAGE = 40;
    uint256 public constant STARTING_HP = 100;
    
    // ============ State ============
    
    uint256 public nextMatchId;
    mapping(uint256 => Battle) public battles;
    mapping(address => uint256[]) public agentMatches;
    mapping(address => AgentProfile) public profiles;
    
    struct AgentProfile {
        string visualPrompt;
        bytes32 promptHash;
        uint256 wins;
        uint256 losses;
        uint256 matchesPlayed;
        uint256 totalWagered;
        uint256 totalWon;
        bool exists;
    }
    
    // ============ Events ============
    
    event ProfileCreated(address indexed agent, bytes32 promptHash);
    event MatchCreated(uint256 indexed matchId, address playerA, address playerB, uint256 wager);
    event MatchJoined(uint256 indexed matchId, address player);
    event CommitPhase(uint256 indexed matchId, uint8 round, uint8 turn, uint256 deadline);
    event MoveCommitted(uint256 indexed matchId, address player);
    event RevealPhase(uint256 indexed matchId, uint256 deadline);
    event MoveRevealed(uint256 indexed matchId, address player, MoveType move);
    event TurnResolved(uint256 indexed matchId, uint8 round, uint8 turn, 
                       MoveType moveA, MoveType moveB, TurnResult result, 
                       uint256 damageA, uint256 damageB);
    event RoundEnd(uint256 indexed matchId, uint8 round, address winner);
    event MatchEnd(uint256 indexed matchId, address winner, address loser);
    event AutoMiss(uint256 indexed matchId, address player, uint8 missCount);
    event Forfeit(uint256 indexed matchId, address forfeiter);
    
    // ============ Modifiers ============
    
    modifier onlyPlayer(uint256 _matchId) {
        Battle storage b = battles[_matchId];
        require(msg.sender == b.playerA || msg.sender == b.playerB, "Not player");
        _;
    }
    
    // ============ Profile Management ============
    
    function createProfile(string calldata _visualPrompt) external {
        require(!profiles[msg.sender].exists, "Profile exists");
        require(bytes(_visualPrompt).length > 0, "Prompt required");
        
        profiles[msg.sender] = AgentProfile({
            visualPrompt: _visualPrompt,
            promptHash: keccak256(bytes(_visualPrompt)),
            wins: 0,
            losses: 0,
            matchesPlayed: 0,
            totalWagered: 0,
            totalWon: 0,
            exists: true
        });
        
        emit ProfileCreated(msg.sender, keccak256(bytes(_visualPrompt)));
    }
    
    // ============ Match Creation ============
    
    function createMatch(address _opponent, bytes32 _matchSeed) external payable {
        require(profiles[msg.sender].exists, "Create profile first");
        require(profiles[_opponent].exists, "Opponent needs profile");
        require(msg.value > 0, "Wager required");
        require(_opponent != msg.sender, "Can't battle self");
        
        uint256 matchId = nextMatchId++;
        Battle storage b = battles[matchId];
        
        b.id = matchId;
        b.playerA = msg.sender;
        b.playerB = _opponent;
        b.wagerAmount = msg.value;
        b.matchSeed = _matchSeed;
        b.createdAt = block.timestamp;
        b.state = BattleState.PENDING;
        
        // Init agent A
        b.agentA.wallet = msg.sender;
        b.agentA.visualPrompt = profiles[msg.sender].visualPrompt;
        b.agentA.promptHash = profiles[msg.sender].promptHash;
        
        agentMatches[msg.sender].push(matchId);
        
        emit MatchCreated(matchId, msg.sender, _opponent, msg.value);
    }
    
    function joinMatch(uint256 _matchId) external payable {
        Battle storage b = battles[_matchId];
        require(b.state == BattleState.PENDING, "Not pending");
        require(msg.sender == b.playerB, "Not invited");
        require(msg.value == b.wagerAmount, "Wrong wager");
        require(profiles[msg.sender].exists, "Create profile first");
        
        // Init agent B
        b.agentB.wallet = msg.sender;
        b.agentB.visualPrompt = profiles[msg.sender].visualPrompt;
        b.agentB.promptHash = profiles[msg.sender].promptHash;
        
        // Start match
        b.state = BattleState.ACTIVE;
        _startRound(_matchId, 1);
        
        agentMatches[msg.sender].push(_matchId);
        
        emit MatchJoined(_matchId, msg.sender);
    }
    
    function _startRound(uint256 _matchId, uint8 _roundNum) internal {
        Battle storage b = battles[_matchId];
        b.currentRound = _roundNum;
        
        // Reset HP and meter per round
        b.agentA.hp = STARTING_HP;
        b.agentA.meter = 0;
        b.agentA.finisherReady = false;
        b.agentA.consecutiveMisses = 0;
        b.agentB.hp = STARTING_HP;
        b.agentB.meter = 0;
        b.agentB.finisherReady = false;
        b.agentB.consecutiveMisses = 0;
        
        Round memory newRound;
        newRound.turnCount = 1;
        b.rounds.push(newRound);
        
        _startTurn(_matchId);
    }
    
    function _startTurn(uint256 _matchId) internal {
        Battle storage b = battles[_matchId];
        b.state = BattleState.COMMIT_PHASE;
        b.commitDeadline = block.timestamp + COMMIT_DURATION;
        b.revealDeadline = 0;
        
        // Reset turn state
        b.agentA.moveCommit = bytes32(0);
        b.agentA.revealedMove = MoveType.NONE;
        b.agentA.hasCommitted = false;
        b.agentA.hasRevealed = false;
        b.agentB.moveCommit = bytes32(0);
        b.agentB.revealedMove = MoveType.NONE;
        b.agentB.hasCommitted = false;
        b.agentB.hasRevealed = false;
        
        emit CommitPhase(_matchId, b.currentRound, b.rounds[b.currentRound-1].turnCount, b.commitDeadline);
    }
    
    // ============ Commit-Reveal ============
    
    function commitMove(uint256 _matchId, bytes32 _commitHash) external onlyPlayer(_matchId) {
        Battle storage b = battles[_matchId];
        require(b.state == BattleState.COMMIT_PHASE, "Not commit phase");
        require(block.timestamp <= b.commitDeadline, "Commit deadline passed");
        require(_commitHash != bytes32(0), "Invalid commit");
        
        Agent storage agent = msg.sender == b.playerA ? b.agentA : b.agentB;
        require(!agent.hasCommitted, "Already committed");
        
        agent.moveCommit = _commitHash;
        agent.hasCommitted = true;
        
        emit MoveCommitted(_matchId, msg.sender);
        
        // Both committed? Start reveal
        if (b.agentA.hasCommitted && b.agentB.hasCommitted) {
            b.state = BattleState.REVEAL_PHASE;
            b.revealDeadline = block.timestamp + REVEAL_DURATION;
            emit RevealPhase(_matchId, b.revealDeadline);
        }
    }
    
    function revealMove(uint256 _matchId, MoveType _move, bytes32 _salt) external onlyPlayer(_matchId) {
        Battle storage b = battles[_matchId];
        require(b.state == BattleState.REVEAL_PHASE, "Not reveal phase");
        require(block.timestamp <= b.revealDeadline, "Reveal deadline passed");
        require(_move != MoveType.NONE, "Invalid move");
        
        Agent storage agent = msg.sender == b.playerA ? b.agentA : b.agentB;
        require(!agent.hasRevealed, "Already revealed");
        
        // Verify commit
        bytes32 hash = keccak256(abi.encodePacked(_move, _salt));
        require(hash == agent.moveCommit, "Invalid reveal");
        
        // Check special meter
        if (_move == MoveType.SPECIAL) {
            require(agent.meter >= 2, "Need 2 meter");
        }
        
        agent.revealedMove = _move;
        agent.hasRevealed = true;
        
        emit MoveRevealed(_matchId, msg.sender, _move);
        
        if (b.agentA.hasRevealed && b.agentB.hasRevealed) {
            _resolveTurn(_matchId);
        }
    }
    
    // ============ Resolution ============
    
    function _resolveTurn(uint256 _matchId) internal {
        Battle storage b = battles[_matchId];
        Agent storage a = b.agentA;
        Agent storage d = b.agentB;
        Round storage round = b.rounds[b.currentRound-1];
        
        MoveType moveA = a.revealedMove;
        MoveType moveB = d.revealedMove;
        
        TurnResult result;
        uint256 dmgA = 0;
        uint256 dmgB = 0;
        bool cleanHitA = false;
        bool cleanHitB = false;
        
        // Classification
        bool aIsStrike = _isStrike(moveA);
        bool bIsStrike = _isStrike(moveB);
        bool aIsGuard = _isGuard(moveA);
        bool bIsGuard = _isGuard(moveB);
        
        // === STRIKE VS STRIKE ===
        if (aIsStrike && bIsStrike) {
            dmgA = BASE_DAMAGE;
            dmgB = BASE_DAMAGE;
            a.hp = _sub(a.hp, dmgA);
            d.hp = _sub(d.hp, dmgB);
            result = TurnResult.TRADE;
        }
        // === STRIKE VS GUARD ===
        else if (aIsStrike && bIsGuard) {
            if (_blocks(moveB, moveA)) {
                result = TurnResult.A_BLOCKED;
                // Small chip damage optional
            } else {
                dmgB = COUNTER_DAMAGE;
                d.hp = _sub(d.hp, dmgB);
                result = TurnResult.A_HIT;
                cleanHitA = true;
                a.meter = uint8(_min(a.meter + 1, 3));
            }
        }
        else if (bIsStrike && aIsGuard) {
            if (_blocks(moveA, moveB)) {
                result = TurnResult.B_BLOCKED;
            } else {
                dmgA = COUNTER_DAMAGE;
                a.hp = _sub(a.hp, dmgA);
                result = TurnResult.B_HIT;
                cleanHitB = true;
                d.meter = uint8(_min(d.meter + 1, 3));
            }
        }
        // === DODGE ===
        else if (moveA == MoveType.DODGE && bIsStrike) {
            result = TurnResult.A_DODGED;
            // Successful dodge builds meter
            a.meter = uint8(_min(a.meter + 1, 3));
        }
        else if (moveB == MoveType.DODGE && aIsStrike) {
            result = TurnResult.B_DODGED;
            d.meter = uint8(_min(d.meter + 1, 3));
        }
        // === CATCH VS DODGE ===
        else if (moveA == MoveType.CATCH && moveB == MoveType.DODGE) {
            dmgB = BASE_DAMAGE;
            d.hp = _sub(d.hp, dmgB);
            result = TurnResult.A_HIT;
            cleanHitA = true;
            a.meter = uint8(_min(a.meter + 1, 3));
        }
        else if (moveB == MoveType.CATCH && moveA == MoveType.DODGE) {
            dmgA = BASE_DAMAGE;
            a.hp = _sub(a.hp, dmgA);
            result = TurnResult.B_HIT;
            cleanHitB = true;
            d.meter = uint8(_min(d.meter + 1, 3));
        }
        // === CATCH VS STRIKE ===
        else if (moveA == MoveType.CATCH && bIsStrike) {
            dmgA = BASE_DAMAGE;
            a.hp = _sub(a.hp, dmgA);
            result = TurnResult.B_HIT;
            cleanHitB = true;
            d.meter = uint8(_min(d.meter + 1, 3));
        }
        else if (moveB == MoveType.CATCH && aIsStrike) {
            dmgB = BASE_DAMAGE;
            d.hp = _sub(d.hp, dmgB);
            result = TurnResult.A_HIT;
            cleanHitA = true;
            a.meter = uint8(_min(a.meter + 1, 3));
        }
        // === SPECIAL ===
        else if (moveA == MoveType.SPECIAL) {
            if (moveB == MoveType.DODGE) {
                result = TurnResult.A_DODGED;
                a.meter = 0;
            } else {
                dmgB = SPECIAL_DAMAGE;
                d.hp = _sub(d.hp, dmgB);
                result = TurnResult.A_HIT;
                cleanHitA = true;
                a.meter = 0;
            }
        }
        else if (moveB == MoveType.SPECIAL) {
            if (moveA == MoveType.DODGE) {
                result = TurnResult.B_DODGED;
                d.meter = 0;
            } else {
                dmgA = SPECIAL_DAMAGE;
                a.hp = _sub(a.hp, dmgA);
                result = TurnResult.B_HIT;
                cleanHitB = true;
                d.meter = 0;
            }
        }
        // === BOTH DEFEND/GUARD/CATCH ===
        else {
            result = TurnResult.BOTH_DEFEND;
        }
        
        // Finisher tracking
        if (cleanHitA) {
            a.consecutiveHits = (a.consecutiveHits + 1);
            d.consecutiveHits = 0;
            if (a.consecutiveHits >= 2) a.finisherReady = true;
        } else if (cleanHitB) {
            d.consecutiveHits = (d.consecutiveHits + 1);
            a.consecutiveHits = 0;
            if (d.consecutiveHits >= 2) d.finisherReady = true;
        } else {
            a.consecutiveHits = 0;
            d.consecutiveHits = 0;
        }
        
        round.history.push(result);
        round.turnCount++;
        
        emit TurnResolved(_matchId, b.currentRound, uint8(round.turnCount-1), 
                         moveA, moveB, result, dmgA, dmgB);
        
        // Check round end
        if (a.hp == 0 || d.hp == 0 || round.turnCount > MAX_TURNS_PER_ROUND) {
            _endRound(_matchId);
        } else {
            _startTurn(_matchId);
        }
    }
    
    function _endRound(uint256 _matchId) internal {
        Battle storage b = battles[_matchId];
        Agent storage a = b.agentA;
        Agent storage d = b.agentB;
        
        address roundWinner;
        if (a.hp == 0 && d.hp == 0) {
            // Draw - both get 0, sudden death next round
        } else if (a.hp == 0) {
            roundWinner = b.playerB;
            d.roundsWon++;
        } else if (d.hp == 0) {
            roundWinner = b.playerA;
            a.roundsWon++;
        } else {
            // Turn limit - highest HP wins
            if (a.hp > d.hp) {
                roundWinner = b.playerA;
                a.roundsWon++;
            } else if (d.hp > a.hp) {
                roundWinner = b.playerB;
                d.roundsWon++;
            }
            // Else: draw
        }
        
        emit RoundEnd(_matchId, b.currentRound, roundWinner);
        
        // Check match end (first to 2)
        if (a.roundsWon >= 2) {
            _endMatch(_matchId, b.playerA, b.playerB);
        } else if (d.roundsWon >= 2) {
            _endMatch(_matchId, b.playerB, b.playerA);
        } else {
            // Next round
            _startRound(_matchId, b.currentRound + 1);
        }
    }
    
    function _endMatch(uint256 _matchId, address _winner, address _loser) internal {
        Battle storage b = battles[_matchId];
        b.state = BattleState.FINISHED;
        b.winner = _winner;
        
        // Update stats
        profiles[_winner].wins++;
        profiles[_winner].totalWon += b.wagerAmount * 2;
        profiles[_loser].losses++;
        profiles[_winner].matchesPlayed++;
        profiles[_loser].matchesPlayed++;
        
        // Payout
        (bool sent, ) = _winner.call{value: b.wagerAmount * 2}("");
        require(sent, "Payout failed");
        
        emit MatchEnd(_matchId, _winner, _loser);
    }
    
    // ============ Anti-Stall ============
    
    function resolveMissedCommit(uint256 _matchId, address _missedPlayer) external {
        Battle storage b = battles[_matchId];
        require(b.state == BattleState.COMMIT_PHASE, "Not commit phase");
        require(block.timestamp > b.commitDeadline, "Deadline not passed");
        
        Agent storage agent = _missedPlayer == b.playerA ? b.agentA : b.agentB;
        require(!agent.hasCommitted, "Player committed");
        
        // Auto-miss penalty
        agent.consecutiveMisses++;
        agent.hp = _sub(agent.hp, 10); // Small damage
        
        emit AutoMiss(_matchId, _missedPlayer, agent.consecutiveMisses);
        
        if (agent.consecutiveMisses >= MAX_MISSES) {
            _forfeit(_matchId, _missedPlayer);
        } else {
            // Skip turn, other player gets free action
            // ...implementation...
        }
    }
    
    function _forfeit(uint256 _matchId, address _forfeiter) internal {
        Battle storage b = battles[_matchId];
        address winner = _forfeiter == b.playerA ? b.playerB : b.playerA;
        _endMatch(_matchId, winner, _forfeiter);
        emit Forfeit(_matchId, _forfeiter);
    }
    
    // ============ Helpers ============
    
    function _isStrike(MoveType m) internal pure returns (bool) {
        return m == MoveType.HIGH_STRIKE || m == MoveType.MID_STRIKE || m == MoveType.LOW_STRIKE;
    }
    
    function _isGuard(MoveType m) internal pure returns (bool) {
        return m == MoveType.GUARD_HIGH || m == MoveType.GUARD_MID || m == MoveType.GUARD_LOW;
    }
    
    function _blocks(MoveType guard, MoveType strike) internal pure returns (bool) {
        return (guard == MoveType.GUARD_HIGH && strike == MoveType.HIGH_STRIKE) ||
               (guard == MoveType.GUARD_MID && strike == MoveType.MID_STRIKE) ||
               (guard == MoveType.GUARD_LOW && strike == MoveType.LOW_STRIKE);
    }
    
    function _sub(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a - b : 0;
    }
    
    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
    
    // ============ Views ============
    
    function getBattle(uint256 _matchId) external view returns (Battle memory) {
        return battles[_matchId];
    }
}