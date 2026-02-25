import { Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { NextResponse } from "next/server";
import { getConnection } from "../../../../lib/solana-connection";
import { requireJsonContentType, sanitizeErrorResponse } from "../../../../lib/api-middleware";

export const dynamic = "force-dynamic";

const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_WALLETS_PER_WINDOW = 3;
const walletRateLimit = new Map<string, { count: number; resetAt: number }>();

const AIRDROP_SOL = 0.1;

function getRateLimitKey(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    return forwardedFor.split(",")[0].trim();
  }
  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  return "unknown";
}

function consumeWalletQuota(request: Request): { allowed: boolean; retryAfterSec: number } {
  const key = getRateLimitKey(request);
  const now = Date.now();

  // Periodic cleanup
  if (walletRateLimit.size > 10_000) {
    for (const [entryKey, entry] of walletRateLimit.entries()) {
      if (now >= entry.resetAt) walletRateLimit.delete(entryKey);
    }
  }

  const existing = walletRateLimit.get(key);
  if (!existing || now >= existing.resetAt) {
    walletRateLimit.set(key, {
      count: 1,
      resetAt: now + RATE_LIMIT_WINDOW_MS,
    });
    return { allowed: true, retryAfterSec: 0 };
  }

  if (existing.count >= MAX_WALLETS_PER_WINDOW) {
    return {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }

  existing.count += 1;
  walletRateLimit.set(key, existing);
  return { allowed: true, retryAfterSec: 0 };
}

export async function POST(request: Request) {
  try {
    // Kill switch
    if (process.env.ENABLE_WALLET_CREATION === "false") {
      return NextResponse.json(
        { error: "Wallet creation is currently disabled." },
        { status: 503 },
      );
    }

    const contentTypeError = requireJsonContentType(request);
    if (contentTypeError) return contentTypeError;

    // Rate limit
    const quota = consumeWalletQuota(request);
    if (!quota.allowed) {
      return NextResponse.json(
        {
          error: "Wallet creation rate limit exceeded. Max 3 wallets per hour.",
          retry_after_seconds: quota.retryAfterSec,
        },
        { status: 429, headers: { "Retry-After": String(quota.retryAfterSec) } },
      );
    }

    // Generate keypair
    const keypair = Keypair.generate();
    const walletAddress = keypair.publicKey.toBase58();
    const bs58 = require("bs58");
    const secretKeyBase58 = bs58.encode(keypair.secretKey);

    // Fund on devnet
    let fundedSol = 0;
    let airdropWarning: string | undefined;

    try {
      const connection = getConnection();
      const signature = await connection.requestAirdrop(
        keypair.publicKey,
        AIRDROP_SOL * LAMPORTS_PER_SOL,
      );
      // Fire-and-forget — don't wait for confirmation (devnet airdrop is flaky)
      fundedSol = AIRDROP_SOL;
      console.log(`[Wallet] Created + funded ${walletAddress} (airdrop sig: ${signature})`);
    } catch (airdropErr: any) {
      console.error(`[Wallet] Airdrop failed for ${walletAddress}:`, airdropErr);
      airdropWarning =
        "Airdrop failed (devnet faucet may be rate-limited). Wallet created but unfunded. " +
        "Try funding manually: https://faucet.solana.com or retry later.";
    }

    return NextResponse.json({
      success: true,
      wallet_address: walletAddress,
      secret_key: secretKeyBase58,
      funded_sol: fundedSol,
      network: "devnet",
      warnings: [
        "SAVE YOUR SECRET KEY — it is returned once and never stored by UCF.",
        "This is a DEVNET wallet. Do not send real SOL to this address.",
        ...(airdropWarning ? [airdropWarning] : []),
      ],
      next_steps: {
        register: "POST /api/fighter/register with { walletAddress, name, robotType, chassisDescription, fistsDescription, ... }",
        queue: "POST /api/rumble/queue with { fighter_id, api_key, auto_requeue: true }",
        docs: "GET /skill.md for full documentation",
      },
    });
  } catch (error: any) {
    console.error("[Wallet] create-wallet error:", error);
    return NextResponse.json(
      sanitizeErrorResponse(error, "Failed to create wallet"),
      { status: 500 },
    );
  }
}
