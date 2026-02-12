import { NextRequest, NextResponse } from "next/server";
import { UCF_LORA_MODEL_VERSION, UCF_TRIGGER_WORD } from "../../../../../lib/lora-training";
import { getModelInfo } from "../../../../../lib/image-generator";
import { supabase } from "../../../../../lib/supabase";
import { isAuthorizedAdminRequest } from "../../../../../lib/request-auth";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/lora/status
 *
 * Get current LoRA configuration status and image generation costs
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedAdminRequest(req.headers)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const modelInfo = getModelInfo();

  // Get fighter count to estimate costs
  const { count: fighterCount } = await supabase
    .from("ucf_fighters")
    .select("*", { count: "exact", head: true });

  // Get recent match count (last 24 hours)
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count: recentMatchCount } = await supabase
    .from("ucf_matches")
    .select("*", { count: "exact", head: true })
    .gte("created_at", oneDayAgo);

  // Calculate costs
  const imagesPerFighter = 2; // Profile + Victory pose
  const costPerFighter = imagesPerFighter * modelInfo.costPerImage;

  return NextResponse.json({
    lora_status: {
      configured: modelInfo.loraConfigured,
      model_version: UCF_LORA_MODEL_VERSION || "Not configured",
      trigger_word: UCF_TRIGGER_WORD,
    },

    current_model: {
      name: modelInfo.model,
      cost_per_image: `$${modelInfo.costPerImage.toFixed(3)}`,
    },

    cost_comparison: {
      flux_pro: {
        name: "Flux 1.1 Pro (current fallback)",
        cost_per_image: "$0.040",
        cost_per_fighter: "$0.080",
      },
      flux_dev_lora: {
        name: "Flux Dev with LoRA (after training)",
        cost_per_image: "$0.025",
        cost_per_fighter: "$0.050",
        savings: "37.5% cheaper",
      },
    },

    usage_stats: {
      total_fighters: fighterCount || 0,
      matches_last_24h: recentMatchCount || 0,
      images_per_new_fighter: imagesPerFighter,
    },

    estimated_costs: {
      cost_per_new_fighter: `$${costPerFighter.toFixed(3)}`,
      training_cost: "$1.50 (one-time)",
      break_even_fighters: modelInfo.loraConfigured
        ? "Already using LoRA!"
        : Math.ceil(1.5 / (0.04 - 0.025)) + " fighters",
    },

    next_steps: modelInfo.loraConfigured
      ? [
          "LoRA is configured and active!",
          "All new images will use the trained model",
          `Cost per image: $${modelInfo.costPerImage.toFixed(3)}`,
        ]
      : [
          "1. Generate training images: POST /api/admin/lora/generate-training-images",
          "2. Start training: POST /api/admin/lora/train",
          "3. Update UCF_LORA_MODEL_VERSION in lib/lora-training.ts",
          "4. Redeploy to activate",
        ],

    api_endpoints: {
      status: "GET /api/admin/lora/status (this endpoint)",
      generate_images: "POST /api/admin/lora/generate-training-images",
      train: "POST /api/admin/lora/train",
      check_training: "GET /api/admin/lora/train?training_id=xxx",
    },
  });
}
