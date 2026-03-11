import { NextResponse } from "next/server";

// ---------------------------------------------------------------------------
// In-memory rate limiter using Map
//
// LIMITATION (distributed / serverless): These buckets live in process memory.
// On Vercel, each serverless invocation may run in a separate isolate, so a
// client can exceed the configured limit by spreading requests across cold
// starts.  This is an intentional trade-off — adding Redis or an external
// store is not warranted for the current traffic volume.  The rate limiter
// still provides meaningful protection within a single long-lived instance
// (Railway worker, sustained Vercel warm instance) and acts as a
// best-effort guard against simple abuse in the serverless case.
//
// Endpoints that still apply rate limiting (as of 2026-03):
//   PUBLIC_READ  — /leaderboard, /matches, /stats, /activity, /history,
//                  /rumble/queue (GET), /rumble/bet (GET), /rumble/submit-tx (GET),
//                  /rumble/pending-moves, /mobile-auth/nonce,
//                  /rumble/sponsorship/balance
//   PUBLIC_WRITE — /rumble/bet (POST), /rumble/wallet-submit,
//                  /rumble/claim/prepare, /rumble/claim/confirm,
//                  /rumble/bet/prepare, /rumble/submit-move,
//                  /rumble/move/commit/prepare, /rumble/move/reveal/prepare,
//                  /mobile-auth/verify, /fighter/verify,
//                  /rumble/commentary (POST),
//                  /rumble/sponsorship/claim/prepare,
//                  /rumble/sponsorship/claim/confirm
//   AUTHENTICATED — /rumble/submit-tx (POST), /rumble/queue (POST/DELETE)
//   SSE          — /rumble/live
//
// Intentionally removed from high-frequency read endpoints:
//   /rumble/status, /rumble/my-bets, /rumble/balance, /rumble/sol-balance
//   (these are polled rapidly by the UI and rate limiting caused false 429s)
// ---------------------------------------------------------------------------

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export type RateLimitTier = "PUBLIC_READ" | "PUBLIC_WRITE" | "AUTHENTICATED" | "SSE";

const TIER_CONFIG: Record<RateLimitTier, { maxRequests: number; windowMs: number }> = {
  PUBLIC_READ: { maxRequests: 120, windowMs: 60_000 },
  PUBLIC_WRITE: { maxRequests: 10, windowMs: 60_000 },
  AUTHENTICATED: { maxRequests: 30, windowMs: 60_000 },
  SSE: { maxRequests: 5, windowMs: 60_000 },
};

const DEFAULT_SCOPE = "__shared__";

// Separate bucket per tier + optional route scope so multi-step flows
// (prepare -> submit -> confirm) do not consume a single global write bucket.
// Callers should pass a stable route identifier for scoped limits.
const buckets = new Map<string, Map<string, RateLimitEntry>>();

function getBucketId(tier: RateLimitTier, scope = DEFAULT_SCOPE): string {
  return `${tier}:${scope}`;
}

function getBucket(tier: RateLimitTier, scope = DEFAULT_SCOPE): Map<string, RateLimitEntry> {
  const bucketId = getBucketId(tier, scope);
  let bucket = buckets.get(bucketId);
  if (!bucket) {
    bucket = new Map();
    buckets.set(bucketId, bucket);
  }
  return bucket;
}

// ---------------------------------------------------------------------------
// Auto-cleanup every 5 minutes to prevent memory leaks
// ---------------------------------------------------------------------------
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

function cleanup() {
  const now = Date.now();
  for (const [, bucket] of buckets) {
    for (const [key, entry] of bucket) {
      if (now >= entry.resetAt) {
        bucket.delete(key);
      }
    }
  }
}

// Only schedule cleanup in a Node.js runtime (not during Next.js build)
if (typeof globalThis !== "undefined") {
  const interval = setInterval(cleanup, CLEANUP_INTERVAL_MS);
  // Allow the process to exit without waiting for this interval
  if (interval && typeof (interval as any).unref === "function") {
    (interval as any).unref();
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract a rate-limit key (client IP) from the request headers.
 */
export function getRateLimitKey(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    return forwardedFor.split(",")[0].trim();
  }
  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  return "unknown";
}

/**
 * Check whether a request is allowed under the given rate-limit tier.
 * Pass `scope` to isolate buckets for individual routes or workflows.
 * Returns `{ allowed, retryAfterMs }`.
 */
export function checkRateLimit(
  tier: RateLimitTier,
  key: string,
  scope = DEFAULT_SCOPE,
): { allowed: boolean; retryAfterMs: number } {
  const config = TIER_CONFIG[tier];
  const bucket = getBucket(tier, scope);
  const now = Date.now();

  // Evict if bucket grows too large (safety valve)
  if (bucket.size > 50_000) {
    for (const [k, entry] of bucket) {
      if (now >= entry.resetAt) bucket.delete(k);
    }
  }

  const existing = bucket.get(key);

  // No entry or window expired — start fresh
  if (!existing || now >= existing.resetAt) {
    bucket.set(key, { count: 1, resetAt: now + config.windowMs });
    return { allowed: true, retryAfterMs: 0 };
  }

  // Within window — check count
  if (existing.count >= config.maxRequests) {
    return {
      allowed: false,
      retryAfterMs: Math.max(1, existing.resetAt - now),
    };
  }

  existing.count += 1;
  return { allowed: true, retryAfterMs: 0 };
}

/**
 * Build a 429 Too Many Requests response with a Retry-After header.
 */
export function rateLimitResponse(retryAfterMs: number): NextResponse {
  const retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return NextResponse.json(
    {
      error: "Rate limit exceeded. Please slow down.",
      retry_after_seconds: retryAfterSec,
    },
    {
      status: 429,
      headers: { "Retry-After": String(retryAfterSec) },
    },
  );
}
