import { NextRequest, NextResponse } from "next/server";
import { generateTrainingImages, TRAINING_IMAGE_PROMPTS } from "../../../../../lib/lora-training";
import { storeImagePermanently } from "../../../../../lib/image-storage";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/lora/generate-training-images
 *
 * Generates training images for the UCF LoRA model.
 * These images will be used to train a consistent art style.
 *
 * Query params:
 * - count: Number of images to generate (default: 20, max: 30)
 * - store: Whether to store images permanently in Supabase (default: true)
 *
 * Cost: ~$0.04 per image = ~$0.80 for 20 images
 */
export async function POST(req: NextRequest) {
  const adminKey = req.headers.get("x-admin-key");
  if (adminKey !== process.env.ADMIN_API_KEY && adminKey !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const count = Math.min(parseInt(searchParams.get("count") || "20"), 30);
  const shouldStore = searchParams.get("store") !== "false";

  console.log(`[LoRA] Starting generation of ${count} training images...`);

  const result = await generateTrainingImages(count);

  // Optionally store images permanently
  let storedUrls: string[] = [];
  if (shouldStore && result.images.length > 0) {
    console.log(`[LoRA] Storing ${result.images.length} images permanently...`);

    for (let i = 0; i < result.images.length; i++) {
      const tempUrl = result.images[i];
      const path = `lora-training/ucf-style-${Date.now()}-${i}.png`;

      const permanentUrl = await storeImagePermanently(tempUrl, path);
      if (permanentUrl) {
        storedUrls.push(permanentUrl);
      } else {
        // Keep temp URL if storage fails
        storedUrls.push(tempUrl);
      }
    }
  } else {
    storedUrls = result.images;
  }

  return NextResponse.json({
    success: result.success,
    message: `Generated ${result.images.length}/${count} training images`,
    images: storedUrls,
    temp_images: result.images, // Original Replicate URLs (expire in 1 hour)
    errors: result.errors,
    cost_estimate: `$${(result.images.length * 0.04).toFixed(2)}`,
    next_step: result.images.length >= 10
      ? "POST /api/admin/lora/train with these image URLs to start training"
      : "Generate more images - need at least 10 for good results",
  });
}

/**
 * GET /api/admin/lora/generate-training-images
 *
 * Returns info about the training image generation process
 */
export async function GET(req: NextRequest) {
  return NextResponse.json({
    description: "Generate training images for UCF LoRA model",
    method: "POST",
    headers: {
      "x-admin-key": "Your ADMIN_API_KEY or ADMIN_SECRET",
    },
    query_params: {
      count: "Number of images to generate (default: 20, max: 30)",
      store: "Whether to store permanently (default: true)",
    },
    cost: "$0.04 per image using Flux 1.1 Pro",
    recommended: "Generate 15-20 diverse images for best results",
    prompts_available: TRAINING_IMAGE_PROMPTS.length,
    prompt_themes: [
      "Heavy Brawlers (industrial, tank-like)",
      "Speed Fighters (sleek, agile)",
      "Themed (samurai, viking, dragon, steampunk)",
      "Tech/Cyber (holographic, glitch)",
      "Classic Archetypes (gladiator, street brawler, golem)",
      "Unique (insectoid, cosmic)",
    ],
  });
}
