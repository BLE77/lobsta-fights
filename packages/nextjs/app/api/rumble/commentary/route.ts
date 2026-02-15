import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
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
const COMMENTARY_CLIP_TTL_MS = 5 * 60 * 1000;
const COMMENTARY_CLIP_CACHE_MAX = 400;

interface CommentaryClip {
  commentary: string;
  audio: Uint8Array;
  createdAt: number;
}

type CommentaryClipCache = Map<string, CommentaryClip>;
type CommentaryInflightMap = Map<string, Promise<CommentaryClip>>;

const g = globalThis as unknown as {
  __rumbleCommentaryClipCache?: CommentaryClipCache;
  __rumbleCommentaryInflight?: CommentaryInflightMap;
};

function getClipCache(): CommentaryClipCache {
  if (!g.__rumbleCommentaryClipCache) {
    g.__rumbleCommentaryClipCache = new Map();
  }
  return g.__rumbleCommentaryClipCache;
}

function getInflightMap(): CommentaryInflightMap {
  if (!g.__rumbleCommentaryInflight) {
    g.__rumbleCommentaryInflight = new Map();
  }
  return g.__rumbleCommentaryInflight;
}

function pruneClipCache(cache: CommentaryClipCache): void {
  const now = Date.now();
  for (const [key, clip] of cache) {
    if (now - clip.createdAt > COMMENTARY_CLIP_TTL_MS) {
      cache.delete(key);
    }
  }
  if (cache.size <= COMMENTARY_CLIP_CACHE_MAX) return;
  const ordered = [...cache.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
  const drop = cache.size - COMMENTARY_CLIP_CACHE_MAX;
  for (let i = 0; i < drop; i += 1) {
    cache.delete(ordered[i][0]);
  }
}

function normalizeClipKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 180);
}

function buildCacheKey(
  eventType: CommentaryEventType,
  voiceId: string,
  context: string,
  clipKey?: string,
): string {
  const stableClipKey =
    clipKey && clipKey.trim().length > 0
      ? normalizeClipKey(clipKey)
      : createHash("sha1").update(`${eventType}|${context}`).digest("hex").slice(0, 20);
  return `${normalizeClipKey(voiceId)}:${eventType}:${stableClipKey}`;
}

function tightenCommentaryLine(commentary: string): string {
  const compact = commentary.replace(/\s+/g, " ").trim();
  if (!compact) return compact;
  const firstSentence = compact.split(/(?<=[.!?])\s+/).filter(Boolean)[0] ?? compact;
  const words = firstSentence.split(/\s+/).filter(Boolean);
  const trimmedWords = words.slice(0, 18).join(" ");
  let output = trimmedWords.trim();
  if (!/[.!?]$/.test(output)) output += "!";
  return output.length > 170 ? `${output.slice(0, 169).trim()}!` : output;
}

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

let cachedSystemPrompt: string | null = null;
let systemPromptLoaded = false;

function stripFrontMatter(raw: string): string {
  if (!raw.startsWith("---")) return raw.trim();
  const closing = raw.indexOf("\n---", 3);
  if (closing === -1) return raw.trim();
  return raw.slice(closing + 4).trim();
}

async function getAnnouncerSystemPrompt(): Promise<string> {
  if (systemPromptLoaded) return cachedSystemPrompt ?? ANNOUNCER_SYSTEM_PROMPT;
  systemPromptLoaded = true;

  const configuredPath = process.env.RUMBLE_COMMENTARY_PROMPT_PATH;
  if (!configuredPath) {
    cachedSystemPrompt = ANNOUNCER_SYSTEM_PROMPT;
    return cachedSystemPrompt;
  }

  const resolvedPath = path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(process.cwd(), configuredPath);
  try {
    const raw = await readFile(resolvedPath, "utf8");
    const normalized = stripFrontMatter(raw);
    if (normalized.length > 0) {
      cachedSystemPrompt = normalized;
      return cachedSystemPrompt;
    }
  } catch (error) {
    console.warn(`[commentary] Failed loading custom prompt from ${resolvedPath}; using default prompt.`);
  }

  cachedSystemPrompt = ANNOUNCER_SYSTEM_PROMPT;
  return cachedSystemPrompt;
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

function clipResponse(clip: CommentaryClip, cacheState: "HIT" | "MISS"): Response {
  return new Response(clip.audio.slice(), {
    status: 200,
    headers: {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "no-store",
      "X-Commentary-Text": encodeURIComponent(clip.commentary),
      "X-Commentary-Cache": cacheState,
    },
  });
}

// ---------------------------------------------------------------------------
// Valid event types
// ---------------------------------------------------------------------------

const VALID_EVENT_TYPES = new Set<CommentaryEventType>([
  "betting_open",
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
  // Commentary can fire repeatedly during betting/combat; use higher tier.
  const rlKey = getRateLimitKey(request);
  const rl = checkRateLimit("AUTHENTICATED", rlKey);
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
      clipKey?: string;
    };
    const clipKeyRaw = typeof (body as any).clipKey === "string" ? (body as any).clipKey : undefined;

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

    const requestedVoice = getVoiceId(voiceId);
    const cacheKey = buildCacheKey(
      eventType as CommentaryEventType,
      requestedVoice,
      context,
      clipKeyRaw,
    );
    const clipCache = getClipCache();
    pruneClipCache(clipCache);
    const cachedClip = clipCache.get(cacheKey);
    if (cachedClip && Date.now() - cachedClip.createdAt <= COMMENTARY_CLIP_TTL_MS) {
      return clipResponse(cachedClip, "HIT");
    }

    const inflight = getInflightMap();
    let task = inflight.get(cacheKey);
    if (!task) {
      task = (async (): Promise<CommentaryClip> => {
        let commentary = "";
        if (getCommentaryMode() === "llm") {
          const prompt = buildCommentaryPrompt(
            eventType as CommentaryEventType,
            context,
            sanitizedAllowedNames,
          );
          const anthropic = getAnthropic();
          const systemPrompt = await getAnnouncerSystemPrompt();
          const msg = await anthropic.messages.create({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 90,
            temperature: 0,
            system: systemPrompt,
            messages: [{ role: "user", content: prompt }],
          });
          commentary = msg.content[0]?.type === "text" ? msg.content[0].text.trim() : "";
        } else {
          commentary = buildGroundedCommentary(context);
        }

        if (!commentary) commentary = buildGroundedCommentary(context);
        commentary = tightenCommentaryLine(commentary);
        if (!commentary) {
          throw new Error("Commentary text was empty");
        }

        let ttsRes = await requestTts(requestedVoice, commentary);
        let errText = ttsRes.ok ? "" : await ttsRes.text().catch(() => "unknown");

        if (!ttsRes.ok && errText.includes("voice_limit_reached") && requestedVoice !== ELEVENLABS_FALLBACK_VOICE) {
          console.warn("[commentary] voice_limit_reached; retrying with fallback voice");
          ttsRes = await requestTts(ELEVENLABS_FALLBACK_VOICE, commentary);
          errText = ttsRes.ok ? "" : await ttsRes.text().catch(() => "unknown");
        }

        if (!ttsRes.ok) {
          throw new Error(`TTS generation failed (${ttsRes.status}): ${errText}`);
        }

        const audio = new Uint8Array(await ttsRes.arrayBuffer());
        if (audio.length === 0) {
          throw new Error("TTS response was empty");
        }

        const clip: CommentaryClip = {
          commentary,
          audio,
          createdAt: Date.now(),
        };
        clipCache.set(cacheKey, clip);
        pruneClipCache(clipCache);
        return clip;
      })()
        .finally(() => {
          inflight.delete(cacheKey);
        });
      inflight.set(cacheKey, task);
    }

    const clip = await task;
    return clipResponse(clip, "MISS");
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
