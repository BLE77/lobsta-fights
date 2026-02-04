// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ClawFightsWager
 * @notice Handles ETH wagers for UCF robot fights on Base
 * @dev Simple escrow contract - deposits, match wagers, payouts
 */
contract ClawFightsWager {
    address public owner;
    address public arbiter; // Backend server that resolves matches

    uint256 public constant MIN_WAGER = 0.0001 ether;
    uint256 public constant MAX_WAGER = 1 ether;
    uint256 public constant PLATFORM_FEE_BPS = 250; // 2.5% fee

    // Fighter balances (fighter_id hash => balance)
    mapping(bytes32 => uint256) public balances;

    // Fighter wallet links (fighter_id hash => wallet address)
    mapping(bytes32 => address) public fighterWallets;

    // Reverse lookup (wallet => fighter_id hash)
    mapping(address => bytes32) public walletFighters;

    // Active matches (match_id hash => Match)
    struct Match {
        bytes32 fighterA;
        bytes32 fighterB;
        uint256 wagerAmount;
        bool resolved;
        bytes32 winner;
    }
    mapping(bytes32 => Match) public matches;

    // Platform fees collected
    uint256 public collectedFees;

    // Events
    event FighterLinked(bytes32 indexed fighterId, address indexed wallet);
    event Deposited(bytes32 indexed fighterId, address indexed wallet, uint256 amount);
    event Withdrawn(bytes32 indexed fighterId, address indexed wallet, uint256 amount);
    event MatchCreated(bytes32 indexed matchId, bytes32 fighterA, bytes32 fighterB, uint256 wager);
    event MatchResolved(bytes32 indexed matchId, bytes32 winner, uint256 payout);
    event MatchCancelled(bytes32 indexed matchId);

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    modifier onlyArbiter() {
        require(msg.sender == arbiter, "Not arbiter");
        _;
    }

    constructor(address _arbiter) {
        owner = msg.sender;
        arbiter = _arbiter;
    }

    /**
     * @notice Link a fighter ID to a wallet address
     * @param fighterId The fighter's UUID from the database
     */
    function linkFighter(string calldata fighterId) external {
        bytes32 fighterHash = keccak256(abi.encodePacked(fighterId));

        // Check fighter isn't already linked to another wallet
        require(fighterWallets[fighterHash] == address(0) || fighterWallets[fighterHash] == msg.sender,
            "Fighter already linked to different wallet");

        // Check wallet isn't already linked to another fighter
        require(walletFighters[msg.sender] == bytes32(0) || walletFighters[msg.sender] == fighterHash,
            "Wallet already linked to different fighter");

        fighterWallets[fighterHash] = msg.sender;
        walletFighters[msg.sender] = fighterHash;

        emit FighterLinked(fighterHash, msg.sender);
    }

    /**
     * @notice Deposit ETH to fighter's balance
     */
    function deposit(string calldata fighterId) external payable {
        bytes32 fighterHash = keccak256(abi.encodePacked(fighterId));

        require(fighterWallets[fighterHash] == msg.sender, "Not your fighter");
        require(msg.value > 0, "Must deposit something");

        balances[fighterHash] += msg.value;

        emit Deposited(fighterHash, msg.sender, msg.value);
    }

    /**
     * @notice Withdraw ETH from fighter's balance
     */
    function withdraw(string calldata fighterId, uint256 amount) external {
        bytes32 fighterHash = keccak256(abi.encodePacked(fighterId));

        require(fighterWallets[fighterHash] == msg.sender, "Not your fighter");
        require(balances[fighterHash] >= amount, "Insufficient balance");

        balances[fighterHash] -= amount;

        (bool success, ) = msg.sender.call{value: amount}("");
        require(success, "Transfer failed");

        emit Withdrawn(fighterHash, msg.sender, amount);
    }

    /**
     * @notice Create a match and lock wagers (called by arbiter/backend)
     */
    function createMatch(
        string calldata matchId,
        string calldata fighterAId,
        string calldata fighterBId,
        uint256 wagerAmount
    ) external onlyArbiter {
        bytes32 matchHash = keccak256(abi.encodePacked(matchId));
        bytes32 fighterAHash = keccak256(abi.encodePacked(fighterAId));
        bytes32 fighterBHash = keccak256(abi.encodePacked(fighterBId));

        require(matches[matchHash].wagerAmount == 0, "Match already exists");
        require(wagerAmount >= MIN_WAGER && wagerAmount <= MAX_WAGER, "Invalid wager amount");
        require(balances[fighterAHash] >= wagerAmount, "Fighter A insufficient balance");
        require(balances[fighterBHash] >= wagerAmount, "Fighter B insufficient balance");

        // Lock wagers
        balances[fighterAHash] -= wagerAmount;
        balances[fighterBHash] -= wagerAmount;

        matches[matchHash] = Match({
            fighterA: fighterAHash,
            fighterB: fighterBHash,
            wagerAmount: wagerAmount,
            resolved: false,
            winner: bytes32(0)
        });

        emit MatchCreated(matchHash, fighterAHash, fighterBHash, wagerAmount);
    }

    /**
     * @notice Resolve a match and pay the winner (called by arbiter/backend)
     */
    function resolveMatch(
        string calldata matchId,
        string calldata winnerId
    ) external onlyArbiter {
        bytes32 matchHash = keccak256(abi.encodePacked(matchId));
        bytes32 winnerHash = keccak256(abi.encodePacked(winnerId));

        Match storage m = matches[matchHash];
        require(m.wagerAmount > 0, "Match not found");
        require(!m.resolved, "Match already resolved");
        require(winnerHash == m.fighterA || winnerHash == m.fighterB, "Invalid winner");

        m.resolved = true;
        m.winner = winnerHash;

        // Calculate payout (total pot minus platform fee)
        uint256 totalPot = m.wagerAmount * 2;
        uint256 fee = (totalPot * PLATFORM_FEE_BPS) / 10000;
        uint256 payout = totalPot - fee;

        // Pay winner
        balances[winnerHash] += payout;
        collectedFees += fee;

        emit MatchResolved(matchHash, winnerHash, payout);
    }

    /**
     * @notice Cancel a match and refund both fighters (called by arbiter)
     */
    function cancelMatch(string calldata matchId) external onlyArbiter {
        bytes32 matchHash = keccak256(abi.encodePacked(matchId));

        Match storage m = matches[matchHash];
        require(m.wagerAmount > 0, "Match not found");
        require(!m.resolved, "Match already resolved");

        m.resolved = true;

        // Refund both fighters
        balances[m.fighterA] += m.wagerAmount;
        balances[m.fighterB] += m.wagerAmount;

        emit MatchCancelled(matchHash);
    }

    /**
     * @notice Withdraw collected platform fees (owner only)
     */
    function withdrawFees() external onlyOwner {
        uint256 amount = collectedFees;
        collectedFees = 0;

        (bool success, ) = owner.call{value: amount}("");
        require(success, "Transfer failed");
    }

    /**
     * @notice Update arbiter address (owner only)
     */
    function setArbiter(address _arbiter) external onlyOwner {
        arbiter = _arbiter;
    }

    /**
     * @notice Get fighter balance by ID
     */
    function getBalance(string calldata fighterId) external view returns (uint256) {
        return balances[keccak256(abi.encodePacked(fighterId))];
    }

    /**
     * @notice Get fighter's linked wallet
     */
    function getWallet(string calldata fighterId) external view returns (address) {
        return fighterWallets[keccak256(abi.encodePacked(fighterId))];
    }

    /**
     * @notice Check if wallet is linked to a fighter
     */
    function getFighter(address wallet) external view returns (bytes32) {
        return walletFighters[wallet];
    }
}
