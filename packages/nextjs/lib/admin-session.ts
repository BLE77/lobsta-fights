import { randomBytes, createHmac } from "node:crypto";

export const SESSION_COOKIE = "ucf_admin_session";
export const SESSION_MAX_AGE = 8 * 60 * 60; // 8 hours

// HMAC key — generated once at process start, sessions invalidate on restart
const SESSION_KEY = process.env.ADMIN_SESSION_KEY ?? randomBytes(32).toString("hex");

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
  const dotIdx = token.lastIndexOf(".");
  if (dotIdx < 0) return false;
  const payload = token.slice(0, dotIdx);
  const sig = token.slice(dotIdx + 1);
  if (!verifyToken(payload, sig)) return false;
  const parts = payload.split(":");
  const ts = parseInt(parts[1], 10);
  if (isNaN(ts)) return false;
  return Date.now() - ts < SESSION_MAX_AGE * 1000;
}
