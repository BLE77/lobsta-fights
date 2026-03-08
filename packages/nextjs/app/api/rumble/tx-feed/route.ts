import { NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import { getRpcEndpoint } from "~~/lib/solana-connection";
import { checkRateLimit, getRateLimitKey, rateLimitResponse } from "~~/lib/rate-limit";

export const dynamic = "force-dynamic";

const PROGRAM_ID = process.env.NEXT_PUBLIC_RUMBLE_ENGINE_PROGRAM || "638DcfW6NaBweznnzmJe4PyxCw51s3CTkykUNskWnxTU";

// Simple in-memory cache (10s TTL) — all clients see the same feed
let cachedFeed: { data: unknown[]; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 10_000;

/**
 * GET /api/rumble/tx-feed
 *
 * Returns recent transaction signatures for the rumble engine program.
 * Proxies the Solana RPC call server-side so mobile clients don't need
 * a Helius key or hit public rate limits.
 */
export async function GET(request: Request) {
  try {
    const now = Date.now();
    if (cachedFeed && now - cachedFeed.fetchedAt < CACHE_TTL_MS) {
      return NextResponse.json({ signatures: cachedFeed.data });
    }

    const rpc = getRpcEndpoint();
    const conn = new Connection(rpc, "confirmed");
    const signatures = await conn.getSignaturesForAddress(
      new PublicKey(PROGRAM_ID),
      { limit: 20 },
    );

    const data = signatures.map(sig => ({
      signature: sig.signature,
      blockTime: sig.blockTime ?? null,
      confirmationStatus: sig.confirmationStatus ?? null,
      err: !!sig.err,
    }));

    cachedFeed = { data, fetchedAt: now };

    return NextResponse.json({ signatures: data });
  } catch (error) {
    console.error("[TxFeedAPI]", error);
    return NextResponse.json(
      { error: "Failed to fetch tx feed" },
      { status: 500 },
    );
  }
}
