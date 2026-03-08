import { NextResponse } from "next/server";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { getCachedBalance, getBettingConnection } from "~~/lib/solana-connection";
import { checkRateLimit, getRateLimitKey, rateLimitResponse } from "~~/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * GET /api/rumble/sol-balance?address=<pubkey>
 *
 * Returns the SOL balance for a wallet address.
 * Proxies the Solana RPC call server-side so mobile clients don't
 * hit public RPC rate limits.
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const address = searchParams.get("address");

    if (!address) {
      return NextResponse.json(
        { error: "Missing address query parameter" },
        { status: 400 },
      );
    }

    let pubkey: PublicKey;
    try {
      pubkey = new PublicKey(address);
    } catch {
      return NextResponse.json(
        { error: "Invalid address" },
        { status: 400 },
      );
    }

    const conn = getBettingConnection();
    const lamports = await getCachedBalance(conn, pubkey, {
      commitment: "confirmed",
      ttlMs: 20_000,
    });
    const sol = lamports / LAMPORTS_PER_SOL;

    return NextResponse.json(
      { address: pubkey.toBase58(), lamports, sol },
      {
        headers: {
          "Cache-Control": "private, max-age=10, stale-while-revalidate=20",
        },
      },
    );
  } catch (error) {
    console.error("[SolBalanceAPI]", error);
    return NextResponse.json(
      { error: "Failed to fetch balance" },
      { status: 500 },
    );
  }
}
