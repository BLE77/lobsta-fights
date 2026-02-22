import { NextResponse } from "next/server";

type RateLimitEntry = {
  count: number;
  resetAt: number;
};

const rateLimitBuckets = new Map<string, RateLimitEntry>();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_CLEANUP_THRESHOLD = 50_000;

/**
 * Require application/json request bodies for mutating endpoints.
 */
export function requireJsonContentType(request: Request): NextResponse | null {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return NextResponse.json(
      { error: "Content-Type must be application/json" },
      { status: 415 },
    );
  }
  return null;
}

/**
 * Log the error server-side and return a generic client-safe error payload.
 */
export function sanitizeErrorResponse(_error: unknown, context: string): { error: string } {
  console.error(`[API Error] ${context}`, _error);
  return { error: context };
}

/**
 * Simple in-memory per-key per-minute rate limiter.
 * Returns true when the key is over the provided per-minute limit.
 */
export function rateLimitCheck(key: string, maxPerMinute: number): boolean {
  if (maxPerMinute <= 0) {
    return false;
  }

  const now = Date.now();

  if (rateLimitBuckets.size > RATE_LIMIT_CLEANUP_THRESHOLD) {
    for (const [storedKey, entry] of rateLimitBuckets) {
      if (now >= entry.resetAt) {
        rateLimitBuckets.delete(storedKey);
      }
    }
  }

  const entry = rateLimitBuckets.get(key);
  if (!entry || now >= entry.resetAt) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }

  entry.count += 1;
  rateLimitBuckets.set(key, entry);

  return entry.count > maxPerMinute;
}
