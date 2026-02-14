// @ts-nocheck
/**
 * Base Chain Contract Integration
 *
 * Handles interaction with ClawFightsWager contract on Base
 */

import { createPublicClient, createWalletClient, http, parseEther, formatEther } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

// Contract ABI (minimal - just the functions we need)
export const WAGER_CONTRACT_ABI = [
  {
    name: 'linkFighter',
    type: 'function',
    inputs: [{ name: 'fighterId', type: 'string' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    name: 'deposit',
    type: 'function',
    inputs: [{ name: 'fighterId', type: 'string' }],
    outputs: [],
    stateMutability: 'payable',
  },
  {
    name: 'withdraw',
    type: 'function',
    inputs: [
      { name: 'fighterId', type: 'string' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    name: 'createMatch',
    type: 'function',
    inputs: [
      { name: 'matchId', type: 'string' },
      { name: 'fighterAId', type: 'string' },
      { name: 'fighterBId', type: 'string' },
      { name: 'wagerAmount', type: 'uint256' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    name: 'resolveMatch',
    type: 'function',
    inputs: [
      { name: 'matchId', type: 'string' },
      { name: 'winnerId', type: 'string' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    name: 'cancelMatch',
    type: 'function',
    inputs: [{ name: 'matchId', type: 'string' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    name: 'getBalance',
    type: 'function',
    inputs: [{ name: 'fighterId', type: 'string' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    name: 'getWallet',
    type: 'function',
    inputs: [{ name: 'fighterId', type: 'string' }],
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
  },
  {
    name: 'balances',
    type: 'function',
    inputs: [{ name: '', type: 'bytes32' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    name: 'matches',
    type: 'function',
    inputs: [{ name: '', type: 'bytes32' }],
    outputs: [
      { name: 'fighterA', type: 'bytes32' },
      { name: 'fighterB', type: 'bytes32' },
      { name: 'wagerAmount', type: 'uint256' },
      { name: 'resolved', type: 'bool' },
      { name: 'winner', type: 'bytes32' },
    ],
    stateMutability: 'view',
  },
] as const;

// Environment config
const USE_TESTNET = process.env.NEXT_PUBLIC_USE_BASE_TESTNET === 'true';
const CHAIN = USE_TESTNET ? baseSepolia : base;
const RPC_URL = USE_TESTNET
  ? process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org'
  : process.env.BASE_RPC_URL || 'https://mainnet.base.org';

// Contract address (deploy and set this)
const CONTRACT_ADDRESS = process.env.WAGER_CONTRACT_ADDRESS as `0x${string}` | undefined;

// Arbiter private key (server-side only - for creating/resolving matches)
const ARBITER_PRIVATE_KEY = process.env.ARBITER_PRIVATE_KEY as `0x${string}` | undefined;

// Public client for reading contract state
export function getPublicClient() {
  return createPublicClient({
    chain: CHAIN,
    transport: http(RPC_URL),
  });
}

// Wallet client for arbiter transactions
export function getArbiterClient() {
  if (!ARBITER_PRIVATE_KEY) {
    throw new Error('ARBITER_PRIVATE_KEY not configured');
  }

  const account = privateKeyToAccount(ARBITER_PRIVATE_KEY);

  return createWalletClient({
    account,
    chain: CHAIN,
    transport: http(RPC_URL),
  });
}

/**
 * Get fighter's on-chain balance
 */
export async function getFighterBalance(fighterId: string): Promise<string> {
  if (!CONTRACT_ADDRESS) throw new Error('Contract not configured');

  const client = getPublicClient();

  const balance = await client.readContract({
    address: CONTRACT_ADDRESS,
    abi: WAGER_CONTRACT_ABI,
    functionName: 'getBalance',
    args: [fighterId],
  });

  return formatEther(balance);
}

/**
 * Get fighter's linked wallet address
 */
export async function getFighterWallet(fighterId: string): Promise<string> {
  if (!CONTRACT_ADDRESS) throw new Error('Contract not configured');

  const client = getPublicClient();

  const wallet = await client.readContract({
    address: CONTRACT_ADDRESS,
    abi: WAGER_CONTRACT_ABI,
    functionName: 'getWallet',
    args: [fighterId],
  });

  return wallet;
}

/**
 * Create match on-chain (locks wagers)
 */
export async function createOnChainMatch(
  matchId: string,
  fighterAId: string,
  fighterBId: string,
  wagerEth: string
): Promise<string> {
  if (!CONTRACT_ADDRESS) throw new Error('Contract not configured');

  const client = getArbiterClient();
  const publicClient = getPublicClient();

  const hash = await client.writeContract({
    address: CONTRACT_ADDRESS,
    abi: WAGER_CONTRACT_ABI,
    functionName: 'createMatch',
    args: [matchId, fighterAId, fighterBId, parseEther(wagerEth)],
  });

  // Wait for confirmation
  await publicClient.waitForTransactionReceipt({ hash });

  return hash;
}

/**
 * Resolve match on-chain (pays winner)
 */
export async function resolveOnChainMatch(
  matchId: string,
  winnerId: string
): Promise<string> {
  if (!CONTRACT_ADDRESS) throw new Error('Contract not configured');

  const client = getArbiterClient();
  const publicClient = getPublicClient();

  const hash = await client.writeContract({
    address: CONTRACT_ADDRESS,
    abi: WAGER_CONTRACT_ABI,
    functionName: 'resolveMatch',
    args: [matchId, winnerId],
  });

  // Wait for confirmation
  await publicClient.waitForTransactionReceipt({ hash });

  return hash;
}

/**
 * Cancel match on-chain (refunds both fighters)
 */
export async function cancelOnChainMatch(matchId: string): Promise<string> {
  if (!CONTRACT_ADDRESS) throw new Error('Contract not configured');

  const client = getArbiterClient();
  const publicClient = getPublicClient();

  const hash = await client.writeContract({
    address: CONTRACT_ADDRESS,
    abi: WAGER_CONTRACT_ABI,
    functionName: 'cancelMatch',
    args: [matchId],
  });

  // Wait for confirmation
  await publicClient.waitForTransactionReceipt({ hash });

  return hash;
}

/**
 * Check if on-chain wagering is enabled
 */
export function isOnChainWageringEnabled(): boolean {
  return !!CONTRACT_ADDRESS && !!ARBITER_PRIVATE_KEY;
}

/**
 * Get contract address
 */
export function getContractAddress(): string | undefined {
  return CONTRACT_ADDRESS;
}

/**
 * Get chain info
 */
export function getChainInfo() {
  return {
    name: CHAIN.name,
    id: CHAIN.id,
    testnet: USE_TESTNET,
    rpcUrl: RPC_URL,
    blockExplorer: CHAIN.blockExplorers?.default?.url,
  };
}
