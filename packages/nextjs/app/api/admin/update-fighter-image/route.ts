import { NextResponse } from "next/server";
import { supabase } from "../../../../lib/supabase";

/**
 * POST /api/admin/update-fighter-image
 * Update a fighter's image URL (admin only)
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { fighter_id, image_url, admin_secret } = body;

    if (!fighter_id || !image_url || !admin_secret) {
      return NextResponse.json(
        { error: "Missing required fields: fighter_id, image_url, admin_secret" },
        { status: 400 }
      );
    }

    // Verify admin secret
    if (admin_secret !== process.env.ADMIN_SECRET) {
      return NextResponse.json({ error: "Invalid admin secret" }, { status: 401 });
    }

    // Update fighter image
    const { data, error } = await supabase
      .from("ucf_fighters")
      .update({ image_url })
      .eq("id", fighter_id)
      .select("id, name, image_url")
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      message: "Fighter image updated",
      fighter: data,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
