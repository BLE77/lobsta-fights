import { NextResponse } from "next/server";
import { isAuthorizedAdminToken } from "~~/lib/request-auth";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE,
  createSession,
  isValidAdminSession,
} from "~~/lib/admin-session";

export const dynamic = "force-dynamic";

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
