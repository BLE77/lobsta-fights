/**
 * UCF Image Generator
 *
 * Unified image generation that automatically uses the trained LoRA model
 * when available, otherwise falls back to Flux 1.1 Pro.
 *
 * Cost comparison:
 * - Flux 1.1 Pro: $0.04/image
 * - Flux Dev with LoRA: ~$0.025/image (37% cheaper!)
 */

import { UCF_LORA_MODEL_VERSION, UCF_TRIGGER_WORD } from "./lora-training";

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;

export interface GenerateImageOptions {
  prompt: string;
  aspectRatio?: "1:1" | "16:9" | "9:16" | "4:3" | "3:4";
  quality?: number;
}

export interface GenerateImageResult {
  success: boolean;
  imageUrl?: string;
  error?: string;
  model: "lora" | "flux-pro";
  cost: number;
}

/**
 * Generate an image using the best available model
 * Uses trained LoRA if available, otherwise Flux 1.1 Pro
 */
export async function generateImage(options: GenerateImageOptions): Promise<GenerateImageResult> {
  if (!REPLICATE_API_TOKEN) {
    return {
      success: false,
      error: "REPLICATE_API_TOKEN not configured",
      model: "flux-pro",
      cost: 0,
    };
  }

  // Try LoRA first if configured
  if (UCF_LORA_MODEL_VERSION) {
    const result = await generateWithLora(options);
    if (result.success) {
      return result;
    }
    console.warn(`[ImageGen] LoRA generation failed, falling back to Flux Pro: ${result.error}`);
  }

  // Fall back to Flux 1.1 Pro
  return generateWithFluxPro(options);
}

/**
 * Generate with trained LoRA model
 */
async function generateWithLora(options: GenerateImageOptions): Promise<GenerateImageResult> {
  const { prompt, aspectRatio = "1:1" } = options;

  // Prepend trigger word if not present
  const fullPrompt = prompt.includes(UCF_TRIGGER_WORD)
    ? prompt
    : `${UCF_TRIGGER_WORD} ${prompt}`;

  try {
    const response = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${REPLICATE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version: UCF_LORA_MODEL_VERSION,
        input: {
          prompt: fullPrompt,
          aspect_ratio: aspectRatio,
          output_format: "png",
          num_outputs: 1,
          guidance_scale: 3.5,
          num_inference_steps: 28,
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        success: false,
        error: `LoRA request failed: ${response.status} - ${errorText}`,
        model: "lora",
        cost: 0,
      };
    }

    const prediction = await response.json();
    const imageUrl = await pollForResult(prediction.id);

    if (imageUrl) {
      return {
        success: true,
        imageUrl,
        model: "lora",
        cost: 0.025, // Flux Dev with LoRA cost
      };
    }

    return {
      success: false,
      error: "LoRA generation timed out",
      model: "lora",
      cost: 0,
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message,
      model: "lora",
      cost: 0,
    };
  }
}

/**
 * Generate with Flux 1.1 Pro (fallback)
 */
async function generateWithFluxPro(options: GenerateImageOptions): Promise<GenerateImageResult> {
  const { prompt, aspectRatio = "1:1", quality = 100 } = options;

  try {
    const response = await fetch(
      "https://api.replicate.com/v1/models/black-forest-labs/flux-1.1-pro/predictions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${REPLICATE_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          input: {
            prompt,
            aspect_ratio: aspectRatio,
            output_format: "png",
            output_quality: quality,
            safety_tolerance: 5,
            prompt_upsampling: true,
          },
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      return {
        success: false,
        error: `Flux Pro request failed: ${response.status} - ${errorText}`,
        model: "flux-pro",
        cost: 0,
      };
    }

    const prediction = await response.json();
    const imageUrl = await pollForResult(prediction.id);

    if (imageUrl) {
      return {
        success: true,
        imageUrl,
        model: "flux-pro",
        cost: 0.04, // Flux 1.1 Pro cost
      };
    }

    return {
      success: false,
      error: "Flux Pro generation timed out",
      model: "flux-pro",
      cost: 0,
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message,
      model: "flux-pro",
      cost: 0,
    };
  }
}

/**
 * Poll Replicate for prediction result
 */
async function pollForResult(predictionId: string, maxAttempts: number = 60): Promise<string | null> {
  let attempts = 0;

  while (attempts < maxAttempts) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    attempts++;

    try {
      const response = await fetch(
        `https://api.replicate.com/v1/predictions/${predictionId}`,
        {
          headers: { Authorization: `Bearer ${REPLICATE_API_TOKEN}` },
        }
      );

      if (!response.ok) continue;

      const status = await response.json();

      if (status.status === "succeeded" && status.output) {
        return Array.isArray(status.output) ? status.output[0] : status.output;
      }

      if (status.status === "failed") {
        console.error(`[ImageGen] Generation failed: ${status.error}`);
        return null;
      }
    } catch (err) {
      // Continue polling
    }
  }

  return null;
}

/**
 * Check if LoRA model is configured and available
 */
export function isLoraConfigured(): boolean {
  return !!UCF_LORA_MODEL_VERSION;
}

/**
 * Get current model info
 */
export function getModelInfo(): {
  model: string;
  costPerImage: number;
  loraConfigured: boolean;
} {
  if (UCF_LORA_MODEL_VERSION) {
    return {
      model: `LoRA: ${UCF_LORA_MODEL_VERSION.substring(0, 20)}...`,
      costPerImage: 0.025,
      loraConfigured: true,
    };
  }

  return {
    model: "Flux 1.1 Pro",
    costPerImage: 0.04,
    loraConfigured: false,
  };
}
