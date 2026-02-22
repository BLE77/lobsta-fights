import { randomBytes, createHmac } from "node:crypto";

export const SESSION_COOKIE = "ucf_admin_session";
export const SESSION_MAX_AGE = 8 * 60 * 60; // 8 hours

// HMAC key — must be stable across all serverless instances.
// Priority: explicit env var > derived from ADMIN_SECRET > random (breaks on serverless)
function resolveSessionKey(): string {
  if (process.env.ADMIN_SESSION_KEY) return process.env.ADMIN_SESSION_KEY;
  const adminSecret = process.env.ADMIN_SECRET ?? process.env.ADMIN_API_KEY;
  if (adminSecret) {
    return createHmac("sha256", "ucf-admin-session-key-v1").update(adminSecret).digest("hex");
  }
  return randomBytes(32).toString("hex");
}
const SESSION_KEY = resolveSessionKey();

function signToken(payload: string): string {
  return createHmac("sha256", SESSION_KEY).update(payload).digest("hex");
}

function verifyToken(payload: string, sig: string): boolean {
  const expected = signToken(payload);
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  }
  return diff === 0;
}

/** Create a signed session token */
export function createSession(): string {
  const payload = `admin:${Date.now()}:${randomBytes(16).toString("hex")}`;
  const sig = signToken(payload);
  return `${payload}.${sig}`;
}

/** Validate a session token */
export function isValidAdminSession(token: string | undefined | null): boolean {
  if (!token) return false;
  // Next.js cookies.set() URL-encodes values (: → %3A). Decode before
  // verifying so the HMAC matches the original unencoded payload.
  let decoded: string;
  try {
    decoded = decodeURIComponent(token);
  } catch {
    return false;
  }
  const dotIdx = decoded.lastIndexOf(".");
  if (dotIdx < 0) return false;
  const payload = decoded.slice(0, dotIdx);
  const sig = decoded.slice(dotIdx + 1);
  if (!verifyToken(payload, sig)) return false;
  const parts = payload.split(":");
  const ts = parseInt(parts[1], 10);
  if (isNaN(ts)) return false;
  return Date.now() - ts < SESSION_MAX_AGE * 1000;
}
