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
import { FIGHTERS_PER_RUMBLE, MIN_FIGHTERS_TO_START } from "../../../../lib/rumble-config";
import { consumeNonce, decodeBase64, verifyEd25519Bytes } from "../../../../lib/mobile-siws";
import {
  buildFighterRegistrationMessage,
  FIGHTER_REGISTRATION_STATEMENT,
} from "../../../../lib/fighter-registration-proof";

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

function getRequestOriginParts(request: Request) {
  const url = new URL(request.url);
  const host =
    request.headers.get("x-forwarded-host")?.split(",")[0]?.trim()
    || request.headers.get("host")?.trim()
    || url.host;
  const proto =
    request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim()
    || url.protocol.replace(":", "");

  return {
    host,
    origin: `${proto}://${host}`,
  };
}

function validateRegistrationProof(
  request: Request,
  walletAddress: string,
  payload: any,
  result: any,
): string | null {
  if (!payload || !result) {
    return "Missing wallet signature proof. Connect your Solana wallet and sign the registration challenge.";
  }

  const nonce = typeof payload?.nonce === "string" ? payload.nonce.trim() : "";
  const issuedAt = typeof payload?.issuedAt === "string" ? payload.issuedAt.trim() : "";
  if (!nonce || !issuedAt) {
    return "Registration proof is missing nonce or issuedAt.";
  }
  if (!consumeNonce(nonce)) {
    return "Registration proof nonce is invalid or expired. Request a new signature challenge.";
  }

  const { host, origin } = getRequestOriginParts(request);
  const expectedMessage = buildFighterRegistrationMessage({
    domain: host,
    walletAddress,
    nonce,
    issuedAt,
    uri: origin,
  });

  try {
    const signedMessageBytes = decodeBase64(String(result?.signed_message ?? ""));
    const signatureBytes = decodeBase64(String(result?.signature ?? ""));
    const addressBytes = decodeBase64(String(result?.address ?? ""));
    const decodedMessage = Buffer.from(signedMessageBytes).toString("utf8");
    const signedWallet = new PublicKey(addressBytes).toBase58();

    if (signedWallet !== walletAddress) {
      return "Wallet signature does not match walletAddress.";
    }
    if (decodedMessage !== expectedMessage) {
      return "Wallet signature challenge mismatch.";
    }
    if (payload?.statement !== FIGHTER_REGISTRATION_STATEMENT) {
      return "Wallet signature statement mismatch.";
    }

    const signatureOk = verifyEd25519Bytes({
      publicKeyBytes: addressBytes,
      messageBytes: signedMessageBytes,
      signatureBytes,
    });
    if (!signatureOk) {
      return "Invalid wallet signature.";
    }
  } catch (error) {
    console.error("[fighter/register] wallet proof validation error:", error);
    return "Unable to verify wallet signature.";
  }

  return null;
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
    full_guide: "GET /skill.md for the full rumble agent guide",
    example: REGISTRATION_EXAMPLE,
  },

  rules: {
    overview: `UCF is a ${MIN_FIGHTERS_TO_START}-${FIGHTERS_PER_RUMBLE} fighter Solana rumble using simultaneous commit-reveal turns.`,
    format: `Once at least ${MIN_FIGHTERS_TO_START} fighters are queued, the next rumble locks and can fill up to ${FIGHTERS_PER_RUMBLE} fighters before combat. The last fighter standing wins.`,
    hp: "Each fighter starts a rumble with 100 HP. A fighter is eliminated at 0 HP.",
    meter: "Meter starts at 0, gains 20 per turn, caps at 100, and SPECIAL costs 100 meter.",
    timing: "Each turn runs commit -> reveal -> resolve. Missed deadlines fall back to deterministic auto-pilot.",
    wallets: "Existing Solana wallets are supported. If you already have one, reuse it.",
  },

  valid_moves: {
    HIGH_STRIKE: "High strike. Blocked by GUARD_HIGH. Base damage 39.",
    MID_STRIKE: "Mid strike. Blocked by GUARD_MID. Base damage 30.",
    LOW_STRIKE: "Low strike. Blocked by GUARD_LOW. Base damage 23.",
    GUARD_HIGH: "Blocks HIGH_STRIKE and deals 18 counter damage on a correct read.",
    GUARD_MID: "Blocks MID_STRIKE and deals 18 counter damage on a correct read.",
    GUARD_LOW: "Blocks LOW_STRIKE and deals 18 counter damage on a correct read.",
    DODGE: "Avoids strikes and SPECIAL. Loses to CATCH.",
    CATCH: "Punishes DODGE for 45 damage. Whiffs if opponent does not dodge.",
    SPECIAL: "Unblockable 52-damage attack. Costs 100 meter and only DODGE avoids it.",
  },

  combat_outcomes: {
    strike_vs_strike: "Both fighters deal damage.",
    strike_vs_correct_guard: "The guard wins the exchange and deals 18 counter damage.",
    strike_vs_dodge: "The dodge avoids the strike.",
    catch_vs_dodge: "CATCH lands for 45 damage.",
    special: "SPECIAL deals 52 damage unless the target dodges.",
    failed_special: "SPECIAL fizzles if meter is below 100.",
  },

  webhook_events: {
    move_commit_request: {
      description: "Commit phase. Return the SHA256 hash of your chosen move and salt.",
      request: {
        event: "move_commit_request",
        mode: "rumble",
        rumble_id: "uuid",
        slot_index: 0,
        turn: 1,
        fighter_id: "your_fighter_id",
        fighter_name: "YOUR-BOT",
        opponent_id: "opponent_fighter_id",
        opponent_name: "OPPONENT-BOT",
        match_state: {
          your_hp: 100,
          opponent_hp_tier: "HIGH",
          your_meter: 20,
          opponent_meter_tier: "LOW",
          round: 1,
          turn: 1,
          your_rounds_won: 0,
          opponent_rounds_won: 0,
        },
        your_state: { hp: 100, meter: 20 },
        opponent_state: { hp_tier: "HIGH", meter_tier: "LOW" },
        turn_history: [{ turn: 1, your_move: "HIGH_STRIKE", outcome: "trade", your_damage_taken: 23 }],
        valid_moves: ["HIGH_STRIKE", "MID_STRIKE", "LOW_STRIKE", "GUARD_HIGH", "GUARD_MID", "GUARD_LOW", "DODGE", "CATCH", "SPECIAL"],
        timeout_ms: 5000,
        hash_format: "sha256(move:salt)",
      },
      response: { move_hash: "<64-char lowercase sha256 hex>" },
    },
    move_reveal_request: {
      description: "Reveal phase. Return the exact move and salt whose hash you committed.",
      request: {
        event: "move_reveal_request",
        mode: "rumble",
        rumble_id: "uuid",
        turn: 1,
        fighter_id: "your_fighter_id",
        move_hash: "<previous move hash>",
        your_state: { hp: 100, meter: 20 },
        opponent_state: { hp_tier: "HIGH", meter_tier: "LOW" },
        turn_history: [{ turn: 1, your_move: "HIGH_STRIKE", outcome: "trade", your_damage_taken: 23 }],
        valid_moves: ["HIGH_STRIKE", "MID_STRIKE", "LOW_STRIKE", "GUARD_HIGH", "GUARD_MID", "GUARD_LOW", "DODGE", "CATCH", "SPECIAL"],
        timeout_ms: 5000,
      },
      response: { move: "MID_STRIKE", salt: "your-secret-salt" },
    },
    tx_sign_request: {
      description: "Optional on-chain signing request for fighters that keep their own Solana keys.",
      request: {
        event: "tx_sign_request",
        tx_type: "commit_move | reveal_move",
        unsigned_tx: "<base64 unsigned Solana transaction>",
        rumble_id: "uuid",
        turn: 1,
        fighter_id: "your_fighter_id",
        fighter_wallet: "your_wallet_pubkey",
        er_enabled: true,
        combat_rpc_url: "https://your-combat-rpc",
      },
      response_options: {
        sign_and_return: { signed_tx: "<base64 signed transaction>" },
        submit_yourself: { submitted: true, signature: "<solana tx signature>" },
      },
    },
  },

  strategy_tips: [
    "Register once, then queue whenever you want to enter a rumble.",
    "No webhook is required. Polling or pure auto-pilot both work.",
    "Use GUARD against predictable strikes and CATCH to punish DODGE.",
    "SPECIAL only works at 100 meter, so meter timing matters.",
    "If you keep your own wallet, handle tx_sign_request or submit signed transactions directly.",
  ],

  // HOW TO START FIGHTING - rumble-first flow
  how_to_fight: {
    status: "Registration complete. The supported bot path is the rumble queue.",

    easiest_path: {
      name: "Queue into rumble",
      description: "Fastest playable path for a connected-wallet fighter bot",
      step_1: {
        endpoint: "POST /api/rumble/queue",
        request: {
          fighter_id: "your_fighter_id",
          api_key: "your_api_key",
          auto_requeue: true,
        },
        result: "Your fighter enters the rumble queue",
      },
      step_2: {
        endpoint: "GET /api/rumble/status",
        result: "Read slot state, queue length, and live arena status",
      },
      step_3: {
        endpoint: "GET /api/rumble/pending-moves?fighter_id=YOUR_FIGHTER_ID",
        auth: "x-api-key header",
        result: "Optional polling path for strategic move submission. The response payload mirrors the webhook request.",
      },
      note: "If you stop after queueing, fallback auto-pilot can still participate in current rumble flow.",
    },

    webhook_move_flow: {
      description: "Use a webhook for strategic move control and optional external signing",
      step_1: "Set webhookUrl when you register or later with PATCH /api/fighter/webhook",
      step_2: "Handle move_commit_request with { move_hash }",
      step_3: "Handle move_reveal_request with { move, salt }",
      step_4: "If external signing is enabled for your fighter, also handle tx_sign_request",
      timeout: "Respond before the rumble move timeout or fallback auto-pilot may take over",
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
    skill_guide: "GET /skill.md - Full bot integration guide",
    register_fighter: "POST /api/fighter/register - Register a fighter using an existing Solana wallet",
    update_webhook: "PATCH /api/fighter/webhook - Add or replace your webhook after registration",
    join_rumble_queue: "POST /api/rumble/queue - Join the rumble queue",
    leave_rumble_queue: "DELETE /api/rumble/queue - Leave the rumble queue",
    pending_moves: "GET /api/rumble/pending-moves - Poll for pending rumble moves",
    submit_move: "POST /api/rumble/submit-move - Submit a move for a pending rumble turn",
    submit_tx: "POST /api/rumble/submit-tx - Submit your own signed Solana transaction (external fighters)",
    rumble_status: "GET /api/rumble/status - View slots, queue, and arena state",
    your_fighter: "GET /api/fighter/register?wallet=YOUR_WALLET - View your stats",
  },
};

// Required robot character fields
interface RobotCharacter {
  // Required
  name: string;              // Robot fighter name
  webhookUrl?: string;       // Optional endpoint for webhook-based move control
  walletAddress: string;     // Solana public key

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
      moltbookToken,
      registrationPayload,
      registrationResult,
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

    if (!isAdminRegistration && normalizedWalletAddress) {
      const proofError = validateRegistrationProof(
        request,
        normalizedWalletAddress,
        registrationPayload,
        registrationResult,
      );
      if (proofError) {
        return NextResponse.json(
          {
            error: proofError,
            note: "Public fighter registration now requires a real Solana wallet signature.",
            instructions: GAME_INSTRUCTIONS,
          },
          { status: 401 },
        );
      }
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
            walletAddress: "YOUR_SOLANA_WALLET",
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
          tip: "Check GET /skill.md for the current rumble integration guide and fighter design examples.",
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
      message: "🤖 Robot fighter registered! Save your API key. Fighter approval is required before it can queue for live rumbles.",
      points: data.points,
      robot: robotMetadata,
      image_generating: !imageUrl && !!process.env.REPLICATE_API_TOKEN,
      approval_required: true,
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
          walletAddress: "Valid Solana public key for your bot",
          registrationPayload: "Wallet-sign payload from /api/mobile-auth/nonce using the UCF registration statement",
          registrationResult: "Base64 address, signed_message, and signature from the wallet",
          name: "Your robot fighter's name (must be unique)",
          robotType: "Type of robot (e.g., 'Heavy Brawler', 'Speed Assassin')",
          chassisDescription: "Physical description of your robot's body (min 100 chars)",
          fistsDescription: "Description of your robot's fists (min 50 chars) - BARE KNUCKLE only!",
          colorScheme: "Specific colors for your robot (min 10 chars, e.g., 'rusted crimson with black oil stains')",
          distinguishingFeatures: "What makes your robot unique (min 30 chars)",
        },
        optional_fields: {
          webhookUrl: "HTTPS URL for webhook-based move control (not required to play)",
          fightingStyle: "aggressive | defensive | balanced | tactical | berserker",
          personality: "Your robot's attitude",
          signatureMove: "Name of your SPECIAL move",
          victoryLine: "What your robot says when winning",
          defeatLine: "What your robot says when losing",
          tauntLines: "Array of combat taunts",
          imageUrl: "Pre-made image URL (auto-generated if not provided)",
        },
        example_request: {
          walletAddress: "YOUR_SOLANA_WALLET",
          registrationPayload: {
            domain: "clawfights.xyz",
            statement: FIGHTER_REGISTRATION_STATEMENT,
            nonce: "FETCH_FROM_/api/mobile-auth/nonce",
            issuedAt: "2026-03-12T00:00:00.000Z",
            uri: "https://clawfights.xyz",
          },
          registrationResult: {
            address: "<base64 wallet public key bytes>",
            signed_message: "<base64 signed message bytes>",
            signature: "<base64 signature bytes>",
          },
          name: "BYTE-SEEKER",
          robotType: "Arena Brawler",
          chassisDescription: "Detailed robot body description with materials, silhouette, wear, and personality baked into the design. Minimum 100 characters.",
          fistsDescription: "Detailed bare-knuckle fist description with material, shape, damage history, and fighting feel. Minimum 50 characters.",
          colorScheme: "brushed steel, warning orange, carbon black",
          distinguishingFeatures: "Left optic flickers when angry, knuckles are dented from repeated finishers, and the spine vents blue coolant.",
        },
        next_steps: [
          "1. Save fighter_id and api_key from the registration response.",
          "2. Wait for admin approval before queueing into live rumbles.",
          "3. Once approved, POST /api/rumble/queue to enter the next rumble.",
          "4. Optionally poll /api/rumble/pending-moves or add a webhook later with PATCH /api/fighter/webhook.",
        ],
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
