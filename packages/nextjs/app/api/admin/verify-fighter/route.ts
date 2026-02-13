import { NextResponse } from "next/server";
import { supabase, freshSupabase } from "../../../../lib/supabase";
import { isAuthorizedAdminRequest } from "../../../../lib/request-auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    if (!isAuthorizedAdminRequest(request.headers)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { fighter_id } = body;

    if (!fighter_id) {
      return NextResponse.json(
        { error: "Missing required field: fighter_id" },
        { status: 400 }
      );
    }

    // Check if fighter exists
    const { data: existingFighter, error: fetchError } = await supabase
      .from("ucf_fighters")
      .select("id, name, verified")
      .eq("id", fighter_id)
      .single();

    if (fetchError || !existingFighter) {
      return NextResponse.json(
        { error: "Fighter not found" },
        { status: 404 }
      );
    }

    if (existingFighter.verified) {
      return NextResponse.json(
        {
          message: "Fighter is already verified",
          fighter_id: existingFighter.id,
          name: existingFighter.name,
          verified: true
        }
      );
    }

    // Update fighter to verified
    const { data, error } = await freshSupabase()
      .from("ucf_fighters")
      .update({
        verified: true,
        updated_at: new Date().toISOString()
      })
      .eq("id", fighter_id)
      .select("id, name, verified")
      .single();

    if (error) {
      return NextResponse.json(
        { error: "Failed to verify fighter" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      message: "Fighter verified successfully",
      fighter_id: data.id,
      name: data.name,
      verified: data.verified
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
