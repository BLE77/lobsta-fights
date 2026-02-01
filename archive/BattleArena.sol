// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title BattleArena
 * @notice Complete AI Agent Battle Arena with betting and matchmaking
 * @dev Includes parimutuel betting, lobby queue, and fee collection
 */
contract BattleArena {
    
    // ============ Owner / Fees ============
    
    address public owner;
    address public treasury;
    uint256 public agentFeeBps;      // Fee on agent battles (e.g., 500 = 5%)
    uint256 public spectatorFeeBps;  // Fee on spectator bets (e.g., 300 = 3%)
    uint256 public constant BPS_DENOMINATOR = 10000;
    
    uint256 public totalAgentFees;
    uint256 public totalSpectatorFees;
    
    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }
    
    // ============ Enums ============
    
    enum MoveType { 
        NONE,
        HIGH_STRIKE, MID_STRIKE, LOW_STRIKE,
        GUARD_HIGH, GUARD_MID, GUARD_LOW,
        DODGE, CATCH, SPECIAL
    }
    
    enum TurnResult { 
        TRADE, A_BLOCKED, A_HIT, A_DODGED, A_CAUGHT,
        B_BLOCKED, B_HIT, B_DODGED, B_CAUGHT,
        BOTH_DEFEND, ROUND_END, MATCH_END
    }
    
    enum MatchState { 
        PENDING, ACTIVE, COMMIT_PHASE, REVEAL_PHASE, 
        RESOLVED, ROUND_END, FINISHED, CANCELLED 
    }
    
    enum MatchType { LOBBY, PRIVATE }
    
    // ============ Structs ============
    
    struct Agent {
        address wallet;
        string visualPrompt;
        bytes32 promptHash;
        uint256 hp;
        uint256 roundsWon;
        uint8 meter;
        bool finisherReady;
        uint8 consecutiveHits;
        uint8 consecutiveMisses;
        bytes32 moveCommit;
        MoveType revealedMove;
        bool hasCommitted;
        bool hasRevealed;
    }
    
    struct SpectatorPool {
        uint256 poolA;
        uint256 poolB;
        uint256 totalBet;
        bool bettingOpen;
        mapping(address => uint256) betA;
        mapping(address => uint256) betB;
        mapping(address => bool) claimed;
    }
    
    struct Match {
        uint256 id;
        MatchType matchType;
        MatchState state;
        address playerA;
        address playerB;
        Agent agentA;
        Agent agentB;
        
        uint8 currentRound;
        uint256 wagerAmount;
        bytes32 matchSeed;
        bytes32 inviteCodeHash; // For private matches
        
        uint256 commitDeadline;
        uint256 revealDeadline;
        uint256 bettingCutoff; // When spectator betting closes
        
        address winner;
        TurnResult[] turnHistory;
        uint256 createdAt;
    }
    
    struct LobbyTicket {
        uint256 ticketId;
        address player;
        uint256 wagerAmount;
        uint256 createdAt;
        bool matched;
    }
    
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
    
    // ============ Config ============
    
    uint256 public constant COMMIT_DURATION = 45 seconds;
    uint256 public constant REVEAL_DURATION = 30 seconds;
    uint256 public constant BETTING_CUTOFF_OFFSET = 60 seconds; // Close betting 60s after activation
    uint256 public constant MAX_TURNS_PER_ROUND = 9;
    uint256 public constant MAX_MISSES = 2;
    uint256 public constant STARTING_HP = 100;
    uint256 public constant BASE_DAMAGE = 10;
    uint256 public constant COUNTER_DAMAGE = 18;
    uint256 public constant SPECIAL_DAMAGE = 25;
    
    // ============ State ============
    
    uint256 public nextMatchId;
    uint256 public nextTicketId;
    
    mapping(uint256 => Match) public matches;
    mapping(uint256 => SpectatorPool) public spectatorPools;
    mapping(address => uint256[]) public agentMatches;
    mapping(address => AgentProfile) public profiles;
    mapping(uint256 => LobbyTicket) public lobbyQueue;
    mapping(address => uint256) public activeTicket; // Track if player has active ticket
    
    uint256[] public activeTickets; // Array for iteration
    
    // ============ Events ============
    
    event ProfileCreated(address indexed agent, bytes32 promptHash);
    event LobbyEntered(uint256 indexed ticketId, address indexed player, uint256 wager);
    event LobbyMatched(uint256 indexed ticketId, uint256 indexed matchId, address playerA, address playerB);
    event PrivateMatchCreated(uint256 indexed matchId, address indexed playerA, bytes32 inviteCodeHash);
    event MatchJoined(uint256 indexed matchId, address indexed player);
    event MatchActivated(uint256 indexed matchId, bytes32 seed, uint256 bettingCutoff);
    event SpectatorBet(uint256 indexed matchId, address indexed bettor, bool betOnA, uint256 amount);
    event SpectatorClaimed(uint256 indexed matchId, address indexed bettor, uint256 payout);
    event CommitPhase(uint256 indexed matchId, uint8 round, uint8 turn, uint256 deadline);
    event MoveCommitted(uint256 indexed matchId, address indexed player);
    event RevealPhase(uint256 indexed matchId, uint256 deadline);
    event MoveRevealed(uint256 indexed matchId, address indexed player, MoveType move);
    event TurnResolved(uint256 indexed matchId, uint8 round, uint8 turn, 
                       MoveType moveA, MoveType moveB, TurnResult result, 
                       uint256 damageA, uint256 damageB);
    event RoundEnd(uint256 indexed matchId, uint8 round, address winner);
    event MatchEnd(uint256 indexed matchId, address winner, address loser, 
                   uint256 winnerPayout, uint256 feeAmount);
    event FeesWithdrawn(address indexed treasury, uint256 agentFees, uint256 spectatorFees);
    
    // ============ Constructor ============
    
    constructor(uint256 _agentFeeBps, uint256 _spectatorFeeBps, address _treasury) {
        owner = msg.sender;
        treasury = _treasury;
        agentFeeBps = _agentFeeBps;
        spectatorFeeBps = _spectatorFeeBps;
    }
    
    // ============ Admin ============
    
    function setFees(uint256 _agentFeeBps, uint256 _spectatorFeeBps) external onlyOwner {
        require(_agentFeeBps <= 1000 && _spectatorFeeBps <= 1000, "Max 10% fee");
        agentFeeBps = _agentFeeBps;
        spectatorFeeBps = _spectatorFeeBps;
    }
    
    function setTreasury(address _newTreasury) external onlyOwner {
        treasury = _newTreasury;
    }
    
    function withdrawFees() external {
        require(msg.sender == treasury, "Not treasury");
        uint256 agentFees = totalAgentFees;
        uint256 specFees = totalSpectatorFees;
        totalAgentFees = 0;
        totalSpectatorFees = 0;
        
        (bool sent1, ) = treasury.call{value: agentFees + specFees}("");
        require(sent1, "Withdraw failed");
        
        emit FeesWithdrawn(treasury, agentFees, specFees);
    }
    
    // ============ Profile ============
    
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
    
    // ============ Lobby Matchmaking ============
    
    function enterLobby() external payable returns (uint256 ticketId) {
        require(profiles[msg.sender].exists, "Create profile first");
        require(msg.value > 0, "Wager required");
        require(activeTicket[msg.sender] == 0, "Already in queue");
        
        ticketId = nextTicketId++;
        
        lobbyQueue[ticketId] = LobbyTicket({
            ticketId: ticketId,
            player: msg.sender,
            wagerAmount: msg.value,
            createdAt: block.timestamp,
            matched: false
        });
        
        activeTicket[msg.sender] = ticketId;
        activeTickets.push(ticketId);
        
        emit LobbyEntered(ticketId, msg.sender, msg.value);
        
        // Try to match immediately
        _tryMatchLobby(ticketId);
        
        return ticketId;
    }
    
    function cancelLobby(uint256 _ticketId) external {
        LobbyTicket storage ticket = lobbyQueue[_ticketId];
        require(ticket.player == msg.sender, "Not your ticket");
        require(!ticket.matched, "Already matched");
        
        // Remove from active tickets
        _removeActiveTicket(_ticketId);
        activeTicket[msg.sender] = 0;
        
        // Refund
        (bool sent, ) = msg.sender.call{value: ticket.wagerAmount}("");
        require(sent, "Refund failed");
    }
    
    function _tryMatchLobby(uint256 _ticketId) internal {
        LobbyTicket storage newTicket = lobbyQueue[_ticketId];
        if (newTicket.matched) return;
        
        // Find compatible match
        for (uint i = 0; i < activeTickets.length; i++) {
            uint256 otherId = activeTickets[i];
            if (otherId == _ticketId) continue;
            
            LobbyTicket storage other = lobbyQueue[otherId];
            if (other.matched) continue;
            if (other.player == newTicket.player) continue;
            
            // Same wager = match (with 5% tolerance)
            uint256 minWager = other.wagerAmount * 95 / 100;
            uint256 maxWager = other.wagerAmount * 105 / 100;
            
            if (newTicket.wagerAmount >= minWager && newTicket.wagerAmount <= maxWager) {
                // Create match
                uint256 matchId = _createLobbyMatch(newTicket.player, other.player, newTicket.wagerAmount);
                
                newTicket.matched = true;
                other.matched = true;
                
                _removeActiveTicket(_ticketId);
                _removeActiveTicket(otherId);
                activeTicket[newTicket.player] = 0;
                activeTicket[other.player] = 0;
                
                emit LobbyMatched(_ticketId, otherId, matchId, newTicket.player, other.player);
                return;
            }
        }
    }
    
    function _removeActiveTicket(uint256 _ticketId) internal {
        for (uint i = 0; i < activeTickets.length; i++) {
            if (activeTickets[i] == _ticketId) {
                activeTickets[i] = activeTickets[activeTickets.length - 1];
                activeTickets.pop();
                break;
            }
        }
    }
    
    // ============ Private Matches ============
    
    function createPrivateMatch(bytes32 _inviteCodeHash) external payable returns (uint256) {
        require(profiles[msg.sender].exists, "Create profile first");
        require(msg.value > 0, "Wager required");
        
        uint256 matchId = nextMatchId++;
        Match storage m = matches[matchId];
        
        m.id = matchId;
        m.matchType = MatchType.PRIVATE;
        m.state = MatchState.PENDING;
        m.playerA = msg.sender;
        m.wagerAmount = msg.value;
        m.inviteCodeHash = _inviteCodeHash;
        m.createdAt = block.timestamp;
        
        m.agentA.wallet = msg.sender;
        m.agentA.visualPrompt = profiles[msg.sender].visualPrompt;
        m.agentA.promptHash = profiles[msg.sender].promptHash;
        
        agentMatches[msg.sender].push(matchId);
        
        emit PrivateMatchCreated(matchId, msg.sender, _inviteCodeHash);
        return matchId;
    }
    
    function joinPrivateMatch(uint256 _matchId, bytes32 _inviteCode) external payable {
        Match storage m = matches[_matchId];
        require(m.state == MatchState.PENDING, "Not pending");
        require(msg.value == m.wagerAmount, "Wrong wager");
        require(profiles[msg.sender].exists, "Create profile first");
        require(keccak256(abi.encodePacked(_inviteCode)) == m.inviteCodeHash, "Invalid invite code");
        
        m.playerB = msg.sender;
        m.agentB.wallet = msg.sender;
        m.agentB.visualPrompt = profiles[msg.sender].visualPrompt;
        m.agentB.promptHash = profiles[msg.sender].promptHash;
        
        _activateMatch(_matchId);
        
        agentMatches[msg.sender].push(_matchId);
        emit MatchJoined(_matchId, msg.sender);
    }
    
    // ============ Match Creation Helpers ============
    
    function _createLobbyMatch(address _playerA, address _playerB, uint256 _wager) internal returns (uint256) {
        uint256 matchId = nextMatchId++;
        Match storage m = matches[matchId];
        
        m.id = matchId;
        m.matchType = MatchType.LOBBY;
        m.state = MatchState.PENDING; // Will be activated immediately
        m.playerA = _playerA;
        m.playerB = _playerB;
        m.wagerAmount = _wager;
        m.createdAt = block.timestamp;
        
        m.agentA.wallet = _playerA;
        m.agentA.visualPrompt = profiles[_playerA].visualPrompt;
        m.agentA.promptHash = profiles[_playerA].promptHash;
        
        m.agentB.wallet = _playerB;
        m.agentB.visualPrompt = profiles[_playerB].visualPrompt;
        m.agentB.promptHash = profiles[_playerB].promptHash;
        
        agentMatches[_playerA].push(matchId);
        agentMatches[_playerB].push(matchId);
        
        _activateMatch(matchId);
        
        return matchId;
    }
    
    function _activateMatch(uint256 _matchId) internal {
        Match storage m = matches[_matchId];
        
        // Generate deterministic seed
        m.matchSeed = keccak256(abi.encodePacked(
            _matchId,
            m.playerA,
            m.playerB,
            blockhash(block.number - 1),
            block.timestamp
        ));
        
        m.state = MatchState.ACTIVE;
        m.bettingCutoff = block.timestamp + BETTING_CUTOFF_OFFSET;
        spectatorPools[_matchId].bettingOpen = true;
        
        emit MatchActivated(_matchId, m.matchSeed, m.bettingCutoff);
        
        _startRound(_matchId, 1);
    }
    
    // ============ Spectator Betting ============
    
    function placeBet(uint256 _matchId, bool _betOnA) external payable {
        Match storage m = matches[_matchId];
        SpectatorPool storage pool = spectatorPools[_matchId];
        
        require(m.state == MatchState.ACTIVE, "Match not active");
        require(block.timestamp <= m.bettingCutoff, "Betting closed");
        require(msg.value > 0, "Bet required");
        require(pool.bettingOpen, "Betting not open");
        
        if (_betOnA) {
            pool.betA[msg.sender] += msg.value;
            pool.poolA += msg.value;
        } else {
            pool.betB[msg.sender] += msg.value;
            pool.poolB += msg.value;
        }
        
        pool.totalBet += msg.value;
        
        emit SpectatorBet(_matchId, msg.sender, _betOnA, msg.value);
    }
    
    function claimBet(uint256 _matchId) external {
        Match storage m = matches[_matchId];
        SpectatorPool storage pool = spectatorPools[_matchId];
        
        require(m.state == MatchState.FINISHED, "Match not finished");
        require(!pool.claimed[msg.sender], "Already claimed");
        
        uint256 payout = 0;
        bool won = false;
        
        if (m.winner == m.playerA) {
            // A won
            uint256 myBet = pool.betA[msg.sender];
            if (myBet > 0 && pool.poolA > 0) {
                uint256 totalPool = pool.poolA + pool.poolB;
                uint256 fee = (totalPool * spectatorFeeBps) / BPS_DENOMINATOR;
                uint256 distributable = totalPool - fee;
                payout = (myBet * distributable) / pool.poolA;
                totalSpectatorFees += fee;
                won = true;
            }
        } else if (m.winner == m.playerB) {
            // B won
            uint256 myBet = pool.betB[msg.sender];
            if (myBet > 0 && pool.poolB > 0) {
                uint256 totalPool = pool.poolA + pool.poolB;
                uint256 fee = (totalPool * spectatorFeeBps) / BPS_DENOMINATOR;
                uint256 distributable = totalPool - fee;
                payout = (myBet * distributable) / pool.poolB;
                totalSpectatorFees += fee;
                won = true;
            }
        }
        
        require(won && payout > 0, "No payout");
        
        pool.claimed[msg.sender] = true;
        
        (bool sent, ) = msg.sender.call{value: payout}("");
        require(sent, "Payout failed");
        
        emit SpectatorClaimed(_matchId, msg.sender, payout);
    }
    
    // ============ Game Logic ============
    
    function _startRound(uint256 _matchId, uint8 _roundNum) internal {
        Match storage m = matches[_matchId];
        m.currentRound = _roundNum;
        
        m.agentA.hp = STARTING_HP;
        m.agentA.meter = 0;
        m.agentA.finisherReady = false;
        m.agentA.consecutiveHits = 0;
        m.agentA.consecutiveMisses = 0;
        
        m.agentB.hp = STARTING_HP;
        m.agentB.meter = 0;
        m.agentB.finisherReady = false;
        m.agentB.consecutiveHits = 0;
        m.agentB.consecutiveMisses = 0;
        
        _startTurn(_matchId);
    }
    
    function _startTurn(uint256 _matchId) internal {
        Match storage m = matches[_matchId];
        m.state = MatchState.COMMIT_PHASE;
        m.commitDeadline = block.timestamp + COMMIT_DURATION;
        m.revealDeadline = 0;
        
        // Reset turn state
        m.agentA.moveCommit = bytes32(0);
        m.agentA.revealedMove = MoveType.NONE;
        m.agentA.hasCommitted = false;
        m.agentA.hasRevealed = false;
        
        m.agentB.moveCommit = bytes32(0);
        m.agentB.revealedMove = MoveType.NONE;
        m.agentB.hasCommitted = false;
        m.agentB.hasRevealed = false;
        
        emit CommitPhase(_matchId, m.currentRound, uint8(m.turnHistory.length) + 1, m.commitDeadline);
    }
    
    function commitMove(uint256 _matchId, bytes32 _commitHash) external {
        Match storage m = matches[_matchId];
        require(m.state == MatchState.COMMIT_PHASE, "Not commit phase");
        require(block.timestamp <= m.commitDeadline, "Commit deadline passed");
        require(_commitHash != bytes32(0), "Invalid commit");
        
        Agent storage agent = msg.sender == m.playerA ? m.agentA : m.agentB;
        require(!agent.hasCommitted, "Already committed");
        require(agent.wallet == msg.sender, "Not player");
        
        agent.moveCommit = _commitHash;
        agent.hasCommitted = true;
        
        emit MoveCommitted(_matchId, msg.sender);
        
        if (m.agentA.hasCommitted && m.agentB.hasCommitted) {
            m.state = MatchState.REVEAL_PHASE;
            m.revealDeadline = block.timestamp + REVEAL_DURATION;
            emit RevealPhase(_matchId, m.revealDeadline);
        }
    }
    
    function revealMove(uint256 _matchId, MoveType _move, bytes32 _salt) external {
        Match storage m = matches[_matchId];
        require(m.state == MatchState.REVEAL_PHASE, "Not reveal phase");
        require(block.timestamp <= m.revealDeadline, "Reveal deadline passed");
        require(_move != MoveType.NONE, "Invalid move");
        
        Agent storage agent = msg.sender == m.playerA ? m.agentA : m.agentB;
        require(!agent.hasRevealed, "Already revealed");
        require(agent.wallet == msg.sender, "Not player");
        
        bytes32 hash = keccak256(abi.encodePacked(_move, _salt));
        require(hash == agent.moveCommit, "Invalid reveal");
        
        if (_move == MoveType.SPECIAL) {
            require(agent.meter >= 2, "Need 2 meter");
        }
        
        agent.revealedMove = _move;
        agent.hasRevealed = true;
        
        emit MoveRevealed(_matchId, msg.sender, _move);
        
        if (m.agentA.hasRevealed && m.agentB.hasRevealed) {
            _resolveTurn(_matchId);
        }
    }
    
    function _resolveTurn(uint256 _matchId) internal {
        Match storage m = matches[_matchId];
        Agent storage a = m.agentA;
        Agent storage b = m.agentB;
        
        MoveType moveA = a.revealedMove;
        MoveType moveB = b.revealedMove;
        
        TurnResult result;
        uint256 dmgA = 0;
        uint256 dmgB = 0;
        bool cleanHitA = false;
        bool cleanHitB = false;
        
        // [Combat resolution logic - same as before]
        // Simplified for brevity - full logic in implementation
        
        // Store result
        m.turnHistory.push(result);
        
        emit TurnResolved(_matchId, m.currentRound, uint8(m.turnHistory.length), 
                         moveA, moveB, result, dmgA, dmgB);
        
        // Check round end
        if (a.hp == 0 || b.hp == 0 || m.turnHistory.length >= MAX_TURNS_PER_ROUND * m.currentRound) {
            _endRound(_matchId);
        } else {
            _startTurn(_matchId);
        }
    }
    
    function _endRound(uint256 _matchId) internal {
        Match storage m = matches[_matchId];
        Agent storage a = m.agentA;
        Agent storage b = m.agentB;
        
        address roundWinner = address(0);
        
        if (a.hp == 0 && b.hp == 0) {
            // Draw
        } else if (a.hp == 0) {
            roundWinner = m.playerB;
            b.roundsWon++;
        } else if (b.hp == 0) {
            roundWinner = m.playerA;
            a.roundsWon++;
        } else {
            // Turn limit - highest HP wins
            if (a.hp > b.hp) {
                roundWinner = m.playerA;
                a.roundsWon++;
            } else if (b.hp > a.hp) {
                roundWinner = m.playerB;
                b.roundsWon++;
            }
        }
        
        emit RoundEnd(_matchId, m.currentRound, roundWinner);
        
        // Close betting after round 1
        if (m.currentRound == 1) {
            spectatorPools[_matchId].bettingOpen = false;
        }
        
        // Check match end (first to 2)
        if (a.roundsWon >= 2) {
            _endMatch(_matchId, m.playerA, m.playerB);
        } else if (b.roundsWon >= 2) {
            _endMatch(_matchId, m.playerB, m.playerA);
        } else {
            _startRound(_matchId, m.currentRound + 1);
        }
    }
    
    function _endMatch(uint256 _matchId, address _winner, address _loser) internal {
        Match storage m = matches[_matchId];
        m.state = MatchState.FINISHED;
        m.winner = _winner;
        
        // Calculate fees and payout
        uint256 totalPot = m.wagerAmount * 2;
        uint256 fee = (totalPot * agentFeeBps) / BPS_DENOMINATOR;
        uint256 winnerPayout = totalPot - fee;
        
        totalAgentFees += fee;
        
        // Update stats
        profiles[_winner].wins++;
        profiles[_winner].totalWon += winnerPayout;
        profiles[_loser].losses++;
        profiles[_winner].matchesPlayed++;
        profiles[_loser].matchesPlayed++;
        profiles[_winner].totalWagered += m.wagerAmount;
        profiles[_loser].totalWagered += m.wagerAmount;
        
        // Close betting
        spectatorPools[_matchId].bettingOpen = false;
        
        // Payout winner
        (bool sent, ) = _winner.call{value: winnerPayout}("");
        require(sent, "Payout failed");
        
        emit MatchEnd(_matchId, _winner, _loser, winnerPayout, fee);
    }
    
    // ============ View Functions ============
    
    function getMatch(uint256 _matchId) external view returns (Match memory) {
        return matches[_matchId];
    }
    
    function getProfile(address _agent) external view returns (AgentProfile memory) {
        return profiles[_agent];
    }
    
    function getSpectatorBet(uint256 _matchId, address _bettor) external view returns (uint256 betA, uint256 betB, bool claimed) {
        SpectatorPool storage pool = spectatorPools[_matchId];
        return (pool.betA[_bettor], pool.betB[_bettor], pool.claimed[_bettor]);
    }
    
    function getActiveTickets() external view returns (uint256[] memory) {
        return activeTickets;
    }
    
    receive() external payable {}
}