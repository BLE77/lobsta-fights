import { NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import { getRpcEndpoint, getBettingRpcEndpoint } from "~~/lib/solana-connection";
import { RUMBLE_ENGINE_ID, RUMBLE_ENGINE_ID_MAINNET } from "~~/lib/solana-programs";

export const dynamic = "force-dynamic";

const DEVNET_PROGRAM_ID = process.env.NEXT_PUBLIC_RUMBLE_ENGINE_PROGRAM || RUMBLE_ENGINE_ID.toBase58();

// Per-network caches (10s TTL)
const cachedFeeds: Record<string, { data: unknown[]; fetchedAt: number }> = {};
const CACHE_TTL_MS = 10_000;

/**
 * GET /api/rumble/tx-feed?network=mainnet|devnet
 *
 * Returns recent transaction signatures for the rumble engine program.
 * Supports both mainnet and devnet via the `network` query param.
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const networkParam = (url.searchParams.get("network") ?? "").trim().toLowerCase();
    const isMainnet = networkParam === "mainnet" || networkParam === "mainnet-beta";
    const cacheKey = isMainnet ? "mainnet" : "devnet";

    const now = Date.now();
    const cached = cachedFeeds[cacheKey];
    if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
      return NextResponse.json({ signatures: cached.data, network: cacheKey });
    }

    const rpc = isMainnet ? getBettingRpcEndpoint() : getRpcEndpoint();
    const programId = isMainnet ? RUMBLE_ENGINE_ID_MAINNET.toBase58() : DEVNET_PROGRAM_ID;
    const conn = new Connection(rpc, "confirmed");
    const signatures = await conn.getSignaturesForAddress(
      new PublicKey(programId),
      { limit: 20 },
    );

    const data = signatures.map(sig => ({
      signature: sig.signature,
      blockTime: sig.blockTime ?? null,
      confirmationStatus: sig.confirmationStatus ?? null,
      err: !!sig.err,
    }));

    cachedFeeds[cacheKey] = { data, fetchedAt: now };

    return NextResponse.json({ signatures: data, network: cacheKey });
  } catch (error) {
    console.error("[TxFeedAPI]", error);
    return NextResponse.json(
      { error: "Failed to fetch tx feed" },
      { status: 500 },
    );
  }
}
