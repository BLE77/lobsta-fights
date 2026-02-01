import { getTargetNetworks } from "~~/utils/scaffold-eth";

const targetNetworks = getTargetNetworks();

// @ts-ignore
export type ContractName = "UndergroundClawFights";

export type Contract<TContractName extends ContractName = ContractName> = {
  address: string;
  abi: any[];
};

export function getContract<TContractName extends ContractName>(
  contractName: TContractName,
  chainId: number,
): Contract<TContractName> | undefined {
  const contracts = getAllContracts();
  return contracts[chainId]?.[contractName] as Contract<TContractName> | undefined;
}

export function getAllContracts(): Record<number, Record<ContractName, Contract>> {
  const contracts: Record<number, Record<string, Contract>> = {};

  // Base Sepolia
  contracts[84532] = {
    UndergroundClawFights: {
      address: process.env.NEXT_PUBLIC_UCF_CONTRACT || "0x0000000000000000000000000000000000000000",
      abi: UCF_ABI,
    },
  };

  // Base Mainnet
  contracts[8453] = {
    UndergroundClawFights: {
      address: process.env.NEXT_PUBLIC_UCF_CONTRACT_MAINNET || "0x0000000000000000000000000000000000000000",
      abi: UCF_ABI,
    },
  };

  return contracts;
}

export const contracts = getAllContracts();

/**
 * UCF - Underground Claw Fights ABI
 * Production-ready, security audited
 */
export const UCF_ABI = [
  // Constructor
  {
    "inputs": [
      {"internalType": "uint256", "name": "_agentFeeBps", "type": "uint256"},
      {"internalType": "uint256", "name": "_spectatorFeeBps", "type": "uint256"},
      {"internalType": "address", "name": "_treasury", "type": "address"}
    ],
    "stateMutability": "nonpayable",
    "type": "constructor"
  },

  // Profile
  {
    "inputs": [{"internalType": "string", "name": "_visualPrompt", "type": "string"}],
    "name": "createProfile",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [{"internalType": "address", "name": "_agent", "type": "address"}],
    "name": "getProfile",
    "outputs": [{"components": [{"internalType": "string", "name": "visualPrompt", "type": "string"},{"internalType": "bytes32", "name": "promptHash", "type": "bytes32"},{"internalType": "uint256", "name": "wins", "type": "uint256"},{"internalType": "uint256", "name": "losses", "type": "uint256"},{"internalType": "uint256", "name": "matchesPlayed", "type": "uint256"},{"internalType": "uint256", "name": "totalWagered", "type": "uint256"},{"internalType": "uint256", "name": "totalWon", "type": "uint256"},{"internalType": "bool", "name": "exists", "type": "bool"}],"internalType": "struct UndergroundClawFights.AgentProfile","name": "","type": "tuple"}],
    "stateMutability": "view",
    "type": "function"
  },

  // Lobby
  {
    "inputs": [],
    "name": "enterLobby",
    "outputs": [{"internalType": "uint256", "name": "ticketId", "type": "uint256"}],
    "stateMutability": "payable",
    "type": "function"
  },
  {
    "inputs": [{"internalType": "uint256", "name": "_ticketId", "type": "uint256"}],
    "name": "cancelLobby",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "getActiveTickets",
    "outputs": [{"internalType": "uint256[]", "name": "", "type": "uint256[]"}],
    "stateMutability": "view",
    "type": "function"
  },

  // Private Matches
  {
    "inputs": [{"internalType": "bytes32", "name": "_inviteCodeHash", "type": "bytes32"}],
    "name": "createPrivateMatch",
    "outputs": [{"internalType": "uint256", "name": "", "type": "uint256"}],
    "stateMutability": "payable",
    "type": "function"
  },
  {
    "inputs": [{"internalType": "uint256", "name": "_matchId", "type": "uint256"},{"internalType": "bytes32", "name": "_inviteCode", "type": "bytes32"}],
    "name": "joinPrivateMatch",
    "outputs": [],
    "stateMutability": "payable",
    "type": "function"
  },
  {
    "inputs": [{"internalType": "uint256", "name": "_matchId", "type": "uint256"}],
    "name": "cancelPrivateMatch",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },

  // Betting
  {
    "inputs": [{"internalType": "uint256", "name": "_matchId", "type": "uint256"},{"internalType": "bool", "name": "_betOnA", "type": "bool"}],
    "name": "placeBet",
    "outputs": [],
    "stateMutability": "payable",
    "type": "function"
  },
  {
    "inputs": [{"internalType": "uint256", "name": "_matchId", "type": "uint256"}],
    "name": "claimBet",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [{"internalType": "uint256", "name": "_matchId", "type": "uint256"},{"internalType": "address", "name": "_bettor", "type": "address"}],
    "name": "getSpectatorBet",
    "outputs": [{"internalType": "uint256", "name": "betA", "type": "uint256"},{"internalType": "uint256", "name": "betB", "type": "uint256"},{"internalType": "bool", "name": "claimed", "type": "bool"}],
    "stateMutability": "view",
    "type": "function"
  },

  // Game Actions
  {
    "inputs": [{"internalType": "uint256", "name": "_matchId", "type": "uint256"},{"internalType": "bytes32", "name": "_commitHash", "type": "bytes32"}],
    "name": "commitMove",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [{"internalType": "uint256", "name": "_matchId", "type": "uint256"}],
    "name": "startRevealPhase",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [{"internalType": "uint256", "name": "_matchId", "type": "uint256"},{"internalType": "uint8", "name": "_move", "type": "uint8"},{"internalType": "bytes32", "name": "_salt", "type": "bytes32"}],
    "name": "revealMove",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [{"internalType": "uint256", "name": "_matchId", "type": "uint256"}],
    "name": "resolveDeadlineTimeout",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },

  // Match View
  {
    "inputs": [{"internalType": "uint256", "name": "_matchId", "type": "uint256"}],
    "name": "getMatch",
    "outputs": [{"components": [{"internalType": "uint256", "name": "id", "type": "uint256"},{"internalType": "uint8", "name": "matchType", "type": "uint8"},{"internalType": "uint8", "name": "state", "type": "uint8"},{"internalType": "address", "name": "playerA", "type": "address"},{"internalType": "address", "name": "playerB", "type": "address"},{"components": [{"internalType": "address", "name": "wallet", "type": "address"},{"internalType": "string", "name": "visualPrompt", "type": "string"},{"internalType": "bytes32", "name": "promptHash", "type": "bytes32"},{"internalType": "uint256", "name": "hp", "type": "uint256"},{"internalType": "uint256", "name": "roundsWon", "type": "uint256"},{"internalType": "uint8", "name": "meter", "type": "uint8"},{"internalType": "bool", "name": "finisherReady", "type": "bool"},{"internalType": "uint8", "name": "consecutiveHits", "type": "uint8"},{"internalType": "uint8", "name": "consecutiveMisses", "type": "uint8"},{"internalType": "bytes32", "name": "moveCommit", "type": "bytes32"},{"internalType": "uint8", "name": "revealedMove", "type": "uint8"},{"internalType": "bool", "name": "hasCommitted", "type": "bool"},{"internalType": "bool", "name": "hasRevealed", "type": "bool"}],"internalType": "struct UndergroundClawFights.Agent","name": "agentA","type": "tuple"},{"components": [{"internalType": "address", "name": "wallet", "type": "address"},{"internalType": "string", "name": "visualPrompt", "type": "string"},{"internalType": "bytes32", "name": "promptHash", "type": "bytes32"},{"internalType": "uint256", "name": "hp", "type": "uint256"},{"internalType": "uint256", "name": "roundsWon", "type": "uint256"},{"internalType": "uint8", "name": "meter", "type": "uint8"},{"internalType": "bool", "name": "finisherReady", "type": "bool"},{"internalType": "uint8", "name": "consecutiveHits", "type": "uint8"},{"internalType": "uint8", "name": "consecutiveMisses", "type": "uint8"},{"internalType": "bytes32", "name": "moveCommit", "type": "bytes32"},{"internalType": "uint8", "name": "revealedMove", "type": "uint8"},{"internalType": "bool", "name": "hasCommitted", "type": "bool"},{"internalType": "bool", "name": "hasRevealed", "type": "bool"}],"internalType": "struct UndergroundClawFights.Agent","name": "agentB","type": "tuple"},{"internalType": "uint8", "name": "currentRound", "type": "uint8"},{"internalType": "uint256", "name": "wagerAmount", "type": "uint256"},{"internalType": "bytes32", "name": "inviteCodeHash", "type": "bytes32"},{"internalType": "uint256", "name": "commitDeadline", "type": "uint256"},{"internalType": "uint256", "name": "revealDeadline", "type": "uint256"},{"internalType": "uint256", "name": "bettingCutoff", "type": "uint256"},{"internalType": "address", "name": "winner", "type": "address"},{"internalType": "uint8[]", "name": "turnHistory", "type": "uint8[]"},{"internalType": "uint256", "name": "createdAt", "type": "uint256"},{"internalType": "uint256", "name": "commitCompletedBlock", "type": "uint256"}],"internalType": "struct UndergroundClawFights.Match","name": "","type": "tuple"}],
    "stateMutability": "view",
    "type": "function"
  },

  // Admin
  {
    "inputs": [{"internalType": "address", "name": "_newOwner", "type": "address"}],
    "name": "transferOwnership",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [{"internalType": "uint256", "name": "_agentFeeBps", "type": "uint256"},{"internalType": "uint256", "name": "_spectatorFeeBps", "type": "uint256"}],
    "name": "setFees",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [{"internalType": "address", "name": "_newTreasury", "type": "address"}],
    "name": "setTreasury",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "withdrawFees",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },

  // State Variables
  {"inputs": [],"name": "owner","outputs": [{"internalType": "address", "name": "", "type": "address"}],"stateMutability": "view","type": "function"},
  {"inputs": [],"name": "treasury","outputs": [{"internalType": "address", "name": "", "type": "address"}],"stateMutability": "view","type": "function"},
  {"inputs": [],"name": "agentFeeBps","outputs": [{"internalType": "uint256", "name": "", "type": "uint256"}],"stateMutability": "view","type": "function"},
  {"inputs": [],"name": "spectatorFeeBps","outputs": [{"internalType": "uint256", "name": "", "type": "uint256"}],"stateMutability": "view","type": "function"},
  {"inputs": [],"name": "totalAgentFees","outputs": [{"internalType": "uint256", "name": "", "type": "uint256"}],"stateMutability": "view","type": "function"},
  {"inputs": [],"name": "totalSpectatorFees","outputs": [{"internalType": "uint256", "name": "", "type": "uint256"}],"stateMutability": "view","type": "function"},
  {"inputs": [],"name": "nextMatchId","outputs": [{"internalType": "uint256", "name": "", "type": "uint256"}],"stateMutability": "view","type": "function"},
  {"inputs": [],"name": "nextTicketId","outputs": [{"internalType": "uint256", "name": "", "type": "uint256"}],"stateMutability": "view","type": "function"},
  {"inputs": [],"name": "MAX_WAGER","outputs": [{"internalType": "uint256", "name": "", "type": "uint256"}],"stateMutability": "view","type": "function"},
  {"inputs": [],"name": "MIN_SPECTATOR_BET","outputs": [{"internalType": "uint256", "name": "", "type": "uint256"}],"stateMutability": "view","type": "function"},

  // Events
  {"anonymous": false,"inputs": [{"indexed": true, "internalType": "address", "name": "agent", "type": "address"},{"indexed": false, "internalType": "bytes32", "name": "promptHash", "type": "bytes32"}],"name": "ProfileCreated","type": "event"},
  {"anonymous": false,"inputs": [{"indexed": true, "internalType": "uint256", "name": "ticketId", "type": "uint256"},{"indexed": true, "internalType": "address", "name": "player", "type": "address"},{"indexed": false, "internalType": "uint256", "name": "wager", "type": "uint256"}],"name": "LobbyEntered","type": "event"},
  {"anonymous": false,"inputs": [{"indexed": true, "internalType": "uint256", "name": "ticketId", "type": "uint256"},{"indexed": true, "internalType": "address", "name": "player", "type": "address"}],"name": "LobbyCancelled","type": "event"},
  {"anonymous": false,"inputs": [{"indexed": true, "internalType": "uint256", "name": "ticketId", "type": "uint256"},{"indexed": true, "internalType": "uint256", "name": "matchId", "type": "uint256"},{"indexed": false, "internalType": "address", "name": "playerA", "type": "address"},{"indexed": false, "internalType": "address", "name": "playerB", "type": "address"}],"name": "LobbyMatched","type": "event"},
  {"anonymous": false,"inputs": [{"indexed": true, "internalType": "uint256", "name": "matchId", "type": "uint256"},{"indexed": false, "internalType": "uint256", "name": "bettingCutoff", "type": "uint256"}],"name": "MatchActivated","type": "event"},
  {"anonymous": false,"inputs": [{"indexed": true, "internalType": "uint256", "name": "matchId", "type": "uint256"},{"indexed": false, "internalType": "address", "name": "winner", "type": "address"},{"indexed": false, "internalType": "address", "name": "loser", "type": "address"},{"indexed": false, "internalType": "uint256", "name": "winnerPayout", "type": "uint256"},{"indexed": false, "internalType": "uint256", "name": "feeAmount", "type": "uint256"}],"name": "MatchEnd","type": "event"},
  {"anonymous": false,"inputs": [{"indexed": true, "internalType": "address", "name": "treasury", "type": "address"},{"indexed": false, "internalType": "uint256", "name": "agentFees", "type": "uint256"},{"indexed": false, "internalType": "uint256", "name": "spectatorFees", "type": "uint256"}],"name": "FeesWithdrawn","type": "event"},
  {"anonymous": false,"inputs": [{"indexed": true, "internalType": "address", "name": "oldOwner", "type": "address"},{"indexed": true, "internalType": "address", "name": "newOwner", "type": "address"}],"name": "OwnershipTransferred","type": "event"}
];

export type { ContractName as default };
