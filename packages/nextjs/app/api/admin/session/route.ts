import { NextResponse } from "next/server";
import { isAuthorizedAdminToken } from "~~/lib/request-auth";
import { randomBytes, createHmac } from "node:crypto";

export const dynamic = "force-dynamic";

const SESSION_COOKIE = "ucf_admin_session";
const SESSION_MAX_AGE = 8 * 60 * 60; // 8 hours

// HMAC key — generated once at process start, sessions invalidate on restart
const SESSION_KEY = process.env.ADMIN_SESSION_KEY ?? randomBytes(32).toString("hex");

function signToken(payload: string): string {
  return createHmac("sha256", SESSION_KEY).update(payload).digest("hex");
}

function verifyToken(payload: string, sig: string): boolean {
  const expected = signToken(payload);
  if (expected.length !== sig.length) return false;
  // Constant-time comparison
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  }
  return diff === 0;
}

/** Create a signed session token */
function createSession(): string {
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
  // Check expiry
  const parts = payload.split(":");
  const ts = parseInt(parts[1], 10);
  if (isNaN(ts)) return false;
  return Date.now() - ts < SESSION_MAX_AGE * 1000;
}

/**
 * POST /api/admin/session — Login with admin secret, get httpOnly cookie
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const secret = body.secret;

    if (!isAuthorizedAdminToken(secret)) {
      return NextResponse.json({ error: "Invalid admin secret" }, { status: 401 });
    }

    const token = createSession();
    const res = NextResponse.json({ ok: true });
    res.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: SESSION_MAX_AGE,
      path: "/",
    });
    return res;
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
}

/**
 * DELETE /api/admin/session — Logout, clear cookie
 */
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 0,
    path: "/",
  });
  return res;
}

/**
 * GET /api/admin/session — Check if session is valid
 */
export async function GET(request: Request) {
  const cookie = request.headers.get("cookie") ?? "";
  const match = cookie.match(/ucf_admin_session=([^;]+)/);
  const token = match?.[1];

  if (isValidAdminSession(token)) {
    return NextResponse.json({ authenticated: true });
  }
  return NextResponse.json({ authenticated: false }, { status: 401 });
}
