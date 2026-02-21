import { NextResponse } from "next/server";
import { freshSupabase } from "~~/lib/supabase";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { getConnection } from "~~/lib/solana-connection";

export const dynamic = "force-dynamic";

// Rate limit: simple in-memory per-wallet cooldown (1 message per 2 seconds)
const lastMessageTime = new Map<string, number>();
const COOLDOWN_MS = 2000;

// Cache chat eligibility per wallet for 60s to avoid hammering DB + RPC
const eligibilityCache = new Map<string, { eligible: boolean; expiresAt: number }>();
const ELIGIBILITY_TTL_MS = 60_000;

// Token mint for chat gating (ICHOR — will be updated to pump.fun CA)
const CHAT_TOKEN_MINT = process.env.NEXT_PUBLIC_ICHOR_TOKEN_MINT
  ?? process.env.NEXT_PUBLIC_ICHOR_MINT
  ?? null;

async function isEligibleToChat(walletAddress: string): Promise<boolean> {
  const now = Date.now();
  const cached = eligibilityCache.get(walletAddress);
  if (cached && cached.expiresAt > now) return cached.eligible;

  // Check 1: Has the wallet placed any bet?
  const db = freshSupabase();
  const { count } = await db
    .from("ucf_bets")
    .select("id", { count: "exact", head: true })
    .eq("wallet_address", walletAddress)
    .limit(1);

  if (count && count > 0) {
    eligibilityCache.set(walletAddress, { eligible: true, expiresAt: now + ELIGIBILITY_TTL_MS });
    return true;
  }

  // Check 2: Does the wallet hold the token?
  if (CHAT_TOKEN_MINT) {
    try {
      const mint = new PublicKey(CHAT_TOKEN_MINT);
      const owner = new PublicKey(walletAddress);
      const ata = getAssociatedTokenAddressSync(mint, owner);
      const conn = getConnection();
      const info = await conn.getAccountInfo(ata);
      if (info && info.data.length >= 64) {
        // SPL token account data: bytes 64-72 = amount (u64 LE)
        const amount = info.data.readBigUInt64LE(64);
        if (amount > 0n) {
          eligibilityCache.set(walletAddress, { eligible: true, expiresAt: now + ELIGIBILITY_TTL_MS });
          return true;
        }
      }
    } catch {
      // RPC error or invalid address — fall through
    }
  }

  eligibilityCache.set(walletAddress, { eligible: false, expiresAt: now + ELIGIBILITY_TTL_MS });
  return false;
}

export async function GET() {
  try {
    const db = freshSupabase();
    const { data, error } = await db
      .from("chat_messages")
      .select("id, user_id, username, message, created_at")
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Return in ascending order (oldest first) for display
    return NextResponse.json(data?.reverse() ?? []);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { wallet_address, message, signature, timestamp } = body;

    if (!wallet_address || typeof wallet_address !== "string") {
      return NextResponse.json({ error: "wallet_address required" }, { status: 400 });
    }
    if (!message || typeof message !== "string") {
      return NextResponse.json({ error: "message required" }, { status: 400 });
    }

    // Validate wallet is a valid Solana public key
    let walletPubkey: PublicKey;
    try {
      walletPubkey = new PublicKey(wallet_address);
    } catch {
      return NextResponse.json({ error: "Invalid wallet address" }, { status: 400 });
    }

    // Verify wallet ownership via signed message (if signature provided)
    // Signature proves the sender actually controls this wallet
    if (signature && timestamp) {
      try {
        const { default: nacl } = await import("tweetnacl");
        const expectedMsg = `UCF Chat: ${timestamp}`;
        const msgBytes = new TextEncoder().encode(expectedMsg);
        const sigBytes = Buffer.from(signature, "base64");
        const valid = nacl.sign.detached.verify(msgBytes, sigBytes, walletPubkey.toBytes());
        if (!valid) {
          return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
        }
        // Reject stale signatures (older than 5 minutes)
        const ts = parseInt(timestamp, 10);
        if (isNaN(ts) || Math.abs(Date.now() - ts) > 5 * 60 * 1000) {
          return NextResponse.json({ error: "Signature expired" }, { status: 401 });
        }
      } catch {
        return NextResponse.json({ error: "Signature verification failed" }, { status: 401 });
      }
    }

    const trimmed = message.trim();
    // Strip HTML tags and control characters
    const sanitized = trimmed.replace(/<[^>]*>/g, '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    if (sanitized.length === 0 || sanitized.length > 500) {
      return NextResponse.json({ error: "Message must be 1-500 characters" }, { status: 400 });
    }

    // Rate limit check
    const now = Date.now();
    const last = lastMessageTime.get(wallet_address) ?? 0;
    if (now - last < COOLDOWN_MS) {
      return NextResponse.json({ error: "Slow down! Wait a moment before sending another message." }, { status: 429 });
    }

    // Eligibility check: must have bet or hold the token
    const eligible = await isEligibleToChat(wallet_address);
    if (!eligible) {
      return NextResponse.json(
        { error: "You need to place a bet or hold $ICHOR to chat." },
        { status: 403 },
      );
    }

    lastMessageTime.set(wallet_address, now);

    // Clean up rate limit map periodically (prevent memory leak)
    if (lastMessageTime.size > 1000) {
      const cutoff = now - 60_000;
      for (const [key, time] of lastMessageTime) {
        if (time < cutoff) lastMessageTime.delete(key);
      }
    }

    // Build username from wallet address (first 4 + last 4)
    const username =
      wallet_address.length > 8
        ? `${wallet_address.slice(0, 4)}...${wallet_address.slice(-4)}`
        : wallet_address;

    const db = freshSupabase();
    const { data, error } = await db
      .from("chat_messages")
      .insert({
        user_id: wallet_address,
        username,
        message: sanitized,
      })
      .select("id, user_id, username, message, created_at")
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(data);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
