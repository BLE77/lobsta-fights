import { NextResponse } from "next/server";
import { supabase } from "../../../../lib/supabase";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const admin_secret = searchParams.get("admin_secret");

    // Validate admin secret
    if (!admin_secret) {
      return NextResponse.json(
        { error: "Missing required query parameter: admin_secret" },
        { status: 400 }
      );
    }

    // Verify admin secret
    const expectedSecret = process.env.ADMIN_SECRET;
    if (!expectedSecret) {
      return NextResponse.json(
        { error: "Admin secret not configured on server" },
        { status: 500 }
      );
    }

    if (admin_secret !== expectedSecret) {
      return NextResponse.json(
        { error: "Invalid admin secret" },
        { status: 401 }
      );
    }

    // Fetch pending (unverified) fighters
    const { data, error } = await supabase
      .from("ucf_fighters")
      .select("id, name, wallet_address, webhook_url, created_at")
      .eq("verified", false)
      .order("created_at", { ascending: false });

    if (error) {
      return NextResponse.json(
        { error: error.message },
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
      { error: error.message },
      { status: 500 }
    );
  }
}
