import { NextRequest, NextResponse } from "next/server";
import { freshSupabase } from "../../../../lib/supabase";
import { generateVictoryPosePrompt, generateFighterPortraitPrompt } from "../../../../lib/art-style";
import { storeImagePermanently } from "../../../../lib/image-storage";

export const dynamic = "force-dynamic";
export const maxDuration = 120; // 2 min per fighter is plenty

/**
 * POST /api/admin/generate-victory-poses
 *
 * Generates victory poses (and optionally PFPs) for fighters who don't have them.
 *
 * Auth: x-admin-key header OR admin_secret in body (accepts ADMIN_API_KEY or ADMIN_SECRET env vars)
 *
 * Optional query params:
 *   ?fighter_id=xxx  — Generate for a specific fighter only
 *   ?type=pfp        — Generate PFP instead of victory pose
 *   ?type=both       — Generate both PFP and victory pose
 */
export async function POST(req: NextRequest) {
  const supabase = freshSupabase();

  // Auth check - accept ADMIN_API_KEY or ADMIN_SECRET
  const adminKeyHeader = req.headers.get("x-admin-key");
  let body: any = {};
  try { body = await req.json(); } catch { /* empty body is ok */ }
  const adminSecretBody = body?.admin_secret;

  const validKeys = [process.env.ADMIN_API_KEY, process.env.ADMIN_SECRET].filter(Boolean);
  const providedKey = adminKeyHeader || adminSecretBody;

  if (!providedKey || !validKeys.includes(providedKey)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Accept token from body (for backfill) or env
  const REPLICATE_API_TOKEN = body?.replicate_token || process.env.REPLICATE_API_TOKEN;
  if (!REPLICATE_API_TOKEN) {
    return NextResponse.json({ error: "REPLICATE_API_TOKEN not configured" }, { status: 500 });
  }

  const { searchParams } = new URL(req.url);
  const specificFighterId = searchParams.get("fighter_id");
  const genType = searchParams.get("type") || "victory"; // "victory", "pfp", or "both"

  // Find fighters needing images
  let query = supabase
    .from("ucf_fighters")
    .select("id, name, robot_metadata, image_url, victory_pose_url");

  if (specificFighterId) {
    query = query.eq("id", specificFighterId);
  } else if (genType === "pfp") {
    query = query.is("image_url", null);
  } else if (genType === "both") {
    query = query.or("image_url.is.null,victory_pose_url.is.null");
  } else {
    query = query.is("victory_pose_url", null);
  }

  const { data: fighters, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!fighters || fighters.length === 0) {
    return NextResponse.json({ message: "All fighters already have the requested images", count: 0 });
  }

  // Process ONE fighter per request to avoid timeout
  // If no specific fighter_id, just process the first one
  const fighter = specificFighterId ? fighters[0] : fighters[0];
  const robotMetadata = fighter.robot_metadata || {};
  const fighterDetails = {
    name: fighter.name,
    robotType: robotMetadata.robot_type,
    chassisDescription: robotMetadata.chassis_description,
    fistsDescription: robotMetadata.fists_description,
    colorScheme: robotMetadata.color_scheme,
    distinguishingFeatures: robotMetadata.distinguishing_features,
    personality: robotMetadata.personality,
    fightingStyle: robotMetadata.fighting_style,
  };

  const results: { type: string; status: string; url?: string }[] = [];

  // Generate victory pose if needed
  if ((genType === "victory" || genType === "both") && !fighter.victory_pose_url) {
    const result = await generateImage(
      REPLICATE_API_TOKEN,
      generateVictoryPosePrompt(fighterDetails),
      `fighters/${fighter.id}-victory.png`,
      fighter.id,
      "victory_pose_url",
      supabase
    );
    results.push({ type: "victory_pose", ...result });
  }

  // Generate PFP if needed
  if ((genType === "pfp" || genType === "both") && !fighter.image_url) {
    const result = await generateImage(
      REPLICATE_API_TOKEN,
      generateFighterPortraitPrompt(fighterDetails),
      `fighters/${fighter.id}.png`,
      fighter.id,
      "image_url",
      supabase
    );
    results.push({ type: "pfp", ...result });
  }

  return NextResponse.json({
    fighter_id: fighter.id,
    fighter_name: fighter.name,
    results,
    remaining: fighters.length - 1,
    hint: fighters.length > 1
      ? `${fighters.length - 1} more fighters need images. Call again to process the next one.`
      : "All done!",
  });
}

/**
 * Generate a single image via Replicate, store permanently, update DB
 */
async function generateImage(
  replicateToken: string,
  prompt: string,
  storagePath: string,
  fighterId: string,
  dbColumn: string,
  supabase: ReturnType<typeof freshSupabase>
): Promise<{ status: string; url?: string }> {
  try {
    // Start generation
    const response = await fetch("https://api.replicate.com/v1/models/black-forest-labs/flux-1.1-pro/predictions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${replicateToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: {
          prompt,
          aspect_ratio: "1:1",
          output_format: "png",
          output_quality: 100,
          safety_tolerance: 5,
          prompt_upsampling: true,
        },
      }),
    });

    if (!response.ok) {
      return { status: "failed_to_start" };
    }

    const prediction = await response.json();
    console.log(`[ImageGen] Started ${dbColumn} for ${fighterId}: ${prediction.id}`);

    // Poll for completion (max 60s)
    for (let i = 0; i < 30; i++) {
      await new Promise(resolve => setTimeout(resolve, 2000));

      const statusRes = await fetch(
        `https://api.replicate.com/v1/predictions/${prediction.id}`,
        { headers: { "Authorization": `Bearer ${replicateToken}` } }
      );
      if (!statusRes.ok) continue;

      const status = await statusRes.json();

      if (status.status === "succeeded" && status.output) {
        const tempUrl = Array.isArray(status.output) ? status.output[0] : status.output;

        // Try permanent storage
        const permanentUrl = await storeImagePermanently(tempUrl, storagePath);
        const finalUrl = permanentUrl || tempUrl;

        // Update DB
        await supabase
          .from("ucf_fighters")
          .update({ [dbColumn]: finalUrl })
          .eq("id", fighterId);

        console.log(`[ImageGen] ${dbColumn} for ${fighterId}: ${finalUrl}`);
        return { status: permanentUrl ? "success" : "success_temp_url", url: finalUrl };
      }

      if (status.status === "failed") {
        return { status: "generation_failed" };
      }
    }

    return { status: "timeout" };
  } catch (err: any) {
    console.error(`[ImageGen] Error:`, err);
    return { status: "error" };
  }
}

export async function GET(req: NextRequest) {
  const supabase = freshSupabase();

  const { data: needPoses } = await supabase
    .from("ucf_fighters")
    .select("id, name, image_url, victory_pose_url")
    .or("image_url.is.null,victory_pose_url.is.null");

  const { data: complete } = await supabase
    .from("ucf_fighters")
    .select("id, name")
    .not("victory_pose_url", "is", null)
    .not("image_url", "is", null);

  return NextResponse.json({
    need_images: needPoses?.length || 0,
    complete: complete?.length || 0,
    fighters_needing_images: needPoses?.map(f => ({
      id: f.id,
      name: f.name,
      needs_pfp: !f.image_url,
      needs_victory_pose: !f.victory_pose_url,
    })) || [],
  });
}
