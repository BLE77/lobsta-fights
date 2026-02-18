// ---------------------------------------------------------------------------
// Server-side commentary generator — shared between API route & Railway worker
//
// Generates commentary text (grounded or LLM) and TTS audio, optionally
// uploads to Supabase Storage so all clients play the same clip.
// ---------------------------------------------------------------------------

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import {
  ANNOUNCER_SYSTEM_PROMPT,
  buildCommentaryPrompt,
  buildGroundedCommentary,
  type CommentaryEventType,
} from "./commentary";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ELEVENLABS_API_URL = "https://api.elevenlabs.io/v1/text-to-speech";
const ELEVENLABS_MODEL = "eleven_flash_v2_5";
const ELEVENLABS_FALLBACK_VOICE = "21m00Tcm4TlvDq8ikWAM";
const STORAGE_BUCKET = "commentary-clips";

// ---------------------------------------------------------------------------
// Lazy singletons
// ---------------------------------------------------------------------------

let _anthropic: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (!_anthropic) _anthropic = new Anthropic();
  return _anthropic;
}

const noStoreFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, cache: "no-store" });

function freshServiceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing Supabase env vars");
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: noStoreFetch },
  });
}

// ---------------------------------------------------------------------------
// Text generation
// ---------------------------------------------------------------------------

type CommentaryMode = "grounded" | "llm";

function getCommentaryMode(): CommentaryMode {
  const raw = String(process.env.RUMBLE_COMMENTARY_MODE ?? "grounded").trim().toLowerCase();
  return raw === "llm" ? "llm" : "grounded";
}

function tightenCommentaryLine(commentary: string): string {
  const compact = commentary.replace(/\s+/g, " ").trim();
  if (!compact) return compact;
  const sentences = compact.split(/(?<=[.!?])\s+/).filter(Boolean);
  const kept = sentences.slice(0, 3).join(" ");
  const words = kept.split(/\s+/).filter(Boolean);
  const trimmedWords = words.slice(0, 50).join(" ");
  let output = trimmedWords.trim();
  if (!/[.!?]$/.test(output)) output += "!";
  return output.length > 350 ? `${output.slice(0, 349).trim()}!` : output;
}

export async function generateCommentaryText(
  eventType: CommentaryEventType,
  context: string,
  allowedNames: string[] = [],
): Promise<string> {
  let commentary = "";

  if (getCommentaryMode() === "llm" && process.env.ANTHROPIC_API_KEY) {
    try {
      const prompt = buildCommentaryPrompt(eventType, context, allowedNames);
      const anthropic = getAnthropic();
      const msg = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 200,
        temperature: 0.85,
        system: ANNOUNCER_SYSTEM_PROMPT,
        messages: [{ role: "user", content: prompt }],
      });
      commentary = msg.content[0]?.type === "text" ? msg.content[0].text.trim() : "";
    } catch (err) {
      console.warn("[commentary-generator] LLM fallback to grounded:", err);
    }
  }

  if (!commentary) {
    commentary = buildGroundedCommentary(context);
  }

  return tightenCommentaryLine(commentary);
}

// ---------------------------------------------------------------------------
// TTS generation
// ---------------------------------------------------------------------------

function getElevenLabsKey(): string {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("ELEVENLABS_API_KEY not set");
  return key;
}

function getVoiceId(): string {
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
        stability: 0.35,
        similarity_boost: 0.85,
      },
    }),
  });
}

export async function generateTtsAudio(text: string): Promise<Uint8Array> {
  const voice = getVoiceId();
  let ttsRes = await requestTts(voice, text);
  let errText = ttsRes.ok ? "" : await ttsRes.text().catch(() => "unknown");

  if (!ttsRes.ok && errText.includes("voice_limit_reached") && voice !== ELEVENLABS_FALLBACK_VOICE) {
    console.warn("[commentary-generator] voice_limit_reached; retrying with fallback");
    ttsRes = await requestTts(ELEVENLABS_FALLBACK_VOICE, text);
    errText = ttsRes.ok ? "" : await ttsRes.text().catch(() => "unknown");
  }

  if (!ttsRes.ok) {
    throw new Error(`TTS generation failed (${ttsRes.status}): ${errText}`);
  }

  const audio = new Uint8Array(await ttsRes.arrayBuffer());
  if (audio.length === 0) throw new Error("TTS response was empty");
  return audio;
}

// ---------------------------------------------------------------------------
// Supabase Storage upload
// ---------------------------------------------------------------------------

export async function uploadCommentaryClip(
  rumbleId: string,
  clipKey: string,
  audio: Uint8Array,
): Promise<string | null> {
  try {
    const sb = freshServiceClient();
    const safeKey = clipKey.replace(/[^a-zA-Z0-9_:-]/g, "_").slice(0, 120);
    const path = `${rumbleId}/${safeKey}.mp3`;

    const { error } = await sb.storage
      .from(STORAGE_BUCKET)
      .upload(path, audio, {
        contentType: "audio/mpeg",
        upsert: true,
      });

    if (error) {
      console.warn("[commentary-generator] Storage upload failed:", error.message);
      return null;
    }

    const { data: urlData } = sb.storage
      .from(STORAGE_BUCKET)
      .getPublicUrl(path);

    return urlData?.publicUrl ?? null;
  } catch (err) {
    console.warn("[commentary-generator] Storage upload error:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Full pipeline: text → audio → upload → URL
// ---------------------------------------------------------------------------

export interface CommentaryClipResult {
  text: string;
  audioUrl: string | null;
}

export async function generateAndUploadCommentary(
  rumbleId: string,
  clipKey: string,
  eventType: CommentaryEventType,
  context: string,
  allowedNames: string[] = [],
): Promise<CommentaryClipResult | null> {
  // Guard: need at least ElevenLabs key
  if (!process.env.ELEVENLABS_API_KEY) {
    return null;
  }

  try {
    const text = await generateCommentaryText(eventType, context, allowedNames);
    if (!text) return null;

    const audio = await generateTtsAudio(text);
    const audioUrl = await uploadCommentaryClip(rumbleId, clipKey, audio);

    return { text, audioUrl };
  } catch (err) {
    console.warn("[commentary-generator] Pipeline failed:", err);
    return null;
  }
}
