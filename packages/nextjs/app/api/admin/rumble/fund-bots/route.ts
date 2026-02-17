import { NextResponse } from "next/server";
import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { isAuthorizedAdminRequest } from "~~/lib/request-auth";
import { freshSupabase } from "~~/lib/supabase";

export const dynamic = "force-dynamic";

const DEVNET_RPC = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com";
const MIN_BALANCE_SOL = 0.1;
const AIRDROP_AMOUNT_SOL = 1;

/**
 * POST /api/admin/rumble/fund-bots
 *
 * Checks each house bot wallet's SOL balance on devnet.
 * Airdrops 1 SOL to any wallet below 0.1 SOL.
 */
export async function POST(request: Request) {
  if (!isAuthorizedAdminRequest(request.headers)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const houseBotIds = (process.env.RUMBLE_HOUSE_BOT_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);

    if (houseBotIds.length === 0) {
      return NextResponse.json({
        success: false,
        error: "No RUMBLE_HOUSE_BOT_IDS configured",
      }, { status: 400 });
    }

    // Look up wallet addresses from DB
    const supabase = freshSupabase();
    const { data: fighters, error: dbError } = await supabase
      .from("ucf_fighters")
      .select("id, name, wallet_address")
      .in("id", houseBotIds);

    if (dbError) {
      return NextResponse.json({
        success: false,
        error: `DB lookup failed: ${dbError.message}`,
      }, { status: 500 });
    }

    if (!fighters || fighters.length === 0) {
      return NextResponse.json({
        success: false,
        error: "No fighters found for configured house bot IDs",
      }, { status: 400 });
    }

    const connection = new Connection(DEVNET_RPC, "confirmed");
    const results: Array<{
      fighterId: string;
      name: string;
      wallet: string;
      balanceBefore: number;
      balanceAfter: number | null;
      funded: boolean;
      error: string | null;
    }> = [];

    for (const fighter of fighters) {
      const wallet = fighter.wallet_address;
      if (!wallet) {
        results.push({
          fighterId: fighter.id,
          name: fighter.name,
          wallet: "-",
          balanceBefore: 0,
          balanceAfter: null,
          funded: false,
          error: "No wallet_address",
        });
        continue;
      }

      let pubkey: PublicKey;
      try {
        pubkey = new PublicKey(wallet);
      } catch {
        results.push({
          fighterId: fighter.id,
          name: fighter.name,
          wallet,
          balanceBefore: 0,
          balanceAfter: null,
          funded: false,
          error: "Invalid wallet address",
        });
        continue;
      }

      try {
        const balanceLamports = await connection.getBalance(pubkey);
        const balanceSol = balanceLamports / LAMPORTS_PER_SOL;

        if (balanceSol >= MIN_BALANCE_SOL) {
          results.push({
            fighterId: fighter.id,
            name: fighter.name,
            wallet: wallet.slice(0, 8) + "..." + wallet.slice(-4),
            balanceBefore: balanceSol,
            balanceAfter: balanceSol,
            funded: false,
            error: null,
          });
          continue;
        }

        // Airdrop
        const sig = await connection.requestAirdrop(
          pubkey,
          AIRDROP_AMOUNT_SOL * LAMPORTS_PER_SOL,
        );
        await connection.confirmTransaction(sig, "confirmed");

        const newBalance = await connection.getBalance(pubkey);
        results.push({
          fighterId: fighter.id,
          name: fighter.name,
          wallet: wallet.slice(0, 8) + "..." + wallet.slice(-4),
          balanceBefore: balanceSol,
          balanceAfter: newBalance / LAMPORTS_PER_SOL,
          funded: true,
          error: null,
        });
      } catch (err: any) {
        results.push({
          fighterId: fighter.id,
          name: fighter.name,
          wallet: wallet.slice(0, 8) + "..." + wallet.slice(-4),
          balanceBefore: 0,
          balanceAfter: null,
          funded: false,
          error: err?.message?.slice(0, 120) ?? "Airdrop failed",
        });
      }
    }

    const funded = results.filter((r) => r.funded).length;
    const errors = results.filter((r) => r.error).length;

    return NextResponse.json({
      success: true,
      totalBots: results.length,
      funded,
      errors,
      results,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("[FundBots]", error);
    return NextResponse.json({ error: "Fund bots failed" }, { status: 500 });
  }
}
