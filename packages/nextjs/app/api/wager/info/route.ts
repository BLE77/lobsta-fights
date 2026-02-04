import { NextRequest, NextResponse } from "next/server";
import { supabase } from "../../../../lib/supabase";
import {
  getFighterBalance,
  getFighterWallet,
  isOnChainWageringEnabled,
  getContractAddress,
  getChainInfo,
} from "../../../../lib/contracts";

/**
 * GET /api/wager/info
 *
 * Get wager info for a fighter - on-chain balance, linked wallet, etc.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const fighterId = searchParams.get("fighter_id");
  const apiKey = searchParams.get("api_key");

  if (!fighterId || !apiKey) {
    return NextResponse.json(
      { error: "Missing fighter_id or api_key" },
      { status: 400 }
    );
  }

  // Verify credentials
  const { data: fighter, error } = await supabase
    .from("ucf_fighters")
    .select("id, name, points")
    .eq("id", fighterId)
    .eq("api_key", apiKey)
    .single();

  if (error || !fighter) {
    return NextResponse.json(
      { error: "Invalid credentials" },
      { status: 401 }
    );
  }

  // Check if on-chain wagering is enabled
  if (!isOnChainWageringEnabled()) {
    return NextResponse.json({
      enabled: false,
      message: "On-chain wagering not configured yet",
      fighter: {
        id: fighter.id,
        name: fighter.name,
        points: fighter.points,
      },
    });
  }

  try {
    const [balance, wallet] = await Promise.all([
      getFighterBalance(fighterId),
      getFighterWallet(fighterId),
    ]);

    const isLinked = wallet !== "0x0000000000000000000000000000000000000000";

    return NextResponse.json({
      enabled: true,
      chain: getChainInfo(),
      contract: getContractAddress(),
      fighter: {
        id: fighter.id,
        name: fighter.name,
        points: fighter.points,
        wallet_linked: isLinked,
        wallet_address: isLinked ? wallet : null,
        on_chain_balance: balance,
        on_chain_balance_eth: `${balance} ETH`,
      },
      instructions: isLinked
        ? {
            deposit: `Call deposit("${fighterId}") on the contract with ETH to add funds`,
            withdraw: `Call withdraw("${fighterId}", amount) to withdraw ETH`,
          }
        : {
            link: `Call linkFighter("${fighterId}") on the contract to link your wallet`,
          },
    });
  } catch (err: any) {
    return NextResponse.json({
      enabled: true,
      error: err.message,
      chain: getChainInfo(),
      contract: getContractAddress(),
      fighter: {
        id: fighter.id,
        name: fighter.name,
        points: fighter.points,
      },
    });
  }
}
