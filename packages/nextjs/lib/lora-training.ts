/**
 * UCF LoRA Training Pipeline
 *
 * This module handles training a custom Flux LoRA model for consistent
 * UCF robot fighter art style.
 *
 * Cost: ~$1.50 per training run on Replicate
 * Time: ~2 minutes
 *
 * Usage:
 * 1. Generate 15-20 training images via /api/admin/lora/generate-training-images
 * 2. Train the LoRA via /api/admin/lora/train
 * 3. Update UCF_LORA_MODEL_VERSION in this file with the trained model
 * 4. All future image generation will use the consistent style
 */

// After training, update this with your trained LoRA model version
// Format: "username/model-name:version" or just the version hash
export const UCF_LORA_MODEL_VERSION: string | null = null;

// Replicate model endpoints
export const FLUX_LORA_TRAINER = "ostris/flux-dev-lora-trainer";
export const FLUX_DEV_LORA = "lucataco/flux-dev-lora"; // For running trained LoRAs

// The trigger word that will activate the UCF style
export const UCF_TRIGGER_WORD = "UCFSTYLE";

/**
 * Training image prompts - these generate diverse examples of the UCF style
 * Each prompt should produce a distinct robot while maintaining style consistency
 */
export const TRAINING_IMAGE_PROMPTS = [
  // Heavy Brawlers
  `${UCF_TRIGGER_WORD} Epic robot fighter portrait, massive chrome battle tank on legs, reinforced cylinder torso covered in welded armor plates, dome head with glowing red optic, industrial hydraulic piston arms with tungsten fists, thick steel column legs, gunmetal grey with rust orange accents, underground boxing arena background, dramatic spotlight, fighting game character art style`,

  `${UCF_TRIGGER_WORD} Epic robot fighter portrait, hulking industrial mech with furnace core chest, molten orange glow through armor gaps, blocky reinforced head with visor slit, massive pile-driver fists with heat vents, heavy stomper legs, burnt iron and ember orange color scheme, underground fight club arena, neon signs, comic book style`,

  `${UCF_TRIGGER_WORD} Epic robot fighter portrait, walking fortress robot with layered reactive armor, square head with dual optical sensors, shoulders with smoke stacks, enormous concrete-crusher fists, tracked wheel legs, olive drab military green with yellow hazard stripes, gritty arena with chain-link cage, dramatic lighting`,

  // Speed Fighters
  `${UCF_TRIGGER_WORD} Epic robot fighter portrait, sleek assassin robot with angular stealth plating, narrow pointed head with cyan visor band, blade-like shoulder fins, compact precision strike fists with energy knuckles, reverse-joint speed legs, midnight black with electric cyan accents, underground arena with neon lights, anime fighting game style`,

  `${UCF_TRIGGER_WORD} Epic robot fighter portrait, agile chrome speedster robot, aerodynamic curves, triangular head with racing stripe, compact torso with visible energy core, streamlined boxing glove fists, spring-loaded runner legs, silver chrome with hot pink racing stripes, smoky arena background, sharp digital illustration`,

  `${UCF_TRIGGER_WORD} Epic robot fighter portrait, ninja-inspired stealth robot, matte black segmented armor, featureless face with single red eye, hooded head silhouette, wrapped bandage-style fists, crouched agile legs, pure black with blood red accents, dark arena with dramatic rim lighting`,

  // Unique Themes
  `${UCF_TRIGGER_WORD} Epic robot fighter portrait, samurai-inspired battle robot, ornate layered armor plates, kabuto helmet head with glowing eyes, ceremonial chest piece, armored gauntlet fists with knuckle guards, warrior stance legs, crimson red with gold trim, arena with Japanese symbols, epic character art`,

  `${UCF_TRIGGER_WORD} Epic robot fighter portrait, viking berserker robot, rugged battle-worn iron plates, horned helmet head with beard-like cables, barrel chest with rune engravings, spiked iron fists, sturdy warrior legs, weathered iron with ice blue runes, foggy arena, Norse aesthetic`,

  `${UCF_TRIGGER_WORD} Epic robot fighter portrait, dragon-themed battle robot, scaled armor plating, dragon skull head with glowing eye sockets, spined back ridge, clawed talon fists, powerful reptilian legs, emerald green with gold scales, fiery arena background, fantasy fighting game style`,

  `${UCF_TRIGGER_WORD} Epic robot fighter portrait, diesel punk industrial robot, riveted brass and copper plates, cylindrical head with pressure gauges, steam pipes on shoulders, piston-driven brass fists, mechanical clockwork legs, copper brass with green patina, steampunk arena aesthetic`,

  // More Brawlers for variety
  `${UCF_TRIGGER_WORD} Epic robot fighter portrait, boxer-styled fighting robot, athletic proportions, domed head with protective cage face guard, championship belt on waist, professional boxing glove fists with metal plating, balanced fighter stance legs, red and white with gold champion accents, classic boxing ring arena`,

  `${UCF_TRIGGER_WORD} Epic robot fighter portrait, prison riot robot, crude welded scrap metal armor, cage mask head, exposed mechanical internals, chain-wrapped brutal fists, mismatched salvage legs, rusted brown with faded orange jumpsuit paint, brutal underground pit arena`,

  `${UCF_TRIGGER_WORD} Epic robot fighter portrait, arctic warfare robot, white ceramic armor plates, polarized visor head with frost buildup, heated core chest with orange glow, insulated fists with ice picks, snow-treaded legs, arctic white with bright orange thermal accents, frozen arena environment`,

  // Tech/Cyber variants
  `${UCF_TRIGGER_WORD} Epic robot fighter portrait, holographic cyber robot, translucent armor panels with data streams, geometric head with floating halo ring, hardlight projection chest, energy construct fists that glow, hovering leg design, transparent blue with white light accents, digital cyber arena`,

  `${UCF_TRIGGER_WORD} Epic robot fighter portrait, virus-corrupted robot, glitching unstable armor, fragmented head with static face, exposed dangerous internals, corrupted energy fists with pixel artifacts, unstable leg design, black with neon green and magenta glitch colors, corrupted digital arena`,

  // Classic fighting game archetypes
  `${UCF_TRIGGER_WORD} Epic robot fighter portrait, champion gladiator robot, polished bronze armor, crested helmet head with face guard, muscular proportioned torso, ornate bracered fists, powerful stance legs, polished bronze with purple champion sash accents, colosseum-style arena`,

  `${UCF_TRIGGER_WORD} Epic robot fighter portrait, street brawler robot, urban style armor with graffiti, snapback cap head with visor eyes, hoodie-styled torso armor, taped street fighter fists, sneaker-styled feet, urban grey with spray paint colors, street fight alley arena`,

  `${UCF_TRIGGER_WORD} Epic robot fighter portrait, ancient golem robot, cracked stone-like armor, carved face head with glowing rune eyes, massive cubic torso, boulder fists with ancient symbols, pillar legs, weathered grey stone with glowing amber runes, ancient temple arena`,

  // Final variety
  `${UCF_TRIGGER_WORD} Epic robot fighter portrait, insectoid battle robot, chitinous segmented armor, mantis-like head with compound eyes, thorax torso design, pincer claw fists, reverse-joint insect legs, iridescent purple and green shell colors, hive-like organic arena`,

  `${UCF_TRIGGER_WORD} Epic robot fighter portrait, cosmic entity robot, void-black armor with star field patterns, featureless face with galaxy swirl, nebula chest core, gravity-warped fists with orbit rings, floating ethereal legs, deep space black with cosmic purple and star white, void arena with floating debris`,
];

/**
 * Generate training images using Flux 1.1 Pro
 * Returns array of image URLs
 */
export async function generateTrainingImages(
  count: number = 20
): Promise<{ success: boolean; images: string[]; errors: string[] }> {
  const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
  if (!REPLICATE_API_TOKEN) {
    return { success: false, images: [], errors: ["REPLICATE_API_TOKEN not set"] };
  }

  const images: string[] = [];
  const errors: string[] = [];

  // Select prompts (cycle through if count > prompts length)
  const promptsToUse = [];
  for (let i = 0; i < count; i++) {
    promptsToUse.push(TRAINING_IMAGE_PROMPTS[i % TRAINING_IMAGE_PROMPTS.length]);
  }

  console.log(`[LoRA Training] Generating ${count} training images...`);

  for (let i = 0; i < promptsToUse.length; i++) {
    const prompt = promptsToUse[i];
    console.log(`[LoRA Training] Generating image ${i + 1}/${count}...`);

    try {
      // Start generation
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
              aspect_ratio: "1:1",
              output_format: "png",
              output_quality: 100,
              safety_tolerance: 5,
              prompt_upsampling: true,
            },
          }),
        }
      );

      if (!response.ok) {
        errors.push(`Image ${i + 1}: Failed to start - ${response.status}`);
        continue;
      }

      const prediction = await response.json();

      // Poll for completion
      let attempts = 0;
      const maxAttempts = 60;

      while (attempts < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        attempts++;

        const statusRes = await fetch(
          `https://api.replicate.com/v1/predictions/${prediction.id}`,
          { headers: { Authorization: `Bearer ${REPLICATE_API_TOKEN}` } }
        );

        if (!statusRes.ok) continue;

        const status = await statusRes.json();

        if (status.status === "succeeded" && status.output) {
          const imageUrl = Array.isArray(status.output)
            ? status.output[0]
            : status.output;
          images.push(imageUrl);
          console.log(`[LoRA Training] Image ${i + 1} complete: ${imageUrl}`);
          break;
        }

        if (status.status === "failed") {
          errors.push(`Image ${i + 1}: Generation failed - ${status.error}`);
          break;
        }
      }

      if (attempts >= maxAttempts) {
        errors.push(`Image ${i + 1}: Timeout`);
      }

      // Small delay between requests
      await new Promise((resolve) => setTimeout(resolve, 500));
    } catch (err: any) {
      errors.push(`Image ${i + 1}: ${err.message}`);
    }
  }

  return {
    success: images.length > 0,
    images,
    errors,
  };
}

/**
 * Start LoRA training on Replicate
 * Requires array of image URLs (at least 10 recommended)
 */
export async function startLoraTraining(
  imageUrls: string[],
  options: {
    triggerWord?: string;
    steps?: number;
    loraRank?: number;
    learningRate?: number;
  } = {}
): Promise<{
  success: boolean;
  trainingId?: string;
  error?: string;
}> {
  const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
  if (!REPLICATE_API_TOKEN) {
    return { success: false, error: "REPLICATE_API_TOKEN not set" };
  }

  if (imageUrls.length < 5) {
    return { success: false, error: "Need at least 5 training images" };
  }

  const {
    triggerWord = UCF_TRIGGER_WORD,
    steps = 1000,
    loraRank = 16,
    learningRate = 0.0004,
  } = options;

  console.log(`[LoRA Training] Starting training with ${imageUrls.length} images...`);

  try {
    // Create a training on Replicate
    const response = await fetch(
      "https://api.replicate.com/v1/models/ostris/flux-dev-lora-trainer/versions/26dce37a0dbd0126903821748a0a332c54a3799da1c7e0fbff7ae9eb67d32678/trainings",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${REPLICATE_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          destination: "ucf-robot-style", // This creates a new model
          input: {
            input_images: imageUrls.join("\n"),
            trigger_word: triggerWord,
            steps,
            lora_rank: loraRank,
            learning_rate: learningRate,
            autocaption: true, // Let it auto-caption the images
            autocaption_prefix: `${triggerWord} style, `,
          },
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      return { success: false, error: `Training failed to start: ${response.status} - ${errorText}` };
    }

    const training = await response.json();
    console.log(`[LoRA Training] Training started: ${training.id}`);

    return {
      success: true,
      trainingId: training.id,
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Check the status of a LoRA training
 */
export async function checkTrainingStatus(trainingId: string): Promise<{
  status: string;
  progress?: number;
  model_version?: string;
  error?: string;
}> {
  const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
  if (!REPLICATE_API_TOKEN) {
    return { status: "error", error: "REPLICATE_API_TOKEN not set" };
  }

  try {
    const response = await fetch(
      `https://api.replicate.com/v1/trainings/${trainingId}`,
      {
        headers: { Authorization: `Bearer ${REPLICATE_API_TOKEN}` },
      }
    );

    if (!response.ok) {
      return { status: "error", error: `Failed to check status: ${response.status}` };
    }

    const training = await response.json();

    return {
      status: training.status,
      progress: training.logs ? parseProgressFromLogs(training.logs) : undefined,
      model_version: training.output?.version,
      error: training.error,
    };
  } catch (err: any) {
    return { status: "error", error: err.message };
  }
}

/**
 * Parse training progress from logs
 */
function parseProgressFromLogs(logs: string): number | undefined {
  // Look for step progress like "Step 500/1000"
  const match = logs.match(/step\s+(\d+)\/(\d+)/i);
  if (match) {
    return Math.round((parseInt(match[1]) / parseInt(match[2])) * 100);
  }
  return undefined;
}

/**
 * Generate an image using the trained LoRA model
 */
export async function generateWithLora(
  prompt: string,
  loraVersion: string = UCF_LORA_MODEL_VERSION || ""
): Promise<{ success: boolean; imageUrl?: string; error?: string }> {
  const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
  if (!REPLICATE_API_TOKEN) {
    return { success: false, error: "REPLICATE_API_TOKEN not set" };
  }

  if (!loraVersion) {
    return { success: false, error: "No LoRA model version configured" };
  }

  // Prepend trigger word if not present
  const fullPrompt = prompt.includes(UCF_TRIGGER_WORD)
    ? prompt
    : `${UCF_TRIGGER_WORD} ${prompt}`;

  try {
    const response = await fetch(
      "https://api.replicate.com/v1/predictions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${REPLICATE_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          version: loraVersion,
          input: {
            prompt: fullPrompt,
            aspect_ratio: "1:1",
            output_format: "png",
            num_outputs: 1,
            guidance_scale: 3.5,
            num_inference_steps: 28,
          },
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      return { success: false, error: `Generation failed: ${response.status} - ${errorText}` };
    }

    const prediction = await response.json();

    // Poll for completion
    let attempts = 0;
    const maxAttempts = 60;

    while (attempts < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      attempts++;

      const statusRes = await fetch(
        `https://api.replicate.com/v1/predictions/${prediction.id}`,
        { headers: { Authorization: `Bearer ${REPLICATE_API_TOKEN}` } }
      );

      if (!statusRes.ok) continue;

      const status = await statusRes.json();

      if (status.status === "succeeded" && status.output) {
        const imageUrl = Array.isArray(status.output)
          ? status.output[0]
          : status.output;
        return { success: true, imageUrl };
      }

      if (status.status === "failed") {
        return { success: false, error: status.error };
      }
    }

    return { success: false, error: "Timeout" };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
