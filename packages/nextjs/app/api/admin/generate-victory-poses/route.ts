import { NextRequest, NextResponse } from "next/server";
import { supabase } from "../../../../lib/supabase";
import { generateVictoryPosePrompt } from "../../../../lib/art-style";
import { storeImagePermanently } from "../../../../lib/image-storage";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/generate-victory-poses
 *
 * Generates victory poses for all existing fighters who don't have one.
 * This is a one-time migration endpoint to backfill victory poses for
 * fighters registered before the feature was added.
 *
 * Requires admin API key in header.
 */
export async function POST(req: NextRequest) {
  // Simple admin check - in production you'd want proper auth
  const adminKey = req.headers.get("x-admin-key");
  if (adminKey !== process.env.ADMIN_API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
  if (!REPLICATE_API_TOKEN) {
    return NextResponse.json({ error: "REPLICATE_API_TOKEN not configured" }, { status: 500 });
  }

  // Find fighters without victory poses
  const { data: fighters, error } = await supabase
    .from("ucf_fighters")
    .select("id, name, robot_metadata, victory_pose_url")
    .is("victory_pose_url", null);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!fighters || fighters.length === 0) {
    return NextResponse.json({ message: "All fighters already have victory poses", count: 0 });
  }

  console.log(`[VictoryPose] Starting generation for ${fighters.length} fighters...`);

  const results: { id: string; name: string; status: string; url?: string }[] = [];

  // Process each fighter sequentially to avoid rate limits
  for (const fighter of fighters) {
    try {
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

      const prompt = generateVictoryPosePrompt(fighterDetails);
      console.log(`[VictoryPose] Generating for ${fighter.name} (${fighter.id})...`);

      // Start image generation
      const response = await fetch("https://api.replicate.com/v1/models/black-forest-labs/flux-1.1-pro/predictions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${REPLICATE_API_TOKEN}`,
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
        const errorText = await response.text();
        console.error(`[VictoryPose] Failed to start for ${fighter.name}: ${response.status}`);
        results.push({ id: fighter.id, name: fighter.name, status: "failed_to_start" });
        continue;
      }

      const prediction = await response.json();

      // Poll for completion
      let attempts = 0;
      const maxAttempts = 30;
      let succeeded = false;

      while (attempts < maxAttempts && !succeeded) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        attempts++;

        const statusRes = await fetch(
          `https://api.replicate.com/v1/predictions/${prediction.id}`,
          { headers: { "Authorization": `Bearer ${REPLICATE_API_TOKEN}` } }
        );

        if (!statusRes.ok) continue;

        const status = await statusRes.json();

        if (status.status === "succeeded" && status.output) {
          const tempImageUrl = Array.isArray(status.output) ? status.output[0] : status.output;

          // Store permanently
          const path = `fighters/${fighter.id}-victory.png`;
          const permanentUrl = await storeImagePermanently(tempImageUrl, path);

          if (permanentUrl) {
            // Update fighter
            await supabase
              .from("ucf_fighters")
              .update({ victory_pose_url: permanentUrl })
              .eq("id", fighter.id);

            console.log(`[VictoryPose] Success for ${fighter.name}: ${permanentUrl}`);
            results.push({ id: fighter.id, name: fighter.name, status: "success", url: permanentUrl });
          } else {
            // Use temp URL as fallback
            await supabase
              .from("ucf_fighters")
              .update({ victory_pose_url: tempImageUrl })
              .eq("id", fighter.id);

            results.push({ id: fighter.id, name: fighter.name, status: "success_temp_url", url: tempImageUrl });
          }

          succeeded = true;
        }

        if (status.status === "failed") {
          console.error(`[VictoryPose] Generation failed for ${fighter.name}:`, status.error);
          results.push({ id: fighter.id, name: fighter.name, status: "generation_failed" });
          break;
        }
      }

      if (!succeeded && attempts >= maxAttempts) {
        results.push({ id: fighter.id, name: fighter.name, status: "timeout" });
      }

      // Small delay between fighters to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));

    } catch (err: any) {
      console.error(`[VictoryPose] Error for ${fighter.name}:`, err);
      results.push({ id: fighter.id, name: fighter.name, status: "error", url: err.message });
    }
  }

  const successCount = results.filter(r => r.status.startsWith("success")).length;

  return NextResponse.json({
    message: `Generated victory poses for ${successCount}/${fighters.length} fighters`,
    total: fighters.length,
    success: successCount,
    results,
  });
}

export async function GET(req: NextRequest) {
  // Check how many fighters need victory poses
  const { data: needPoses, error: countError } = await supabase
    .from("ucf_fighters")
    .select("id, name")
    .is("victory_pose_url", null);

  const { data: havePoses } = await supabase
    .from("ucf_fighters")
    .select("id, name")
    .not("victory_pose_url", "is", null);

  return NextResponse.json({
    need_victory_poses: needPoses?.length || 0,
    have_victory_poses: havePoses?.length || 0,
    fighters_needing_poses: needPoses?.map(f => ({ id: f.id, name: f.name })) || [],
  });
}
