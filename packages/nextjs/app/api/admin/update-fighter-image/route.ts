import { NextResponse } from "next/server";
import { freshSupabase } from "../../../../lib/supabase";
import { isAuthorizedAdminRequest } from "../../../../lib/request-auth";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/update-fighter-image
 * Update a fighter's image URL (admin only)
 */
export async function POST(request: Request) {
  try {
    if (!isAuthorizedAdminRequest(request.headers)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { fighter_id, image_url } = body;

    if (!fighter_id || !image_url) {
      return NextResponse.json(
        { error: "Missing required fields: fighter_id, image_url" },
        { status: 400 }
      );
    }

    // Update fighter image
    const { data, error } = await freshSupabase()
      .from("ucf_fighters")
      .update({ image_url })
      .eq("id", fighter_id)
      .select("id, name, image_url")
      .single();

    if (error) {
      return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      message: "Fighter image updated",
      fighter: data,
    });
  } catch (error: any) {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
