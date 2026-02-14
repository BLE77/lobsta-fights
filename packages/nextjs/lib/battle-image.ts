// @ts-nocheck
import { supabase } from "./supabase";
import {
  generateBattleResultPrompt,
  type BattleResultDetails,
} from "./art-style";

/**
 * Trigger battle result image generation (async, non-blocking)
 * Uses the centralized UCF Master Art Style from lib/art-style.ts
 */
export async function generateBattleResultImage(matchId: string): Promise<void> {
  const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
  if (!REPLICATE_API_TOKEN) {
    console.log("[Image] No REPLICATE_API_TOKEN, skipping image generation");
    return;
  }

  try {
    // Fetch match with fighter details including robot_metadata
    const { data: match, error } = await supabase
      .from("ucf_matches")
      .select(`
        *,
        fighter_a:ucf_fighters!fighter_a_id(id, name, description, special_move, robot_metadata),
        fighter_b:ucf_fighters!fighter_b_id(id, name, description, special_move, robot_metadata)
      `)
      .eq("id", matchId)
      .single();

    if (error || !match || !match.winner_id) {
      console.error("[Image] Cannot generate image - match not found or no winner:", error);
      return;
    }

    // IDEMPOTENCY CHECK: Don't regenerate if image already exists
    if (match.result_image_url) {
      console.log(`[Image] Match ${matchId} already has result image, skipping generation`);
      return;
    }

    const winnerData = match.winner_id === match.fighter_a_id ? match.fighter_a : match.fighter_b;
    const loserData = match.winner_id === match.fighter_a_id ? match.fighter_b : match.fighter_a;
    const lastTurn = match.turn_history?.[match.turn_history.length - 1];
    const winnerHP = match.winner_id === match.fighter_a_id ? lastTurn?.hp_a_after : lastTurn?.hp_b_after;

    // Get the final moves that ended the fight
    const winnerMove = match.winner_id === match.fighter_a_id ? lastTurn?.move_a : lastTurn?.move_b;
    const loserMove = match.winner_id === match.fighter_a_id ? lastTurn?.move_b : lastTurn?.move_a;

    // Extract robot metadata
    const winnerMeta = winnerData?.robot_metadata || {};
    const loserMeta = loserData?.robot_metadata || {};

    // Build battle details for centralized prompt generator
    const battleDetails: BattleResultDetails = {
      winner: {
        name: winnerData?.name || "Winner",
        chassisDescription: winnerMeta.chassis_description,
        fistsDescription: winnerMeta.fists_description,
        colorScheme: winnerMeta.color_scheme,
        distinguishingFeatures: winnerMeta.distinguishing_features,
        finalMove: winnerMove,
        hpRemaining: winnerHP,
      },
      loser: {
        name: loserData?.name || "Loser",
        chassisDescription: loserMeta.chassis_description,
        fistsDescription: loserMeta.fists_description,
        colorScheme: loserMeta.color_scheme,
        distinguishingFeatures: loserMeta.distinguishing_features,
        failedMove: loserMove,
      },
      totalRounds: (match.agent_a_state?.rounds_won || 0) + (match.agent_b_state?.rounds_won || 0),
    };

    // Generate prompt using centralized art style system
    const prompt = generateBattleResultPrompt(battleDetails);

    console.log(`[Image] Starting battle result image generation for match ${matchId}`);

    // Start image generation with Flux 1.1 Pro - HIGH QUALITY
    const response = await fetch("https://api.replicate.com/v1/models/black-forest-labs/flux-1.1-pro/predictions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${REPLICATE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: {
          prompt,
          aspect_ratio: "3:4", // Portrait to show full robot bodies
          output_format: "png",
          output_quality: 100,
          safety_tolerance: 5,
          prompt_upsampling: true,
        },
      }),
    });

    if (!response.ok) {
      console.error(`[Image] Replicate API error: ${response.status}`);
      return;
    }

    const prediction = await response.json();

    // Store the prediction ID so we can poll for the result
    await supabase
      .from("ucf_matches")
      .update({ result_image_prediction_id: prediction.id })
      .eq("id", matchId);

    console.log(`[Image] Started battle result image for match ${matchId}: ${prediction.id}`);

    // Poll for completion (max 60 seconds)
    let attempts = 0;
    const maxAttempts = 30;

    const pollForResult = async () => {
      while (attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
        attempts++;

        const statusRes = await fetch(
          `https://api.replicate.com/v1/predictions/${prediction.id}`,
          { headers: { "Authorization": `Bearer ${REPLICATE_API_TOKEN}` } }
        );

        if (!statusRes.ok) continue;

        const status = await statusRes.json();

        if (status.status === "succeeded" && status.output) {
          // Handle both array and string output formats from Replicate
          const tempImageUrl = Array.isArray(status.output) ? status.output[0] : status.output;
          console.log(`[Image] Battle image generated: ${tempImageUrl}`);

          // Store image permanently in Supabase Storage
          const { storeBattleImage } = await import("./image-storage");
          const permanentUrl = await storeBattleImage(matchId, tempImageUrl);

          if (permanentUrl) {
            console.log(`[Image] Battle result image stored permanently for match ${matchId}: ${permanentUrl}`);
          } else {
            // Fallback to temp URL if storage fails
            console.error(`[Image] Failed to store permanently, using temp URL for match ${matchId}`);
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
    };

    // Run polling in background
    pollForResult().catch(console.error);

  } catch (err) {
    console.error("[Image] Error in generateBattleResultImage:", err);
  }
}
