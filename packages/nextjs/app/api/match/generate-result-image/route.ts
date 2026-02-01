import { NextRequest, NextResponse } from "next/server";
import { supabase } from "../../../../lib/supabase";
import {
  generateBattleResultPrompt,
  UCF_NEGATIVE_PROMPT,
  type BattleResultDetails,
} from "../../../../lib/art-style";

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

    // Call Replicate API
    const response = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${REPLICATE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version: "5599ed30703defd1d160a25a63321b4dec97101d98b4674bcc56e41f62f35637",
        input: {
          prompt: prompt,
          negative_prompt: UCF_NEGATIVE_PROMPT,
          num_outputs: 1,
          aspect_ratio: "16:9", // Widescreen for battle scenes
          output_format: "png",
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
