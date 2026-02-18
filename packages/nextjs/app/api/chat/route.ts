import { NextResponse } from "next/server";
import { freshSupabase } from "~~/lib/supabase";

export const dynamic = "force-dynamic";

// Rate limit: simple in-memory per-wallet cooldown (1 message per 2 seconds)
const lastMessageTime = new Map<string, number>();
const COOLDOWN_MS = 2000;

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
    const { wallet_address, message } = body;

    if (!wallet_address || typeof wallet_address !== "string") {
      return NextResponse.json({ error: "wallet_address required" }, { status: 400 });
    }
    if (!message || typeof message !== "string") {
      return NextResponse.json({ error: "message required" }, { status: 400 });
    }

    const trimmed = message.trim();
    if (trimmed.length === 0 || trimmed.length > 500) {
      return NextResponse.json({ error: "Message must be 1-500 characters" }, { status: 400 });
    }

    // Rate limit check
    const now = Date.now();
    const last = lastMessageTime.get(wallet_address) ?? 0;
    if (now - last < COOLDOWN_MS) {
      return NextResponse.json({ error: "Slow down! Wait a moment before sending another message." }, { status: 429 });
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
        message: trimmed,
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
