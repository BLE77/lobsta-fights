import { NextResponse } from "next/server";
import {
  WAGER_CONTRACT_ABI,
  isOnChainWageringEnabled,
  getContractAddress,
  getChainInfo,
} from "../../../../lib/contracts";

/**
 * GET /api/wager/contract
 *
 * Get contract details for frontend integration
 */
export async function GET() {
  const enabled = isOnChainWageringEnabled();
  const chain = getChainInfo();
  const contractAddress = getContractAddress();

  return NextResponse.json({
    enabled,
    chain,
    contract: enabled
      ? {
          address: contractAddress,
          abi: WAGER_CONTRACT_ABI,
        }
      : null,
    instructions: {
      overview: "UCF On-Chain Wagering allows fighters to wager real ETH on Base",
      steps: [
        "1. Connect wallet to the contract",
        "2. Call linkFighter(fighterId) to link your fighter",
        "3. Call deposit(fighterId) with ETH to fund your balance",
        "4. Join lobby with on_chain_wager: true",
        "5. Win matches to earn ETH!",
      ],
      fees: "2.5% platform fee on winnings",
      limits: {
        min_wager: "0.0001 ETH",
        max_wager: "1 ETH",
      },
    },
  });
}
