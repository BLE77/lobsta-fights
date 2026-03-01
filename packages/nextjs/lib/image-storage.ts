/**
 * Image Storage Utility
 *
 * Downloads images from temporary URLs (like Replicate) and stores them
 * permanently in Supabase Storage.
 */

import { freshSupabase } from "./supabase";
import { isAllowedUrl } from "./url-validation";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const BUCKET_NAME = "images";

// Use fresh client for storage - images bucket allows public uploads
const getStorageClient = () => freshSupabase();

/**
 * Download an image from a URL and upload it to Supabase Storage
 * Returns the permanent public URL
 */
export async function storeImagePermanently(
  tempUrl: string,
  path: string // e.g., "fighters/abc123.png" or "battles/xyz789.png"
): Promise<string | null> {
  try {
    // Validate URL before attempting to download
    if (!tempUrl || tempUrl.length < 10) {
      console.error(`[ImageStorage] Invalid URL received: "${tempUrl}" - skipping storage`);
      return null;
    }

    const isAllowed = await isAllowedUrl(tempUrl);
    if (!isAllowed) {
      console.error(`[ImageStorage] Invalid URL received: "${tempUrl}" - skipping storage`);
      return null;
    }

    console.log(`[ImageStorage] Downloading from: ${tempUrl}`);

    // Download the image
    const response = await fetch(tempUrl, { redirect: "error" });
    if (!response.ok) {
      console.error(`[ImageStorage] Failed to download: ${response.status}`);
      return null;
    }

    const imageBlob = await response.blob();
    const arrayBuffer = await imageBlob.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    console.log(`[ImageStorage] Downloaded ${buffer.length} bytes, uploading to ${path}`);

    // Upload to Supabase Storage using admin client (bypasses RLS)
    const storageClient = getStorageClient();
    const { data, error } = await storageClient.storage
      .from(BUCKET_NAME)
      .upload(path, buffer, {
        contentType: "image/png",
        upsert: true, // Overwrite if exists
      });

    if (error) {
      console.error(`[ImageStorage] Upload failed:`, error);
      return null;
    }

    // Get the public URL
    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET_NAME}/${path}`;
    console.log(`[ImageStorage] Stored permanently at: ${publicUrl}`);

    return publicUrl;
  } catch (err) {
    console.error(`[ImageStorage] Error:`, err);
    return null;
  }
}

/**
 * Store a fighter's profile image permanently
 * @param suffix - Optional suffix like "victory" for victory pose images
 */
export async function storeFighterImage(
  fighterId: string,
  tempUrl: string,
  suffix?: string
): Promise<string | null> {
  const filename = suffix ? `${fighterId}-${suffix}.png` : `${fighterId}.png`;
  const path = `fighters/${filename}`;
  const permanentUrl = await storeImagePermanently(tempUrl, path);

  if (permanentUrl && !suffix) {
    // Only update image_url for profile images (no suffix)
    // Victory poses are handled separately in the registration route
    // Use freshSupabase() to avoid stale cached client on Vercel
    const client = freshSupabase();
    const { error } = await client
      .from("ucf_fighters")
      .update({ image_url: permanentUrl })
      .eq("id", fighterId);

    if (error) {
      console.error(`[ImageStorage] Failed to update fighter image_url:`, error);
    }
  }

  return permanentUrl;
}

/**
 * Store a battle result image permanently
 */
export async function storeBattleImage(
  matchId: string,
  tempUrl: string
): Promise<string | null> {
  const path = `battles/${matchId}.png`;
  const permanentUrl = await storeImagePermanently(tempUrl, path);

  if (permanentUrl) {
    // Update the match's result_image_url in the database
    // Use freshSupabase() to avoid stale cached client on Vercel
    const client = freshSupabase();
    const { error } = await client
      .from("ucf_matches")
      .update({ result_image_url: permanentUrl })
      .eq("id", matchId);

    if (error) {
      console.error(`[ImageStorage] Failed to update match result_image_url:`, error);
    }
  }

  return permanentUrl;
}
