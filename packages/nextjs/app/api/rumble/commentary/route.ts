import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import {
  checkRateLimit,
  getRateLimitKey,
  rateLimitResponse,
} from "~~/lib/rate-limit";
import {
  ANNOUNCER_SYSTEM_PROMPT,
  buildCommentaryPrompt,
  buildGroundedCommentary,
} from "~~/lib/commentary";
import type { CommentaryEventType } from "~~/lib/commentary";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Lazy-init Anthropic client (avoids crash when env vars are missing at build)
// ---------------------------------------------------------------------------

let _anthropic: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (!_anthropic) {
    _anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  }
  return _anthropic;
}

// ---------------------------------------------------------------------------
// ElevenLabs config
// ---------------------------------------------------------------------------

const ELEVENLABS_API_URL = "https://api.elevenlabs.io/v1/text-to-speech";
const ELEVENLABS_MODEL = "eleven_flash_v2_5";
const ELEVENLABS_FALLBACK_VOICE = "21m00Tcm4TlvDq8ikWAM"; // public default voice

function getElevenLabsKey(): string {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("ELEVENLABS_API_KEY not set");
  return key;
}

function getCommentaryConfigError(): string | null {
  if (!process.env.ELEVENLABS_API_KEY) {
    return "Commentary is unavailable: missing ELEVENLABS_API_KEY.";
  }
  if (getCommentaryMode() === "llm" && !process.env.ANTHROPIC_API_KEY) {
    return "Commentary is unavailable: missing ANTHROPIC_API_KEY.";
  }
  return null;
}

type CommentaryMode = "grounded" | "llm";
function getCommentaryMode(): CommentaryMode {
  const raw = String(process.env.RUMBLE_COMMENTARY_MODE ?? "grounded").trim().toLowerCase();
  return raw === "llm" ? "llm" : "grounded";
}

function getVoiceId(requested?: string): string {
  if (requested) return requested;
  return process.env.ELEVENLABS_VOICE_A ?? "QMJTqaMXmGnG8TCm8WQG";
}

async function requestTts(voice: string, text: string): Promise<Response> {
  return fetch(`${ELEVENLABS_API_URL}/${voice}/stream`, {
    method: "POST",
    headers: {
      "xi-api-key": getElevenLabsKey(),
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text,
      model_id: ELEVENLABS_MODEL,
      output_format: "mp3_44100_128",
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
      },
    }),
  });
}

// ---------------------------------------------------------------------------
// Valid event types
// ---------------------------------------------------------------------------

const VALID_EVENT_TYPES = new Set<CommentaryEventType>([
  "big_hit",
  "elimination",
  "combat_start",
  "rumble_complete",
  "payout",
  "ichor_shower",
]);

// ---------------------------------------------------------------------------
// POST /api/rumble/commentary
// ---------------------------------------------------------------------------

export async function POST(request: Request) {
  // Rate limit: 10 requests per minute per IP (use PUBLIC_WRITE tier)
  const rlKey = getRateLimitKey(request);
  const rl = checkRateLimit("PUBLIC_WRITE", rlKey);
  if (!rl.allowed) {
    return rateLimitResponse(rl.retryAfterMs);
  }

  const configError = getCommentaryConfigError();
  if (configError) {
    return NextResponse.json(
      {
        error: configError,
        code: "COMMENTARY_NOT_CONFIGURED",
      },
      { status: 503 },
    );
  }

  try {
    const body = await request.json();
    const { eventType, context, voiceId, allowedNames } = body as {
      eventType?: string;
      context?: string;
      voiceId?: string;
      allowedNames?: unknown;
    };

    // Validate
    if (!eventType || !VALID_EVENT_TYPES.has(eventType as CommentaryEventType)) {
      return NextResponse.json(
        { error: `Invalid eventType. Must be one of: ${[...VALID_EVENT_TYPES].join(", ")}` },
        { status: 400 },
      );
    }
    if (!context || typeof context !== "string" || context.length > 1000) {
      return NextResponse.json(
        { error: "context is required and must be under 1000 characters" },
        { status: 400 },
      );
    }

    const sanitizedAllowedNames = Array.isArray(allowedNames)
      ? [...new Set(allowedNames
          .filter((name): name is string => typeof name === "string")
          .map((name) => name.trim())
          .filter((name) => name.length > 0)
          .slice(0, 24))]
      : [];

    // 1. Generate commentary text (strict grounded by default)
    let commentary = "";
    if (getCommentaryMode() === "llm") {
      const prompt = buildCommentaryPrompt(
        eventType as CommentaryEventType,
        context,
        sanitizedAllowedNames,
      );
      const anthropic = getAnthropic();
      const msg = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 150,
        temperature: 0,
        system: ANNOUNCER_SYSTEM_PROMPT,
        messages: [{ role: "user", content: prompt }],
      });
      commentary = msg.content[0]?.type === "text" ? msg.content[0].text.trim() : "";
    } else {
      commentary = buildGroundedCommentary(context);
    }

    if (!commentary) {
      commentary = buildGroundedCommentary(context);
    }
    if (!commentary) {
      return NextResponse.json({ error: "Commentary text was empty" }, { status: 503 });
    }

    // 2. Convert to speech via ElevenLabs streaming TTS
    const requestedVoice = getVoiceId(voiceId);
    let ttsRes = await requestTts(requestedVoice, commentary);
    let errText = ttsRes.ok ? "" : await ttsRes.text().catch(() => "unknown");

    // Retry once with a known public voice if account-specific voice limits block the request.
    if (!ttsRes.ok && errText.includes("voice_limit_reached") && requestedVoice !== ELEVENLABS_FALLBACK_VOICE) {
      console.warn("[commentary] voice_limit_reached; retrying with fallback voice");
      ttsRes = await requestTts(ELEVENLABS_FALLBACK_VOICE, commentary);
      errText = ttsRes.ok ? "" : await ttsRes.text().catch(() => "unknown");
    }

    if (!ttsRes.ok) {
      console.error("[commentary] ElevenLabs error:", ttsRes.status, errText);
      return NextResponse.json(
        {
          error: "Commentary provider unavailable (TTS generation failed).",
          code: "COMMENTARY_PROVIDER_ERROR",
          details: errText,
        },
        { status: 503 },
      );
    }

    // 3. Stream audio back to client
    const audioBody = ttsRes.body;
    if (!audioBody) {
      return NextResponse.json(
        {
          error: "Commentary provider unavailable (empty TTS body).",
          code: "COMMENTARY_PROVIDER_ERROR",
        },
        { status: 503 },
      );
    }

    return new Response(audioBody as any, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
        "X-Commentary-Text": encodeURIComponent(commentary),
      },
    });
  } catch (err: any) {
    console.error("[commentary] Error:", err);
    return NextResponse.json(
      {
        error: err?.message ?? "Commentary provider unavailable.",
        code: "COMMENTARY_PROVIDER_ERROR",
      },
      { status: 503 },
    );
  }
}
