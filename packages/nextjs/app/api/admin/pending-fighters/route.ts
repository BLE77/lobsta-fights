// @ts-nocheck
import { NextResponse } from "next/server";
import { supabase } from "../../../../lib/supabase";
import { isAuthorizedAdminRequest } from "../../../../lib/request-auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    if (!isAuthorizedAdminRequest(request.headers)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Fetch pending (unverified) fighters
    const { data, error } = await supabase
      .from("ucf_fighters")
      .select("id, name, wallet_address, webhook_url, created_at")
      .eq("verified", false)
      .order("created_at", { ascending: false });

    if (error) {
      return NextResponse.json(
        { error: "Failed to fetch pending fighters" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      pending_fighters: data,
      count: data?.length || 0
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
