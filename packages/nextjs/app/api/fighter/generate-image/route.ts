import { NextRequest, NextResponse } from "next/server";
import {
  generateFighterPortraitPrompt,
  UCF_NEGATIVE_PROMPT,
  buildReplicateRequest,
  type FighterDetails,
} from "../../../../lib/art-style";

/**
 * Generate robot fighter image using the UCF Master Art Style
 *
 * Uses Flux 1.1 Pro via Replicate (~$0.04 per image) - HIGH QUALITY
 * All images follow the centralized art style defined in lib/art-style.ts
 */

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;

export async function POST(req: NextRequest) {
  try {
    if (!REPLICATE_API_TOKEN) {
      return NextResponse.json(
        { error: "Image generation not configured. Add REPLICATE_API_TOKEN to environment." },
        { status: 500 }
      );
    }

    const body = await req.json();
    const {
      robotName,
      appearance,
      specialMove,
      // New structured fields (preferred)
      robotType,
      chassisDescription,
      fistsDescription,
      colorScheme,
      distinguishingFeatures,
      personality,
      fightingStyle,
    } = body;

    // Build fighter details from either new structured format or legacy format
    const fighterDetails: FighterDetails = {
      name: robotName || "Unknown Fighter",
      robotType: robotType,
      chassisDescription: chassisDescription || appearance, // fallback to legacy 'appearance'
      fistsDescription: fistsDescription,
      colorScheme: colorScheme,
      distinguishingFeatures: distinguishingFeatures,
      personality: personality,
      fightingStyle: fightingStyle,
    };

    if (!fighterDetails.chassisDescription) {
      return NextResponse.json(
        {
          error: "Missing robot description",
          hint: "Provide 'chassisDescription' or 'appearance' field",
        },
        { status: 400 }
      );
    }

    // Generate prompt using centralized art style system
    const prompt = generateFighterPortraitPrompt(fighterDetails);

    // Call Replicate API with Flux 1.1 Pro - HIGH QUALITY model
    const response = await fetch("https://api.replicate.com/v1/models/black-forest-labs/flux-1.1-pro/predictions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${REPLICATE_API_TOKEN}`,
        "Content-Type": "application/json",
        "Prefer": "wait", // Wait for result instead of polling
      },
      body: JSON.stringify({
        input: {
          prompt: prompt,
          aspect_ratio: "1:1",
          output_format: "png",
          output_quality: 100,
          safety_tolerance: 5, // Allow creative content
          prompt_upsampling: true, // Enhance prompt for better results
        },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error("Replicate API error:", error);
      return NextResponse.json(
        { error: "Failed to start image generation" },
        { status: 500 }
      );
    }

    const prediction = await response.json();

    return NextResponse.json({
      predictionId: prediction.id,
      status: prediction.status,
      message: "Image generation started using UCF Master Art Style",
    });
  } catch (error: any) {
    console.error("Image generation error:", error);
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}

// GET endpoint to check prediction status
export async function GET(req: NextRequest) {
  try {
    if (!REPLICATE_API_TOKEN) {
      return NextResponse.json(
        { error: "Image generation not configured" },
        { status: 500 }
      );
    }

    const predictionId = req.nextUrl.searchParams.get("id");

    if (!predictionId) {
      return NextResponse.json(
        { error: "Missing prediction ID" },
        { status: 400 }
      );
    }

    const response = await fetch(
      `https://api.replicate.com/v1/predictions/${predictionId}`,
      {
        headers: {
          Authorization: `Bearer ${REPLICATE_API_TOKEN}`,
        },
      }
    );

    if (!response.ok) {
      return NextResponse.json(
        { error: "Failed to get prediction status" },
        { status: 500 }
      );
    }

    const prediction = await response.json();

    return NextResponse.json({
      status: prediction.status,
      output: prediction.output,
      error: prediction.error,
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}
