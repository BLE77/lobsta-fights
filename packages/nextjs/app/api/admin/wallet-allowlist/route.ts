import { NextResponse } from "next/server";
import { freshSupabase } from "~~/lib/supabase";
import { isAuthorizedAdminRequest } from "~~/lib/request-auth";
import {
  listWalletAllowlistEntries,
  normalizeTrustedWalletAddress,
  removeWalletAllowlistEntry,
  upsertWalletAllowlistEntry,
} from "~~/lib/wallet-trust";

export const dynamic = "force-dynamic";

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

export async function GET(request: Request) {
  if (!isAuthorizedAdminRequest(request.headers)) return unauthorized();

  const entries = await listWalletAllowlistEntries();
  return NextResponse.json({
    success: true,
    entries,
    count: entries.length,
  });
}

export async function POST(request: Request) {
  if (!isAuthorizedAdminRequest(request.headers)) return unauthorized();

  let body: {
    wallet_address?: string;
    label?: string;
    notes?: string;
    verify_existing?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const walletAddress = normalizeTrustedWalletAddress(body.wallet_address);
  if (!walletAddress) {
    return NextResponse.json({ error: "Invalid wallet_address" }, { status: 400 });
  }

  const entry = await upsertWalletAllowlistEntry({
    walletAddress,
    label: typeof body.label === "string" ? body.label.trim() || null : null,
    notes: typeof body.notes === "string" ? body.notes.trim() || null : null,
    approvedBy: "admin",
    source: "manual_allowlist",
    active: true,
  });

  let affectedFighters = 0;
  if (body.verify_existing !== false) {
    const { data, error } = await freshSupabase()
      .from("ucf_fighters")
      .update({
        verified: true,
        updated_at: new Date().toISOString(),
      })
      .eq("wallet_address", walletAddress)
      .eq("verified", false)
      .select("id");

    if (error) {
      return NextResponse.json(
        { error: `Allowlist saved, but failed to verify existing fighters: ${error.message}` },
        { status: 500 },
      );
    }
    affectedFighters = Array.isArray(data) ? data.length : 0;
  }

  return NextResponse.json({
    success: true,
    entry,
    affected_fighters: affectedFighters,
  });
}

export async function DELETE(request: Request) {
  if (!isAuthorizedAdminRequest(request.headers)) return unauthorized();

  const url = new URL(request.url);
  const walletAddress = normalizeTrustedWalletAddress(url.searchParams.get("wallet_address"));
  if (!walletAddress) {
    return NextResponse.json({ error: "Missing wallet_address query param" }, { status: 400 });
  }

  const removed = await removeWalletAllowlistEntry(walletAddress);
  if (!removed) {
    return NextResponse.json({ error: "Wallet not found in allowlist" }, { status: 404 });
  }

  return NextResponse.json({
    success: true,
    wallet_address: walletAddress,
  });
}
