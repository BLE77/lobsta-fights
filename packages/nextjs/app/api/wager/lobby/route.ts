import { NextResponse } from "next/server";
import { supabase } from "../../../../lib/supabase";
import {
  getFighterBalance,
  getFighterWallet,
  createOnChainMatch,
  isOnChainWageringEnabled,
  getChainInfo,
} from "../../../../lib/contracts";
import { parseEther } from "viem";

export const dynamic = "force-dynamic";

/**
 * POST /api/wager/lobby
 *
 * Join the on-chain wager lobby. If matched, creates an on-chain match with locked ETH.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { fighterId, apiKey, wagerEth = "0.001" } = body;

    if (!fighterId || !apiKey) {
      return NextResponse.json(
        { error: "Missing fighterId or apiKey" },
        { status: 400 }
      );
    }

    // Check if on-chain wagering is enabled
    if (!isOnChainWageringEnabled()) {
      return NextResponse.json(
        {
          error: "On-chain wagering not enabled",
          message: "Contract not deployed or configured yet",
        },
        { status: 503 }
      );
    }

    // Validate wager amount
    const wagerWei = parseEther(wagerEth);
    const minWager = parseEther("0.0001");
    const maxWager = parseEther("1");

    if (wagerWei < minWager || wagerWei > maxWager) {
      return NextResponse.json(
        {
          error: "Invalid wager amount",
          min: "0.0001 ETH",
          max: "1 ETH",
          provided: `${wagerEth} ETH`,
        },
        { status: 400 }
      );
    }

    // Verify fighter and API key
    const { data: fighter, error: fighterError } = await supabase
      .from("ucf_fighters")
      .select("id, name, verified")
      .eq("id", fighterId)
      .eq("api_key", apiKey)
      .single();

    if (fighterError || !fighter) {
      return NextResponse.json({ error: "Invalid fighter or API key" }, { status: 401 });
    }

    if (!fighter.verified) {
      return NextResponse.json({ error: "Fighter not verified" }, { status: 403 });
    }

    // Check wallet is linked and has sufficient balance
    const [wallet, balance] = await Promise.all([
      getFighterWallet(fighterId),
      getFighterBalance(fighterId),
    ]);

    if (wallet === "0x0000000000000000000000000000000000000000") {
      return NextResponse.json(
        {
          error: "Wallet not linked",
          message: `Call linkFighter("${fighterId}") on the contract first`,
          chain: getChainInfo(),
        },
        { status: 400 }
      );
    }

    const balanceWei = parseEther(balance);
    if (balanceWei < wagerWei) {
      return NextResponse.json(
        {
          error: "Insufficient on-chain balance",
          required: `${wagerEth} ETH`,
          available: `${balance} ETH`,
          message: `Deposit more ETH to the contract`,
        },
        { status: 400 }
      );
    }

    // Check if already in an active match
    const { data: activeMatch } = await supabase
      .from("ucf_matches")
      .select("id")
      .or(`fighter_a_id.eq.${fighterId},fighter_b_id.eq.${fighterId}`)
      .neq("state", "FINISHED")
      .single();

    if (activeMatch) {
      return NextResponse.json({
        status: "in_match",
        match_id: activeMatch.id,
        message: "Already in an active match",
      });
    }

    // Look for another fighter in the on-chain lobby with matching wager
    const { data: opponent } = await supabase
      .from("ucf_lobby")
      .select("fighter_id")
      .neq("fighter_id", fighterId)
      .gte("points_wager", -1) // Placeholder - we'd need a proper on-chain lobby table
      .order("created_at", { ascending: true })
      .limit(1)
      .single();

    // For now, simplified: check if there's anyone in regular lobby we can match with
    // In production, you'd have a separate on-chain lobby table

    if (opponent) {
      // Check opponent also has sufficient on-chain balance
      const opponentBalance = await getFighterBalance(opponent.fighter_id);
      const opponentBalanceWei = parseEther(opponentBalance);

      if (opponentBalanceWei < wagerWei) {
        // Opponent doesn't have enough, skip them
        return NextResponse.json({
          status: "waiting",
          message: "Waiting for opponent with sufficient on-chain balance",
          wager_eth: wagerEth,
        });
      }

      // Create match in database first
      const { data: match, error: matchError } = await supabase
        .from("ucf_matches")
        .insert({
          fighter_a_id: opponent.fighter_id,
          fighter_b_id: fighterId,
          state: "COMMIT_PHASE",
          points_wager: 0, // No points wager for on-chain
          on_chain_wager: true,
          wager_eth: parseFloat(wagerEth),
          commit_deadline: new Date(Date.now() + 60000).toISOString(),
          started_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (matchError) {
        return NextResponse.json({ error: matchError.message }, { status: 500 });
      }

      // Create on-chain match (locks wagers)
      try {
        const txHash = await createOnChainMatch(
          match.id,
          opponent.fighter_id,
          fighterId,
          wagerEth
        );

        // Update match with tx hash
        await supabase
          .from("ucf_matches")
          .update({ create_tx_hash: txHash })
          .eq("id", match.id);

        // Remove opponent from lobby
        await supabase.from("ucf_lobby").delete().eq("fighter_id", opponent.fighter_id);

        return NextResponse.json({
          status: "matched",
          match_id: match.id,
          opponent_id: opponent.fighter_id,
          wager_eth: wagerEth,
          on_chain: true,
          create_tx: txHash,
          message: "On-chain match created! Wagers locked. Commit your move.",
          chain: getChainInfo(),
        });
      } catch (err: any) {
        // On-chain creation failed, cancel the match
        await supabase.from("ucf_matches").delete().eq("id", match.id);

        return NextResponse.json(
          {
            error: "Failed to create on-chain match",
            details: err.message,
          },
          { status: 500 }
        );
      }
    }

    // No opponent found - join lobby
    const { error: lobbyError } = await supabase.from("ucf_lobby").upsert({
      fighter_id: fighterId,
      points_wager: -1, // Marker for on-chain wager
    });

    if (lobbyError) {
      return NextResponse.json({ error: lobbyError.message }, { status: 500 });
    }

    return NextResponse.json({
      status: "waiting",
      message: `Waiting for on-chain opponent (${wagerEth} ETH wager)`,
      wager_eth: wagerEth,
      on_chain: true,
      chain: getChainInfo(),
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
