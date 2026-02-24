// ---------------------------------------------------------------------------
// generate-voice-library.ts — Pre-generate TTS voice clips for all fighters
//
// Usage:
//   npx tsx --env-file=.env.local scripts/generate-voice-library.ts
//   npx tsx --env-file=.env.local scripts/generate-voice-library.ts --fighter "BLACK ANVIL"
//   npx tsx --env-file=.env.local scripts/generate-voice-library.ts --dry-run
// ---------------------------------------------------------------------------

import { createClient } from "@supabase/supabase-js";
import { buildVoiceLinePrompts, type VoiceLine } from "../lib/voice-line-prompts";

const STORAGE_BUCKET = "voice-library";
const ELEVENLABS_API_URL = "https://api.elevenlabs.io/v1/text-to-speech";
const ELEVENLABS_MODEL = "eleven_flash_v2_5";
const DELAY_BETWEEN_CLIPS_MS = 500; // Rate limit safety

// --- CLI args ---
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const forceRegenerate = args.includes("--force");
const fighterIdx = args.indexOf("--fighter");
const singleFighter = fighterIdx >= 0 ? args[fighterIdx + 1] : null;

// --- Supabase client ---
const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// --- ElevenLabs TTS ---
function getElevenLabsKey(): string {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("ELEVENLABS_API_KEY not set");
  return key;
}

function getVoiceId(): string {
  return process.env.ELEVENLABS_VOICE_A ?? "QMJTqaMXmGnG8TCm8WQG";
}

async function generateTtsAudio(text: string): Promise<Uint8Array> {
  const voice = getVoiceId();
  const res = await fetch(`${ELEVENLABS_API_URL}/${voice}/stream`, {
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
      voice_settings: { stability: 0.35, similarity_boost: 0.85 },
    }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "unknown");
    throw new Error(`TTS failed (${res.status}): ${err}`);
  }

  const audio = new Uint8Array(await res.arrayBuffer());
  if (audio.length === 0) throw new Error("TTS response was empty");
  return audio;
}

// --- Storage ---
async function ensureBucket() {
  const { data: buckets } = await sb.storage.listBuckets();
  if (!buckets?.find(b => b.name === STORAGE_BUCKET)) {
    const { error } = await sb.storage.createBucket(STORAGE_BUCKET, { public: true });
    if (error && !error.message.includes("already exists")) {
      throw new Error(`Failed to create bucket: ${error.message}`);
    }
    console.log(`  Created storage bucket: ${STORAGE_BUCKET}`);
  }
}

async function uploadClip(fighterId: string, clipKey: string, audio: Uint8Array): Promise<string> {
  const path = `${fighterId}/${clipKey}.mp3`;

  const { error } = await sb.storage
    .from(STORAGE_BUCKET)
    .upload(path, audio, { contentType: "audio/mpeg", upsert: true });

  if (error) throw new Error(`Upload failed: ${error.message}`);

  const { data: urlData } = sb.storage.from(STORAGE_BUCKET).getPublicUrl(path);
  return urlData.publicUrl;
}

// --- Main ---
interface FighterRow {
  id: string;
  name: string;
  robot_metadata: Record<string, unknown> | null;
}

async function main() {
  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  UCF Voice Library Generator");
  console.log("══════════════════════════════════════════════════════════════");
  if (dryRun) console.log("  MODE: DRY RUN (no TTS calls, no uploads)");
  if (forceRegenerate) console.log("  MODE: FORCE REGENERATE (overwrite existing clips)");
  if (singleFighter) console.log(`  TARGET: ${singleFighter}`);
  console.log();

  // Fetch fighters
  let query = sb.from("ucf_fighters").select("id, name, robot_metadata").eq("is_active", true).order("name");
  if (singleFighter) query = query.eq("name", singleFighter);
  const { data: fighters, error } = await query;

  if (error) { console.error("Failed to fetch fighters:", error.message); process.exit(1); }
  if (!fighters?.length) { console.error("No fighters found"); process.exit(1); }

  console.log(`  Found ${fighters.length} fighter(s)\n`);

  if (!dryRun) await ensureBucket();

  let totalClips = 0;
  let totalChars = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  for (const fighter of fighters as FighterRow[]) {
    console.log(`\n${"─".repeat(60)}`);
    console.log(`  ${fighter.name} (${fighter.id.slice(0, 8)}...)`);
    console.log(`${"─".repeat(60)}`);

    const lines = buildVoiceLinePrompts({ name: fighter.name, robot_metadata: fighter.robot_metadata as any });

    // Check for existing clips
    const existingClips = (fighter.robot_metadata as any)?.voice_clips ?? {};

    const voiceClips: Record<string, { text: string; audio_url: string; generated_at: string }> = { ...existingClips };

    for (const line of lines) {
      const existing = existingClips[line.key];

      // Skip if already generated with same text (unless --force)
      if (existing?.audio_url && existing?.text === line.text && !forceRegenerate) {
        console.log(`  ✓ ${line.label} — already generated (${line.text.length} chars)`);
        totalSkipped++;
        continue;
      }

      totalChars += line.text.length;

      if (dryRun) {
        console.log(`  ○ ${line.label} — ${line.text.length} chars`);
        console.log(`    "${line.text.slice(0, 100)}${line.text.length > 100 ? "..." : ""}"`);
        totalClips++;
        continue;
      }

      try {
        // Generate TTS audio
        const audio = await generateTtsAudio(line.text);
        const sizeKb = (audio.length / 1024).toFixed(1);

        // Upload to storage
        const audioUrl = await uploadClip(fighter.id, line.key, audio);

        voiceClips[line.key] = {
          text: line.text,
          audio_url: audioUrl,
          generated_at: new Date().toISOString(),
        };

        console.log(`  ✓ ${line.label} — ${line.text.length} chars, ${sizeKb}KB`);
        totalClips++;

        // Rate limit delay
        await new Promise(r => setTimeout(r, DELAY_BETWEEN_CLIPS_MS));
      } catch (err: any) {
        console.error(`  ✗ ${line.label} — FAILED: ${err.message}`);
        totalErrors++;
      }
    }

    // Save voice_clips back to robot_metadata
    if (!dryRun && Object.keys(voiceClips).length > 0) {
      const merged = { ...(fighter.robot_metadata ?? {}), voice_clips: voiceClips };
      const { error: updateErr } = await sb
        .from("ucf_fighters")
        .update({ robot_metadata: merged })
        .eq("id", fighter.id);

      if (updateErr) {
        console.error(`  ✗ Failed to save metadata: ${updateErr.message}`);
      } else {
        console.log(`  📝 Saved ${Object.keys(voiceClips).length} clip URLs to metadata`);
      }
    }
  }

  // Summary
  console.log(`\n${"═".repeat(60)}`);
  console.log("  SUMMARY");
  console.log(`${"═".repeat(60)}`);
  console.log(`  Fighters:   ${fighters.length}`);
  console.log(`  Generated:  ${totalClips} clips`);
  console.log(`  Skipped:    ${totalSkipped} (already up to date)`);
  console.log(`  Errors:     ${totalErrors}`);
  console.log(`  Characters: ${totalChars.toLocaleString()}`);
  console.log(`  Est. cost:  ~$${(totalChars * 0.00003).toFixed(4)} (ElevenLabs)`);
  if (dryRun) console.log("\n  [DRY RUN — no clips were actually generated]");
  console.log();
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
