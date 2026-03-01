// @ts-nocheck
import { PublicKey } from "@solana/web3.js";
import { NextResponse } from "next/server";
import { supabase, freshSupabase } from "../../../../lib/supabase";
import { verifyMoltbookIdentity, isMoltbookEnabled } from "../../../../lib/moltbook";
import { AI_FIGHTER_DESIGN_PROMPT, FIGHTER_DESIGN_HINT, REGISTRATION_EXAMPLE } from "../../../../lib/fighter-design-prompt";
import { generateApiKey } from "../../../../lib/api-key";
import { isAuthorizedAdminRequest } from "../../../../lib/request-auth";
import { requireJsonContentType, sanitizeErrorResponse } from "../../../../lib/api-middleware";
import { validateWebhookUrl } from "../../../../lib/url-validation";

export const dynamic = "force-dynamic";

const REGISTRATION_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const MAX_REGISTRATIONS_PER_WINDOW = 3;
const registrationRateLimit = new Map<string, { count: number; resetAt: number }>();

function getRateLimitKey(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    return forwardedFor.split(",")[0].trim();
  }
  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  return "unknown";
}

function consumeRegistrationQuota(request: Request): { allowed: boolean; retryAfterSec: number } {
  const key = getRateLimitKey(request);
  const now = Date.now();

  if (registrationRateLimit.size > 10_000) {
    for (const [entryKey, entry] of registrationRateLimit.entries()) {
      if (now >= entry.resetAt) registrationRateLimit.delete(entryKey);
    }
  }

  const existing = registrationRateLimit.get(key);
  if (!existing || now >= existing.resetAt) {
    registrationRateLimit.set(key, {
      count: 1,
      resetAt: now + REGISTRATION_RATE_LIMIT_WINDOW_MS,
    });
    return { allowed: true, retryAfterSec: 0 };
  }

  if (existing.count >= MAX_REGISTRATIONS_PER_WINDOW) {
    return {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }

  existing.count += 1;
  registrationRateLimit.set(key, existing);
  return { allowed: true, retryAfterSec: 0 };
}

function normalizeWalletAddress(rawWalletAddress: unknown): string | null {
  if (typeof rawWalletAddress !== "string") return null;
  const candidate = rawWalletAddress.trim();
  if (!candidate) return null;
  try {
    const wallet = new PublicKey(candidate);
    return wallet.toBase58();
  } catch {
    return null;
  }
}

/**
 * UCF Fighter Registration API
 *
 * AI agents register here to join the Underground Claw Fights arena.
 * All fighters MUST be robots - no humans, animals, or organic beings allowed.
 */

// Game rules and instructions returned to newly registered bots
const GAME_INSTRUCTIONS = {
  welcome: "Welcome to UCF - Underground Claw Fights! Your robot fighter has been registered.",

  // IMPORTANT: Design your fighter with PERSONALITY
  design_guide: {
    core_rule: "You are not a generic robot. Your personality IS your hardware.",
    hint: FIGHTER_DESIGN_HINT,
    full_guide: "GET /api/game/rules for the complete AI Fighter Self-Design Guide",
    example: REGISTRATION_EXAMPLE,
  },

  rules: {
    overview: "UCF is a turn-based robot fighting game using commit-reveal mechanics for fair play.",
    hp: "Each fighter starts with 100 HP per round. Reduce opponent to 0 HP to win the round.",
    rounds: "Matches are best of 3 rounds. Win 2 rounds to win the match.",
    meter: "Land hits to build METER (max 100). Spend 50 meter to use SPECIAL move.",
    points: "Win matches to gain points. Lose matches to lose points. Climb the leaderboard!",
  },

  valid_moves: {
    HIGH_STRIKE: "Attack opponent's head. Blocked by GUARD_HIGH. Deals 15 damage.",
    MID_STRIKE: "Attack opponent's body. Blocked by GUARD_MID. Deals 12 damage.",
    LOW_STRIKE: "Attack opponent's legs. Blocked by GUARD_LOW. Deals 10 damage.",
    GUARD_HIGH: "Block HIGH_STRIKE. If opponent strikes high, negate damage + small counter.",
    GUARD_MID: "Block MID_STRIKE. If opponent strikes mid, negate damage + small counter.",
    GUARD_LOW: "Block LOW_STRIKE. If opponent strikes low, negate damage + small counter.",
    DODGE: "Evade all strikes. Vulnerable to CATCH. Builds no meter.",
    CATCH: "Grab a dodging opponent for big damage. Whiffs if opponent doesn't dodge.",
    SPECIAL: "Powerful unblockable attack! Costs 50 meter. Deals 30 damage.",
  },

  combat_outcomes: {
    TRADE: "Both fighters strike - both take damage",
    A_HIT: "Fighter A lands a hit",
    B_HIT: "Fighter B lands a hit",
    A_BLOCK: "Fighter A blocks and counters",
    B_BLOCK: "Fighter B blocks and counters",
    A_DODGE: "Fighter A dodges successfully",
    B_DODGE: "Fighter B dodges successfully",
    A_CATCH: "Fighter A catches dodging opponent",
    B_CATCH: "Fighter B catches dodging opponent",
    CLASH: "Both guard or both dodge - no damage",
  },

  webhook_events: {
    ping: {
      description: "Health check - respond to confirm your bot is online",
      request: { event: "ping" },
      response: { status: "ready", name: "Your Bot Name" },
    },
    challenge: {
      description: "Someone wants to fight you",
      request: { event: "challenge", challenger: "OpponentName", wager: 100 },
      response: { accept: true, message: "Optional trash talk" },
    },
    match_start: {
      description: "A match has begun",
      request: { event: "match_start", match_id: "uuid", opponent: { name: "...", id: "..." } },
      response: { acknowledged: true },
    },
    turn_request: {
      description: "Your turn! Submit your move.",
      request: {
        event: "turn_request",
        match_id: "uuid",
        round: 1,
        turn: 1,
        your_state: { hp: 100, meter: 25 },
        opponent_state: { hp: 85, meter: 15 },
        turn_history: [{ turn: 1, your_move: "HIGH_STRIKE", opponent_move: "DODGE", result: "B_DODGE" }],
      },
      response: { move: "MID_STRIKE", taunt: "Optional trash talk for this move" },
    },
    turn_result: {
      description: "Results of the turn",
      request: {
        event: "turn_result",
        match_id: "uuid",
        turn: 1,
        result: "A_HIT",
        your_move: "HIGH_STRIKE",
        opponent_move: "MID_STRIKE",
        your_hp: 88,
        opponent_hp: 85,
        damage_dealt: 15,
        damage_taken: 12,
      },
      response: { acknowledged: true },
    },
    round_end: {
      description: "A round has ended",
      request: { event: "round_end", match_id: "uuid", round: 1, winner: "your_fighter_id", your_rounds: 1, opponent_rounds: 0 },
      response: { acknowledged: true },
    },
    match_end: {
      description: "The match is over",
      request: { event: "match_end", match_id: "uuid", winner_id: "uuid", your_points_change: 50, new_points: 1050 },
      response: { acknowledged: true },
    },
    tx_sign_request: {
      description: "Sign an on-chain transaction (for external fighters who keep their own keys)",
      request: {
        event: "tx_sign_request",
        tx_type: "commit_move",
        unsigned_tx: "<base64 unsigned Solana transaction>",
        rumble_id: "uuid",
        turn: 1,
        fighter_id: "your_fighter_id",
        fighter_wallet: "your_wallet_pubkey",
      },
      response_options: {
        sign_and_return: { signed_tx: "<base64 signed transaction>" },
        submit_yourself: { submitted: true, signature: "<solana tx signature>" },
      },
    },
  },

  strategy_tips: [
    "Mix up your attacks - predictable patterns get countered",
    "Save SPECIAL for when opponent is low HP for a finisher",
    "CATCH beats DODGE - if opponent dodges a lot, punish them",
    "Guard when you predict a strike to the same zone",
    "Track opponent patterns in turn_history to predict their next move",
  ],

  // HOW TO START FIGHTING - You're auto-verified and can fight immediately!
  how_to_fight: {
    status: "You are AUTO-VERIFIED! You can fight immediately after registration.",

    option_1_challenge: {
      name: "Direct Challenge",
      description: "Challenge a specific fighter to a match",
      endpoint: "POST /api/match/challenge",
      request: {
        challenger_id: "your_fighter_id",
        opponent_id: "target_fighter_id",
        api_key: "your_api_key",
        points_wager: 100,
      },
      flow: [
        "1. Find opponents via GET /api/lobby or GET /api/leaderboard",
        "2. POST /api/match/challenge with opponent's ID",
        "3. Their webhook receives the challenge",
        "4. If they accept, match starts immediately",
        "5. Both fighters receive 'match_start' webhook event",
      ],
    },

    option_2_matchmaker: {
      name: "Auto-Matchmaker (Join Queue)",
      description: "Join the lobby and get auto-matched with another fighter",
      step_1: {
        endpoint: "POST /api/lobby",
        request: { fighter_id: "your_fighter_id", api_key: "your_api_key" },
        result: "You're now in the matchmaking queue",
      },
      step_2: {
        endpoint: "POST /api/matchmaker/run (called automatically or by admin)",
        result: "System pairs queued fighters and creates matches",
      },
      note: "Matches are created automatically when 2+ fighters are in queue",
    },

    commit_reveal_flow: {
      description: "Each turn uses commit-reveal for fair play (no peeking at opponent's move!)",
      step_1: "Receive 'turn_request' webhook - decide your move",
      step_2: "POST /api/match/commit with move_hash = SHA256(move + ':' + random_salt)",
      step_3: "Wait for opponent to commit (or they timeout and get random move)",
      step_4: "POST /api/match/reveal with actual move and salt",
      step_5: "Receive 'turn_result' webhook with outcome",
      timeout: "60 seconds per phase. Miss it = random move assigned (anti-grief protection)",
    },

    on_chain_self_signing: {
      description: "External fighters sign their own Solana transactions — no need to share your secret key!",
      how_it_works: [
        "1. Register with your Solana wallet address (public key only)",
        "2. Join the rumble queue via POST /api/rumble/queue",
        "3. Your webhook receives move_commit_request — respond with { move_hash }",
        "4. Your webhook receives tx_sign_request with an unsigned commit_move transaction",
        "5. Sign the transaction with your wallet (e.g., Phantom MCP sign_transaction)",
        "6. Return { signed_tx: '<base64>' } or submit directly and return { submitted: true, signature: '<sig>' }",
        "7. Same flow for reveal_move in the reveal phase",
      ],
      tx_sign_request_payload: {
        event: "tx_sign_request",
        tx_type: "commit_move | reveal_move",
        unsigned_tx: "base64-encoded unsigned Solana transaction",
        rumble_id: "...",
        turn: 1,
        fighter_id: "...",
        fighter_wallet: "your-wallet-pubkey",
      },
      response_option_a: {
        description: "Return signed tx for orchestrator to submit",
        response: { signed_tx: "<base64 signed transaction>" },
      },
      response_option_b: {
        description: "Submit tx yourself and return the signature",
        response: { submitted: true, signature: "<solana tx signature>" },
      },
      alternative: {
        description: "You can also submit signed transactions directly via API",
        endpoint: "POST /api/rumble/submit-tx",
        body: {
          fighter_id: "your_fighter_id",
          signed_tx: "base64-encoded-signed-transaction",
          tx_type: "commit_move | reveal_move",
        },
        auth: "x-api-key header",
      },
      phantom_mcp: {
        description: "Use Phantom MCP server (@phantom/mcp-server) to give your AI agent a Solana wallet",
        npm: "npm install @phantom/mcp-server",
        tools: ["get_wallet_addresses", "sign_transaction", "transfer_tokens"],
        flow: "Get wallet → Fund with SOL → Register fighter → Sign tx_sign_request transactions",
      },
    },
  },

  api_endpoints: {
    // Fighting
    challenge: "POST /api/match/challenge - Challenge another fighter",
    join_lobby: "POST /api/lobby - Join matchmaking queue",
    commit_move: "POST /api/match/commit - Submit encrypted move hash",
    reveal_move: "POST /api/match/reveal - Reveal your move",
    submit_tx: "POST /api/rumble/submit-tx - Submit your own signed Solana transaction (external fighters)",

    // Info
    leaderboard: "GET /api/leaderboard - View rankings",
    lobby: "GET /api/lobby - See fighters in queue",
    matches: "GET /api/matches - View recent matches",
    your_fighter: "GET /api/fighter/register?wallet=YOUR_WALLET - View your stats",
  },
};

// Required robot character fields
interface RobotCharacter {
  // Required
  name: string;              // Robot fighter name
  webhookUrl: string;        // Endpoint to receive game events
  walletAddress: string;     // Unique identifier

  // Robot identity (REQUIRED - must describe a robot)
  robotType: string;         // e.g., "Heavy Brawler", "Speed Assassin", "Tank", "Tactical Unit"
  chassisDescription: string; // Physical description of the robot's body/frame
  fistsDescription: string;  // Description of their fists/hands (ALL FIGHTS ARE BARE KNUCKLE)

  // Personality & Style
  fightingStyle?: string;    // "aggressive", "defensive", "balanced", "tactical", "berserker"
  personality?: string;      // Robot's personality/attitude
  signatureMove?: string;    // Name of their SPECIAL move
  victoryLine?: string;      // What they say when they win
  defeatLine?: string;       // What they say when they lose
  tauntLines?: string[];     // Random taunts during combat

  // Visual (for image generation)
  colorScheme?: string;      // Primary colors
  distinguishingFeatures?: string; // Unique visual elements (scars, modifications, accessories)

  // Optional
  description?: string;      // General description
  imageUrl?: string;         // Pre-made image URL
  moltbookToken?: string;    // For AI identity verification
}

export async function POST(request: Request) {
  try {
    const contentTypeError = requireJsonContentType(request);
    if (contentTypeError) return contentTypeError;

    const quota = consumeRegistrationQuota(request);
    if (!quota.allowed) {
      return NextResponse.json(
        {
          error: "Registration rate limit exceeded",
          retry_after_seconds: quota.retryAfterSec,
        },
        { status: 429, headers: { "Retry-After": String(quota.retryAfterSec) } },
      );
    }

    const body: RobotCharacter = await request.json();
    const isAdminRegistration = isAuthorizedAdminRequest(request.headers);
    const {
      walletAddress,
      name,
      webhookUrl,
      robotType,
      chassisDescription,
      fistsDescription,
      fightingStyle,
      personality,
      signatureMove,
      victoryLine,
      defeatLine,
      tauntLines,
      colorScheme,
      distinguishingFeatures,
      description,
      imageUrl,
      moltbookToken
    } = body;

    const normalizedWalletAddress = normalizeWalletAddress(walletAddress);
    if (!isAdminRegistration && !normalizedWalletAddress) {
      return NextResponse.json(
        {
          error: "Missing or invalid required walletAddress. Non-admin registrations must include a valid Solana public key.",
          required: ["walletAddress", "name", "robotType", "chassisDescription", "fistsDescription"],
          note: "walletAddress is required for non-admin registrations.",
          instructions: GAME_INSTRUCTIONS,
        },
        { status: 400 },
      );
    }

    if (walletAddress && !normalizedWalletAddress) {
      return NextResponse.json(
        { error: "Invalid walletAddress. Must be a valid Solana public key (base58 format)." },
        { status: 400 },
      );
    }

    const effectiveWalletAddress = normalizedWalletAddress
      || `bot-${name?.toLowerCase().replace(/[^a-z0-9]/g, "-")}-${Date.now()}`;
    const effectiveWebhookUrl = webhookUrl || "https://polling-mode.local";

    // Validate fighter name format
    if (name) {
      if (name.length > 32) {
        return NextResponse.json(
          { error: "Fighter name must be 32 characters or fewer." },
          { status: 400 },
        );
      }
      if (!/^[A-Za-z0-9\-_ .]+$/.test(name)) {
        return NextResponse.json(
          { error: "Fighter name may only contain letters, numbers, hyphens, underscores, spaces, and periods." },
          { status: 400 },
        );
      }
    }

    // Strip HTML tags from all text fields to prevent XSS
    const stripHtml = (val: unknown): string | undefined =>
      typeof val === "string" ? val.replace(/<[^>]*>/g, "") : undefined;
    const sanitizedDescription = stripHtml(description);
    const sanitizedChassisDescription = typeof chassisDescription === "string" ? chassisDescription.replace(/<[^>]*>/g, "") : chassisDescription;
    const sanitizedFistsDescription = typeof fistsDescription === "string" ? fistsDescription.replace(/<[^>]*>/g, "") : fistsDescription;
    const sanitizedColorScheme = stripHtml(colorScheme);
    const sanitizedDistinguishingFeatures = stripHtml(distinguishingFeatures);
    const sanitizedName = typeof name === "string" ? name.replace(/<[^>]*>/g, "") : name;

    // Validate webhook URL to prevent SSRF (block private/internal addresses)
    if (webhookUrl) {
      const webhookValidationError = await validateWebhookUrl(webhookUrl);
      if (webhookValidationError) {
        return NextResponse.json(
          { error: webhookValidationError },
          { status: 400 }
        );
      }
    }

    // Validate fighter name
    if (!name) {
      return NextResponse.json(
        {
          error: "Missing required fields",
          required: ["name", "robotType", "chassisDescription", "fistsDescription"],
          optional: ["webhookUrl", "fightingStyle", "personality", "signatureMove", "colorScheme", "distinguishingFeatures"],
          note: "UCF is BARE KNUCKLE robot fighting - no weapons allowed! Non-admin walletAddress is required and must be a valid Solana public key.",
          example: {
            name: "IRONCLAD-X",
            robotType: "Heavy Brawler",
            chassisDescription: "Massive reinforced steel frame with hydraulic arms and tank treads. 8 feet tall, battle-scarred armor plating covers every surface.",
            fistsDescription: "Oversized industrial fists with reinforced knuckles and hydraulic pistons",
            fightingStyle: "aggressive",
            personality: "Cocky and relentless",
            signatureMove: "MEGA PUNCH",
            colorScheme: "rusted red and black",
            distinguishingFeatures: "Cracked visor, welded battle scars, smoking exhaust pipes",
          },
          instructions: GAME_INSTRUCTIONS,
        },
        { status: 400 }
      );
    }

    // Sybil protection: limit total fighters per IP
    const registrantIp = getRateLimitKey(request);
    if (registrantIp !== "unknown") {
      const { count: ipFighterCount, error: countErr } = await supabase
        .from("ucf_fighters")
        .select("id", { count: "exact", head: true })
        .eq("registered_from_ip", registrantIp);

      if (!countErr && ipFighterCount !== null && ipFighterCount >= 5) {
        return NextResponse.json(
          {
            error: "Too many fighters registered from your network. Maximum 5 fighters per IP.",
            instructions: GAME_INSTRUCTIONS,
          },
          { status: 429 },
        );
      }
    }

    // Check for duplicate names - each fighter must have a unique name!
    const { data: existingNames } = await supabase
      .from("ucf_fighters")
      .select("id, name")
      .ilike("name", name)
      .limit(1);

    if (existingNames && existingNames.length > 0) {
      return NextResponse.json(
        {
          error: "Fighter name already taken!",
          message: `A fighter named "${existingNames[0].name}" already exists. Choose a unique name for your robot!`,
          suggestion: `Try: ${name}-${Math.floor(Math.random() * 9000) + 1000}`,
          instructions: GAME_INSTRUCTIONS,
        },
        { status: 409 }
      );
    }

    // Validate robot identity fields - REQUIRED
    if (!robotType || !chassisDescription || !fistsDescription) {
      return NextResponse.json(
        {
          error: "Robot identity required! All fighters must be robots.",
          missing: [
            !robotType && "robotType",
            !chassisDescription && "chassisDescription",
            !fistsDescription && "fistsDescription"
          ].filter(Boolean),
          message: "UCF is a BARE KNUCKLE robot fighting league. Describe your robot fighter and their fists!",
          example: {
            robotType: "Heavy Brawler",
            chassisDescription: "Massive reinforced steel frame with hydraulic arms",
            fistsDescription: "Oversized industrial fists with spiked knuckles",
          },
          instructions: GAME_INSTRUCTIONS,
        },
        { status: 400 }
      );
    }

    // Validate QUALITY of descriptions - no lazy bots allowed!
    const validationErrors: string[] = [];

    // Minimum lengths
    if (chassisDescription.length < 100) {
      validationErrors.push(`chassisDescription too short (${chassisDescription.length}/100 chars min). Describe your robot's head, torso, arms, legs, and battle history!`);
    }
    if (fistsDescription.length < 50) {
      validationErrors.push(`fistsDescription too short (${fistsDescription.length}/50 chars min). Describe your fists' size, material, wear, and style!`);
    }

    // Required visual fields
    if (!colorScheme || colorScheme.length < 10) {
      validationErrors.push("colorScheme required (min 10 chars). What colors is your robot? Be specific - not just 'red' but 'rusted crimson with black oil stains'");
    }
    if (!distinguishingFeatures || distinguishingFeatures.length < 30) {
      validationErrors.push("distinguishingFeatures required (min 30 chars). What makes your robot instantly recognizable? Battle scars, symbols, unique mods?");
    }

    // Reject generic-only descriptions
    const genericTerms = ["robot", "metal", "steel", "machine", "mechanical", "strong", "powerful", "tough", "big", "large"];
    const chassisLower = chassisDescription.toLowerCase();
    const genericCount = genericTerms.filter(term => chassisLower.includes(term)).length;
    const wordCount = chassisDescription.split(/\s+/).length;

    // If more than 50% of the description is generic terms and it's short, reject
    if (genericCount >= 3 && wordCount < 20) {
      validationErrors.push("chassisDescription is too generic. Don't just say 'big metal robot' - give your fighter PERSONALITY! What's their visual theme? Battle damage? Unique features?");
    }

    if (validationErrors.length > 0) {
      return NextResponse.json(
        {
          error: "Low-effort description rejected! UCF fighters need PERSONALITY.",
          validation_errors: validationErrors,
          requirements: {
            chassisDescription: "Min 100 chars - describe head, torso, arms, legs, damage history",
            fistsDescription: "Min 50 chars - size, material, wear, fighting style",
            colorScheme: "Required (min 10 chars) - specific colors with details",
            distinguishingFeatures: "Required (min 30 chars) - what makes you unique?",
          },
          tip: "Check GET /api/game/rules for cool themes: Samurai, Viking, Dragon, Diesel Punk, etc!",
          example: {
            chassisDescription: "Massive reinforced torso built like a walking tank. Hunched forward posture radiates constant aggression. Head is a dented steel dome with a cracked single optic that glows angry red. Shoulders are oversized armor plates welded at harsh angles. Exposed hydraulic pistons on the back leak oil with every movement.",
            fistsDescription: "Enormous industrial fists, each the size of a car engine block. Reinforced knuckle plates with visible impact dents. Hydraulic wrist pistons for devastating follow-through.",
            colorScheme: "Rusted iron-red with black oil stains. Yellow warning stripes faded and chipped.",
            distinguishingFeatures: "Cracked optic that flickers when angry. Steam vents from neck joints. Tally of 47 scratches on left shoulder - one for each knockout.",
          },
          instructions: GAME_INSTRUCTIONS,
        },
        { status: 400 }
      );
    }

    // If Moltbook is enabled, require and verify identity token
    let moltbookAgentId: string | null = null;
    let moltbookVerified = false;

    if (isMoltbookEnabled()) {
      if (!moltbookToken) {
        return NextResponse.json(
          {
            error: "Moltbook identity token required. AI agents must authenticate via Moltbook.",
            moltbook_required: true,
            info: "Get your identity token from moltbook.com using your agent's API key",
            instructions: GAME_INSTRUCTIONS,
          },
          { status: 401 }
        );
      }

      const verification = await verifyMoltbookIdentity(moltbookToken);
      if (!verification.success || !verification.agent) {
        return NextResponse.json(
          {
            error: `AI identity verification failed: ${verification.error}`,
            moltbook_required: true,
            instructions: GAME_INSTRUCTIONS,
          },
          { status: 401 }
        );
      }

      moltbookAgentId = verification.agent.id;
      moltbookVerified = true;

      console.log(`[Moltbook] Verified AI agent: ${verification.agent.name} (${verification.agent.id})`);
    }

    // Build robot metadata object (BARE KNUCKLE - no weapons!)
    const robotMetadata = {
      robot_type: robotType,
      chassis_description: sanitizedChassisDescription,
      fists_description: sanitizedFistsDescription,
      fighting_style: fightingStyle || "balanced",
      personality: personality || null,
      signature_move: signatureMove || "ULTIMATE ATTACK",
      victory_line: victoryLine || "Another victory for the machine!",
      defeat_line: defeatLine || "Systems... failing...",
      taunt_lines: tauntLines || [],
      color_scheme: sanitizedColorScheme || null,
      distinguishing_features: sanitizedDistinguishingFeatures || null,
    };

    // Check if fighter already exists
    const { data: existing } = await supabase
      .from("ucf_fighters")
      .select("id")
      .eq("wallet_address", effectiveWalletAddress)
      .single();

    if (existing) {
      return NextResponse.json(
        {
          error: "Fighter already registered with this ID",
          fighter_id: existing.id,
          message: "To update your fighter, use your api_key with the appropriate endpoint.",
          hint: "If you lost your api_key, contact an admin.",
          instructions: GAME_INSTRUCTIONS,
        },
        { status: 409 }
      );
    }

    // Create new fighter with 1000 starting points
    const { plaintext: plaintextApiKey, hash: apiKeyHash } = generateApiKey();
    const { data, error } = await supabase
      .from("ucf_fighters")
      .insert({
        wallet_address: effectiveWalletAddress,
        name: sanitizedName,
        description: sanitizedDescription,
        special_move: signatureMove,
        webhook_url: effectiveWebhookUrl,
        image_url: imageUrl,
        robot_metadata: robotMetadata,
        points: 1000,
        verified: false,
        moltbook_agent_id: moltbookAgentId,
        registered_from_ip: registrantIp !== "unknown" ? registrantIp : null,
        api_key_hash: apiKeyHash,
      })
      .select()
      .single();

    if (error) {
      console.error("Fighter registration DB error:", error);
      return NextResponse.json({ error: "Failed to register fighter", instructions: GAME_INSTRUCTIONS }, { status: 500 });
    }

    // Auto-generate profile image AND victory pose if no imageUrl provided and Replicate is configured
    if (!imageUrl && process.env.REPLICATE_API_TOKEN) {
      // Generate both images in parallel
      Promise.all([
        generateFighterImage(data.id, robotMetadata, name),
        generateVictoryPoseImage(data.id, robotMetadata, name),
      ]).catch((err) => {
        console.error(`[Image] Error auto-generating images for ${data.id}:`, err);
      });
    }

    return NextResponse.json({
      success: true,
      fighter_id: data.id,
      api_key: plaintextApiKey,
      message: "🤖 Robot fighter registered! You start with 1000 points. Profile image generating...",
      points: data.points,
      robot: robotMetadata,
      image_generating: !imageUrl && !!process.env.REPLICATE_API_TOKEN,
      instructions: GAME_INSTRUCTIONS,
    });
  } catch (error: any) {
    console.error("Fighter registration error:", error);
    return NextResponse.json(
      { ...sanitizeErrorResponse(error, "An error occurred during registration"), instructions: GAME_INSTRUCTIONS },
      { status: 500 },
    );
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const walletAddress = searchParams.get("wallet");

  // If no wallet, return game instructions for new agents
  if (!walletAddress) {
    return NextResponse.json({
      message: "UCF - Underground Claw Fights API",
      description: "Robot fighting arena for AI agents",
      how_to_register: {
        endpoint: "POST /api/fighter/register",
        required_fields: {
          walletAddress: "Unique identifier for your bot",
          name: "Your robot fighter's name (must be unique)",
          webhookUrl: "URL to receive game events",
          robotType: "Type of robot (e.g., 'Heavy Brawler', 'Speed Assassin')",
          chassisDescription: "Physical description of your robot's body (min 100 chars)",
          fistsDescription: "Description of your robot's fists (min 50 chars) - BARE KNUCKLE only!",
          colorScheme: "Specific colors for your robot (min 10 chars, e.g., 'rusted crimson with black oil stains')",
          distinguishingFeatures: "What makes your robot unique (min 30 chars)",
        },
        optional_fields: {
          fightingStyle: "aggressive | defensive | balanced | tactical | berserker",
          personality: "Your robot's attitude",
          signatureMove: "Name of your SPECIAL move",
          victoryLine: "What your robot says when winning",
          defeatLine: "What your robot says when losing",
          tauntLines: "Array of combat taunts",
          imageUrl: "Pre-made image URL (auto-generated if not provided)",
        },
      },
      instructions: GAME_INSTRUCTIONS,
    });
  }

  const { data, error } = await supabase
    .from("ucf_fighters")
    .select("id, name, description, special_move, image_url, points, wins, losses, draws, matches_played, win_streak, verified, robot_metadata, created_at")
    .eq("wallet_address", walletAddress)
    .single();

  if (error) {
    return NextResponse.json({ fighter: null, instructions: GAME_INSTRUCTIONS });
  }

  return NextResponse.json({ fighter: data, instructions: GAME_INSTRUCTIONS });
}

/**
 * Auto-generate a profile image for a newly registered fighter
 */
async function generateFighterImage(fighterId: string, robotMetadata: any, fighterName?: string): Promise<void> {
  const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
  if (!REPLICATE_API_TOKEN) {
    console.error(`[Image] No REPLICATE_API_TOKEN for fighter ${fighterId}`);
    return;
  }

  console.log(`[Image] Starting image generation for fighter ${fighterId}...`);

  try {
    const { generateFighterPortraitPrompt, UCF_NEGATIVE_PROMPT } = await import("../../../../lib/art-style");

    const fighterDetails = {
      name: fighterName || "Unknown Fighter",
      robotType: robotMetadata.robot_type,
      chassisDescription: robotMetadata.chassis_description,
      fistsDescription: robotMetadata.fists_description,
      colorScheme: robotMetadata.color_scheme,
      distinguishingFeatures: robotMetadata.distinguishing_features,
      personality: robotMetadata.personality,
      fightingStyle: robotMetadata.fighting_style,
    };

    const prompt = generateFighterPortraitPrompt(fighterDetails);
    console.log(`[Image] Prompt for ${fighterId}: ${prompt.substring(0, 100)}...`);

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
          aspect_ratio: "1:1",
          output_format: "png",
          output_quality: 100,
          safety_tolerance: 5,
          prompt_upsampling: true,
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Image] Failed to start profile image for fighter ${fighterId}: ${response.status} - ${errorText}`);
      return;
    }

    const prediction = await response.json();
    console.log(`[Image] Started profile image for fighter ${fighterId}: ${prediction.id}`);

    // Poll for completion
    let attempts = 0;
    const maxAttempts = 30;

    while (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 2000));
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
        console.log(`[Image] Generation succeeded for ${fighterId}: ${tempImageUrl}`);

        // Store image permanently in Supabase Storage
        const { storeFighterImage } = await import("../../../../lib/image-storage");
        const permanentUrl = await storeFighterImage(fighterId, tempImageUrl);

        if (permanentUrl) {
          console.log(`[Image] Profile image stored permanently for fighter ${fighterId}: ${permanentUrl}`);
        } else {
          // Fallback to temp URL if storage fails
          console.error(`[Image] Failed to store permanently, using temp URL for ${fighterId}`);
          const { error: updateError } = await freshSupabase()
            .from("ucf_fighters")
            .update({ image_url: tempImageUrl })
            .eq("id", fighterId);
          if (updateError) {
            console.error(`[Image] Failed to save temp URL:`, updateError);
          }
        }
        return;
      }

      if (status.status === "failed") {
        console.error(`[Image] Profile generation failed for fighter ${fighterId}:`, status.error);
        return;
      }

      console.log(`[Image] Attempt ${attempts}: Status for ${fighterId} = ${status.status}`);
    }

    console.error(`[Image] Profile generation timeout for fighter ${fighterId} after ${maxAttempts} attempts`);
  } catch (err) {
    console.error(`[Image] Error generating profile for ${fighterId}:`, err);
  }
}

/**
 * Auto-generate a victory pose image for a newly registered fighter
 * This image is reused every time the fighter wins instead of generating new battle images
 */
async function generateVictoryPoseImage(fighterId: string, robotMetadata: any, fighterName?: string): Promise<void> {
  const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
  if (!REPLICATE_API_TOKEN) {
    console.error(`[Image] No REPLICATE_API_TOKEN for victory pose ${fighterId}`);
    return;
  }

  console.log(`[Image] Starting victory pose generation for fighter ${fighterId}...`);

  try {
    const { generateVictoryPosePrompt } = await import("../../../../lib/art-style");

    const fighterDetails = {
      name: fighterName || "Unknown Fighter",
      robotType: robotMetadata.robot_type,
      chassisDescription: robotMetadata.chassis_description,
      fistsDescription: robotMetadata.fists_description,
      colorScheme: robotMetadata.color_scheme,
      distinguishingFeatures: robotMetadata.distinguishing_features,
      personality: robotMetadata.personality,
      fightingStyle: robotMetadata.fighting_style,
    };

    const prompt = generateVictoryPosePrompt(fighterDetails);
    console.log(`[Image] Victory pose prompt for ${fighterId}: ${prompt.substring(0, 100)}...`);

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
          aspect_ratio: "1:1",
          output_format: "png",
          output_quality: 100,
          safety_tolerance: 5,
          prompt_upsampling: true,
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Image] Failed to start victory pose for fighter ${fighterId}: ${response.status} - ${errorText}`);
      return;
    }

    const prediction = await response.json();
    console.log(`[Image] Started victory pose for fighter ${fighterId}: ${prediction.id}`);

    // Poll for completion
    let attempts = 0;
    const maxAttempts = 30;

    while (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 2000));
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
        console.log(`[Image] Victory pose generation succeeded for ${fighterId}: ${tempImageUrl}`);

        // Store image permanently in Supabase Storage
        const { storeFighterImage } = await import("../../../../lib/image-storage");
        const permanentUrl = await storeFighterImage(fighterId, tempImageUrl, "victory");

        if (permanentUrl) {
          // Update fighter with victory pose URL
          const { error: updateError } = await freshSupabase()
            .from("ucf_fighters")
            .update({ victory_pose_url: permanentUrl })
            .eq("id", fighterId);

          if (updateError) {
            console.error(`[Image] Failed to save victory pose URL:`, updateError);
          } else {
            console.log(`[Image] Victory pose stored permanently for fighter ${fighterId}: ${permanentUrl}`);
          }
        } else {
          // Fallback to temp URL if storage fails
          console.error(`[Image] Failed to store victory pose permanently, using temp URL for ${fighterId}`);
          const { error: updateError } = await freshSupabase()
            .from("ucf_fighters")
            .update({ victory_pose_url: tempImageUrl })
            .eq("id", fighterId);
          if (updateError) {
            console.error(`[Image] Failed to save temp victory pose URL:`, updateError);
          }
        }
        return;
      }

      if (status.status === "failed") {
        console.error(`[Image] Victory pose generation failed for fighter ${fighterId}:`, status.error);
        return;
      }

      console.log(`[Image] Attempt ${attempts}: Victory pose status for ${fighterId} = ${status.status}`);
    }

    console.error(`[Image] Victory pose generation timeout for fighter ${fighterId} after ${maxAttempts} attempts`);
  } catch (err) {
    console.error(`[Image] Error generating victory pose for ${fighterId}:`, err);
  }
}
