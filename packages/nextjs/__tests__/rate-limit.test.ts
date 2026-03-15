import { describe, expect, it } from "vitest";

import { checkRateLimit } from "~~/lib/rate-limit";

function uniqueKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

describe("checkRateLimit", () => {
  it("enforces the configured limit within a shared bucket", () => {
    const key = uniqueKey("shared");

    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(checkRateLimit("PUBLIC_WRITE", key).allowed).toBe(true);
    }

    const limited = checkRateLimit("PUBLIC_WRITE", key);
    expect(limited.allowed).toBe(false);
    expect(limited.retryAfterMs).toBeGreaterThan(0);
  });

  it("isolates different scopes for the same client and tier", () => {
    const key = uniqueKey("scoped");

    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(checkRateLimit("PUBLIC_WRITE", key, "/api/rumble/bet/prepare").allowed).toBe(true);
    }

    expect(checkRateLimit("PUBLIC_WRITE", key, "/api/rumble/bet/prepare").allowed).toBe(false);
    expect(checkRateLimit("PUBLIC_WRITE", key, "/api/rumble/bet").allowed).toBe(true);
  });
});
