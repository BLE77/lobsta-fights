import { NextRequest, NextResponse } from "next/server";
import { freshSupabase } from "../../../../lib/supabase";
import { storeImagePermanently } from "../../../../lib/image-storage";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * POST /api/admin/persist-images
 *
 * Migrates temporary Replicate URLs to permanent Supabase Storage.
 * Processes one fighter per request to avoid timeout.
 */
export async function POST(req: NextRequest) {
  const backfillToken = req.headers.get("x-backfill-token");
  if (backfillToken !== "ucf-victory-pose-backfill-2026") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = freshSupabase();

  // Find fighters with temp URLs (replicate.delivery)
  const { data: fighters, error } = await supabase
    .from("ucf_fighters")
    .select("id, name, image_url, victory_pose_url")
    .or("image_url.like.%replicate.delivery%,victory_pose_url.like.%replicate.delivery%")
    .limit(1); // One at a time

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!fighters || fighters.length === 0) {
    return NextResponse.json({ message: "All images are already permanent!", remaining: 0 });
  }

  const fighter = fighters[0];
  const results: { field: string; status: string; url?: string }[] = [];

  // Persist victory pose
  if (fighter.victory_pose_url?.includes("replicate.delivery")) {
    const path = `fighters/${fighter.id}-victory.png`;
    const permanentUrl = await storeImagePermanently(fighter.victory_pose_url, path);
    if (permanentUrl) {
      await supabase
        .from("ucf_fighters")
        .update({ victory_pose_url: permanentUrl })
        .eq("id", fighter.id);
      results.push({ field: "victory_pose_url", status: "persisted", url: permanentUrl });
    } else {
      results.push({ field: "victory_pose_url", status: "storage_failed" });
    }
  }

  // Persist PFP
  if (fighter.image_url?.includes("replicate.delivery")) {
    const path = `fighters/${fighter.id}.png`;
    const permanentUrl = await storeImagePermanently(fighter.image_url, path);
    if (permanentUrl) {
      await supabase
        .from("ucf_fighters")
        .update({ image_url: permanentUrl })
        .eq("id", fighter.id);
      results.push({ field: "image_url", status: "persisted", url: permanentUrl });
    } else {
      results.push({ field: "image_url", status: "storage_failed" });
    }
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
