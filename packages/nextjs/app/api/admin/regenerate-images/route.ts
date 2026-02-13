import { NextResponse } from "next/server";
import { supabase } from "../../../../lib/supabase";
import { generateFighterPortraitPrompt } from "../../../../lib/art-style";
import { storeFighterImage } from "../../../../lib/image-storage";
import { isAuthorizedAdminRequest } from "../../../../lib/request-auth";

export const dynamic = "force-dynamic";

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;

export async function POST(request: Request) {
  try {
    if (!isAuthorizedAdminRequest(request.headers)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { fighter_id } = body;

    if (!REPLICATE_API_TOKEN) {
      return NextResponse.json({ error: "REPLICATE_API_TOKEN not configured" }, { status: 500 });
    }

    // Get fighters needing images (null OR invalid like 'h')
    let query = supabase
      .from("ucf_fighters")
      .select("id, name, robot_metadata");

    if (fighter_id) {
      query = query.eq("id", fighter_id);
    } else {
      // Find fighters with missing or invalid image URLs (null, 'h', or too short to be valid)
      query = query.or("image_url.is.null,image_url.eq.h,image_url.lt.10");
    }

    const { data: fighters, error } = await query;

    if (error) {
      return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }

    if (!fighters || fighters.length === 0) {
      return NextResponse.json({ message: "No fighters need images" });
    }

    const results = [];

    for (const fighter of fighters) {
      const metadata = fighter.robot_metadata as any;

      const fighterDetails = {
        name: fighter.name,
        robotType: metadata?.robot_type,
        chassisDescription: metadata?.chassis_description,
        fistsDescription: metadata?.fists_description,
        colorScheme: metadata?.color_scheme,
        distinguishingFeatures: metadata?.distinguishing_features,
        personality: metadata?.personality,
        fightingStyle: metadata?.fighting_style,
      };

      const prompt = generateFighterPortraitPrompt(fighterDetails);

      // Start image generation
      const response = await fetch("https://api.replicate.com/v1/models/black-forest-labs/flux-1.1-pro/predictions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${REPLICATE_API_TOKEN}`,
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
        results.push({ name: fighter.name, status: "failed", error: "API error" });
        continue;
      }

      const prediction = await response.json();

      // Poll for completion (max 60 seconds)
      let imageUrl = null;
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 2000));

        const statusRes = await fetch(`https://api.replicate.com/v1/predictions/${prediction.id}`, {
          headers: { Authorization: `Bearer ${REPLICATE_API_TOKEN}` },
        });

        const status = await statusRes.json();

        if (status.status === "succeeded" && status.output) {
          // Handle both array and string output formats
          imageUrl = Array.isArray(status.output) ? status.output[0] : status.output;
          break;
        }
        if (status.status === "failed") {
          break;
        }
      }

      if (imageUrl) {
        // Store permanently
        const permanentUrl = await storeFighterImage(fighter.id, imageUrl);
        results.push({ name: fighter.name, status: "success", image_url: permanentUrl || imageUrl });
      } else {
        results.push({ name: fighter.name, status: "timeout" });
      }
    }

    return NextResponse.json({ results });
  } catch (error: any) {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
