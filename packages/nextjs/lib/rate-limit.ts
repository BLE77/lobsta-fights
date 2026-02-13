import { NextResponse } from "next/server";

// ---------------------------------------------------------------------------
// In-memory rate limiter using Map
// ---------------------------------------------------------------------------

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export type RateLimitTier = "PUBLIC_READ" | "PUBLIC_WRITE" | "AUTHENTICATED" | "SSE";

const TIER_CONFIG: Record<RateLimitTier, { maxRequests: number; windowMs: number }> = {
  PUBLIC_READ: { maxRequests: 60, windowMs: 60_000 },
  PUBLIC_WRITE: { maxRequests: 10, windowMs: 60_000 },
  AUTHENTICATED: { maxRequests: 30, windowMs: 60_000 },
  SSE: { maxRequests: 5, windowMs: 60_000 },
};

// Separate bucket per tier so read limits don't eat into write limits
const buckets = new Map<RateLimitTier, Map<string, RateLimitEntry>>();

function getBucket(tier: RateLimitTier): Map<string, RateLimitEntry> {
  let bucket = buckets.get(tier);
  if (!bucket) {
    bucket = new Map();
    buckets.set(tier, bucket);
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
 * Returns `{ allowed, retryAfterMs }`.
 */
export function checkRateLimit(
  tier: RateLimitTier,
  key: string,
): { allowed: boolean; retryAfterMs: number } {
  const config = TIER_CONFIG[tier];
  const bucket = getBucket(tier);
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
