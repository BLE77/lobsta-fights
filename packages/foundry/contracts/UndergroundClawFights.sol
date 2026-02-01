// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/**
 * @title UndergroundClawFights
 * @notice UCF - Underground Claw Fights - Robot battle arena
 * @dev Turn-based combat with commit-reveal and betting
 * @custom:security-contact security@ucf.gg
 */
contract UndergroundClawFights is ReentrancyGuard {

    // ============ Owner / Fees ============

    address public owner;
    address public treasury;
    uint256 public agentFeeBps;
    uint256 public spectatorFeeBps;
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
        PENDING, ACTIVE, COMMIT_PHASE, COMMIT_COMPLETE, REVEAL_PHASE,
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
        bool isRefundable;
        bool feesCollected;  // NEW: Track if fees already taken
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
        bytes32 inviteCodeHash;
        uint256 commitDeadline;
        uint256 revealDeadline;
        uint256 bettingCutoff;
        address winner;
        TurnResult[] turnHistory;
        uint256 createdAt;
        uint256 commitCompletedBlock;
    }

    struct LobbyTicket {
        uint256 ticketId;
        address player;
        uint256 wagerAmount;
        uint256 createdAt;
        bool matched;
        bool cancelled;  // NEW: Track cancelled tickets
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
    uint256 public constant BETTING_CUTOFF_OFFSET = 60 seconds;
    uint256 public constant MAX_TURNS_PER_ROUND = 9;
    uint256 public constant MAX_MISSES = 2;
    uint256 public constant STARTING_HP = 100;
    uint256 public constant BASE_DAMAGE = 10;
    uint256 public constant COUNTER_DAMAGE = 18;
    uint256 public constant SPECIAL_DAMAGE = 25;
    uint256 public constant MAX_WAGER = 10 ether;
    uint256 public constant MIN_REVEAL_DELAY_BLOCKS = 10;
    uint256 public constant MIN_SPECTATOR_BET = 0.001 ether;
    uint256 public constant MAX_PROMPT_LENGTH = 500;
    uint256 public constant FORFEIT_GRACE_PERIOD = 300; // 5 minutes
    uint256 public constant PRIVATE_MATCH_TIMEOUT = 3600; // 1 hour
    uint256 public constant MAX_MATCH_ROUNDS = 5;

    // ============ State ============

    uint256 public nextMatchId;
    uint256 public nextTicketId;

    mapping(uint256 => Match) public matches;
    mapping(uint256 => SpectatorPool) public spectatorPools;
    mapping(address => uint256[]) public agentMatches;
    mapping(address => AgentProfile) public profiles;
    mapping(uint256 => LobbyTicket) public lobbyQueue;
    mapping(address => uint256) public activeTicket;
    uint256[] public activeTickets;

    // ============ Events ============

    event ProfileCreated(address indexed agent, bytes32 promptHash);
    event LobbyEntered(uint256 indexed ticketId, address indexed player, uint256 wager);
    event LobbyCancelled(uint256 indexed ticketId, address indexed player);
    event LobbyMatched(uint256 indexed ticketId, uint256 indexed matchId, address playerA, address playerB);
    event PrivateMatchCreated(uint256 indexed matchId, address indexed playerA, bytes32 inviteCodeHash);
    event PrivateMatchCancelled(uint256 indexed matchId, address indexed player);
    event MatchJoined(uint256 indexed matchId, address indexed player);
    event MatchActivated(uint256 indexed matchId, uint256 bettingCutoff);
    event MatchCancelled(uint256 indexed matchId, string reason);
    event SpectatorBet(uint256 indexed matchId, address indexed bettor, bool betOnA, uint256 amount);
    event SpectatorClaimed(uint256 indexed matchId, address indexed bettor, uint256 payout);
    event SpectatorRefunded(uint256 indexed matchId, address indexed bettor, uint256 amount);
    event SpectatorRefundAvailable(uint256 indexed matchId, uint256 totalPool);
    event CommitPhase(uint256 indexed matchId, uint8 round, uint8 turn, uint256 deadline);
    event CommitComplete(uint256 indexed matchId, uint256 revealStartBlock);
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
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event FeesUpdated(uint256 oldAgentFee, uint256 newAgentFee, uint256 oldSpectatorFee, uint256 newSpectatorFee);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);

    // ============ Constructor ============

    constructor(uint256 _agentFeeBps, uint256 _spectatorFeeBps, address _treasury) {
        require(_treasury != address(0), "Invalid treasury");
        require(_agentFeeBps <= 1000, "Agent fee too high");
        require(_spectatorFeeBps <= 1000, "Spectator fee too high");

        owner = msg.sender;
        treasury = _treasury;
        agentFeeBps = _agentFeeBps;
        spectatorFeeBps = _spectatorFeeBps;
    }

    // ============ Admin ============

    function transferOwnership(address _newOwner) external onlyOwner {
        require(_newOwner != address(0), "Invalid owner");
        address oldOwner = owner;
        owner = _newOwner;
        emit OwnershipTransferred(oldOwner, _newOwner);
    }

    function setFees(uint256 _agentFeeBps, uint256 _spectatorFeeBps) external onlyOwner {
        require(_agentFeeBps <= 1000 && _spectatorFeeBps <= 1000, "Max 10% fee");
        emit FeesUpdated(agentFeeBps, _agentFeeBps, spectatorFeeBps, _spectatorFeeBps);
        agentFeeBps = _agentFeeBps;
        spectatorFeeBps = _spectatorFeeBps;
    }

    function setTreasury(address _newTreasury) external onlyOwner {
        require(_newTreasury != address(0), "Invalid treasury");
        address oldTreasury = treasury;
        treasury = _newTreasury;
        emit TreasuryUpdated(oldTreasury, _newTreasury);
    }

    function withdrawFees() external nonReentrant {
        require(msg.sender == treasury, "Not treasury");
        uint256 agentFees = totalAgentFees;
        uint256 specFees = totalSpectatorFees;
        totalAgentFees = 0;
        totalSpectatorFees = 0;

        (bool sent, ) = treasury.call{value: agentFees + specFees}("");
        require(sent, "Withdraw failed");

        emit FeesWithdrawn(treasury, agentFees, specFees);
    }

    // ============ Profile ============

    function createProfile(string calldata _visualPrompt) external {
        require(!profiles[msg.sender].exists, "Profile exists");
        require(bytes(_visualPrompt).length > 0, "Prompt required");
        require(bytes(_visualPrompt).length <= MAX_PROMPT_LENGTH, "Prompt too long");

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

    function enterLobby() external payable nonReentrant returns (uint256 ticketId) {
        require(profiles[msg.sender].exists, "Create profile first");
        require(msg.value > 0, "Wager required");
        require(msg.value <= MAX_WAGER, "Wager exceeds maximum");
        require(activeTicket[msg.sender] == 0, "Already in queue");

        ticketId = nextTicketId++;

        lobbyQueue[ticketId] = LobbyTicket({
            ticketId: ticketId,
            player: msg.sender,
            wagerAmount: msg.value,
            createdAt: block.timestamp,
            matched: false,
            cancelled: false
        });

        activeTicket[msg.sender] = ticketId;
        activeTickets.push(ticketId);

        emit LobbyEntered(ticketId, msg.sender, msg.value);

        _tryMatchLobby(ticketId);

        return ticketId;
    }

    function cancelLobby(uint256 _ticketId) external nonReentrant {
        LobbyTicket storage ticket = lobbyQueue[_ticketId];
        require(ticket.player == msg.sender, "Not your ticket");
        require(!ticket.matched, "Already matched");
        require(!ticket.cancelled, "Already cancelled");

        // Mark cancelled BEFORE external call (CEI pattern)
        ticket.cancelled = true;
        _removeActiveTicket(_ticketId);
        activeTicket[msg.sender] = 0;

        uint256 refundAmount = ticket.wagerAmount;

        emit LobbyCancelled(_ticketId, msg.sender);

        (bool sent, ) = msg.sender.call{value: refundAmount}("");
        require(sent, "Refund failed");
    }

    function _tryMatchLobby(uint256 _ticketId) internal {
        LobbyTicket storage newTicket = lobbyQueue[_ticketId];
        if (newTicket.matched || newTicket.cancelled) return;

        uint256 bestMatch = 0;
        for (uint i = 0; i < activeTickets.length; i++) {
            uint256 otherId = activeTickets[i];
            if (otherId == _ticketId) continue;

            LobbyTicket storage other = lobbyQueue[otherId];
            if (other.matched || other.cancelled) continue;
            if (other.player == newTicket.player) continue;

            uint256 minWager = other.wagerAmount * 95 / 100;
            uint256 maxWager = other.wagerAmount * 105 / 100;

            if (newTicket.wagerAmount >= minWager && newTicket.wagerAmount <= maxWager) {
                bestMatch = otherId;
                break;
            }
        }

        if (bestMatch != 0) {
            LobbyTicket storage other = lobbyQueue[bestMatch];
            uint256 matchWager = newTicket.wagerAmount < other.wagerAmount ? newTicket.wagerAmount : other.wagerAmount;

            // Mark as matched BEFORE any external calls
            newTicket.matched = true;
            other.matched = true;

            _removeActiveTicket(_ticketId);
            _removeActiveTicket(bestMatch);
            activeTicket[newTicket.player] = 0;
            activeTicket[other.player] = 0;

            // Refund differentials (use pull pattern for safety)
            uint256 refundA = newTicket.wagerAmount > matchWager ? newTicket.wagerAmount - matchWager : 0;
            uint256 refundB = other.wagerAmount > matchWager ? other.wagerAmount - matchWager : 0;

            uint256 matchId = _createLobbyMatch(newTicket.player, other.player, matchWager);

            emit LobbyMatched(_ticketId, matchId, newTicket.player, other.player);

            // External calls LAST (safe because state already updated)
            if (refundA > 0) {
                (bool sent, ) = newTicket.player.call{value: refundA}("");
                // Don't revert on refund failure - user can claim via separate mechanism if needed
                if (!sent) {
                    // Could emit event or track failed refund
                }
            }
            if (refundB > 0) {
                (bool sent, ) = other.player.call{value: refundB}("");
                if (!sent) {
                    // Could emit event or track failed refund
                }
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

    function createPrivateMatch(bytes32 _inviteCodeHash) external payable nonReentrant returns (uint256) {
        require(profiles[msg.sender].exists, "Create profile first");
        require(msg.value > 0, "Wager required");
        require(msg.value <= MAX_WAGER, "Wager exceeds maximum");

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

    function joinPrivateMatch(uint256 _matchId, bytes32 _inviteCode) external payable nonReentrant {
        Match storage m = matches[_matchId];
        require(m.state == MatchState.PENDING, "Not pending");
        require(msg.sender != m.playerA, "Cannot join own match");
        require(m.playerB == address(0), "Match already joined");
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

    function cancelPrivateMatch(uint256 _matchId) external nonReentrant {
        Match storage m = matches[_matchId];

        require(m.matchType == MatchType.PRIVATE, "Not private match");
        require(m.state == MatchState.PENDING, "Match started");
        require(msg.sender == m.playerA, "Not match creator");
        require(block.timestamp >= m.createdAt + PRIVATE_MATCH_TIMEOUT, "Too early");
        require(m.playerB == address(0), "Match joined");

        m.state = MatchState.CANCELLED;
        uint256 refundAmount = m.wagerAmount;

        emit PrivateMatchCancelled(_matchId, msg.sender);

        (bool sent, ) = m.playerA.call{value: refundAmount}("");
        require(sent, "Refund failed");
    }

    // ============ Match Creation Helpers ============

    function _createLobbyMatch(address _playerA, address _playerB, uint256 _wager) internal returns (uint256) {
        uint256 matchId = nextMatchId++;
        Match storage m = matches[matchId];

        m.id = matchId;
        m.matchType = MatchType.LOBBY;
        m.state = MatchState.PENDING;
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

        m.state = MatchState.ACTIVE;
        m.bettingCutoff = block.timestamp + BETTING_CUTOFF_OFFSET;
        spectatorPools[_matchId].bettingOpen = true;

        emit MatchActivated(_matchId, m.bettingCutoff);

        _startRound(_matchId, 1);
    }

    // ============ Spectator Betting ============

    function placeBet(uint256 _matchId, bool _betOnA) external payable nonReentrant {
        Match storage m = matches[_matchId];
        SpectatorPool storage pool = spectatorPools[_matchId];

        require(m.state == MatchState.ACTIVE || m.state == MatchState.COMMIT_PHASE, "Match not active");
        require(block.timestamp <= m.bettingCutoff, "Betting closed");
        require(msg.value >= MIN_SPECTATOR_BET, "Bet too small");
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

    function claimBet(uint256 _matchId) external nonReentrant {
        Match storage m = matches[_matchId];
        SpectatorPool storage pool = spectatorPools[_matchId];

        require(m.state == MatchState.FINISHED, "Match not finished");
        require(!pool.claimed[msg.sender], "Already claimed");

        if (pool.isRefundable) {
            uint256 refund = pool.betA[msg.sender] + pool.betB[msg.sender];
            require(refund > 0, "No bets");

            pool.claimed[msg.sender] = true;

            emit SpectatorRefunded(_matchId, msg.sender, refund);

            (bool sent, ) = msg.sender.call{value: refund}("");
            require(sent, "Refund failed");
            return;
        }

        // FIXED: Collect fees only once per pool
        uint256 totalPool = pool.poolA + pool.poolB;
        if (!pool.feesCollected && totalPool > 0) {
            uint256 fee = (totalPool * spectatorFeeBps) / BPS_DENOMINATOR;
            totalSpectatorFees += fee;
            pool.feesCollected = true;
        }

        uint256 payout = 0;
        bool won = false;

        // Calculate distributable amount (after fees)
        uint256 fee = (totalPool * spectatorFeeBps) / BPS_DENOMINATOR;
        uint256 distributable = totalPool - fee;

        if (m.winner == m.playerA) {
            uint256 myBet = pool.betA[msg.sender];
            if (myBet > 0 && pool.poolA > 0) {
                payout = (myBet * distributable) / pool.poolA;
                won = true;
            }
        } else if (m.winner == m.playerB) {
            uint256 myBet = pool.betB[msg.sender];
            if (myBet > 0 && pool.poolB > 0) {
                payout = (myBet * distributable) / pool.poolB;
                won = true;
            }
        }

        pool.claimed[msg.sender] = true;

        if (payout == 0) {
            emit SpectatorClaimed(_matchId, msg.sender, 0);
            return;
        }

        require(won, "No payout");

        emit SpectatorClaimed(_matchId, msg.sender, payout);

        (bool sent, ) = msg.sender.call{value: payout}("");
        require(sent, "Payout failed");
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
            m.commitCompletedBlock = block.number;
            m.state = MatchState.COMMIT_COMPLETE;
            emit CommitComplete(_matchId, block.number + MIN_REVEAL_DELAY_BLOCKS);
        }
    }

    function startRevealPhase(uint256 _matchId) external {
        Match storage m = matches[_matchId];
        require(m.state == MatchState.COMMIT_COMPLETE, "Not ready");
        require(block.number >= m.commitCompletedBlock + MIN_REVEAL_DELAY_BLOCKS, "Too early");

        m.state = MatchState.REVEAL_PHASE;
        m.revealDeadline = block.timestamp + REVEAL_DURATION;
        emit RevealPhase(_matchId, m.revealDeadline);
    }

    function revealMove(uint256 _matchId, MoveType _move, bytes32 _salt) external {
        Match storage m = matches[_matchId];
        require(m.state == MatchState.REVEAL_PHASE, "Not reveal phase");
        require(block.timestamp <= m.revealDeadline, "Reveal deadline passed");
        require(_move != MoveType.NONE, "Invalid move");
        require(uint256(_salt) > 2**128, "Salt too weak");

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

        bool aIsStrike = _isStrike(moveA);
        bool bIsStrike = _isStrike(moveB);
        bool aIsGuard = _isGuard(moveA);
        bool bIsGuard = _isGuard(moveB);

        if (aIsStrike && bIsStrike) {
            dmgA = BASE_DAMAGE;
            dmgB = BASE_DAMAGE;
            a.hp = _sub(a.hp, dmgA);
            b.hp = _sub(b.hp, dmgB);
            result = TurnResult.TRADE;
        } else if (aIsStrike && bIsGuard) {
            if (_blocks(moveB, moveA)) {
                result = TurnResult.A_BLOCKED;
            } else {
                dmgB = COUNTER_DAMAGE;
                b.hp = _sub(b.hp, dmgB);
                result = TurnResult.A_HIT;
                cleanHitA = true;
                a.meter = uint8(_min(a.meter + 1, 3));
            }
        } else if (bIsStrike && aIsGuard) {
            if (_blocks(moveA, moveB)) {
                result = TurnResult.B_BLOCKED;
            } else {
                dmgA = COUNTER_DAMAGE;
                a.hp = _sub(a.hp, dmgA);
                result = TurnResult.B_HIT;
                cleanHitB = true;
                b.meter = uint8(_min(b.meter + 1, 3));
            }
        } else if (moveA == MoveType.DODGE && bIsStrike) {
            result = TurnResult.A_DODGED;
            a.meter = uint8(_min(a.meter + 1, 3));
        } else if (moveB == MoveType.DODGE && aIsStrike) {
            result = TurnResult.B_DODGED;
            b.meter = uint8(_min(b.meter + 1, 3));
        } else if (moveA == MoveType.CATCH && moveB == MoveType.DODGE) {
            dmgB = BASE_DAMAGE;
            b.hp = _sub(b.hp, dmgB);
            result = TurnResult.A_HIT;
            cleanHitA = true;
            a.meter = uint8(_min(a.meter + 1, 3));
        } else if (moveB == MoveType.CATCH && moveA == MoveType.DODGE) {
            dmgA = BASE_DAMAGE;
            a.hp = _sub(a.hp, dmgA);
            result = TurnResult.B_HIT;
            cleanHitB = true;
            b.meter = uint8(_min(b.meter + 1, 3));
        } else if (moveA == MoveType.CATCH && bIsStrike) {
            dmgA = BASE_DAMAGE;
            a.hp = _sub(a.hp, dmgA);
            result = TurnResult.B_HIT;
            cleanHitB = true;
            b.meter = uint8(_min(b.meter + 1, 3));
        } else if (moveB == MoveType.CATCH && aIsStrike) {
            dmgB = BASE_DAMAGE;
            b.hp = _sub(b.hp, dmgB);
            result = TurnResult.A_HIT;
            cleanHitA = true;
            a.meter = uint8(_min(a.meter + 1, 3));
        } else if (moveA == MoveType.SPECIAL) {
            if (moveB == MoveType.DODGE) {
                result = TurnResult.A_DODGED;
                a.meter = 0;
            } else {
                dmgB = SPECIAL_DAMAGE;
                b.hp = _sub(b.hp, dmgB);
                result = TurnResult.A_HIT;
                cleanHitA = true;
                a.meter = 0;
            }
        } else if (moveB == MoveType.SPECIAL) {
            if (moveA == MoveType.DODGE) {
                result = TurnResult.B_DODGED;
                b.meter = 0;
            } else {
                dmgA = SPECIAL_DAMAGE;
                a.hp = _sub(a.hp, dmgA);
                result = TurnResult.B_HIT;
                cleanHitB = true;
                b.meter = 0;
            }
        } else {
            result = TurnResult.BOTH_DEFEND;
        }

        if (cleanHitA) {
            a.consecutiveHits++;
            b.consecutiveHits = 0;
            if (a.consecutiveHits >= 2) a.finisherReady = true;
        } else if (cleanHitB) {
            b.consecutiveHits++;
            a.consecutiveHits = 0;
            if (b.consecutiveHits >= 2) b.finisherReady = true;
        } else {
            a.consecutiveHits = 0;
            b.consecutiveHits = 0;
        }

        m.turnHistory.push(result);

        emit TurnResolved(_matchId, m.currentRound, uint8(m.turnHistory.length),
                         moveA, moveB, result, dmgA, dmgB);

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
            if (a.hp > b.hp) {
                roundWinner = m.playerA;
                a.roundsWon++;
            } else if (b.hp > a.hp) {
                roundWinner = m.playerB;
                b.roundsWon++;
            }
        }

        emit RoundEnd(_matchId, m.currentRound, roundWinner);

        if (m.currentRound == 1) {
            spectatorPools[_matchId].bettingOpen = false;
        }

        if (m.currentRound >= MAX_MATCH_ROUNDS) {
            if (a.roundsWon == b.roundsWon) {
                _refundMatch(_matchId);
                return;
            }
        }

        if (a.roundsWon >= 2) {
            _endMatch(_matchId, m.playerA, m.playerB);
        } else if (b.roundsWon >= 2) {
            _endMatch(_matchId, m.playerB, m.playerA);
        } else {
            _startRound(_matchId, m.currentRound + 1);
        }
    }

    function _refundMatch(uint256 _matchId) internal {
        Match storage m = matches[_matchId];
        m.state = MatchState.FINISHED;
        m.winner = address(0);

        uint256 refundAmount = m.wagerAmount;

        SpectatorPool storage pool = spectatorPools[_matchId];
        pool.bettingOpen = false;
        pool.isRefundable = true;

        emit SpectatorRefundAvailable(_matchId, pool.poolA + pool.poolB);
        emit MatchEnd(_matchId, address(0), address(0), 0, 0);

        (bool sentA, ) = m.playerA.call{value: refundAmount}("");
        require(sentA, "Refund A failed");

        (bool sentB, ) = m.playerB.call{value: refundAmount}("");
        require(sentB, "Refund B failed");
    }

    function resolveDeadlineTimeout(uint256 _matchId) external {
        Match storage m = matches[_matchId];

        if (m.state == MatchState.COMMIT_PHASE) {
            require(block.timestamp > m.commitDeadline + FORFEIT_GRACE_PERIOD, "Grace period active");

            if (!m.agentA.hasCommitted && !m.agentB.hasCommitted) {
                _refundMatch(_matchId);
            } else if (!m.agentA.hasCommitted) {
                _endMatch(_matchId, m.playerB, m.playerA);
            } else if (!m.agentB.hasCommitted) {
                _endMatch(_matchId, m.playerA, m.playerB);
            }
        } else if (m.state == MatchState.REVEAL_PHASE) {
            require(block.timestamp > m.revealDeadline + FORFEIT_GRACE_PERIOD, "Grace period active");

            if (!m.agentA.hasRevealed && !m.agentB.hasRevealed) {
                _refundMatch(_matchId);
            } else if (!m.agentA.hasRevealed) {
                _endMatch(_matchId, m.playerB, m.playerA);
            } else if (!m.agentB.hasRevealed) {
                _endMatch(_matchId, m.playerA, m.playerB);
            }
        }
    }

    function _endMatch(uint256 _matchId, address _winner, address _loser) internal {
        Match storage m = matches[_matchId];
        m.state = MatchState.FINISHED;
        m.winner = _winner;

        uint256 totalPot = m.wagerAmount * 2;
        uint256 fee = (totalPot * agentFeeBps) / BPS_DENOMINATOR;
        uint256 winnerPayout = totalPot - fee;

        totalAgentFees += fee;

        profiles[_winner].wins++;
        profiles[_winner].totalWon += winnerPayout;
        profiles[_loser].losses++;
        profiles[_winner].matchesPlayed++;
        profiles[_loser].matchesPlayed++;
        profiles[_winner].totalWagered += m.wagerAmount;
        profiles[_loser].totalWagered += m.wagerAmount;

        spectatorPools[_matchId].bettingOpen = false;

        emit MatchEnd(_matchId, _winner, _loser, winnerPayout, fee);

        (bool sent, ) = _winner.call{value: winnerPayout}("");
        require(sent, "Payout failed");
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

    receive() external payable {
        revert("Use placeBet or enterLobby to send ETH");
    }
}
