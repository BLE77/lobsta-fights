import { NextRequest, NextResponse } from "next/server";

// Generate robot fighter image using Flux via Replicate
// Flux Schnell is fast and cheap (~$0.003 per image)

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;

// Master style prompt for UCF robot fighters
const STYLE_PROMPT = `A stylized grotesque full-body robot character illustration inspired by exaggerated adult animation aesthetics. The robot is fictional, designed as a combat/fighting machine with a distinct personality.

FRAMING: Full-body robot visible from head to feet. Centered composition. No cropping of limbs. Dynamic but readable pose (boxing stance, guard up, leaning forward, mid-motion).

DESIGN & PROPORTIONS: Robot anatomy is exaggerated but controlled. Oversized head or helmet relative to body. Thick, overbuilt shoulders and arms. Slightly hunched posture for menace and personality. Mechanical joints visibly stressed, worn, or asymmetrical. Hands oversized like boxing gloves or industrial tools. Legs sturdy, compact, slightly bowed or uneven. Design feels brutish, imperfect, and handmade, not sleek or futuristic.

FACE/HEAD: Expressive robotic "face" or mask. Heavy-lidded or glowing eyes with attitude (tired, angry, smug, unhinged). Visible dents, scratches, bolts, seams, cracked plating. Head tilt or expression that gives character.

SURFACE & TEXTURE: Armor shows wear: chipped paint, rust, grime, oil stains. Uneven plating, exposed cables, pistons, rivets. Texture feels used, not factory-fresh. No smooth plastic, no chrome shine.

LINEWORK & SHADING: Clean, confident, illustrative linework. Hand-inked look with visible contour lines. Flat-to-soft shading with subtle gradients. No painterly smears, no blur, no sketchiness.

COLOR PALETTE: Muted industrial colors: dirty yellows, rusted reds, worn steel, olive, off-white. Slight warmth overall. No neon, no glossy sci-fi glow. Lighting is readable and grounded.

STYLE: Dark adult animation meets editorial caricature meets modern grotesque cartoon. MeatCanyon-inspired but more polished, consistent, and controlled. Unsettling but not horror. Humorous but intimidating.

BACKGROUND: Simple neutral gradient or transparent background. No environment, no arena, no crowd.

High detail, sharp focus, clean edges, professional illustration quality. NOT photorealistic, NOT 3D, NOT anime, NOT cute, NOT chibi, NOT sleek sci-fi.`;

export async function POST(req: NextRequest) {
  try {
    if (!REPLICATE_API_TOKEN) {
      return NextResponse.json(
        { error: "Image generation not configured" },
        { status: 500 }
      );
    }

    const { robotName, appearance, specialMove } = await req.json();

    if (!appearance) {
      return NextResponse.json(
        { error: "Missing robot appearance description" },
        { status: 400 }
      );
    }

    // Combine fighter details with master style prompt
    const prompt = `${STYLE_PROMPT}

CHARACTER DETAILS:
Robot Name: "${robotName || 'Unknown Fighter'}"
Appearance: ${appearance}
${specialMove ? `Signature Move: ${specialMove}` : ''}

Generate this specific robot fighter with all the style guidelines above.`;

    // Call Replicate API with Flux Schnell (fast + cheap)
    const response = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${REPLICATE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        // Flux Schnell - fast generation, good quality, cheap
        version: "5599ed30703defd1d160a25a63321b4dec97101d98b4674bcc56e41f62f35637",
        input: {
          prompt: prompt,
          num_outputs: 1,
          aspect_ratio: "1:1",
          output_format: "webp",
          output_quality: 90,
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

    // Return the prediction ID - client can poll for result
    return NextResponse.json({
      predictionId: prediction.id,
      status: prediction.status,
      message: "Image generation started",
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
          "Authorization": `Bearer ${REPLICATE_API_TOKEN}`,
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
      output: prediction.output, // Array of image URLs when complete
      error: prediction.error,
    });

  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}
