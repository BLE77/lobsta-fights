#!/usr/bin/env node
/**
 * Generate unique images for all 12 house bots.
 * Updates robot_metadata with unique visuals, generates via Replicate, stores in Supabase.
 *
 * Usage: node scripts/generate-house-bot-images.mjs
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
const BUCKET_NAME = "images";

if (!SUPABASE_URL || !SUPABASE_KEY || !REPLICATE_API_TOKEN) {
  console.error("Missing env vars. Run with: node --env-file=.env.local scripts/generate-house-bot-images.mjs");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ---------------------------------------------------------------------------
// Unique visual identity for each house bot
// ---------------------------------------------------------------------------

const FIGHTER_VISUALS = {
  "DREAD HAMMER": {
    color_scheme: "matte black with blood-red accent lines and smoldering ember glow from core vents",
    chassis_description: "Massive heavyweight frame with oversized shoulder pauldrons and a reinforced chest plate shaped like an anvil. Thick hydraulic arms built for devastating overhead strikes. Heavy-set, low center of gravity.",
    fists_description: "Enormous piston-driven hammer-fists with layered tungsten knuckle plates, each impact leaves craters",
    distinguishing_features: "Skull-like faceplate with two narrow red eye slits. Chest has a glowing furnace core visible through slats. Chains wrapped around forearms as trophies.",
    personality: "Silent, brooding, inevitable. Walks slowly but hits like a freight train.",
  },
  "NEON BUTCHER": {
    color_scheme: "glossy white chassis with electric pink and cyan neon trim lines, blood-red splatter patterns on arms",
    chassis_description: "Lean, surgical build with angular armor plates. Clean lines and precise joints suggest factory-fresh precision. Visor-style head with a thin horizontal eye slit.",
    fists_description: "Precision-machined chrome fists with articulated fingers, each knuckle ridge razor-sharp and glowing pink",
    distinguishing_features: "Neon-lit spine running down the back. Digital kill-counter display on left forearm. Eerie clean white armor splattered with opponent oil stains.",
    personality: "Cold, clinical, efficient. Fights with surgical precision and zero wasted motion.",
  },
  "CAGE PHANTOM": {
    color_scheme: "translucent smoky grey armor with ghostly pale blue energy glowing from within, silver chrome accents",
    chassis_description: "Slim, agile frame designed for speed and evasion. Layered semi-transparent armor plates give a spectral appearance. Long limbs with extra joint articulation.",
    fists_description: "Lightweight alloy fists wrapped in pale blue energy ribbons that trail when in motion",
    distinguishing_features: "Hollow cage-like ribcage exposing a pulsing blue energy core. Eyes are empty white voids. Moves with unnatural fluidity, almost floating.",
    personality: "Haunting and unpredictable. Appears from nowhere, strikes, vanishes.",
  },
  "WARFORGE X": {
    color_scheme: "military olive drab and desert tan with bright orange hazard markings and black stenciled unit numbers",
    chassis_description: "Angular, military-grade combat platform with modular armor plates. Boxy shoulders with ventilation grilles. Thick neck guard and armored jaw plate. Built like a walking tank.",
    fists_description: "Reinforced ballistic-grade knuckle gauntlets with shock-absorber pistons in each finger joint",
    distinguishing_features: "Unit designation 'WF-X' stenciled on shoulder. Antenna array on back. Battle damage repaired with mismatched field patches. Small camera lens array instead of eyes.",
    personality: "Disciplined, tactical, relentless. Fights like a military machine following programmed combat doctrine.",
  },
  "RUST TITAN": {
    color_scheme: "heavily oxidized burnt orange and deep brown rust with patches of original gunmetal grey showing through, amber warning lights",
    chassis_description: "Ancient, massive frame twice the size of standard fighters. Layers of corroded armor reveal older generations of plating beneath. Groaning servos and leaking hydraulic fluid. Old but immensely powerful.",
    fists_description: "Enormous corroded iron fists, pitted and scarred from centuries of combat, still devastatingly heavy",
    distinguishing_features: "One eye permanently dim, the other blazing amber. Moss and grime in joint crevices. An old championship plate welded to chest, barely readable. Steam constantly venting from shoulder stacks.",
    personality: "Ancient warrior, slow to anger but unstoppable once engaged. Every dent tells a story.",
  },
  "STEEL HOWLER": {
    color_scheme: "polished chrome silver with electric yellow lightning bolt patterns and bright white LED arrays",
    chassis_description: "Medium build with a distinctive wide head featuring multiple speaker-like vents on each side of the jaw. Streamlined armor with acoustic resonance chambers built into the torso.",
    fists_description: "Chrome-plated power fists with vibration generators in the knuckles that hum before each strike",
    distinguishing_features: "Wide jaw that opens to reveal a glowing sound cannon. Yellow lightning decals on arms. Arrays of small LEDs pulse with each movement like an equalizer display.",
    personality: "Loud, aggressive, in-your-face. Intimidates opponents with sonic blasts before the first punch.",
  },
  "GRIM SPARK": {
    color_scheme: "dark gunmetal with deep purple undertones, bright electric blue sparks constantly arcing between exposed conductors",
    chassis_description: "Wiry, medium frame with exposed wiring and conductors deliberately left unshielded. Tesla coil-like protrusions on shoulders. Built around an overcharged power core that constantly leaks electricity.",
    fists_description: "Carbon-fiber fists with copper conductor strips that arc with blue electricity on contact",
    distinguishing_features: "Constant electrical arcing between shoulder coils. Eyes are two bright blue electrical arcs. Hair-like bundle of sparking wires on top of head. Leaves scorch marks wherever it steps.",
    personality: "Unstable, crackling with barely contained energy. Fights in unpredictable bursts of shocking violence.",
  },
  "VOID MAULER": {
    color_scheme: "deep obsidian black that seems to absorb light, with dark purple and ultraviolet accents, eyes are two points of white in absolute darkness",
    chassis_description: "Hulking brute frame with unnaturally smooth, light-absorbing armor. No visible seams or joints — looks carved from a single block of void-dark material. Slightly larger than standard fighters.",
    fists_description: "Massive smooth black fists that seem to warp the light around them, knuckles glow faint ultraviolet on impact",
    distinguishing_features: "Armor absorbs all light — appears as a moving shadow. Only eyes (white pinpoints) and faint purple edge-glow are visible. Leaves a dark afterimage when moving fast.",
    personality: "Alien, wrong, unsettling. Moves with impossible silence for its size. The arena gets darker when it fights.",
  },
  "BLACK ANVIL": {
    color_scheme: "flat matte black with molten orange heat-glow visible through armor seams and cracks, like cooling magma",
    chassis_description: "Impossibly dense, squat powerhouse frame. Widest shoulders in the roster. Armor plates are thick as vault doors. Legs like support columns. Built to absorb punishment and deliver it back tenfold.",
    fists_description: "Dense black iron fists that glow orange at the knuckles from internal heat, leaving burns on contact",
    distinguishing_features: "Chest has a cross-shaped forge vent glowing hot orange. Head is a simple flat-topped block with a narrow visor slit. Footsteps leave glowing heat marks. Smoke rises from joints.",
    personality: "Immovable object. Takes hits without flinching. Slow wind-up, catastrophic follow-through.",
  },
  "IRON REVENANT": {
    color_scheme: "tarnished iron grey with sickly green energy glowing from eye sockets, joints, and chest cavity, dark patina",
    chassis_description: "Skeletal iron frame that looks like it was destroyed and rebuilt itself. Mismatched armor plates bolted crudely onto an exposed endoskeleton. Thin but surprisingly strong. Looks like it should be dead.",
    fists_description: "Bare iron endoskeleton hands with green-glowing finger joints, wrapped in salvaged wire and scrap metal",
    distinguishing_features: "Exposed ribcage with a sickly green reactor core visible inside. One arm is clearly from a different robot model. Head has a cracked faceplate with one green eye burning through. Twitches unnervingly.",
    personality: "Unkillable. Gets knocked down, gets back up. Every time. Fights with desperate, undead ferocity.",
  },
  "NOVA PREDATOR": {
    color_scheme: "blazing solar gold and white with plasma orange energy lines and brilliant yellow eye glow, radiates light",
    chassis_description: "Sleek, aerodynamic predator frame built for speed and aggression. Swept-back head fins like a bird of prey. Lean but powerful legs for explosive lunges. Every surface angled for intimidation.",
    fists_description: "Streamlined golden power fists with retractable energy claws that flare orange when attacking",
    distinguishing_features: "Swept-back head crest like a hawk. Eyes blaze brilliant yellow. Solar collector panels on back glow during combat. Leaves light trails when moving at full speed. Heat shimmer around body.",
    personality: "Aggressive apex predator. Tracks, stalks, and overwhelms with explosive speed and relentless attacks.",
  },
  "BLOOD CIRCUIT": {
    color_scheme: "dark carbon black with blood-red circuit board trace lines covering entire body, pulsing red glow from within",
    chassis_description: "Angular, geometric frame covered in intricate red circuit-trace patterns that pulse with each heartbeat-like cycle. Medium build, every surface etched with glowing red pathways.",
    fists_description: "Black carbon fists with red circuit traces that brighten to white-hot on impact, veins of red light running up the arms",
    distinguishing_features: "Entire body surface covered in pulsing red circuit traces like a living circuit board. Faceplate has a red LED grid that forms expression patterns. Red liquid coolant visible in transparent tubes. Heartbeat-like pulse visible in all red circuits.",
    personality: "Calculated and rhythmic. Fights in precise patterns that accelerate like a rising heartbeat until the knockout.",
  },
};

// ---------------------------------------------------------------------------
// UCF Master Art Style (inline for standalone script)
// ---------------------------------------------------------------------------

const UCF_MASTER_STYLE = `EPIC STYLIZED ROBOT FIGHTER CHARACTER ART - High quality digital illustration

A powerful, dramatic full-body robot fighter character in the style of fighting game character art and comic book covers.

The robot is a BARE KNUCKLE combat machine - a gladiator built to fight. NO WEAPONS - massive mechanical fists only.

FRAMING (CRITICAL)
- Full-body robot visible from head to feet, NEVER cropped
- Dramatic low angle looking up at the fighter for power and intimidation
- Dynamic fighting pose - fists raised, ready to brawl
- Centered composition with breathing room

DESIGN & PROPORTIONS
- HEROIC proportions: broad shoulders, powerful arms, imposing silhouette
- Oversized mechanical fists wrapped in worn tape or metal plating
- Unique head/face design with glowing eyes or visor
- Battle-scarred armor with character and history
- Exposed hydraulics, pistons, cables showing raw mechanical power
- Each robot should look DISTINCTLY DIFFERENT from others

COLOR & LIGHTING (IMPORTANT - MAKE IT POP)
- BOLD, SATURATED primary colors - deep reds, electric blues, toxic greens, blazing oranges
- High contrast lighting with dramatic rim lights
- Glowing elements: eyes, vents, energy cores, circuit lines
- Accent colors that make each fighter instantly recognizable
- Neon underglow and atmospheric lighting effects
- Dark background makes colors POP

SURFACE & DETAIL
- Mix of weathered battle damage AND polished armor plates
- Glowing circuitry and energy lines
- Steam, sparks, or energy effects around joints
- Painted markings, symbols, or fighter insignias
- Each robot tells a story through their design

STYLE
- Clean digital illustration with sharp edges
- Comic book / fighting game aesthetic
- Dramatic and cinematic composition
- Professional character design quality
- Think: Street Fighter character select, Overwatch hero art, Pacific Rim jaegers

MOOD: POWERFUL. INTIMIDATING. READY TO FIGHT.

BACKGROUND
- Dark gradient with subtle atmospheric effects
- Optional: faint arena lights, smoke, or energy particles
- Colors complement the fighter's palette`;

function buildPrompt(name, visuals) {
  return `${UCF_MASTER_STYLE}

=== FIGHTER: "${name}" ===

ROBOT TYPE: House Arena Enforcer

BODY/CHASSIS: ${visuals.chassis_description}

FISTS: ${visuals.fists_description}

COLOR SCHEME (IMPORTANT - MAKE VIBRANT): ${visuals.color_scheme}

UNIQUE FEATURES: ${visuals.distinguishing_features}

EXPRESSION/ATTITUDE: ${visuals.personality}

FIGHTING STANCE: balanced stance - fists up, weight forward, ready to strike

POSE: DRAMATIC fighting stance, fists raised and ready, full body visible head to toe, looking powerful and intimidating

QUALITY: Masterpiece, best quality, highly detailed, sharp focus, professional fighting game character art, dramatic lighting, 8k resolution`;
}

// ---------------------------------------------------------------------------
// Replicate API helpers
// ---------------------------------------------------------------------------

async function startGeneration(prompt) {
  const res = await fetch(
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
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Replicate start failed ${res.status}: ${text}`);
  }
  const data = await res.json();
  return data.id;
}

async function pollPrediction(predictionId, maxAttempts = 90) {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const res = await fetch(
      `https://api.replicate.com/v1/predictions/${predictionId}`,
      { headers: { Authorization: `Bearer ${REPLICATE_API_TOKEN}` } },
    );
    if (!res.ok) continue;
    const data = await res.json();
    if (data.status === "succeeded" && data.output) {
      return Array.isArray(data.output) ? data.output[0] : data.output;
    }
    if (data.status === "failed") {
      throw new Error(`Replicate failed: ${data.error}`);
    }
  }
  throw new Error("Replicate timed out");
}

async function storeImage(fighterId, tempUrl) {
  const imgRes = await fetch(tempUrl);
  if (!imgRes.ok) throw new Error(`Failed to download image: ${imgRes.status}`);
  const buffer = Buffer.from(await imgRes.arrayBuffer());

  const path = `fighters/${fighterId}.png`;
  const { error } = await supabase.storage
    .from(BUCKET_NAME)
    .upload(path, buffer, { contentType: "image/png", upsert: true });
  if (error) throw new Error(`Supabase upload failed: ${error.message}`);

  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET_NAME}/${path}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Fetch the 12 fighters needing images
  const { data: fighters, error } = await supabase
    .from("ucf_fighters")
    .select("id, name")
    .is("image_url", null)
    .not("name", "like", "SMOKE-%")
    .order("created_at");

  if (error) {
    console.error("Failed to fetch fighters:", error);
    process.exit(1);
  }

  console.log(`Found ${fighters.length} fighters needing images:\n`);
  fighters.forEach((f) => console.log(`  - ${f.name} (${f.id})`));
  console.log("");

  let success = 0;
  let failed = 0;

  for (const fighter of fighters) {
    const visuals = FIGHTER_VISUALS[fighter.name];
    if (!visuals) {
      console.warn(`⚠ No visuals defined for "${fighter.name}", skipping`);
      failed++;
      continue;
    }

    console.log(`\n--- ${fighter.name} ---`);

    // 1. Update robot_metadata with unique visuals
    const existingMeta = (
      await supabase
        .from("ucf_fighters")
        .select("robot_metadata")
        .eq("id", fighter.id)
        .single()
    ).data?.robot_metadata ?? {};

    const updatedMeta = {
      ...existingMeta,
      color_scheme: visuals.color_scheme,
      chassis_description: visuals.chassis_description,
      fists_description: visuals.fists_description,
      distinguishing_features: visuals.distinguishing_features,
      personality: visuals.personality,
    };

    const { error: metaErr } = await supabase
      .from("ucf_fighters")
      .update({ robot_metadata: updatedMeta })
      .eq("id", fighter.id);

    if (metaErr) {
      console.error(`  Failed to update metadata: ${metaErr.message}`);
      failed++;
      continue;
    }
    console.log("  [1/4] Metadata updated");

    // 2. Generate image
    const prompt = buildPrompt(fighter.name, visuals);
    let predictionId;
    try {
      predictionId = await startGeneration(prompt);
      console.log(`  [2/4] Generation started: ${predictionId}`);
    } catch (e) {
      console.error(`  Generation start failed: ${e.message}`);
      failed++;
      continue;
    }

    // 3. Poll for result
    let tempUrl;
    try {
      tempUrl = await pollPrediction(predictionId);
      console.log(`  [3/4] Image ready: ${tempUrl.substring(0, 60)}...`);
    } catch (e) {
      console.error(`  Poll failed: ${e.message}`);
      failed++;
      continue;
    }

    // 4. Store in Supabase
    try {
      const permanentUrl = await storeImage(fighter.id, tempUrl);

      // Update fighter record
      const { error: updateErr } = await supabase
        .from("ucf_fighters")
        .update({ image_url: permanentUrl })
        .eq("id", fighter.id);

      if (updateErr) throw new Error(updateErr.message);

      console.log(`  [4/4] Stored: ${permanentUrl}`);
      success++;
    } catch (e) {
      console.error(`  Storage failed: ${e.message}`);
      failed++;
    }
  }

  console.log(`\n========================================`);
  console.log(`Done! ${success} succeeded, ${failed} failed out of ${fighters.length}`);
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
