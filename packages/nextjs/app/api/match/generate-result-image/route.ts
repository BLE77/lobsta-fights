import { NextRequest, NextResponse } from "next/server";
import { supabase } from "../../../../lib/supabase";
import {
  generateBattleResultPrompt,
  UCF_NEGATIVE_PROMPT,
  type BattleResultDetails,
} from "../../../../lib/art-style";

export const dynamic = "force-dynamic";

/**
 * Generate a battle result image showing the aftermath of a UCF match
 *
 * Uses the centralized UCF Master Art Style from lib/art-style.ts
 * Flux Schnell via Replicate (~$0.003 per image)
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

    const { match_id } = await req.json();

    if (!match_id) {
      return NextResponse.json(
        { error: "Missing match_id" },
        { status: 400 }
      );
    }

    // Fetch match with fighter details including robot_metadata
    const { data: match, error: matchError } = await supabase
      .from("ucf_matches")
      .select(`
        *,
        fighter_a:ucf_fighters!fighter_a_id(id, name, description, special_move, image_url, robot_metadata),
        fighter_b:ucf_fighters!fighter_b_id(id, name, description, special_move, image_url, robot_metadata)
      `)
      .eq("id", match_id)
      .single();

    if (matchError || !match) {
      return NextResponse.json(
        { error: "Match not found" },
        { status: 404 }
      );
    }

    if (match.state !== "FINISHED") {
      return NextResponse.json(
        { error: "Match is not finished yet" },
        { status: 400 }
      );
    }

    const winnerData = match.winner_id === match.fighter_a_id ? match.fighter_a : match.fighter_b;
    const loserData = match.winner_id === match.fighter_a_id ? match.fighter_b : match.fighter_a;

    // Get final stats and moves from turn history
    const lastTurn = match.turn_history?.[match.turn_history.length - 1];
    const winnerHP = match.winner_id === match.fighter_a_id ? lastTurn?.hp_a_after : lastTurn?.hp_b_after;
    const winnerMove = match.winner_id === match.fighter_a_id ? lastTurn?.move_a : lastTurn?.move_b;
    const loserMove = match.winner_id === match.fighter_a_id ? lastTurn?.move_b : lastTurn?.move_a;
    const totalRounds = (match.agent_a_state?.rounds_won || 0) + (match.agent_b_state?.rounds_won || 0);

    // Extract robot metadata for detailed descriptions
    const winnerMeta = winnerData.robot_metadata || {};
    const loserMeta = loserData.robot_metadata || {};

    // Build battle details for centralized prompt generator
    const battleDetails: BattleResultDetails = {
      winner: {
        name: winnerData.name,
        chassisDescription: winnerMeta.chassis_description || winnerData.description,
        fistsDescription: winnerMeta.fists_description,
        colorScheme: winnerMeta.color_scheme,
        distinguishingFeatures: winnerMeta.distinguishing_features,
        finalMove: winnerMove,
        hpRemaining: winnerHP,
      },
      loser: {
        name: loserData.name,
        chassisDescription: loserMeta.chassis_description || loserData.description,
        fistsDescription: loserMeta.fists_description,
        colorScheme: loserMeta.color_scheme,
        distinguishingFeatures: loserMeta.distinguishing_features,
        failedMove: loserMove,
      },
      totalRounds,
    };

    // Generate prompt using centralized UCF art style system
    const prompt = generateBattleResultPrompt(battleDetails);

    // Call Replicate API with Flux 1.1 Pro - HIGH QUALITY
    const response = await fetch("https://api.replicate.com/v1/models/black-forest-labs/flux-1.1-pro/predictions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${REPLICATE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: {
          prompt: prompt,
          aspect_ratio: "3:4", // Portrait to show full robot bodies
          output_format: "png",
          output_quality: 100,
          safety_tolerance: 5,
          prompt_upsampling: true,
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

    // Store prediction ID
    await supabase
      .from("ucf_matches")
      .update({ result_image_prediction_id: prediction.id })
      .eq("id", match_id);

    // Poll for result in background (non-blocking)
    pollAndStoreImage(prediction.id, match_id).catch((err) => {
      console.error("[Image] Error polling for result:", err);
    });

    return NextResponse.json({
      predictionId: prediction.id,
      status: prediction.status,
      message: "Battle result image generation started using UCF Master Art Style",
      match_id,
      winner: winnerData.name,
      loser: loserData.name,
    });
  } catch (error: any) {
    console.error("Battle image generation error:", error);
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}

/**
 * Poll for image generation result and store it
 */
async function pollAndStoreImage(predictionId: string, matchId: string): Promise<void> {
  let attempts = 0;
  const maxAttempts = 30;

  while (attempts < maxAttempts) {
    await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
    attempts++;

    const statusRes = await fetch(
      `https://api.replicate.com/v1/predictions/${predictionId}`,
      { headers: { Authorization: `Bearer ${REPLICATE_API_TOKEN}` } }
    );

    if (!statusRes.ok) continue;

    const status = await statusRes.json();

    if (status.status === "succeeded" && status.output?.[0]) {
      const tempImageUrl = status.output[0];
      console.log(`[Image] Battle image generated for match ${matchId}: ${tempImageUrl}`);

      // Store image permanently in Supabase Storage
      try {
        const { storeBattleImage } = await import("../../../../lib/image-storage");
        const permanentUrl = await storeBattleImage(matchId, tempImageUrl);

        if (permanentUrl) {
          console.log(`[Image] Battle result image stored permanently for match ${matchId}`);
        } else {
          // Fallback to temp URL if storage fails
          await supabase
            .from("ucf_matches")
            .update({ result_image_url: tempImageUrl })
            .eq("id", matchId);
        }
      } catch (e) {
        // Fallback to temp URL
        await supabase
          .from("ucf_matches")
          .update({ result_image_url: tempImageUrl })
          .eq("id", matchId);
      }
      return;
    }

    if (status.status === "failed") {
      console.error(`[Image] Generation failed for match ${matchId}:`, status.error);
      return;
    }
  }
  console.log(`[Image] Polling timed out for match ${matchId}`);
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
