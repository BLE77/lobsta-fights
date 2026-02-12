import { NextRequest, NextResponse } from "next/server";
import { freshSupabase } from "../../../../lib/supabase";
import { isAuthorizedAdminToken } from "../../../../lib/request-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * POST /api/admin/persist-images
 *
 * Migrates temporary Replicate URLs to permanent Supabase Storage.
 * Processes one fighter per request to avoid timeout.
 */
export async function POST(req: NextRequest) {
  const adminKey =
    req.headers.get("x-admin-secret") ??
    req.headers.get("x-admin-key") ??
    req.headers.get("x-backfill-token");
  if (!isAuthorizedAdminToken(adminKey)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = freshSupabase();
  // Use regular client - images bucket allows public uploads
  const storageClient = supabase;

  // Find fighters with temp URLs (replicate.delivery)
  const { data: fighters, error } = await supabase
    .from("ucf_fighters")
    .select("id, name, image_url, victory_pose_url")
    .or("image_url.like.%replicate.delivery%,victory_pose_url.like.%replicate.delivery%")
    .limit(1);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!fighters || fighters.length === 0) {
    return NextResponse.json({ message: "All images are already permanent!", remaining: 0 });
  }

  const fighter = fighters[0];
  const results: any[] = [];

  // Helper to persist one image
  async function persistImage(tempUrl: string, storagePath: string, dbColumn: string) {
    try {
      // Download
      const dlResponse = await fetch(tempUrl);
      if (!dlResponse.ok) {
        return { field: dbColumn, status: "download_failed", error: `HTTP ${dlResponse.status}` };
      }

      const imageBlob = await dlResponse.blob();
      const arrayBuffer = await imageBlob.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      // Upload to Supabase Storage
      const { data, error: uploadError } = await (storageClient as any).storage
        .from("images")
        .upload(storagePath, buffer, {
          contentType: "image/png",
          upsert: true,
        });

      if (uploadError) {
        return { field: dbColumn, status: "upload_failed", error: uploadError.message };
      }

      // Build permanent URL
      const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const permanentUrl = `${SUPABASE_URL}/storage/v1/object/public/images/${storagePath}`;

      // Update DB
      await supabase
        .from("ucf_fighters")
        .update({ [dbColumn]: permanentUrl })
        .eq("id", fighter.id);

      return { field: dbColumn, status: "success", url: permanentUrl };
    } catch (err: any) {
      return { field: dbColumn, status: "error", error: err.message };
    }
  }

  // Persist victory pose
  if (fighter.victory_pose_url?.includes("replicate.delivery")) {
    const result = await persistImage(
      fighter.victory_pose_url,
      `fighters/${fighter.id}-victory.png`,
      "victory_pose_url"
    );
    results.push(result);
  }

  // Persist PFP
  if (fighter.image_url?.includes("replicate.delivery")) {
    const result = await persistImage(
      fighter.image_url,
      `fighters/${fighter.id}.png`,
      "image_url"
    );
    results.push(result);
  }

  // Check remaining
  const { data: remaining } = await supabase
    .from("ucf_fighters")
    .select("id")
    .or("image_url.like.%replicate.delivery%,victory_pose_url.like.%replicate.delivery%");

  return NextResponse.json({
    fighter_id: fighter.id,
    fighter_name: fighter.name,
    results,
    remaining: remaining?.length || 0,
  });
}
