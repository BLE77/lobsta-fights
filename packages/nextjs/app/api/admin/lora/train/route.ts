import { NextRequest, NextResponse } from "next/server";
import { startLoraTraining, checkTrainingStatus, UCF_TRIGGER_WORD } from "../../../../../lib/lora-training";
import { supabase } from "../../../../../lib/supabase";

/**
 * POST /api/admin/lora/train
 *
 * Start LoRA training with provided image URLs.
 *
 * Body:
 * {
 *   "images": ["url1", "url2", ...],  // At least 10 images recommended
 *   "steps": 1000,                     // Training steps (default: 1000)
 *   "lora_rank": 16                    // LoRA rank (default: 16)
 * }
 *
 * Cost: ~$1.50 for 1000 steps
 * Time: ~2 minutes
 */
export async function POST(req: NextRequest) {
  const adminKey = req.headers.get("x-admin-key");
  if (adminKey !== process.env.ADMIN_API_KEY && adminKey !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { images, steps = 1000, lora_rank = 16 } = body;

    if (!images || !Array.isArray(images)) {
      return NextResponse.json(
        {
          error: "Missing 'images' array in request body",
          example: {
            images: ["https://...", "https://..."],
            steps: 1000,
            lora_rank: 16,
          },
        },
        { status: 400 }
      );
    }

    if (images.length < 5) {
      return NextResponse.json(
        {
          error: `Need at least 5 images for training, got ${images.length}`,
          recommendation: "10-20 images recommended for best results",
        },
        { status: 400 }
      );
    }

    console.log(`[LoRA] Starting training with ${images.length} images, ${steps} steps...`);

    const result = await startLoraTraining(images, {
      triggerWord: UCF_TRIGGER_WORD,
      steps,
      loraRank: lora_rank,
    });

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    // Store training info for later reference
    // You could save this to Supabase if you want to track training history

    return NextResponse.json({
      success: true,
      message: "LoRA training started!",
      training_id: result.trainingId,
      trigger_word: UCF_TRIGGER_WORD,
      config: {
        images: images.length,
        steps,
        lora_rank,
      },
      cost_estimate: "$1.50",
      time_estimate: "~2 minutes",
      next_step: `GET /api/admin/lora/train?training_id=${result.trainingId} to check status`,
      important: "When training completes, update UCF_LORA_MODEL_VERSION in lib/lora-training.ts with the model version",
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

/**
 * GET /api/admin/lora/train?training_id=xxx
 *
 * Check the status of a LoRA training job
 */
export async function GET(req: NextRequest) {
  const adminKey = req.headers.get("x-admin-key");
  if (adminKey !== process.env.ADMIN_API_KEY && adminKey !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const trainingId = searchParams.get("training_id");

  if (!trainingId) {
    return NextResponse.json({
      description: "Start or check LoRA training for UCF style",
      endpoints: {
        POST: {
          description: "Start a new training",
          body: {
            images: ["array of image URLs (10-20 recommended)"],
            steps: "Training steps (default: 1000)",
            lora_rank: "LoRA rank (default: 16)",
          },
          cost: "~$1.50 for 1000 steps",
        },
        GET: {
          description: "Check training status",
          params: {
            training_id: "The training ID returned from POST",
          },
        },
      },
      trigger_word: UCF_TRIGGER_WORD,
      workflow: [
        "1. Generate training images: POST /api/admin/lora/generate-training-images",
        "2. Start training: POST /api/admin/lora/train with image URLs",
        "3. Check status: GET /api/admin/lora/train?training_id=xxx",
        "4. When complete, update UCF_LORA_MODEL_VERSION in lib/lora-training.ts",
        "5. All future image generation will use the LoRA model",
      ],
    });
  }

  const status = await checkTrainingStatus(trainingId);

  const response: any = {
    training_id: trainingId,
    status: status.status,
  };

  if (status.progress !== undefined) {
    response.progress = `${status.progress}%`;
  }

  if (status.status === "succeeded" && status.model_version) {
    response.model_version = status.model_version;
    response.message = "Training complete!";
    response.next_step = `Update UCF_LORA_MODEL_VERSION in lib/lora-training.ts to: "${status.model_version}"`;
    response.important = "After updating, redeploy to use the new model for all image generation";
  } else if (status.status === "failed") {
    response.error = status.error;
  } else if (status.status === "processing") {
    response.message = "Training in progress...";
  }

  return NextResponse.json(response);
}
