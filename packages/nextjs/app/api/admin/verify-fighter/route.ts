import { NextResponse } from "next/server";
import { supabase } from "../../../../lib/supabase";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { fighter_id, admin_secret } = body;

    // Validate required fields
    if (!fighter_id || !admin_secret) {
      return NextResponse.json(
        { error: "Missing required fields: fighter_id, admin_secret" },
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
    const { data, error } = await supabase
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
        { error: error.message },
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
      { error: error.message },
      { status: 500 }
    );
  }
}
